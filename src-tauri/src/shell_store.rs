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
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE: &str = "layout.json";

/// Reconstructible, and the deliberate asymmetry in `userdata::store`.
///
/// This is the file written most often — `persist` runs inside every
/// `ShellState::mutate`, so a divider drag writes it — which makes it both the
/// one most likely to be caught mid-write and the worst candidate for keeping a
/// copy of each failure. Rearranging the windows again costs a minute. A
/// directory holding a hundred `layout.json.corrupt-…` files costs more.
const KEEP: Keep = Keep::Nothing;

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

/// Write the current state. Called from `ShellState::mutate`, so every change
/// that reaches a window reaches the disk too.
pub fn persist(app: &AppHandle, snapshot: &ShellSnapshot) {
    save(app, &Stored::from_snapshot(snapshot));
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
    let live: std::collections::HashSet<&str> = stored
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .flat_map(|c| c.tree.tabs())
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
    let stored = file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default();

    prune_unreachable(stored)
}

/// Write the store, atomically, through `userdata::store`.
pub fn save(app: &AppHandle, stored: &Stored) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, stored, "the layout");
    }
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
                }],
                active_cluster_id: Some("cluster-1".to_string()),
                geometry: None,
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
                }],
                active_cluster_id: Some("cluster-1".to_string()),
                geometry: Some(WindowGeometry {
                    x: 100,
                    y: 50,
                    width: 1440,
                    height: 900,
                }),
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
}
