//! The layout, on disk.
//!
//! Restarting a machine should not cost you your workspace. This writes the shell's layout — every
//! window, where it sits, the clusters it holds, the pane trees inside them, the tab order, what
//! was focused — and reads it back at launch, so OpenKaava opens in the state it closed in.
//!
//! Second thing here to touch the disk, after `project::store`, and built to its same four rules:
//!   * **Never fatal.** Every read degrades to `Stored::default()`. An unparseable layout costs
//!     your window arrangement; refusing to start costs the application, which no layout is worth.
//!   * **Atomic write.** Temp file, then rename — atomic on NTFS and POSIX alike. A crash
//!     mid-write leaves the previous layout intact rather than half of two.
//!   * **Forward-compatible.** `#[serde(default)]` throughout, unknown fields ignored. An older
//!     build must not choke on a file a newer one wrote.
//!   * **Not in the repo.** The config directory, never beside a project.
//!
//! Written on every mutation, from inside `ShellState::mutate`, and never on exit — not a
//! preference but the only correct place. `WindowEvent::Destroyed` fires for *every* window when
//! the app quits, so saving on the way out would save a state `reclaim` had already collapsed into
//! one window: close OpenKaava with three windows, open with one, every time, and the bug looks like a
//! serialization fault, not a lifecycle one. `project::store` writes inside every mutator too.

use crate::shell_state::{
    ShellSnapshot, SurfaceInstance, TerminalSession, WindowGeometry, WindowPlacement,
};
use crate::userdata::store::Keep;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const FILE: &str = "layout.json";

/// A corrupt or newer-format layout is set aside rather than written over.
///
/// This used to be `Keep::Nothing`, on the worry that the file is written on
/// every mutation and a backup per failure would pile up. Two things changed
/// that: writes are debounced now (see [`WriteBehind`]) and atomic, so a corrupt
/// file is rare rather than routine, and `userdata::backup` caps copies at three
/// per file, so the pile cannot grow. What is left is the argument for keeping:
/// the layout is the whole workspace, and "never wipe" is worth three small files.
const KEEP: Keep = Keep::Aside;

/// How long a burst of mutations waits before the layout is written.
///
/// A divider drag fires a mutation per pointer move, and each write ends in a
/// `sync_all`. The trailing edge is what is written, so the disk sees the state
/// the drag ended on. Short enough that a crash loses at most a fraction of a
/// second of arrangement; `flush` and `flush_pending` close the remaining gap
/// on every orderly exit.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// What survives a restart.
///
/// A parallel type rather than `ShellSnapshot` itself, on the same reasoning
/// `project::store` uses: the wire type and the on-disk type answer different
/// questions and should be able to gain and lose fields independently. One
/// thing is pointedly absent: a terminal's `agent_finished` dot means *this
/// agent finished while you were looking away*, which is not a fact that
/// outlives the session it happened in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stored {
    pub windows: Vec<WindowPlacement>,
    pub instances: Vec<SurfaceInstance>,
    /// Terminal *tabs*, not sessions.
    ///
    /// A pty dies with the process — `PtySessions` is rebuilt empty at every
    /// launch — so nothing here can bring a shell back. What it does bring back
    /// is the tab, its title, and its place in a cluster, which is what lets
    /// the tree references to it still resolve. `restore` spawns a fresh shell
    /// behind each one; see `lib.rs`.
    pub terminals: Vec<TerminalSession>,
}

impl Stored {
    fn from_snapshot(snapshot: &ShellSnapshot) -> Self {
        Stored {
            windows: snapshot.windows.clone(),
            instances: snapshot.instances.clone(),
            terminals: snapshot
                .terminals
                .iter()
                .map(|t| TerminalSession {
                    agent_finished: false,
                    ..t.clone()
                })
                .collect(),
        }
    }
}

/// Coalesces a burst of writes into one, written after things go quiet.
///
/// Generic over what it writes so the timing can be tested without an
/// `AppHandle` or a disk. The rules it keeps, which are the whole reason it is
/// not a bare `thread::sleep`:
///   * **Newest wins.** A submit replaces whatever is pending; nothing older is
///     ever written after something newer.
///   * **One writer at a time.** `writing` is taken *before* the pending value
///     is, by the timer and by `flush_now` alike, so a slow timer write can
///     never land after a `flush_now` that overtook it.
///   * **`flush_now` is synchronous** and cancels what was pending, for the
///     moments the process is about to end.
pub struct WriteBehind<T: Send + 'static> {
    inner: Arc<WriteBehindInner<T>>,
}

struct WriteBehindInner<T> {
    slot: Mutex<Slot<T>>,
    writing: Mutex<()>,
    delay: Duration,
    sink: Box<dyn Fn(T) + Send + Sync>,
}

struct Slot<T> {
    pending: Option<T>,
    scheduled: bool,
}

impl<T: Send + 'static> WriteBehind<T> {
    pub fn new(delay: Duration, sink: impl Fn(T) + Send + Sync + 'static) -> Self {
        WriteBehind {
            inner: Arc::new(WriteBehindInner {
                slot: Mutex::new(Slot {
                    pending: None,
                    scheduled: false,
                }),
                writing: Mutex::new(()),
                delay,
                sink: Box::new(sink),
            }),
        }
    }

    /// Record `value` as the one to write, and make sure a write is coming.
    pub fn submit(&self, value: T) {
        let start = {
            let mut slot = lock(&self.inner.slot);
            slot.pending = Some(value);
            !std::mem::replace(&mut slot.scheduled, true)
        };
        if !start {
            return;
        }
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            std::thread::sleep(inner.delay);
            // Writing lock first, then the value: see the type's doc.
            let _writing = lock(&inner.writing);
            let value = {
                let mut slot = lock(&inner.slot);
                slot.scheduled = false;
                slot.pending.take()
            };
            if let Some(value) = value {
                (inner.sink)(value);
            }
        });
    }

    /// Write now, discarding whatever was pending. `value` is the state to
    /// write; `None` writes only a pending value, if there is one.
    pub fn flush_now(&self, value: Option<T>) {
        let _writing = lock(&self.inner.writing);
        let pending = {
            let mut slot = lock(&self.inner.slot);
            let pending = slot.pending.take();
            value.or(pending)
        };
        if let Some(value) = pending {
            (self.inner.sink)(value);
        }
    }
}

/// A poisoned lock here means a sink panicked mid-write; the data behind it is
/// still just "the latest snapshot", so carry on rather than turning one failed
/// write into every later one failing too.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

type Job = (PathBuf, Stored);

fn writer() -> &'static WriteBehind<Job> {
    static WRITER: OnceLock<WriteBehind<Job>> = OnceLock::new();
    WRITER.get_or_init(|| {
        WriteBehind::new(DEBOUNCE, |(path, stored): Job| {
            write_to(&path, &stored);
        })
    })
}

/// Write the current state, soon. Called from `ShellState::mutate`, so every
/// change that reaches a window reaches the disk too — after a short quiet.
pub fn persist(app: &AppHandle, snapshot: &ShellSnapshot) {
    if let Some(path) = file(app) {
        writer().submit((path, Stored::from_snapshot(snapshot)));
    }
}

/// Write the current state *now*. For a window closing on purpose, where the
/// next debounce tick may never come.
pub fn persist_now(app: &AppHandle, snapshot: &ShellSnapshot) {
    if let Some(path) = file(app) {
        writer().flush_now(Some((path, Stored::from_snapshot(snapshot))));
    }
}

/// Write whatever is still waiting on the debounce, and nothing else. Safe on
/// the way out of the process precisely because it never *computes* a state: a
/// pending value was a real snapshot at some mutation, whereas the state at
/// exit may already have been collapsed by windows being destroyed (see the
/// module doc).
pub fn flush_pending() {
    writer().flush_now(None);
}

/// Drop anything the layout can no longer reach.
///
/// A surface lives in two places: an entry in `instances`, and its id in some
/// pane's tab list. Only the tree is ever searched, so an entry no tree names
/// is unreachable — nothing can focus it, close it, or draw it, and nothing
/// will ever put its id back. It is a leak with a serializer attached, and a
/// real `layout.json` from this machine had three of them beside one live tab.
///
/// Done on **load** rather than on save, and that is the whole safety argument.
/// A save can catch a surface mid-move, between being lifted out of one pane
/// and landing in another, and pruning then would delete a tab the user is
/// dragging. At load nothing is in flight: what the file says is the whole
/// truth, so unreachable is permanent rather than momentary.
///
/// Self-healing, therefore. The next mutation writes the pruned set back, so a
/// file that has been accumulating orphans is cleaned once and stays clean.
fn prune_unreachable(mut stored: Stored) -> Stored {
    // A window's right page hosts its app instance outside every tree — that is
    // what lets it stay mounted across a dock/expand toggle — so the page's
    // `instance_id` is a second way to be reachable. Leaving it out pruned the
    // Plane / Cloud agents / Cost instance at every load and left the restored
    // page pointing at an instance that no longer existed.
    let live: std::collections::HashSet<&str> = stored
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .flat_map(|c| c.tree.tabs())
        .chain(
            stored
                .windows
                .iter()
                .filter_map(|w| w.right_page.as_ref())
                .filter_map(|p| p.instance_id.as_deref()),
        )
        .collect();

    let clusters: std::collections::HashSet<&str> = stored
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .map(|c| c.id.as_str())
        .collect();

    let keep_instances: Vec<SurfaceInstance> = stored
        .instances
        .iter()
        .filter(|i| live.contains(i.id.as_str()))
        .cloned()
        .collect();

    // A terminal is normally reached through its cluster's band rather than
    // through a pane, so it is judged against a different set. Two exceptions,
    // and both would be silent data loss if this were a plain cluster check:
    //
    //   * a terminal **dragged into the layout** is drawn as a surface, so its
    //     id is in a tree and its band no longer holds it. `Cluster::tree`'s
    //     doc is explicit that the tree wins when both could claim it.
    //   * a terminal from a `layout.json` written when terminals named a
    //     *window* has no cluster id at all. The empty string is a real state
    //     there, not a placeholder, and `adopt_orphan_terminals` gives it a
    //     cluster at restore — which is after this runs.
    let keep_terminals: Vec<TerminalSession> = stored
        .terminals
        .iter()
        .filter(|t| {
            t.cluster_id.is_empty()
                || clusters.contains(t.cluster_id.as_str())
                || live.contains(t.id.as_str())
        })
        .cloned()
        .collect();

    stored.instances = keep_instances;
    stored.terminals = keep_terminals;
    stored
}

/// Read the store, or start empty. Never fails — see the module doc.
pub fn load(app: &AppHandle) -> Stored {
    file(app).map(|path| load_from(&path)).unwrap_or_default()
}

/// [`load`], against a path — the half with no `AppHandle` in it, so the whole
/// read path (missing, corrupt, older, newer) is testable against a real file.
///
/// Failures are logged through `kaava_log!`, which is what `recent_errors`
/// reads, and degrade to an empty `Stored`, which `restore_session` turns into
/// a first-run workspace. With `KEEP` the bad file was already moved aside.
pub fn load_from(path: &Path) -> Stored {
    prune_unreachable(crate::userdata::store::read(path, KEEP))
}

/// Write the store, atomically, through `userdata::store`.
pub fn write_to(path: &Path, stored: &Stored) {
    crate::userdata::store::write(path, stored, "the layout");
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

// --- placing a restored window ----------------------------------------------

/// A rectangle in physical pixels — a window's outer bounds, or a monitor's.
///
/// Physical on both sides is the whole reason a saved window can be compared
/// against a display at all: `outer_position`, `outer_size` and
/// `available_monitors` all report in physical pixels, and folding a scale
/// factor into any one of them is how a window restores half-size on a scaled
/// monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn centre(&self) -> (i32, i32) {
        (
            self.x + (self.width / 2) as i32,
            self.y + (self.height / 2) as i32,
        )
    }

    fn contains(&self, (x, y): (i32, i32)) -> bool {
        x >= self.x
            && x < self.x + self.width as i32
            && y >= self.y
            && y < self.y + self.height as i32
    }
}

impl From<WindowGeometry> for Rect {
    fn from(g: WindowGeometry) -> Self {
        Rect {
            x: g.x,
            y: g.y,
            width: g.width,
            height: g.height,
        }
    }
}

impl From<Rect> for WindowGeometry {
    fn from(r: Rect) -> Self {
        WindowGeometry {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }
    }
}

/// Keep a restored window somewhere a person can actually see it.
///
/// The case that matters is the laptop: you arrange three windows across two
/// monitors, undock, and launch. The second monitor's coordinates are still in
/// the file and are now nowhere — restoring to them puts a window off-screen,
/// with no title bar to drag it back by, which reads as OpenKaava simply failing to
/// start.
///
/// The test is the window's *centre*, not its whole rectangle. A window
/// straddling two monitors is a normal thing a person did on purpose, and
/// demanding full containment would move it for no reason.
///
/// `None` means "no opinion" — the caller should let Tauri place the window
/// itself, which is the right answer when there is no monitor information to
/// judge against at all.
pub fn place_within(saved: Rect, monitors: &[Rect], primary: Option<Rect>) -> Option<Rect> {
    if monitors.is_empty() {
        return None;
    }

    if monitors.iter().any(|m| m.contains(saved.centre())) {
        return Some(saved);
    }

    // The monitor it was on is gone. Centre it on the primary — same size where
    // that fits, shrunk to the display where it does not, because a window
    // restored larger than the screen it lands on is as unreachable as one
    // restored off the edge of it.
    let target = primary.or_else(|| monitors.first().copied())?;
    let width = saved.width.min(target.width);
    let height = saved.height.min(target.height);

    Some(Rect {
        x: target.x + ((target.width - width) / 2) as i32,
        y: target.y + ((target.height - height) / 2) as i32,
        width,
        height,
    })
}

/// `place_within`, against the displays actually attached right now.
pub fn clamp_to_visible(app: &AppHandle, saved: WindowGeometry) -> Option<WindowGeometry> {
    let monitors: Vec<Rect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();

    let primary = app.primary_monitor().ok().flatten().map(|m| Rect {
        x: m.position().x,
        y: m.position().y,
        width: m.size().width,
        height: m.size().height,
    });

    place_within(saved.into(), &monitors, primary).map(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{PaneNode, SplitDir};
    use crate::shell_state::{Cluster, SurfaceKind};

    fn instance(id: &str) -> SurfaceInstance {
        SurfaceInstance {
            id: id.to_string(),
            app_id: "home".to_string(),
            kind: SurfaceKind::App,
            title: "Home".to_string(),
        }
    }

    fn terminal(id: &str, cluster_id: &str) -> TerminalSession {
        TerminalSession {
            id: id.to_string(),
            title: "bash".to_string(),
            cluster_id: cluster_id.to_string(),
            agent_finished: false,
            group_id: None,
        }
    }

    /// One window, one cluster, one pane holding exactly `tabs`.
    fn stored_with(tabs: &[&str], instances: Vec<SurfaceInstance>) -> Stored {
        Stored {
            windows: vec![WindowPlacement {
                label: "main".to_string(),
                clusters: vec![Cluster {
                    id: "cluster-1".to_string(),
                    name: "Cluster 1".to_string(),
                    tree: PaneNode::Leaf {
                        id: "pane-1".to_string(),
                        tabs: tabs.iter().map(|t| t.to_string()).collect(),
                        active_tab: tabs.first().map(|t| t.to_string()),
                    },
                    project: None,
                    worktree: None,
                    active_terminal: None,
                    band_height: None,
                    page: None,
                    environment: None,
                    pinned: false,
                    icon: None,
                    environment_missing: false,
                }],
                active_cluster_id: Some("cluster-1".to_string()),
                geometry: None,
                right_page: None,
            }],
            instances,
            terminals: Vec::new(),
        }
    }

    /// The bug this was written for. A real `layout.json` from a development
    /// machine held three `home-*` entries beside one live tab.
    #[test]
    fn drops_instances_no_pane_references() {
        let stored = stored_with(
            &["home-39"],
            vec![
                instance("home-3"),
                instance("home-38"),
                instance("viewer-1"),
                instance("home-39"),
            ],
        );

        let pruned = prune_unreachable(stored);
        let ids: Vec<&str> = pruned.instances.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["home-39"]);
    }

    #[test]
    fn keeps_every_instance_a_pane_still_names() {
        let stored = stored_with(
            &["home-1", "files-2"],
            vec![instance("home-1"), instance("files-2")],
        );
        assert_eq!(prune_unreachable(stored).instances.len(), 2);
    }

    /// A terminal whose cluster is gone has a band nothing draws, and
    /// `respawn_terminals` would start a shell for it.
    #[test]
    fn drops_a_terminal_whose_cluster_is_gone() {
        let mut stored = stored_with(&["home-1"], vec![instance("home-1")]);
        stored.terminals = vec![
            terminal("term-1", "cluster-1"),
            terminal("term-9", "cluster-404"),
        ];

        let pruned = prune_unreachable(stored);
        let kept: Vec<&str> = pruned.terminals.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(kept, vec!["term-1"]);
    }

    /// Dragged into the layout, so it is drawn as a surface and its band no
    /// longer holds it. Deleting it here would be silent data loss.
    #[test]
    fn keeps_a_terminal_that_was_dragged_into_a_pane() {
        let mut stored = stored_with(&["term-7"], Vec::new());
        stored.terminals = vec![terminal("term-7", "cluster-404")];
        assert_eq!(prune_unreachable(stored).terminals.len(), 1);
    }

    /// Written when terminals named a window. The empty cluster id is a real
    /// state, and `adopt_orphan_terminals` gives it a cluster at restore, which
    /// happens after this runs.
    #[test]
    fn keeps_a_legacy_terminal_that_names_no_cluster() {
        let mut stored = stored_with(&["home-1"], vec![instance("home-1")]);
        stored.terminals = vec![terminal("term-1", "")];
        assert_eq!(prune_unreachable(stored).terminals.len(), 1);
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// A laptop display, with a second monitor to its right.
    fn two_monitors() -> Vec<Rect> {
        vec![rect(0, 0, 1920, 1080), rect(1920, 0, 2560, 1440)]
    }

    #[test]
    fn a_window_on_a_monitor_that_is_still_there_is_left_alone() {
        let saved = rect(2200, 200, 900, 620);
        assert_eq!(
            place_within(saved, &two_monitors(), Some(rect(0, 0, 1920, 1080))),
            Some(saved),
            "nothing about this window needs moving"
        );
    }

    #[test]
    fn a_window_straddling_two_monitors_is_left_alone() {
        // Centre lands at x=1970, on the second monitor. Deliberate placement,
        // not a fault to correct.
        let saved = rect(1620, 300, 700, 500);
        assert_eq!(
            place_within(saved, &two_monitors(), Some(rect(0, 0, 1920, 1080))),
            Some(saved)
        );
    }

    /// The undocked-laptop case: the second monitor is gone and its
    /// coordinates now name nowhere.
    #[test]
    fn a_window_on_an_absent_monitor_is_recentred_on_the_primary() {
        let saved = rect(2200, 200, 900, 620);
        let primary = rect(0, 0, 1920, 1080);

        let placed = place_within(saved, &[primary], Some(primary)).expect("a placement");

        assert_eq!(placed.width, 900, "the size it had is kept");
        assert_eq!(placed.height, 620);
        assert!(
            primary.contains(placed.centre()),
            "and it lands somewhere visible: {placed:?}"
        );
        assert_eq!(placed.x, (1920 - 900) / 2, "centred horizontally");
    }

    #[test]
    fn a_window_larger_than_the_display_it_lands_on_is_shrunk_to_fit() {
        let saved = rect(3000, 0, 2560, 1440);
        let small = rect(0, 0, 1280, 800);

        let placed = place_within(saved, &[small], Some(small)).expect("a placement");

        assert_eq!(
            placed.width, 1280,
            "a window wider than the screen is unreachable"
        );
        assert_eq!(placed.height, 800);
        assert_eq!(placed.x, 0);
        assert_eq!(placed.y, 0);
    }

    #[test]
    fn with_no_monitor_information_there_is_no_opinion() {
        assert_eq!(
            place_within(rect(0, 0, 900, 620), &[], None),
            None,
            "Tauri's own placement is better than a guess"
        );
    }

    #[test]
    fn a_missing_primary_falls_back_to_the_first_monitor() {
        let saved = rect(9000, 9000, 400, 300);
        let placed = place_within(saved, &two_monitors(), None).expect("a placement");
        assert!(two_monitors()[0].contains(placed.centre()));
    }

    // --- the file itself ----------------------------------------------------

    fn sample() -> Stored {
        let mut tree = PaneNode::leaf("pane-1");
        tree.insert_tab("pane-1", "files-1", None);
        tree.split_pane(
            "pane-1",
            SplitDir::Row,
            "split-1",
            "pane-2",
            "files-2",
            false,
        );

        Stored {
            windows: vec![WindowPlacement {
                label: "main".to_string(),
                clusters: vec![Cluster {
                    id: "cluster-1".to_string(),
                    name: "auth".to_string(),
                    tree,
                    project: Some(r"C:\code\auth".to_string()),
                    worktree: None,
                    active_terminal: Some("term-1".to_string()),
                    band_height: Some(320.0),
                    page: None,
                    environment: None,
                    pinned: false,
                    icon: None,
                    environment_missing: false,
                }],
                active_cluster_id: Some("cluster-1".to_string()),
                geometry: Some(WindowGeometry {
                    x: 100,
                    y: 50,
                    width: 1440,
                    height: 900,
                }),
                right_page: None,
            }],
            instances: vec![
                SurfaceInstance {
                    id: "files-1".to_string(),
                    app_id: "files".to_string(),
                    kind: SurfaceKind::App,
                    title: "Files".to_string(),
                },
                SurfaceInstance {
                    id: "files-2".to_string(),
                    app_id: "files".to_string(),
                    kind: SurfaceKind::App,
                    title: "Files".to_string(),
                },
            ],
            terminals: vec![TerminalSession {
                id: "term-1".to_string(),
                title: "pwsh".to_string(),
                cluster_id: "cluster-1".to_string(),
                agent_finished: false,
                group_id: None,
            }],
        }
    }

    #[test]
    fn a_whole_layout_survives_a_round_trip() {
        let stored = sample();
        let json = serde_json::to_string_pretty(&stored).expect("serializes");
        let back: Stored = serde_json::from_str(&json).expect("and reads back");

        assert_eq!(back.windows.len(), 1);
        assert_eq!(
            back.windows[0].clusters[0].tree,
            stored.windows[0].clusters[0].tree
        );
        assert_eq!(back.windows[0].geometry, stored.windows[0].geometry);
        assert_eq!(
            back.instances.len(),
            2,
            "two Files, which is the whole point"
        );
        assert_eq!(back.terminals[0].cluster_id, "cluster-1");
        assert_eq!(
            back.windows[0].clusters[0].active_terminal.as_deref(),
            Some("term-1"),
            "which terminal the band had open is the cluster's, and comes back with it"
        );
        assert_eq!(
            back.windows[0].clusters[0].band_height,
            Some(320.0),
            "and so is how tall it was left, or reopening lands on the default every launch"
        );
    }

    /// An older build must not choke on a file a newer one wrote, and a file
    /// missing a field a newer build expects must not fail to load. Both
    /// directions, because both happen — the second every time this feature
    /// gains a field.
    #[test]
    fn unknown_fields_are_ignored_and_missing_ones_default() {
        let json = r#"{
            "windows": [],
            "instances": [],
            "somethingAVersionFromTheFutureAdded": {"nested": [1, 2, 3]}
        }"#;

        let stored: Stored = serde_json::from_str(json).expect("an unknown field is not fatal");
        assert!(
            stored.terminals.is_empty(),
            "an absent field takes its default"
        );
    }

    /// The file on disk right now: terminals carrying a `windowLabel`, the
    /// panel's selection stored on the window, and no cluster id on a session
    /// anywhere. It has to load without failing, which is all this asserts — the
    /// terminal comes back with no cluster, and `ShellState::restore` is what
    /// gives it one (see `adopt_orphan_terminals`). Deserialization has only the
    /// one session in front of it and cannot answer a question about the whole
    /// snapshot.
    #[test]
    fn a_layout_from_while_terminals_named_a_window_still_loads() {
        let json = r#"{
            "windows": [{
                "label": "main",
                "clusters": [{
                    "id": "cluster-1",
                    "name": "auth",
                    "tree": {"kind": "leaf", "id": "pane-1", "tabs": [], "activeTab": null},
                    "worktree": null
                }],
                "activeClusterId": "cluster-1",
                "activeTerminal": "term-1",
                "geometry": null
            }],
            "instances": [],
            "terminals": [{
                "id": "term-1",
                "title": "pwsh",
                "windowLabel": "main",
                "agentFinished": false,
                "groupId": null
            }]
        }"#;

        let stored: Stored = serde_json::from_str(json).expect("last week's layout still reads");

        assert_eq!(
            stored.terminals[0].cluster_id, "",
            "no cluster yet; `adopt_orphan_terminals` assigns one at restore"
        );
        assert_eq!(
            stored.windows[0].clusters[0].active_terminal, None,
            "the window's old selection is not read back; `restore` re-seats it"
        );
        assert_eq!(
            stored.windows[0].clusters[0].band_height, None,
            "a layout from before the band had a height here opens at the default"
        );
    }

    /// And the older one still on some machines, from before terminals named a
    /// window at all. Its `clusterId` is the field's name again, so it reads
    /// straight through with nothing to migrate.
    #[test]
    fn a_layout_from_before_terminals_named_a_window_reads_straight_through() {
        let json = r#"{
            "windows": [{
                "label": "main",
                "clusters": [{
                    "id": "cluster-1",
                    "name": "auth",
                    "tree": {"kind": "leaf", "id": "pane-1", "tabs": [], "activeTab": null},
                    "activeTerminal": "term-1",
                    "worktree": null
                }],
                "activeClusterId": "cluster-1",
                "geometry": null
            }],
            "instances": [],
            "terminals": [{
                "id": "term-1",
                "title": "pwsh",
                "clusterId": "cluster-1",
                "agentFinished": false,
                "groupId": null
            }]
        }"#;

        let stored: Stored = serde_json::from_str(json).expect("an older layout reads too");

        assert_eq!(stored.terminals[0].cluster_id, "cluster-1");
        assert_eq!(
            stored.windows[0].clusters[0].active_terminal.as_deref(),
            Some("term-1"),
            "and its band selection, which lived here then and lives here again"
        );
    }

    #[test]
    fn an_empty_document_is_a_valid_empty_layout() {
        let stored: Stored =
            serde_json::from_str("{}").expect("`{}` is a layout with nothing in it");
        assert!(stored.windows.is_empty());
    }

    #[test]
    fn the_agent_dot_does_not_outlive_the_session_that_earned_it() {
        let snapshot = ShellSnapshot {
            windows: Vec::new(),
            instances: Vec::new(),
            terminals: vec![TerminalSession {
                id: "term-1".to_string(),
                title: "claude".to_string(),
                cluster_id: "cluster-1".to_string(),
                agent_finished: true,
                group_id: None,
            }],
        };

        let stored = Stored::from_snapshot(&snapshot);
        assert!(
            !stored.terminals[0].agent_finished,
            "`this agent finished while you were away` is not a fact about tomorrow"
        );
    }

    // --- the whole workspace survives a restart --------------------------------

    use crate::environments::Environment;
    use crate::pages::PageMode;
    use crate::shell_state::{RightPage, ShellState, WorktreeRef};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A directory of its own per test; the tests here run in parallel.
    fn scratch_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "kaava-shell-store-{tag}-{at}-{}",
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("the temp directory is writable");
        dir
    }

    fn json(stored: &Stored) -> serde_json::Value {
        serde_json::to_value(stored).expect("serializes")
    }

    fn leaf(pane: &str, tab: &str) -> PaneNode {
        PaneNode::Leaf {
            id: pane.to_string(),
            tabs: vec![tab.to_string()],
            active_tab: Some(tab.to_string()),
        }
    }

    fn plain_cluster(id: &str, name: &str, tree: PaneNode) -> Cluster {
        Cluster {
            id: id.to_string(),
            name: name.to_string(),
            tree,
            project: Some("C:/games/skyfall".to_string()),
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: None,
            pinned: false,
            icon: None,
            environment_missing: false,
        }
    }

    fn app_instance(id: &str, app_id: &str, title: &str) -> SurfaceInstance {
        SurfaceInstance {
            id: id.to_string(),
            app_id: app_id.to_string(),
            kind: SurfaceKind::App,
            title: title.to_string(),
        }
    }

    /// Everything the acceptance names, at once: two windows (one with a saved
    /// position and a docked page), clusters bound to a worktree, the Design
    /// worktree (pinned) and a legacy worktree ref, a split tree with sizes,
    /// several app instances, an active cluster, a band height and a terminal
    /// selection, and grouped terminals. `wt` and `design` must exist on disk
    /// or the restore would (correctly) flag them missing.
    fn everything(wt: &Path, design: &Path) -> Stored {
        let tree = PaneNode::Split {
            id: "split-1".to_string(),
            dir: SplitDir::Row,
            sizes: vec![0.25, 0.75],
            children: vec![
                PaneNode::Leaf {
                    id: "pane-1".to_string(),
                    tabs: vec!["home-1".to_string(), "files-1".to_string()],
                    active_tab: Some("files-1".to_string()),
                },
                PaneNode::Split {
                    id: "split-2".to_string(),
                    dir: SplitDir::Column,
                    sizes: vec![0.5, 0.5],
                    children: vec![leaf("pane-2", "viewer-1"), leaf("pane-3", "term-3")],
                },
            ],
        };

        let mut main_cluster = plain_cluster("cluster-1", "auth", tree);
        main_cluster.environment = Some(Environment::LocalWorktree {
            name: "auth".to_string(),
            path: wt.display().to_string(),
            branch: "wt/auth".to_string(),
            base: "main".to_string(),
        });
        main_cluster.band_height = Some(312.5);
        main_cluster.active_terminal = Some("term-1".to_string());

        let mut design_cluster = plain_cluster("cluster-2", "Design", leaf("pane-4", "design-1"));
        design_cluster.environment = Some(Environment::Design {
            path: design.display().to_string(),
            branch: "wt/design".to_string(),
        });
        design_cluster.pinned = true;

        let mut legacy = plain_cluster("cluster-3", "legacy", leaf("pane-5", "home-2"));
        legacy.worktree = Some(WorktreeRef {
            path: wt.display().to_string(),
            branch: Some("wt/auth".to_string()),
            base: Some("main".to_string()),
        });
        legacy.environment = Some(Environment::Main);
        legacy.project = None;

        let mut second = plain_cluster("cluster-4", "billing", leaf("pane-6", "files-2"));
        // `reseat_active_terminals` would pick this itself; stated so the
        // round trip compares like with like.
        second.active_terminal = Some("term-4".to_string());

        Stored {
            windows: vec![
                WindowPlacement {
                    label: "main".to_string(),
                    clusters: vec![main_cluster, design_cluster, legacy],
                    active_cluster_id: Some("cluster-3".to_string()),
                    geometry: Some(WindowGeometry {
                        x: -1920,
                        y: 40,
                        width: 1600,
                        height: 900,
                    }),
                    right_page: Some(RightPage {
                        id: "costs".to_string(),
                        mode: PageMode::Docked,
                        width: 455.0,
                        instance_id: Some("costs-page-main".to_string()),
                    }),
                },
                WindowPlacement {
                    label: "win-2".to_string(),
                    clusters: vec![second],
                    active_cluster_id: Some("cluster-4".to_string()),
                    geometry: None,
                    right_page: Some(RightPage {
                        id: "git".to_string(),
                        mode: PageMode::Expanded,
                        width: 340.0,
                        instance_id: None,
                    }),
                },
            ],
            instances: vec![
                instance("home-1"),
                app_instance("files-1", "files", "Files"),
                app_instance("viewer-1", "viewer", "hero.png"),
                instance("design-1"),
                instance("home-2"),
                instance("files-2"),
                app_instance("costs-page-main", "costs", "Cost"),
            ],
            terminals: vec![
                terminal("term-1", "cluster-1"),
                TerminalSession {
                    group_id: Some("group-1".to_string()),
                    title: "claude".to_string(),
                    ..terminal("term-2", "cluster-1")
                },
                // Dragged into the layout: reachable through the tree.
                terminal("term-3", "cluster-1"),
                terminal("term-4", "cluster-4"),
            ],
        }
    }

    fn worktree_dirs(tag: &str) -> (PathBuf, PathBuf) {
        let root = scratch_dir(tag);
        let wt = root.join("auth");
        let design = root.join("design");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&design).unwrap();
        (wt, design)
    }

    fn restored_shell(stored: Stored) -> ShellState {
        let shell = ShellState::default();
        shell.restore(ShellSnapshot {
            windows: stored.windows,
            instances: stored.instances,
            terminals: stored.terminals,
        });
        shell
    }

    /// state -> save -> load -> equal, for every item in the acceptance.
    #[test]
    fn the_whole_workspace_round_trips_through_the_file() {
        let (wt, design) = worktree_dirs("round-trip");
        let path = scratch_dir("round-trip-file").join("layout.json");
        let before = everything(&wt, &design);

        write_to(&path, &before);
        let after = load_from(&path);

        assert_eq!(json(&before), json(&after));
        // Spelled out too, so a failure names the item rather than a diff of
        // one very long value.
        let main = &after.windows[0];
        assert_eq!(main.active_cluster_id.as_deref(), Some("cluster-3"));
        assert_eq!(main.geometry.map(|g| g.x), Some(-1920));
        assert_eq!(main.right_page.as_ref().map(|p| p.width), Some(455.0));
        assert_eq!(
            main.right_page
                .as_ref()
                .and_then(|p| p.instance_id.as_deref()),
            Some("costs-page-main")
        );
        assert_eq!(main.clusters[0].band_height, Some(312.5));
        assert!(main.clusters[1].pinned);
        assert_eq!(after.windows[1].label, "win-2");
        assert_eq!(after.terminals.len(), 4);
    }

    /// The same, one step further: through `ShellState::restore`, which is what
    /// `restore_session` calls. Migrations must not disturb a current file.
    #[test]
    fn a_current_layout_restores_into_the_shell_unchanged() {
        let (wt, design) = worktree_dirs("restore");
        let path = scratch_dir("restore-file").join("layout.json");
        let before = everything(&wt, &design);
        write_to(&path, &before);

        let shell = restored_shell(load_from(&path));
        let restored = shell.snapshot();

        assert_eq!(json(&before), json(&Stored::from_snapshot(&restored)));
        assert!(restored
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .all(|c| !c.environment_missing));
    }

    /// The bug found while writing the round trip: a page's app instance is in
    /// no tree, so pruning judged it unreachable and dropped it at every load.
    #[test]
    fn a_right_pages_instance_is_not_pruned_as_unreachable() {
        let (wt, design) = worktree_dirs("page-instance");
        let pruned = prune_unreachable(everything(&wt, &design));
        assert!(pruned.instances.iter().any(|i| i.id == "costs-page-main"));
    }

    #[test]
    fn a_missing_file_is_a_first_run_not_an_error() {
        let path = scratch_dir("missing").join("layout.json");
        assert!(load_from(&path).windows.is_empty());
    }

    /// Corrupt: degrades to empty, and keeps a copy rather than leaving the
    /// next save to write over the only evidence.
    #[test]
    fn a_corrupt_file_falls_back_to_defaults_and_is_kept_aside() {
        let path = scratch_dir("corrupt").join("layout.json");
        std::fs::write(&path, "{ \"windows\": [ {\"label\": ").unwrap();

        let stored = load_from(&path);

        assert!(stored.windows.is_empty() && stored.terminals.is_empty());
        assert!(
            crate::userdata::backup::newest(&path, "corrupt").is_some(),
            "the unreadable file is set aside, not lost"
        );
    }

    /// Well-formed JSON of the wrong shape is corrupt too.
    #[test]
    fn a_layout_of_the_wrong_shape_is_corrupt_not_a_crash() {
        let path = scratch_dir("shape").join("layout.json");
        std::fs::write(&path, r#"{"windows": "not a list"}"#).unwrap();
        assert!(load_from(&path).windows.is_empty());
        assert!(crate::userdata::backup::newest(&path, "corrupt").is_some());
    }

    /// A file from before `environment`, `pinned`, `rightPage`, `bandHeight`,
    /// the format stamp and cluster-owned terminals: only what the oldest
    /// builds wrote. It loads, and restoring it migrates rather than drops.
    #[test]
    fn an_older_schema_loads_and_migrates() {
        let (wt, _) = worktree_dirs("older");
        let path = scratch_dir("older-file").join("layout.json");
        let old = serde_json::json!({
            "windows": [{
                "label": "main",
                "clusters": [{
                    "id": "cluster-1",
                    "name": "auth",
                    "tree": {"kind": "leaf", "id": "pane-1", "tabs": ["home-1"], "activeTab": "home-1"},
                    "worktree": {"path": wt.display().to_string(), "branch": "wt/auth"}
                }],
                "activeClusterId": "cluster-1"
            }],
            "instances": [{"id": "home-1", "appId": "home", "kind": "app", "title": "Home"}],
            "terminals": [{"id": "term-1", "title": "bash", "agentFinished": false, "groupId": null}]
        });
        std::fs::write(&path, old.to_string()).unwrap();

        let loaded = load_from(&path);
        assert_eq!(loaded.windows.len(), 1, "an old file is not set aside");
        assert_eq!(loaded.instances.len(), 1);
        assert_eq!(loaded.terminals.len(), 1);

        let snap = restored_shell(loaded).snapshot();
        let cluster = &snap.windows[0].clusters[0];
        assert!(matches!(
            cluster.environment,
            Some(Environment::LocalWorktree { .. })
        ));
        assert!(!cluster.pinned && cluster.band_height.is_none());
        assert_eq!(snap.terminals[0].cluster_id, "cluster-1", "orphan adopted");
    }

    /// A file a *newer* build wrote is intact and belongs to that build: this
    /// one starts empty and moves it aside instead of writing over it.
    #[test]
    fn a_newer_format_is_set_aside_intact() {
        let path = scratch_dir("newer").join("layout.json");
        let text = r#"{"format": 99, "windows": []}"#;
        std::fs::write(&path, text).unwrap();

        assert!(load_from(&path).windows.is_empty());

        let kept = crate::userdata::backup::newest(&path, "format-99").expect("kept");
        assert_eq!(std::fs::read_to_string(kept).unwrap(), text);
    }

    /// A saved file always carries the format, so a future bump can tell it
    /// from a legacy one.
    #[test]
    fn a_saved_layout_is_stamped_with_the_format() {
        let path = scratch_dir("stamp").join("layout.json");
        write_to(&path, &Stored::default());
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["format"], crate::userdata::store::FORMAT);
    }

    /// A worktree deleted between launches: the cluster comes back, flagged,
    /// with its layout intact, rather than vanishing or crashing the restore.
    #[test]
    fn a_missing_worktree_restores_as_a_flagged_cluster() {
        let (wt, design) = worktree_dirs("gone");
        let before = everything(&wt, &design);
        std::fs::remove_dir_all(&wt).unwrap();

        let shell = restored_shell(before);
        let snap = shell.snapshot();
        let clusters: Vec<&Cluster> = snap
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .collect();

        let auth = clusters.iter().find(|c| c.id == "cluster-1").unwrap();
        assert!(auth.environment_missing);
        assert_eq!(auth.tree.tabs().len(), 4, "its layout is untouched");
        assert_eq!(auth.band_height, Some(312.5));

        let design = clusters.iter().find(|c| c.id == "cluster-2").unwrap();
        assert!(!design.environment_missing, "the ones that exist are fine");
        assert!(shell.cluster_environment_missing("cluster-1"));
        assert!(!shell.cluster_environment_missing("cluster-2"));
        // Main / cloud / no environment have no local folder of their own to
        // lose, so they can never be flagged.
        let legacy = clusters.iter().find(|c| c.id == "cluster-3").unwrap();
        assert!(!legacy.environment_missing);
    }

    // --- the debounce ----------------------------------------------------------

    fn recorder(delay_ms: u64) -> (WriteBehind<u32>, Arc<Mutex<Vec<u32>>>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&written);
        let wb = WriteBehind::new(Duration::from_millis(delay_ms), move |v| {
            sink.lock().unwrap().push(v);
        });
        (wb, written)
    }

    /// A drag's worth of mutations is one write, of the last state.
    #[test]
    fn a_burst_of_submits_writes_once_with_the_newest_value() {
        let (wb, written) = recorder(150);
        for v in 1..=50 {
            wb.submit(v);
        }
        assert!(written.lock().unwrap().is_empty(), "nothing yet: debounced");
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(*written.lock().unwrap(), vec![50]);
    }

    /// Closing the window: written synchronously, and the timer that was
    /// already running must not write an older state afterwards.
    #[test]
    fn flush_now_writes_immediately_and_cancels_the_pending_write() {
        let (wb, written) = recorder(100);
        wb.submit(1);
        wb.flush_now(Some(2));
        assert_eq!(*written.lock().unwrap(), vec![2]);
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(*written.lock().unwrap(), vec![2], "no stale write after");
    }

    /// The exit hook: commits what was waiting, invents nothing.
    #[test]
    fn flushing_pending_writes_only_what_was_waiting() {
        let (wb, written) = recorder(5000);
        wb.flush_now(None);
        assert!(written.lock().unwrap().is_empty());
        wb.submit(7);
        wb.flush_now(None);
        assert_eq!(*written.lock().unwrap(), vec![7]);
    }

    /// A later burst schedules again; the writer is not one-shot.
    #[test]
    fn a_second_burst_writes_again() {
        let (wb, written) = recorder(50);
        wb.submit(1);
        std::thread::sleep(Duration::from_millis(400));
        wb.submit(2);
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(*written.lock().unwrap(), vec![1, 2]);
    }
}
