//! What every OpenKaava window has to agree on.
//!
//! The shell runs in more than one window: the main one, plus a real OS window for anything that
//! has been dragged out of it. Most of what a window knows is its own business — how wide its
//! panel is, which popover is open — but the layout cannot be, because two windows disagreeing
//! about it would be a visible bug. So the layout lives here, in the backend, and each window is a
//! projection of it: it subscribes to `shell:state` and renders whatever its entry says it holds.
//! Nothing is copied between windows, which means nothing can drift out of sync.
//!
//! A **window** holds zero or more **clusters** and shows one of them. A cluster is one thing being
//! worked on: a pane tree of app surfaces, the **project** every surface in it resolves against,
//! and — once Braden's git work lands — the worktree it operates on. Switching cluster tabs swaps
//! the whole layout beneath the switcher bar, and the project underneath it. An **instance** is one
//! live surface. See [`SurfaceInstance`], [`WindowPlacement::clusters`], [`Cluster::project`] and
//! [`TerminalSession`] for what each of those words is carrying.
//!
//! Where a surface lives has exactly one answer, and it is the tree — see [`Cluster::tree`] for
//! that rule and [`TerminalSession::cluster_id`] for the terminal half of it.

use crate::layout::{PaneNode, SplitDir};
use crate::presets;
use crate::sync::RwLockExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{RwLock, RwLockReadGuard};
use tauri::{AppHandle, Emitter};

/// The event every window listens on. One event carrying the whole state,
/// rather than a family of granular ones: the state is small, it changes only
/// on deliberate user action, and a single message means a window can never
/// apply half an update.
pub const SHELL_STATE_EVENT: &str = "shell:state";

/// What kind of thing an instance is an instance *of*.
///
/// The distinction the frontend cannot make any other way: an app's `invoke` is
/// answered in-process by `app_call`, a tool's would go to its core over the
/// broker, and a terminal has no frame at all. Everything else about the three
/// is deliberately identical — they are all tabs, they all drag the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceKind {
    App,
    Tool,
    Terminal,
}

/// One live surface.
///
/// `files-1` and `files-2` are two Files, side by side, with their own open files and their own
/// scroll positions. This is the distinction the whole module exists to draw: `files` is a *type*,
/// and it stopped being an identity the moment two of them could be on screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceInstance {
    /// `files-1`. Unique for the life of the process, and stable across a
    /// restart because it is written to disk with the tree that references it.
    pub id: String,
    /// `files`. Which app or tool this is an instance of — a type, never an
    /// identity. This is what `app_call` and `tool_frontend` are given.
    pub app_id: String,
    pub kind: SurfaceKind,
    pub title: String,
}

/// What `ShellState::open_instance` is being asked to put on screen.
///
/// A struct rather than five more positional arguments: three of them are
/// strings in a row, and the compiler cannot tell one from another. Not
/// serialized — the frontend sends the two fields it knows about and
/// `commands::open_instance` resolves the rest.
pub struct OpenRequest<'a> {
    /// `files`. Which app or tool, never an identity.
    pub app_id: &'a str,
    /// Resolved from the registry by the caller, never trusted from the
    /// frontend: it decides where an `invoke` from the resulting frame lands.
    pub kind: SurfaceKind,
    /// What the tab reads until the surface reports a title of its own.
    pub title: &'a str,
    /// Which pane the open is *relative to*; `None` falls back to the active
    /// cluster's first pane. It used to mean "and put it in that pane", which
    /// is no longer what an open does — see `dir`.
    pub pane_id: Option<&'a str>,
    /// The axis the frontend measured the target pane along. `Some` asks for a
    /// **pane of its own** beside it rather than a tab inside it;
    /// `PaneNode::open_into` owns that rule, the two cases that refuse it, and
    /// the ceiling. `None` is what the callers with no pane on screen to have
    /// measured pass: seeding a window, seeding a cluster, and filling a
    /// preset's gap — a preset builds its own tree and must not have this
    /// splitting underneath it.
    pub dir: Option<SplitDir>,
}

/// Where a cluster's work is happening on disk.
///
/// A cluster on one of these is working in a second checkout of its project's
/// repository rather than in the project folder itself, which is what lets two
/// clusters hold two branches open at once. `crate::project::cluster_path`
/// resolves the precedence: this wins over the project whenever it is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    pub path: String,
    pub branch: Option<String>,
    /// The branch this one was cut from, recorded when the worktree is created.
    ///
    /// Git does not remember this. A branch knows its commits and its upstream,
    /// but nothing in the repository records what it was forked off — so
    /// "everything this cluster has changed" would otherwise have to guess a
    /// base, and the obvious guess (whatever the main checkout is on right now)
    /// silently becomes wrong the moment somebody switches the main checkout to
    /// another branch. Recording it at creation is the only way the answer stays
    /// stable for the life of the worktree.
    ///
    /// `default` because a `layout.json` written before this field existed has
    /// no such key, and a layout that fails to load is a session lost. `None`
    /// there means the divergence view falls back to comparing against the main
    /// checkout's branch, which is what it would have had to do anyway.
    #[serde(default)]
    pub base: Option<String>,
}

/// One tab in the switcher bar: a layout, the project it is about, and its
/// worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cluster {
    pub id: String,
    pub name: String,
    /// The pane tree. Holds instance ids; see `layout`.
    ///
    /// This is the one answer to where a surface lives: an instance is in whichever cluster's tree
    /// contains its id, and nowhere else. A terminal is in its cluster's band *unless* its id
    /// appears in a tree — any cluster's tree, in any window — in which case it has been dragged
    /// into the layout and is drawn there as a surface instead. No second field records this, so
    /// no second field can contradict it, and a terminal can never draw in two places at once.
    pub tree: PaneNode,
    /// The folder this cluster's work is in, or `None` for a cluster that has not been pointed at
    /// one yet — a brand-new cluster, which draws Home's pick-a-project state rather than
    /// inheriting whatever the last one was looking at.
    ///
    /// The project is the cluster's and not the process's, which is the reason this field exists
    /// at all. Two windows on two monitors, each showing a cluster of its own, are meant to work
    /// on two different projects at once — and a single global "the open project" makes that
    /// unexpressible, not merely awkward: whichever window opened something last would have
    /// retitled and re-rooted the other one.
    ///
    /// A `String` and not a `PathBuf`, matching [`WorktreeRef::path`] and for the reason
    /// [`crate::project::ProjectInfo`] spells out: this crosses into JSON, a Windows path is not
    /// guaranteed to be UTF-8, and doing the conversion at one boundary beats doing it by accident
    /// at several.
    ///
    /// `default` because a `layout.json` written before a cluster owned a project has no such key,
    /// and a layout that failed to load is a session lost. It arrives as `None` and the migration
    /// in `lib.rs` seeds the first cluster from the old global.
    #[serde(default)]
    pub project: Option<String>,
    pub worktree: Option<WorktreeRef>,
    /// Which terminal this cluster's band is showing.
    ///
    /// A fact about the cluster, for the same reason the terminals themselves
    /// are: the band is drawn inside the cluster's half of the window, so which
    /// entry in it is selected changes when the cluster does. The *set* of
    /// terminals is derived from `ShellSnapshot::terminals` rather than
    /// duplicated here — see the module doc on why there is only ever one answer
    /// to where a thing lives — and the invariant that this names one of them,
    /// and never one that has been dragged into a tree, is re-established after
    /// every mutation by `reseat_active_terminals`.
    ///
    /// `default` because a `layout.json` written while this lived on the window
    /// has no such key here. That file's window-level value is dropped rather
    /// than migrated: it named some terminal of the window with nothing saying
    /// which cluster's band should have claimed it, and `reseat_active_terminals`
    /// picks a valid one per cluster on the first load anyway.
    #[serde(default)]
    pub active_terminal: Option<String>,
    /// How tall this cluster's terminal band was last left, in CSS pixels, or `None` for a cluster
    /// nobody has dragged the band in yet — which draws at the frontend's `BOTTOM_DEFAULT`.
    ///
    /// A fact about the cluster for the same reason [`Cluster::active_terminal`] is, and it has to
    /// be one: the band is drawn inside the cluster's half of the window, so a single height held
    /// by the window means the last cluster resized dictates the height of every other one. Pull
    /// the band up in `auth`, switch to `billing`, and `billing`'s band is `auth`'s height.
    ///
    /// Only the *normal* height is kept. Shut and maximized are the same drag's other two
    /// outcomes, and they stay in the window that draws them: whether a band is open is a fact
    /// about this session, and a layout that restored a maximized band would open OpenKaava with the
    /// apps hidden behind a terminal. See `frame/Frame.tsx`'s `bottomHeight` for the same split
    /// spelled from the view's side.
    ///
    /// `f32` and not `f64` because it is a CSS pixel count that came from a pointer position;
    /// `PaneNode`'s `sizes` cross the same boundary as `f32` for the same reason.
    ///
    /// `default` because a `layout.json` written before the band had a home here has no such key,
    /// and a layout that failed to load is a session lost.
    #[serde(default)]
    pub band_height: Option<f32>,
    /// The page this cluster is, or `None` for an ordinary cluster. See `crate::pages`.
    ///
    /// A page cluster has no project, and a tree of exactly one pane holding one
    /// instance of the page's app. Every mutator below that could change that
    /// refuses to for a page — close, rename, move to another window, split,
    /// drop a tab in, drag its tab out — so the invariant is the state's rather
    /// than the cluster bar's. There is at most one per page id per window,
    /// created by `open_page` the first time its chip is chosen.
    ///
    /// Omitted from the JSON when `None`, and `default` when absent, so a
    /// `layout.json` from before pages loads unchanged and one written now reads
    /// the same to an older build for every ordinary cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// Where this cluster's work actually happens: a local worktree, a cloud
    /// session, the read-only main checkout, or the standing design worktree.
    /// See [`crate::environments::Environment`].
    ///
    /// **The new field, and [`WorktreeRef::path`]'s successor rather than its
    /// replacement.** `worktree` stays on the struct for every reader that
    /// resolved a working root through it (`cluster_root`, `git.rs`'s
    /// `cluster_checkout`); `cluster_root` below prefers `environment` when
    /// it is `Some`, so a cluster carrying both is unambiguous rather than
    /// resolved by which of two fields happens to agree.
    ///
    /// `None` covers two different pasts, deliberately conflated: a
    /// `layout.json` old enough to have never heard of this field, and a
    /// cluster this build's own migration declined to guess at (see
    /// `migrate_environment`'s doc for why that is not read as `Main`). Both
    /// want the same treatment — defer to the legacy fields — so one `None`
    /// serves both rather than a third variant explaining the difference.
    ///
    /// `default`/`skip_serializing_if`, as on every optional field here, so a
    /// `layout.json` from before this key existed still loads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<crate::environments::Environment>,
    /// The pinned Design canvas cluster, and only it. Not closable — see
    /// `close_cluster_pure`, the one mutator this actually changes the
    /// behaviour of; renaming and moving are left alone, since nothing in
    /// `KAAVA-UX-REWORK.md` asks for either to be refused.
    ///
    /// `default` rather than derived from `environment`'s `Design` variant,
    /// even though in practice the two are only ever set together (see
    /// `ShellState::add_design_cluster`): a cluster's pin is a fact about its
    /// *position and closability* in the switcher, which is a UI concern this
    /// field owns outright, where deriving it from the environment kind would
    /// make every future caller of `is_page`-style guards re-read the
    /// environment enum just to answer "can this be closed".
    #[serde(default)]
    pub pinned: bool,
}

impl Cluster {
    pub fn is_page(&self) -> bool {
        self.page.is_some()
    }
}

/// A window's outer rectangle, in physical pixels.
///
/// Physical rather than logical because that is what `outer_position` and
/// `outer_size` report and what `available_monitors` measures against; mixing
/// in a scale factor is how a window restores half-size on a scaled display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// What a given window is holding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlacement {
    /// The Tauri window label. `main`, or `win-<n>`.
    ///
    /// Opaque, and deliberately so. It used to be `tool-<id>`, which made "one
    /// window per tool" true by construction — there was no second label a
    /// second Files could have had.
    pub label: String,
    /// "Zero or more" is deliberate, and it is a change. A window used to be guaranteed a cluster;
    /// closing the last one is now allowed, and the app area draws an empty state. Dragging the
    /// last one out to another window is allowed for the same reason: see `move_cluster_pure`,
    /// which used to refuse that.
    pub clusters: Vec<Cluster>,
    pub active_cluster_id: Option<String>,
    /// `None` until the window has reported where it is. Only ever written from
    /// the window's own move and resize events.
    pub geometry: Option<WindowGeometry>,
}

impl WindowPlacement {
    pub fn cluster_mut(&mut self, id: &str) -> Option<&mut Cluster> {
        self.clusters.iter_mut().find(|c| c.id == id)
    }

    /// The cluster this window is showing, if it is showing one.
    pub fn active_cluster_mut(&mut self) -> Option<&mut Cluster> {
        let id = self.active_cluster_id.clone()?;
        self.cluster_mut(&id)
    }
}

/// One shell session, moveable between the places that draw it.
///
/// Terminals were already built this way — `term-1`, `term-2` — with an id that names a
/// **cluster** where it used to name a window; see [`cluster_id`](Self::cluster_id) for what that
/// replaced. The window is derived rather than stored: it is whichever one holds that cluster, so
/// moving a cluster between windows cannot leave a terminal and its window disagreeing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub title: String,
    /// Which cluster's band holds it. Not which window, and that is a reversal.
    ///
    /// It named a **window** while the terminal panel was the window's furniture. The panel is
    /// gone: terminals live in a band drawn *inside* the cluster's half of the window, so the
    /// scope follows the drawing — a terminal belongs to the cluster whose band holds it, spawns
    /// in that cluster's project, and is killed with it. The cross-cluster shell the old rule
    /// protected is still expressible (put the cluster on its own monitor, or drag the terminal
    /// into a pane); it is just no longer what every terminal gets whether it wanted it or not.
    /// The full argument, including what the old arrangement was right about, is in
    /// `docs/design-notes/backend-core.md`.
    ///
    /// Defaulted rather than required, and the empty string is a real state rather than a
    /// placeholder: a `layout.json` written while terminals named a window has a `windowLabel` here
    /// and no cluster id at all, and nothing in it says which of the window's clusters should have
    /// claimed each shell. So it deserializes to "no cluster" and [`adopt_orphan_terminals`] gives
    /// it one at restore, where the whole snapshot is in hand and there is a cluster to point at.
    ///
    /// An id naming no live cluster is otherwise unreachable: every path that creates or moves a
    /// terminal names a cluster that exists, and `close_cluster` takes its terminals with it.
    #[serde(default)]
    pub cluster_id: String,
    /// The dot on a terminal tab: *this agent finished*. Not tool health.
    pub agent_finished: bool,
    /// Sessions sharing a group id render as one tab, laid out side by side in
    /// the deck. `None` for an ordinary, unsplit session.
    pub group_id: Option<String>,
}

/// What [`ShellState::project_live_counts`] answers. See that method's doc
/// for what "live" means here and what it deliberately does not cover yet.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLiveCounts {
    pub open: bool,
    pub cluster_count: usize,
    pub environment_count: usize,
}

/// The whole shared state, as one serializable object.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshot {
    pub windows: Vec<WindowPlacement>,
    /// Every live app and tool surface, flat. The trees hold ids; this is what
    /// they resolve against. Flat rather than nested in the trees so that a
    /// title change does not mean rewriting a tree, which is the same reason
    /// `TerminalSession` has never lived inside a window.
    pub instances: Vec<SurfaceInstance>,
    pub terminals: Vec<TerminalSession>,
}

/// Every monotonic id counter, under one lock.
///
/// Together rather than as loose atomics because minting an id and publishing
/// the thing it names must not be two separately-observable events — the old
/// `next_terminal` comment said exactly this, and it is true of panes and
/// clusters for the same reason.
#[derive(Default)]
struct Counters {
    /// Per app id, so ids read as `files-1`, `files-2`, `home-1` rather than
    /// sharing one global sequence that says nothing about what it names.
    instances: HashMap<String, u32>,
    terminals: u32,
    panes: u32,
    splits: u32,
    clusters: u32,
    windows: u32,
}

pub struct ShellState {
    inner: RwLock<ShellSnapshot>,
    counters: RwLock<Counters>,
    /// Labels of windows whose close has been asked for — as opposed to a
    /// window the OS destroys directly, with no request first.
    ///
    /// This exists because `WindowEvent::Destroyed` alone cannot tell the two
    /// apart, and the difference decides whether `reclaim` should run. A
    /// shutdown that destroys every window that way fires `Destroyed` for
    /// *every* one of them — so a `reclaim` that trusted `Destroyed` alone
    /// would fold every detached window into `main` on the way out, and,
    /// because every mutation is persisted, would write that collapsed layout
    /// to disk as the thing to restore. You would close OpenKaava with three
    /// windows and open it with one, every time, and the tree serialization
    /// would look broken when it was working perfectly.
    ///
    /// So intent is stated rather than inferred: `windows::request_close`
    /// marks the label here the moment `WindowEvent::CloseRequested` fires —
    /// which happens for a close requested by our own titlebar's ×, by
    /// Alt+F4, by the taskbar, or by a graceful OS shutdown closing windows
    /// one at a time, but never for a window destroyed with no close request
    /// at all. Anything that did not announce itself that way reclaims
    /// nothing and writes nothing.
    closing: RwLock<Vec<String>>,
}

impl Default for ShellState {
    fn default() -> Self {
        let mut counters = Counters::default();
        let seed = seed_window(&mut counters, "main");

        Self {
            inner: RwLock::new(ShellSnapshot {
                windows: vec![seed],
                instances: Vec::new(),
                // No terminals until one has a shell behind it. A tab here with
                // no process behind it is a tab that swallows keystrokes;
                // `lib.rs` opens the launch terminal properly, at setup,
                // through the same path everything else uses.
                terminals: Vec::new(),
            }),
            counters: RwLock::new(counters),
            closing: RwLock::new(Vec::new()),
        }
    }
}

/// A window with one empty cluster, ready to be filled.
///
/// A window always has at least one cluster, and a cluster always has at least
/// one pane, so that "where does this go?" always has an answer without any
/// caller having to create scaffolding first.
fn seed_window(counters: &mut Counters, label: &str) -> WindowPlacement {
    counters.clusters += 1;
    counters.panes += 1;
    let cluster_id = format!("cluster-{}", counters.clusters);
    let cluster = Cluster {
        id: cluster_id.clone(),
        // "Cluster 1" rather than "Workspace", because `WindowRoot` names every
        // cluster after this one `Cluster ${n + 1}`. Called anything else, the
        // switcher bar reads "Workspace, Cluster 2, Cluster 3" and a first
        // cluster that is not Cluster 1 is the one a person goes looking for.
        //
        // Renamed to the project's name once one is open — `lib.rs` does that
        // after `project::restore`, since only then is there a name to use.
        name: "Cluster 1".to_string(),
        tree: PaneNode::leaf(format!("pane-{}", counters.panes)),
        // No project. A seeded window is one nobody has pointed anywhere yet,
        // and Home is what points it — see `set_cluster_project`.
        project: None,
        worktree: None,
        active_terminal: None,
        band_height: None,
        page: None,
        environment: None,
        pinned: false,
    };

    WindowPlacement {
        label: label.to_string(),
        clusters: vec![cluster],
        active_cluster_id: Some(cluster_id),
        geometry: None,
    }
}

impl ShellState {
    /// The state, read-locked — the one door every reader in the type goes
    /// through. Panicking on a poisoned lock is `sync`'s decision, made there
    /// once for the whole binary.
    fn read(&self) -> RwLockReadGuard<'_, ShellSnapshot> {
        self.inner.read_or_panic()
    }

    pub fn snapshot(&self) -> ShellSnapshot {
        self.read().clone()
    }

    /// Replace the whole state — the one door restoring a saved session uses.
    ///
    /// Takes the counters too, because ids restored from disk must not be
    /// mintable again: a fresh `files-1` handed out beside a restored `files-1`
    /// would put two surfaces behind one id, and every message for either would
    /// reach whichever the lookup found first.
    pub fn restore(&self, snapshot: ShellSnapshot) {
        {
            let mut counters = self.counters.write_or_panic();
            *counters = counters_for(&snapshot);
        }
        let mut snapshot = snapshot;
        // First, so a terminal in a dropped page's band is re-homed below
        // rather than left naming a cluster that has gone.
        drop_unavailable_pages(&mut snapshot, &|id| crate::pages::find(id).is_some());
        // Before anything reads `environment` below: a cluster whose only
        // record of where it works is the legacy `worktree` field needs that
        // filled in before `cluster_root`/`cluster_environment` are asked
        // about it.
        migrate_environments(&mut snapshot);
        // Order matters: a terminal has to be given a cluster before anything
        // asks which cluster's band it is in.
        adopt_orphan_terminals(&mut snapshot);
        // A file written by an older build has the band's selection on the
        // window, so every cluster comes back with none. `mutate` fixes this up
        // after every change; a restore is the one way state arrives without
        // going through it.
        reseat_active_terminals(&mut snapshot);
        *self.inner.write_or_panic() = snapshot;
    }

    /// Run a mutation, tell every window, and write it down.
    ///
    /// Every public mutator goes through this, which is what guarantees no
    /// change can land without a broadcast — the bug where one window updates
    /// and the others don't is not expressible.
    ///
    /// The write lock is dropped before the emit: `emit` reaches into Tauri's
    /// event machinery, and holding a lock across a call that might itself want
    /// to read this state is how a deadlock gets written.
    ///
    /// Every mutation is followed by `reseat_active_terminals`, so that "a
    /// window's panel selection names one of that window's panel terminals" is
    /// a property of the state rather than something each mutator has to
    /// remember. Closing a terminal, closing the cluster a terminal was dragged
    /// into, moving one between windows and dragging one into a pane all
    /// invalidate it, and only one of them is obviously about the panel.
    fn mutate<F: FnOnce(&mut ShellSnapshot)>(&self, app: &AppHandle, f: F) {
        let updated = {
            let mut guard = self.inner.write_or_panic();
            f(&mut guard);
            reseat_active_terminals(&mut guard);
            guard.clone()
        };
        let _ = app.emit(SHELL_STATE_EVENT, &updated);
        // Every page switch, cluster switch and window close is a mutation
        // through here, so this is the one place that can tell whether the
        // projects page just stopped (or started) being what `main` shows —
        // see `plane_webview::sync_visibility`'s own doc for the other call
        // site, the one this can't reach: a resize with nothing else changed.
        crate::plane_webview::sync_visibility(app, &updated);
        crate::shell_store::persist(app, &updated);
    }

    // --- windows -----------------------------------------------------------

    pub fn claim_window_label(&self) -> String {
        let mut counters = self.counters.write_or_panic();
        counters.windows += 1;
        format!("win-{}", counters.windows)
    }

    /// Announce that a window is about to be closed on purpose. See `closing`.
    pub fn mark_closing(&self, label: &str) {
        let mut closing = self.closing.write_or_panic();
        if !closing.iter().any(|l| l == label) {
            closing.push(label.to_string());
        }
    }

    fn take_closing(&self, label: &str) -> bool {
        let mut closing = self.closing.write_or_panic();
        let Some(i) = closing.iter().position(|l| l == label) else {
            return false;
        };
        closing.remove(i);
        true
    }

    /// Register a new, empty window — File > New Window's half of the work.
    ///
    /// Seeded with a cluster, unlike the window `detach_instance` builds, which
    /// is handed one holding the surface that was dragged out. A window with no
    /// clusters is a legal state now — closing the last one gets you there —
    /// but it is not a sensible thing to *open*: File > New Window that landed
    /// on the empty state would have asked the user to undo a step of its own
    /// making.
    pub fn add_window(&self, app: &AppHandle, label: &str) {
        let seed = {
            let mut counters = self.counters.write_or_panic();
            seed_window(&mut counters, label)
        };
        self.mutate(app, |s| {
            if s.windows.iter().any(|w| w.label == label) {
                return;
            }
            s.windows.push(seed.clone());
        });
    }

    pub fn set_geometry(&self, label: &str, geometry: WindowGeometry) {
        // Not through `mutate`: a move or resize fires continuously while the
        // user drags, and broadcasting the whole state to every window on every
        // frame of that would be a storm no window needs to see. The value is
        // only ever read back at launch, so recording it and skipping both the
        // broadcast and the disk write is exactly right — the next real
        // mutation persists it, and so does a window closing (`flush` for
        // `main`, `reclaim_window`'s own `mutate` for anything else — see
        // `windows::request_close`).
        let mut guard = self.inner.write_or_panic();
        if let Some(w) = guard.windows.iter_mut().find(|w| w.label == label) {
            w.geometry = Some(geometry);
        }
    }

    /// Write the current state to disk without changing it.
    ///
    /// The counterpart to `set_geometry`'s deliberate silence: something has to
    /// commit those quiet updates eventually, and a window closing on purpose
    /// is the last chance to.
    pub fn flush(&self, app: &AppHandle) {
        crate::shell_store::persist(app, &self.snapshot());
    }

    /// Fold a closing window's clusters into the main window, so nothing is
    /// stranded in a window that is no longer on screen.
    ///
    /// Returns `false` — and changes nothing — when the close was not marked
    /// through `mark_closing`, which means the window is not actually closing
    /// on purpose. See the `closing` field.
    ///
    /// `windows::request_close` calls this itself, synchronously, from
    /// `WindowEvent::CloseRequested` — before the window is actually gone, so
    /// a closed window can never be resurrected by a later flush of state
    /// that still lists it. `windows::reclaim` calls it again from
    /// `WindowEvent::Destroyed`, once the window actually finishes closing,
    /// but by then `take_closing` has already consumed the marker, so that
    /// second call is normally a no-op; it remains as the fallback for a
    /// window the OS destroys directly, without a `CloseRequested` first.
    pub fn reclaim_window(&self, app: &AppHandle, label: &str) -> bool {
        if label == "main" || !self.take_closing(label) {
            return false;
        }
        self.mutate(app, |s| reclaim_window_pure(s, label));
        true
    }

    // --- clusters ----------------------------------------------------------

    pub fn add_cluster(&self, app: &AppHandle, label: &str, name: &str) -> Option<String> {
        let (cluster_id, pane_id) = {
            let mut counters = self.counters.write_or_panic();
            counters.clusters += 1;
            counters.panes += 1;
            (
                format!("cluster-{}", counters.clusters),
                format!("pane-{}", counters.panes),
            )
        };

        let mut created = None;
        self.mutate(app, |s| {
            let Some(w) = s.windows.iter_mut().find(|w| w.label == label) else {
                return;
            };
            w.clusters.push(Cluster {
                id: cluster_id.clone(),
                name: name.to_string(),
                tree: PaneNode::leaf(pane_id.clone()),
                // Deliberately empty, and deliberately *not* inherited from the
                // cluster this one was added beside. A new cluster is a new
                // piece of work; if it were meant to be about the same project
                // it would have been a pane in the one already open. Home opens
                // in it (see `commands::add_cluster`) and offers the picker.
                project: None,
                worktree: None,
                active_terminal: None,
                band_height: None,
                page: None,
                environment: None,
                pinned: false,
            });
            w.active_cluster_id = Some(cluster_id.clone());
            created = Some(cluster_id.clone());
        });
        created
    }

    /// Create the pinned Design canvas cluster and put it first in the
    /// switcher.
    ///
    /// Called from `project::open`, and only when the project already has a
    /// `wt/design` worktree — see `environments::detect_design_environment`,
    /// the caller's own check for whether to call this at all. A project
    /// that lacks one is *offered* the canvas rather than having it created
    /// silently; see `KAAVA-UX-REWORK.md` §5 for that half.
    ///
    /// Idempotent per window: a window that already holds a pinned cluster is
    /// left alone, since `project::open` runs on every open and nothing
    /// upstream of this remembers whether a previous open already made one.
    ///
    /// Inserted at index `0` rather than appended, so it reads first in the
    /// switcher regardless of how many ordinary clusters came before it —
    /// and deliberately does not touch `active_cluster_id`: the canvas
    /// becomes available the moment it exists, not thrust in front of
    /// whatever the user was already looking at.
    pub fn add_design_cluster(
        &self,
        app: &AppHandle,
        label: &str,
        project: &str,
        environment: crate::environments::Environment,
    ) -> Option<String> {
        let (cluster_id, pane_id) = {
            let mut counters = self.counters.write_or_panic();
            counters.clusters += 1;
            counters.panes += 1;
            (
                format!("cluster-{}", counters.clusters),
                format!("pane-{}", counters.panes),
            )
        };

        let mut created = None;
        // `environment` moves into the closure whole — `mutate`'s `f` is
        // `FnOnce`, called exactly once from inside `mutate` itself, so there
        // is no second call for an `Option::take` guard to protect against.
        self.mutate(app, |s| {
            created =
                add_design_cluster_pure(s, label, &cluster_id, &pane_id, project, environment);
        });
        created
    }

    /// `add_cluster`'s counterpart for the one gesture that *should* inherit
    /// the project: dropping a tab on the switcher's empty space
    /// (KAAVA-UX-REWORK.md §5), which is "give this tab a cluster of its own,
    /// here" rather than "start something new" — the dragged tab is already
    /// mid-flight over the project it belongs to, so a picker would ask a
    /// question the drop already answered.
    ///
    /// `source_cluster` is searched for across every window, not just
    /// `label`'s, since a multi-monitor drag can cross windows. Home is not
    /// opened here, unlike `add_cluster` — the caller
    /// (`commands::new_cluster_for_drop`) fills the one pane with the dragged
    /// tab in the same breath. Returns the pane id too, unlike `add_cluster`,
    /// since the caller has no other surface to find it by.
    pub fn add_cluster_for_environment(
        &self,
        app: &AppHandle,
        label: &str,
        name: &str,
        source_cluster: &str,
    ) -> Option<(String, String)> {
        let (cluster_id, pane_id) = {
            let mut counters = self.counters.write_or_panic();
            counters.clusters += 1;
            counters.panes += 1;
            (
                format!("cluster-{}", counters.clusters),
                format!("pane-{}", counters.panes),
            )
        };

        let mut created = None;
        self.mutate(app, |s| {
            created = add_cluster_for_environment_pure(
                s,
                label,
                name,
                source_cluster,
                &cluster_id,
                &pane_id,
            );
        });
        created
    }

    pub fn set_active_cluster(&self, app: &AppHandle, label: &str, cluster_id: Option<String>) {
        self.mutate(app, |s| {
            let Some(w) = s.windows.iter_mut().find(|w| w.label == label) else {
                return;
            };
            // A cluster this window does not hold is not something it can show.
            // The guard is not hypothetical: a chip's drag ends with a
            // `pointerup` on the chip, so the browser fires a `click` on it too,
            // and that click asks to select a cluster that has just been dragged
            // into another window. Honouring it would leave the source window
            // pointing at a cluster that is not in it — no tree, no panel, an
            // empty frame — and nothing would ever correct it.
            if cluster_id
                .as_deref()
                .is_some_and(|id| !w.clusters.iter().any(|c| c.id == id))
            {
                return;
            }
            w.active_cluster_id = cluster_id;
        });
    }

    /// Point a cluster at a project, or at nothing.
    ///
    /// Through `mutate` like every other cluster change, which is what makes a
    /// project switch reach every window and reach `layout.json` — the same
    /// guarantee the tree gets, and the reason this is a `ShellState` method
    /// rather than something `project` writes into a store of its own. A
    /// project that only the window that opened it knew about would be the
    /// exact bug the per-cluster model exists to prevent, in miniature.
    ///
    /// Silent when `cluster_id` names nothing: a cluster can be closed while a
    /// picker is up, and the honest answer to "set the project of a cluster
    /// that is gone" is that there is nothing to set.
    pub fn set_cluster_project(&self, app: &AppHandle, cluster_id: &str, path: Option<String>) {
        self.mutate(app, |s| {
            for w in s.windows.iter_mut() {
                // A page is about the cloud, never a folder: silent, as for a gone id.
                if let Some(c) = w.cluster_mut(cluster_id).filter(|c| !c.is_page()) {
                    c.project = path;
                    return;
                }
            }
        });
    }

    /// The project a cluster is pointed at, exactly as stored. `None` both for
    /// a cluster with no project and for an id that names no cluster — the
    /// caller wants somewhere to work, and neither answer gives it one.
    pub fn cluster_project(&self, cluster_id: &str) -> Option<String> {
        let guard = self.read();
        guard
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .find(|c| c.id == cluster_id)
            .and_then(|c| c.project.clone())
    }

    /// Point a cluster at a worktree, or at nothing.
    ///
    /// Mirrors [`Self::set_cluster_project`] exactly, down to going through
    /// `mutate` and staying silent when `cluster_id` names nothing — the same
    /// picker-closed race applies here, and a worktree only one window knew
    /// about would be the identical bug in miniature.
    pub fn set_cluster_worktree(
        &self,
        app: &AppHandle,
        cluster_id: &str,
        worktree: Option<WorktreeRef>,
    ) {
        self.mutate(app, |s| {
            for w in s.windows.iter_mut() {
                if let Some(c) = w.cluster_mut(cluster_id) {
                    c.worktree = worktree;
                    return;
                }
            }
        });
    }

    /// Point a cluster at an environment, or at nothing. Mirrors
    /// [`Self::set_cluster_worktree`] exactly — see that method's doc, which
    /// applies here unchanged. The New Cluster dialog's finishing step is
    /// this method's one caller today (`commands::create_cluster_with_environment`).
    pub fn set_cluster_environment(
        &self,
        app: &AppHandle,
        cluster_id: &str,
        environment: Option<crate::environments::Environment>,
    ) {
        self.mutate(app, |s| {
            for w in s.windows.iter_mut() {
                if let Some(c) = w.cluster_mut(cluster_id) {
                    c.environment = environment;
                    return;
                }
            }
        });
    }

    /// The worktree a cluster is pointed at, exactly as stored. `None` both
    /// for a cluster with no worktree and for an id that names no cluster —
    /// see [`Self::cluster_project`], which this matches case for case.
    pub fn cluster_worktree(&self, cluster_id: &str) -> Option<WorktreeRef> {
        let guard = self.read();
        guard
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .find(|c| c.id == cluster_id)
            .and_then(|c| c.worktree.clone())
    }

    /// Which window holds a cluster — what `add_design_cluster`'s caller
    /// needs and does not otherwise have: `project::open` is handed a
    /// `cluster_id`, and every window-scoped mutator on this type (this one
    /// included) needs a `label`, not an id, to find its target.
    pub fn window_label_of_cluster(&self, cluster_id: &str) -> Option<String> {
        let guard = self.read();
        guard
            .windows
            .iter()
            .find(|w| w.clusters.iter().any(|c| c.id == cluster_id))
            .map(|w| w.label.clone())
    }

    /// How much of a project is live right now, across every window in this
    /// process. Used for the Switch Project dialog's per-row summary
    /// ("3 environments · 4 panes"-style, board 08) — computed from this
    /// state rather than read back from disk, so it is exactly right for a
    /// project open somewhere this session and exactly zero for one that
    /// isn't, rather than a stale or invented number. A project nobody has
    /// opened *this session* reads as closed even if it was open last
    /// launch; only per-project workspace persistence (KAAVA-UX-REWORK.md §6,
    /// not built yet) could answer that honestly, and until it exists the
    /// dialog says so rather than guessing.
    pub fn project_live_counts(&self, path: &str) -> ProjectLiveCounts {
        project_live_counts_pure(&self.read(), path)
    }

    /// The environment a cluster is pointed at, exactly as stored. `None`
    /// both for a cluster with no environment set and for an id that names no
    /// cluster — see [`Self::cluster_project`], which this matches case for
    /// case.
    pub fn cluster_environment(
        &self,
        cluster_id: &str,
    ) -> Option<crate::environments::Environment> {
        let guard = self.read();
        guard
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .find(|c| c.id == cluster_id)
            .and_then(|c| c.environment.clone())
    }

    /// Where a cluster's work actually happens, as opposed to what it is
    /// *about*.
    ///
    /// `environment` wins whenever it is `Some` — see `Cluster::environment`'s
    /// doc for why it takes precedence over the legacy `worktree` it is
    /// replacing. A cluster on `Cloud` then honestly answers `None`: there is
    /// no local checkout to name, and falling back to the project's path
    /// would have a terminal or a file tree open against a folder the cloud
    /// session never touches. Only a cluster with **no** `environment` falls
    /// through to the pre-migration rule: the worktree wins whenever one is
    /// set (the project path would otherwise be the wrong checkout), and the
    /// project is the fallback for a cluster that has neither.
    ///
    /// Deliberately does not check whether the resolved path still exists on
    /// disk — this module does no disk I/O, by design; see [`crate::project`]
    /// for the layer that filters on `is_dir()`.
    pub fn cluster_root(&self, cluster_id: &str) -> Option<String> {
        let guard = self.read();
        let cluster = guard
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .find(|c| c.id == cluster_id)?;

        if let Some(env) = &cluster.environment {
            return env
                .root(cluster.project.as_deref().map(Path::new))
                .map(|p| p.to_string_lossy().to_string());
        }

        cluster
            .worktree
            .as_ref()
            .map(|wt| wt.path.clone())
            .or_else(|| cluster.project.clone())
    }

    /// Which cluster holds `instance_id` — the whole of "which project is this
    /// app call about".
    ///
    /// The tree is the only thing that answers it, and deliberately: an
    /// instance is in whichever cluster's `tree` contains its id and nowhere
    /// else, so this is a search of the same structure `move_instance` moves
    /// tabs around in, using the same `PaneNode::tabs` walk `close_cluster`
    /// already uses to decide what a closing cluster took with it. No second
    /// field records the answer, so no second field can disagree with it.
    pub fn cluster_of_instance(&self, instance_id: &str) -> Option<String> {
        let guard = self.read();
        cluster_of_instance_pure(&guard, instance_id)
    }

    // `active_cluster_project` and `active_cluster_root` were here: the project
    // and the working root of whatever cluster a *window* was showing, asked in
    // that shape because a terminal belonged to the window's panel and so had no
    // cluster of its own to ask. `project::window_path` was the only caller of
    // the second and nothing called the first. Terminals name a cluster now, so
    // both questions have their answer in `cluster_project` and `cluster_root`
    // above, asked of the thing that actually holds the terminal.

    /// Every window, with the project of whatever cluster it is showing. What
    /// `project::retitle` walks — one read of the lock rather than one per
    /// window, and no `ShellSnapshot` clone for a pair of strings.
    pub fn window_projects(&self) -> Vec<(String, Option<String>)> {
        let guard = self.read();
        guard
            .windows
            .iter()
            .map(|w| {
                let project = w
                    .active_cluster_id
                    .as_deref()
                    .and_then(|id| w.clusters.iter().find(|c| c.id == id))
                    .and_then(|c| c.project.clone());
                (w.label.clone(), project)
            })
            .collect()
    }

    /// The first cluster of the main window, for the one-time migration in
    /// `lib.rs` that moves the old global open project onto a cluster.
    pub fn first_cluster_id(&self) -> Option<String> {
        let guard = self.read();
        guard
            .windows
            .iter()
            .find(|w| w.label == "main")
            .or_else(|| guard.windows.first())
            .and_then(|w| w.clusters.iter().find(|c| !c.is_page()))
            .map(|c| c.id.clone())
    }

    /// Whether any cluster anywhere is pointed at a project. The migration's
    /// guard — see `lib.rs`.
    pub fn any_cluster_has_a_project(&self) -> bool {
        let guard = self.read();
        guard
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .any(|c| c.project.is_some())
    }

    /// Rename a cluster. A page keeps the name its chip draws; see `rename_cluster_pure`.
    pub fn rename_cluster(&self, app: &AppHandle, cluster_id: &str, name: &str) {
        self.mutate(app, |s| {
            rename_cluster_pure(s, cluster_id, name);
        });
    }

    /// Close a cluster and everything in it. Returns the instance and terminal ids that went with
    /// it, so the caller can dispose of what sat behind them — a pty in particular, which this
    /// module deliberately knows nothing about and must not be left running with nothing on screen.
    ///
    /// "In it" means two things now, and it used to mean only the first: every tab in its tree,
    /// **and** every terminal in its band. The band's terminals used to be exempt because they
    /// were the window's and outlived every cluster in it; they name this cluster now, so exempting
    /// them would leave shells running with nothing anywhere that draws them. Both are on screen
    /// inside the thing being closed, which is the whole test.
    ///
    /// **The last cluster in a window may be closed.** There is no guard here and its absence is
    /// deliberate: a window that answered "no, it is the only one" would be refusing the one thing
    /// the × means. What it is left with is an empty app area — `NoClustersState` says so and names
    /// the way out.
    ///
    /// `move_cluster_pure` reaches the same window state by the other route, and deliberately: it
    /// used to refuse to move the last cluster out, on the grounds that emptying the source was a
    /// side effect nobody asked for, and that refusal is gone. The two now agree, which is one
    /// fewer rule to hold and one fewer gesture the interface has to hide. A page is never closed.
    pub fn close_cluster(&self, app: &AppHandle, cluster_id: &str) -> (Vec<String>, Vec<String>) {
        let mut closed = (Vec::new(), Vec::new());
        self.mutate(app, |s| closed = close_cluster_pure(s, cluster_id));
        closed
    }

    /// Move a whole cluster — its tree, its tabs and all — into another window.
    ///
    /// The window named by `to_label` is used if the state already knows it, and
    /// created if it does not; that second case is a *detach*, and the caller is
    /// then responsible for building the OS window to match. Doing the
    /// bookkeeping first and the window second is the ordering `detach_instance`
    /// already uses, and it is what makes a refusal here cost nothing: no window
    /// is ever built for a move that did not happen.
    ///
    /// Returns whether the cluster is in `to_label` afterwards. `false` means
    /// the move was refused and nothing changed at all — see `move_cluster_pure`
    /// for the two things it refuses and why.
    pub fn move_cluster(&self, app: &AppHandle, cluster_id: &str, to_label: &str) -> bool {
        let mut moved = false;
        self.mutate(app, |s| {
            moved = move_cluster_pure(s, cluster_id, to_label);
        });
        moved
    }

    /// Where a surface opened "here" goes: the active cluster, and a pane in it.
    ///
    /// `pane_id` is the caller's preference and is honoured only if that pane is
    /// actually in this cluster — a stale id from a layout that has since
    /// changed falls back to the first pane rather than to nowhere, which is the
    /// same forgiveness `open_instance` shows a `None`.
    ///
    /// `None` means the window has no cluster at all, which is the one case with
    /// no sensible answer: there is no tree, so there is no pane.
    ///
    /// Exists because a terminal opened into the layout needs both halves of the
    /// address before it has a session to move — `move_instance` names a cluster
    /// *and* a pane, and `commands::open_terminal_in_pane` has only a window
    /// label to start from.
    pub fn active_pane(&self, label: &str, pane_id: Option<&str>) -> Option<(String, String)> {
        let guard = self.read();
        let w = guard.windows.iter().find(|w| w.label == label)?;
        // A page's one pane is its app's, so a page in front is no pane at all.
        let cluster = work_cluster(w)?;

        let pane = pane_id
            .filter(|id| cluster.tree.pane_of_id(id))
            .unwrap_or_else(|| cluster.tree.first_pane_id())
            .to_string();

        Some((cluster.id.clone(), pane))
    }

    // --- presets -----------------------------------------------------------
    //
    // Two halves of one feature, and both of them are deliberately thin: the
    // model, the merge and the placement rule are all in `crate::presets`, as
    // pure functions over plain data that are tested as such. What is here is
    // the part that cannot be — reading the active cluster under the lock, and
    // minting ids from `Counters`. `layout` and this module already split that
    // way; see `layout`'s header.

    /// The active cluster's arrangement, in the form a preset stores it.
    ///
    /// `None` when the window has no cluster: there is no arrangement to save,
    /// which is a different answer from "an empty one".
    ///
    /// The tab-to-slot resolution happens here rather than in `presets` because
    /// this is where it can be answered. A tab is an id and nothing else; what
    /// it *is* lives in the flat `instances` and `terminals` lists, which
    /// `presets` has deliberately never heard of.
    pub fn capture_preset(&self, label: &str) -> Option<presets::PresetNode> {
        let guard = self.read();
        let w = guard.windows.iter().find(|w| w.label == label)?;
        let cluster = work_cluster(w)?;

        Some(presets::capture(&cluster.tree, &|id: &str| {
            slot_of_tab(&guard, id)
        }))
    }

    /// Rearrange the active cluster into `root`, and say what is still missing.
    ///
    /// Returns the cluster it acted on and the slots it had nothing to fill, or
    /// `None` when the window has no cluster to act on. **Nothing is closed** —
    /// see `presets::plan`, which is where that rule is written down and tested.
    ///
    /// The gaps come back rather than being filled here, and that is not an
    /// oversight: filling one means minting an instance *or spawning a pty*, and
    /// a pty lives in `PtySessions`, which this module knows nothing about and
    /// must not start knowing about — a `ShellState` that could spawn processes
    /// is a `ShellState` that cannot be tested against a bare snapshot.
    /// `commands::apply_preset` fills them through the same public doors
    /// everything else opens surfaces through.
    pub fn apply_preset(
        &self,
        app: &AppHandle,
        label: &str,
        root: &presets::PresetNode,
    ) -> Option<(String, Vec<presets::Gap>)> {
        let mut ids = mint_preset_ids(&self.counters, root);

        let mut applied = None;
        self.mutate(app, |s| {
            // Destructured so the tree can be read against the two flat lists
            // without one borrow of `s` shutting out the other — the same split
            // `reseat_active_terminals` takes, for the same reason.
            let ShellSnapshot {
                windows,
                instances,
                terminals,
                ..
            } = s;

            let Some(w) = windows.iter_mut().find(|w| w.label == label) else {
                return;
            };
            let Some(cluster) = w.active_cluster_mut().filter(|c| !c.is_page()) else {
                return;
            };

            let gaps = rearrange(cluster, instances, terminals, root, &mut ids);
            applied = Some((cluster.id.clone(), gaps));
        });
        applied
    }

    /// The same rearrangement as [`apply_preset`](Self::apply_preset), aimed at
    /// one cluster by id rather than at "whichever is active in this window".
    ///
    /// `commands::apply_project_open_preset` needs this rather than the
    /// label-based version: the cluster a project just opened into is not
    /// necessarily its window's *active* one by the time the async folder pick
    /// that opened it has resolved, and rearranging whatever the user happens
    /// to be looking at instead would be a layout change nobody asked for.
    ///
    /// Hands back the cluster's window `label` along with the gaps, mirroring
    /// `apply_preset`'s `(cluster_id, gaps)` from the other direction — the
    /// caller has a `cluster_id` and needs a `label` for the same reason
    /// `apply_preset`'s caller has a `label` and needs a `cluster_id`: every
    /// gap-filling call still takes one. Answered from the same lookup that
    /// finds the cluster rather than a second locked read afterward.
    ///
    /// `None` for a `cluster_id` that names nothing — closed, or never existed
    /// — same as `apply_preset` returning `None` for a label naming no window.
    pub fn apply_preset_to_cluster(
        &self,
        app: &AppHandle,
        cluster_id: &str,
        root: &presets::PresetNode,
    ) -> Option<(String, Vec<presets::Gap>)> {
        let mut ids = mint_preset_ids(&self.counters, root);

        let mut applied = None;
        self.mutate(app, |s| {
            let ShellSnapshot {
                windows,
                instances,
                terminals,
                ..
            } = s;

            for w in windows.iter_mut() {
                let Some(cluster) = w
                    .clusters
                    .iter_mut()
                    .find(|c| c.id == cluster_id && !c.is_page())
                else {
                    continue;
                };
                let gaps = rearrange(cluster, instances, terminals, root, &mut ids);
                applied = Some((w.label.clone(), gaps));
                return;
            }
        });
        applied
    }

    // --- instances ---------------------------------------------------------

    /// Mint an instance and put it on screen. See `OpenRequest` for what each
    /// field of the request decides.
    ///
    /// Unless `app_id` is `"home"` itself, this closes Home if it is holding
    /// `target` — see `dismiss_takeover`. Doing that first, rather than after
    /// `open_into` has run, is what makes a pane holding only Home read as
    /// empty to `open_into`'s own split decision: the surface takes the pane
    /// outright instead of gaining Home as a permanent neighbour in a sibling.
    pub fn open_instance(
        &self,
        app: &AppHandle,
        label: &str,
        request: OpenRequest<'_>,
    ) -> Option<String> {
        let OpenRequest {
            app_id,
            kind,
            title,
            pane_id,
            dir,
        } = request;
        // Both taken before `mutate` takes the state lock, which is the order
        // every other minting site here uses and is not merely convention:
        // `counters` is a second lock, and taking it *inside* the closure would
        // invert the order these two are acquired in everywhere else — the
        // classic way to write a deadlock that only shows up under two windows
        // opening at once.
        let instance_id = {
            let mut counters = self.counters.write_or_panic();
            let ordinal = counters.instances.entry(app_id.to_string()).or_insert(0);
            *ordinal += 1;
            format!("{app_id}-{ordinal}")
        };
        // Only when a split is actually being asked for. `open_into` may still
        // decline it — an empty pane, or the ceiling — and the pair is then
        // simply unused, which costs a gap in the numbering and nothing else.
        // Minting unconditionally would burn two ids on every Home seed.
        let split_ids = dir.map(|_| {
            let mut counters = self.counters.write_or_panic();
            counters.splits += 1;
            counters.panes += 1;
            (
                format!("split-{}", counters.splits),
                format!("pane-{}", counters.panes),
            )
        });

        let mut opened = None;
        self.mutate(app, |s| {
            // Destructured so `dismiss_takeover` can borrow the tree and
            // `instances` at once — see `apply_preset` below, which takes the
            // same split for the same reason.
            let ShellSnapshot {
                windows, instances, ..
            } = s;

            let Some(w) = windows.iter_mut().find(|w| w.label == label) else {
                return;
            };

            // The cluster that **owns the pane the caller named**, and only
            // failing that the window's active one.
            //
            // It used to be the active cluster unconditionally, which was fine
            // for as long as every caller's pane came from the screen in front
            // of them. `fill_preset_gaps` does not: it names panes belonging to
            // the cluster a project just opened into, and `apply_preset_to_cluster`
            // says in its own doc why that is not necessarily the active one by
            // the time the folder pick has resolved. Reaching for the active
            // cluster there addressed a tree that has no such pane — which was
            // survivable while an unknown pane refused the open outright, and is
            // not now that `place_surface` falls back to a first pane. Forgiving
            // a stale id *within* a cluster is right; dropping a surface into a
            // cluster the caller was not talking about is not.
            let Some(cluster) = open_target(w, pane_id) else {
                return;
            };

            let split = match (dir, &split_ids) {
                (Some(dir), Some((split_id, new_pane_id))) => {
                    Some((dir, split_id.as_str(), new_pane_id.as_str()))
                }
                _ => None,
            };

            // A takeover surface does not get to evict another one — it covers
            // it, and uncovering puts the one underneath back. Every other open
            // evicts; `place_surface` owns the rest of the sequence.
            if !place_surface(
                &mut cluster.tree,
                instances,
                &instance_id,
                pane_id,
                None,
                split,
                !is_takeover_app(app_id),
            ) {
                return;
            }

            instances.push(SurfaceInstance {
                id: instance_id.clone(),
                app_id: app_id.to_string(),
                kind,
                title: title.to_string(),
            });
            opened = Some(instance_id.clone());
        });
        opened
    }

    /// Take an instance off screen. Returns true if it was there — and false for
    /// a page's own instance, which is never closed; see `close_instance_pure`.
    pub fn close_instance(&self, app: &AppHandle, instance_id: &str) -> bool {
        let mut found = false;
        self.mutate(app, |s| found = close_instance_pure(s, instance_id));
        found
    }

    pub fn activate_instance(&self, app: &AppHandle, instance_id: &str) {
        self.mutate(app, |s| {
            for w in s.windows.iter_mut() {
                for c in w.clusters.iter_mut() {
                    if c.tree.activate_tab(instance_id) {
                        // Showing a tab in a cluster nobody is looking at is
                        // not showing it. Bring its cluster forward too.
                        w.active_cluster_id = Some(c.id.clone());
                        return;
                    }
                }
            }
        });
    }

    pub fn set_instance_title(&self, app: &AppHandle, instance_id: &str, title: &str) {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return;
        }
        // Guarded like `set_terminal_title`, and for the same reason: a
        // frontend that reports its title on every render must not broadcast
        // the whole state to every window for no visible change.
        {
            let guard = self.read();
            match guard.instances.iter().find(|i| i.id == instance_id) {
                Some(i) if i.title == trimmed => return,
                None => return,
                _ => {}
            }
        }
        self.mutate(app, |s| {
            if let Some(i) = s.instances.iter_mut().find(|i| i.id == instance_id) {
                i.title = trimmed.to_string();
            }
        });
    }

    /// Move an instance to a pane — within its cluster, or into another
    /// window's. `index` is where in the target strip it lands.
    pub fn move_instance(
        &self,
        app: &AppHandle,
        instance_id: &str,
        to_cluster: &str,
        to_pane: &str,
        index: Option<usize>,
    ) -> bool {
        let mut moved = false;
        self.mutate(app, |s| {
            moved = move_instance_pure(s, instance_id, to_cluster, to_pane, index);
        });
        moved
    }

    /// Split a pane and put an instance in the new half — the drop-on-an-edge
    /// gesture. The instance is removed from wherever it was first, so this
    /// works both for a fresh surface and for a tab dragged out of a neighbour.
    ///
    /// **Nothing is touched unless `pane_id` is actually somewhere.** The removal
    /// used to run unconditionally, ahead of a search that could come up empty,
    /// which made a drop naming a pane that no longer exists *delete the tab that
    /// was dropped*: it left every tree, no split took it, and the broadcast went
    /// out with the surface belonging to nothing. That was reachable — the drop
    /// zone registry was handing out stale pane ids until recently (see
    /// `dropZones.ts`) — and a gesture whose failure mode is losing the thing you
    /// dragged has no business being ordered this way even when nothing is
    /// handing it bad input.
    ///
    /// Returns whether the split happened. The caller surfaces `false`; a drop
    /// that silently does nothing is the hardest kind of failure to report.
    pub fn split_with_instance(
        &self,
        app: &AppHandle,
        pane_id: &str,
        dir: SplitDir,
        instance_id: &str,
        before: bool,
    ) -> bool {
        let (split_id, new_pane_id) = {
            let mut counters = self.counters.write_or_panic();
            counters.splits += 1;
            counters.panes += 1;
            (
                format!("split-{}", counters.splits),
                format!("pane-{}", counters.panes),
            )
        };

        let mut split = false;
        self.mutate(app, |s| {
            let ids = (split_id.as_str(), new_pane_id.as_str());
            split = split_with_instance_pure(s, pane_id, dir, ids, instance_id, before);
        });
        split
    }

    pub fn set_pane_sizes(&self, app: &AppHandle, split_id: &str, sizes: Vec<f32>) {
        self.mutate(app, |s| {
            for w in s.windows.iter_mut() {
                for c in w.clusters.iter_mut() {
                    if c.tree.set_sizes(split_id, &sizes) {
                        return;
                    }
                }
            }
        });
    }

    /// Pull an instance out into a window of its own, taking a fresh cluster
    /// with it. Returns false if the instance is not on screen anywhere, which
    /// is the caller's signal not to build a window for it — doing the
    /// bookkeeping first and the window second means a failed lookup cannot
    /// leave an empty frame on screen.
    pub fn detach_instance(&self, app: &AppHandle, instance_id: &str, new_label: &str) -> bool {
        let (cluster_id, pane_id) = {
            let mut counters = self.counters.write_or_panic();
            counters.clusters += 1;
            counters.panes += 1;
            (
                format!("cluster-{}", counters.clusters),
                format!("pane-{}", counters.panes),
            )
        };

        let mut detached = false;
        self.mutate(app, |s| {
            detached = detach_instance_pure(s, instance_id, new_label, &cluster_id, &pane_id);
        });
        detached
    }

    // --- terminals ---------------------------------------------------------

    /// Claim the next session id and its ordinal, without creating anything.
    ///
    /// Split from `add_terminal` so a pty can be spawned *between* the two. The
    /// id is what names the pty, and a session must not appear in the shared
    /// state until there is a real shell behind it — otherwise a failed spawn
    /// leaves a tab that looks alive and silently eats every keystroke.
    pub fn claim_terminal_id(&self) -> (String, u32) {
        let mut counters = self.counters.write_or_panic();
        counters.terminals += 1;
        (format!("term-{}", counters.terminals), counters.terminals)
    }

    /// Does this label name a window? Asked wherever a window has to exist
    /// before something can be put in it.
    pub fn has_window(&self, label: &str) -> bool {
        let guard = self.read();
        guard.windows.iter().any(|w| w.label == label)
    }

    /// Does this id name a live cluster? Asked before a terminal is opened into
    /// one: a session naming no cluster is a shell running with no band anywhere
    /// that would draw its entry.
    pub fn has_cluster(&self, cluster_id: &str) -> bool {
        let guard = self.read();
        guard
            .windows
            .iter()
            .flat_map(|w| w.clusters.iter())
            .any(|c| c.id == cluster_id)
    }

    /// Which cluster a window is showing, if it is showing one. What
    /// `create_terminal` resolves its caller's window label through — the band
    /// the `+` was clicked in is the active cluster's, by construction.
    ///
    /// `None` while a page is in front. Every caller wants somewhere to *work* —
    /// a terminal, a launch's project, an agent's `set_project` — and a page is
    /// none of those. See [`work_cluster`].
    pub fn active_cluster_of(&self, label: &str) -> Option<String> {
        let guard = self.read();
        let w = guard.windows.iter().find(|w| w.label == label)?;
        work_cluster(w).map(|c| c.id.clone())
    }

    /// Show a page in `label`'s window, creating its cluster the first time.
    ///
    /// Returns the page cluster's id, or `None` when the window does not exist.
    /// Ids are minted only when there is no page cluster to reuse — peeked
    /// under the read lock first, so a click on a chip that already has one
    /// burns nothing. The peek can race another window's open; the loser's ids
    /// go unused, which is the gap `open_instance` already accepts.
    pub fn open_page(
        &self,
        app: &AppHandle,
        label: &str,
        page: &crate::pages::Page,
    ) -> Option<String> {
        let needs_seed = {
            let guard = self.read();
            !page_cluster_is_whole(&guard, label, page.id)
        };
        let seed = needs_seed.then(|| {
            let mut counters = self.counters.write_or_panic();
            counters.clusters += 1;
            counters.panes += 1;
            let ordinal = counters
                .instances
                .entry(page.app_id.to_string())
                .or_insert(0);
            *ordinal += 1;
            let ordinal = *ordinal;
            PageSeed {
                cluster_id: format!("cluster-{}", counters.clusters),
                pane_id: format!("pane-{}", counters.panes),
                instance_id: format!("{}-{ordinal}", page.app_id),
            }
        });

        let mut opened = None;
        self.mutate(app, |s| opened = open_page_pure(s, label, page, seed));
        opened
    }

    /// Publish a session whose shell is already running, into a cluster's band.
    pub fn add_terminal(&self, app: &AppHandle, id: &str, title: &str, cluster_id: &str) {
        self.mutate(app, |s| {
            s.terminals.push(TerminalSession {
                id: id.to_string(),
                title: title.to_string(),
                cluster_id: cluster_id.to_string(),
                agent_finished: false,
                group_id: None,
            });
            for w in s.windows.iter_mut() {
                if let Some(c) = w.cluster_mut(cluster_id) {
                    c.active_terminal = Some(id.to_string());
                    return;
                }
            }
        });
    }

    /// Publish a session **straight into a cluster's tree**, never into a band.
    ///
    /// The counterpart of [`add_terminal`](Self::add_terminal) for the Apps menu's Terminal row
    /// and for a preset's terminal slot, and one mutation rather than "add it, then move it" for a
    /// reason that is visible on screen. `add_terminal` selects what it just opened, because the
    /// band's `+` should show you the terminal you asked for; doing that and then moving the
    /// session into a pane broadcasts twice, so the band jumps to a terminal about to leave it and
    /// `reseat_active_terminals` then repairs the selection to *some* band terminal, not
    /// necessarily the one you were reading — a side effect nobody asked for, with a visible
    /// flicker on the way to it. So there is no intermediate state: the session is published with
    /// its id already in the tree, and `reseat_active_terminals` sees the finished picture and
    /// leaves the cluster's still-valid band selection exactly where it was.
    ///
    /// `dir` asks for a pane of its own rather than a tab, on exactly the terms `open_instance`
    /// above does and through the same `PaneNode::open_into`. The Apps menu lists Terminal beside
    /// the apps, so a row that split and a row that stacked would be two behaviours in one list. A
    /// preset's terminal slot passes `None` with an `index`, because a preset has already decided
    /// the shape.
    #[allow(clippy::too_many_arguments)]
    pub fn add_terminal_in_pane(
        &self,
        app: &AppHandle,
        id: &str,
        title: &str,
        cluster_id: &str,
        pane_id: &str,
        index: Option<usize>,
        dir: Option<SplitDir>,
    ) {
        // Before the lock, for the reason `open_instance` writes out in full.
        let split_ids = dir.map(|_| {
            let mut counters = self.counters.write_or_panic();
            counters.splits += 1;
            counters.panes += 1;
            (
                format!("split-{}", counters.splits),
                format!("pane-{}", counters.panes),
            )
        });

        self.mutate(app, |s| {
            let ShellSnapshot {
                windows,
                instances,
                terminals,
                ..
            } = s;

            terminals.push(TerminalSession {
                id: id.to_string(),
                title: title.to_string(),
                cluster_id: cluster_id.to_string(),
                agent_finished: false,
                group_id: None,
            });
            let split = match (dir, &split_ids) {
                (Some(dir), Some((split_id, new_pane_id))) => {
                    Some((dir, split_id.as_str(), new_pane_id.as_str()))
                }
                _ => None,
            };
            for w in windows.iter_mut() {
                if let Some(c) = w.cluster_mut(cluster_id) {
                    // A terminal is never Home, so the eviction always applies — see
                    // `dismiss_takeover`.
                    //
                    // A `pane_id` that no longer names a pane lands the session in the
                    // cluster's first pane rather than in the band. The band was the old
                    // answer and it was the wrong one: a preset's terminal slot names a pane
                    // the preset itself just planned, so a miss there is not a stale drop to
                    // be forgiving about — it is this session ending up somewhere nobody
                    // arranged. `place_surface` is what makes a miss rare enough to say that.
                    place_surface(
                        &mut c.tree,
                        instances,
                        id,
                        Some(pane_id),
                        index,
                        split,
                        true,
                    );
                    return;
                }
            }
        });
    }

    pub fn close_terminal(&self, app: &AppHandle, id: &str) {
        self.mutate(app, |s| {
            close_terminal_pure(&mut s.terminals, id);
            // A terminal that had been dragged into the layout is a tab too.
            for w in s.windows.iter_mut() {
                for c in w.clusters.iter_mut() {
                    c.tree.remove_tab(id);
                }
            }
            // Whichever band was pointing at it is re-seated by `mutate`.
        });
    }

    /// Which cluster a session sits in, for the split command — it opens the
    /// new pty beside the one it is splitting from, and the caller has no other
    /// way to know where that is.
    pub fn cluster_of_terminal(&self, id: &str) -> Option<String> {
        let guard = self.read();
        guard
            .terminals
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.cluster_id.clone())
    }

    /// Put `id` into `sibling_id`'s group, creating one if `sibling_id` doesn't
    /// already have one. `None` if `sibling_id` is no longer a live session —
    /// its tab could have closed while the new pty was spawning.
    pub fn group_with(&self, app: &AppHandle, sibling_id: &str, id: &str) -> Option<String> {
        let mut assigned = None;
        self.mutate(app, |s| {
            assigned = group_with_pure(&mut s.terminals, sibling_id, id);
        });
        assigned
    }

    /// Move a terminal into the band of whatever cluster `to_label`'s window is
    /// showing.
    ///
    /// Still addressed by *window*, because that is what the drag layer can find
    /// out — `windows::at_cursor` hit-tests screen rectangles, and a cluster has
    /// no rectangle of its own. The window-to-cluster step happens here rather
    /// than in the frontend so that "which cluster is that window showing" is
    /// answered against the state that is about to be mutated, under the same
    /// lock, instead of against whatever the dragging window last heard.
    ///
    /// A window showing no cluster has no band to drop into, and the move is
    /// refused whole: the terminal stays exactly where it was, which is a
    /// gesture that visibly did nothing rather than a session that vanished.
    pub fn move_terminal(&self, app: &AppHandle, id: &str, to_label: &str) {
        self.mutate(app, |s| {
            // A page in front has no band, so it refuses exactly as an empty
            // window does.
            let Some(cluster_id) = s
                .windows
                .iter()
                .find(|w| w.label == to_label)
                .and_then(work_cluster)
                .map(|c| c.id.clone())
            else {
                return;
            };

            // Leaving the tree is part of moving: a terminal dragged from a
            // pane back into a band must stop being a tab, or it would draw in
            // both places at once.
            for w in s.windows.iter_mut() {
                for c in w.clusters.iter_mut() {
                    c.tree.remove_tab(id);
                }
            }
            if let Some(t) = s.terminals.iter_mut().find(|t| t.id == id) {
                t.cluster_id = cluster_id.clone();
            }
            for w in s.windows.iter_mut() {
                if let Some(c) = w.cluster_mut(&cluster_id) {
                    c.active_terminal = Some(id.to_string());
                    return;
                }
            }
        });
    }

    /// Which terminal a cluster's band is showing.
    pub fn set_active_terminal(&self, app: &AppHandle, cluster_id: &str, id: Option<String>) {
        self.mutate(app, |s| {
            for w in s.windows.iter_mut() {
                if let Some(c) = w.cluster_mut(cluster_id) {
                    c.active_terminal = id;
                    return;
                }
            }
        });
    }

    /// How tall a cluster's terminal band was left, at the end of a drag on its handle.
    ///
    /// Named by cluster rather than by window, which is the whole point: the window draws one band
    /// at a time and the height it draws belongs to whichever cluster is in front of it. Searching
    /// every window for the id — rather than taking a label as well — means a cluster that has
    /// since been dragged into another window is still found, the same way
    /// [`ShellState::set_active_terminal`] finds it.
    ///
    /// Written once per drag, on pointer-up, not once per frame: the view animates against a
    /// motion value while the pointer is down and reports only where it was let go. See
    /// `frame/Frame.tsx`'s `onBottomHandleDown`.
    pub fn set_band_height(&self, app: &AppHandle, cluster_id: &str, height: f32) {
        self.mutate(app, |s| set_cluster_band_height(s, cluster_id, height));
    }

    /// A terminal's own program set its title (an OSC `0`/`2` escape sequence),
    /// and the emulator that saw it is reporting up.
    ///
    /// The OSC parsing happens in xterm.js, not here — it ships a tested parser
    /// that already copes with a title sequence split across two pty reads.
    /// What belongs here is ownership of the result: a terminal can be dragged
    /// into another window, so the title has to outlive whichever window first
    /// heard it.
    ///
    /// Two guards, both load-bearing: an empty title is dropped rather than
    /// stored, so a report racing a tab close can never blank the shell-name
    /// fallback `open_terminal` gave the tab; and a title identical to what is
    /// already stored is dropped too, so a shell that rewrites its title on
    /// every prompt doesn't broadcast to every window for no visible change.
    /// That second check is why this doesn't go through `mutate` — `mutate`'s
    /// contract is to broadcast unconditionally, and a no-op here must
    /// broadcast nothing.
    pub fn set_terminal_title(&self, app: &AppHandle, id: &str, title: &str) {
        let shortened = shorten_title(title);
        if shortened.is_empty() {
            return;
        }

        let updated = {
            let mut guard = self.inner.write_or_panic();
            let Some(t) = guard.terminals.iter_mut().find(|t| t.id == id) else {
                return;
            };
            if t.title == shortened {
                return;
            }
            t.title = shortened;
            guard.clone()
        };
        let _ = app.emit(SHELL_STATE_EVENT, &updated);
        crate::shell_store::persist(app, &updated);
    }
}

/// Which cluster holds `instance_id`. The whole of `ShellState::
/// cluster_of_instance` minus the lock, so it can be tested against a bare
/// `ShellSnapshot` — the same split `move_cluster_pure` has, for the same
/// reason.
///
/// Searches every window, not just the calling one. A surface's cluster is a
/// fact about the tree it is in, and an app frame asking a question has no idea
/// which OS window it ended up in — nor should it need one.
fn cluster_of_instance_pure(s: &ShellSnapshot, instance_id: &str) -> Option<String> {
    s.windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.tree.tabs().contains(&instance_id))
        .map(|c| c.id.clone())
}

/// What a tab id is, expressed as the slot a preset would use for it.
///
/// The one place that answer is derived, which is what keeps `capture_preset`
/// and `apply_preset` from disagreeing about what a tab is — a disagreement that
/// would show up as a preset saving a terminal and then refusing to recognise
/// the terminal it had just saved.
///
/// `None` for an id that resolves to neither list. That is not a state anything
/// should be able to produce (an instance is in whichever tree holds its id, and
/// the flat lists are what the ids resolve against), and it is deliberately not
/// papered over: `presets::Existing` treats it as filling nothing, so the tab
/// survives as a leftover instead of quietly satisfying a terminal slot.
///
/// A *tool* instance answers `App { app_id }` with a tool's id in it, which no
/// preset can ever contain — `PresetNode::normalized` strips slots naming
/// anything outside `apps::REGISTRY`. So a tool surface is never claimed and
/// always lands in the last pane, which is the right answer for a surface this
/// build cannot mount anyway.
fn resolve_slot(
    instances: &[SurfaceInstance],
    terminals: &[TerminalSession],
    id: &str,
) -> Option<presets::PresetSlot> {
    if let Some(instance) = instances.iter().find(|i| i.id == id) {
        return Some(presets::PresetSlot::App {
            app_id: instance.app_id.clone(),
        });
    }
    terminals
        .iter()
        .any(|t| t.id == id)
        .then_some(presets::PresetSlot::Terminal)
}

/// [`resolve_slot`] against a whole snapshot — what `capture_preset` hands to
/// `presets::capture`, which takes a resolver rather than the lists themselves.
fn slot_of_tab(snapshot: &ShellSnapshot, id: &str) -> Option<presets::PresetSlot> {
    resolve_slot(&snapshot.instances, &snapshot.terminals, id)
}

// --- A takeover surface's dismissal -------------------------------------------
//
// Home and Tutorials **cover** the cluster rather than taking a pane beside it — `WindowRoot.tsx`'s
// `TAKEOVER_APPS` and `ToolWindow`'s `soloInstanceId` are the drawing half of that. Neither draws a
// tab of its own in the switcher row (see that file's `members`), on purpose: they are the screen
// you are already on, not a fourth thing competing with Files, the viewer and a terminal for a
// place in the row.

/// Apps that cover the cluster instead of taking a pane. Mirrors `TAKEOVER_APPS` in
/// `src/shell/WindowRoot.tsx`; the two are a pair.
///
/// One takeover surface arriving over another is the exception, and it is why `open_instance`
/// guards on this rather than on the id `"home"`. Opening Tutorials from a card on Home must not
/// evict the Home underneath: it is covered, not replaced, and closing the tutorial has to put back
/// the screen the reader left. Evicting would strand a fresh cluster with nothing in it.
fn is_takeover_app(app_id: &str) -> bool {
    matches!(app_id, "home" | "tutorial")
}

/// Whether `id` names a live takeover surface.
fn is_takeover(instances: &[SurfaceInstance], id: &str) -> bool {
    instances
        .iter()
        .any(|i| i.id == id && is_takeover_app(&i.app_id))
}

/// If `pane_id` currently holds Home, close it — the tab and the instance both, exactly what
/// `close_instance` does for anything else. `None` if it did not.
///
/// A takeover surface has no close button anywhere: once something else is visible in its pane
/// there is no gesture left that could bring it back into view there. So this closes it for the
/// user, the instant that happens, rather than leaving a live instance nobody can reach and nobody
/// asked to keep.
///
/// Reached from every path that can put something new into a pane, through
/// [`place_surface`] — which runs this *before* the insertion rather than
/// cleaning up after it. That order is what makes a pane holding only Home read
/// as empty to `open_into`'s own "should this split?" check: the surface opened
/// over it takes the pane outright, rather than gaining Home as a permanent
/// neighbour in a sibling pane because Home was still there to make
/// `pane_is_empty` say no.
fn dismiss_takeover(
    tree: &mut PaneNode,
    pane_id: &str,
    instances: &mut Vec<SurfaceInstance>,
) -> Option<String> {
    let home_id = tree
        .tabs_in(pane_id)?
        .iter()
        .find(|id| is_takeover(instances, id.as_str()))?
        .clone();
    // Unpruned, and the whole mechanism depends on it. Emptying a pane and then
    // pruning deletes that pane, so the caller's very next call — which names it
    // — would address nothing and the arriving surface would land nowhere. That
    // was survivable only for a cluster of one pane, where `prune` exempts the
    // root; in every split cluster it silently swallowed the open.
    tree.remove_tab_unpruned(&home_id);
    instances.retain(|i| i.id != home_id);
    Some(home_id)
}

/// Put a surface into a pane of one cluster: pick the pane, take the surface out
/// of wherever it already is, evict a takeover surface sitting in the way, place.
///
/// **The one door into a pane.** One function rather than three, because the
/// three that came before it — `open_instance`, `add_terminal_in_pane`,
/// `move_instance` — each got a different piece of this wrong, and every one of
/// those defects was invisible in a cluster of a single pane. What each step is
/// for is at the step.
///
/// Returns whether the surface is now in the tree. `false` means the cluster had
/// no pane to put it in at all, which is the only remaining way this can fail.
fn place_surface(
    tree: &mut PaneNode,
    instances: &mut Vec<SurfaceInstance>,
    instance_id: &str,
    pane_id: Option<&str>,
    index: Option<usize>,
    split: Option<(SplitDir, &str, &str)>,
    evict_takeover: bool,
) -> bool {
    // A `pane_id` this tree does not hold falls back to the first pane — the
    // forgiveness `active_pane` documents, and `open_instance` already showed a
    // `None`. A stale id is ordinary rather than exceptional: the frontend's idea
    // of the focused pane is a render behind the tree, and the pane a takeover
    // surface lives in stops existing the moment it is closed. `move_instance`
    // holds itself off this, at its own `holds_pane` guard.
    let target = pane_id
        .filter(|id| tree.pane_of_id(id))
        .unwrap_or_else(|| tree.first_pane_id())
        .to_string();

    // A no-op for a freshly minted surface, and the whole of the move for a
    // dragged one. `insert_tab` used to be the only removal there was, and it
    // only ever looked in the pane it was inserting into — so a tab dragged
    // between two panes of one cluster was copied rather than moved. Unpruned,
    // because the pane a tab is dropped back into may be the pane it was the
    // only occupant of, and pruning here would delete the pane the drop names.
    let moved = tree.remove_tab_unpruned(instance_id);

    if evict_takeover {
        dismiss_takeover(tree, &target, instances);
    }

    let placed = tree.open_into(&target, instance_id, index, split);
    // The pane a dragged tab *left* is the only one this can have emptied and
    // not refilled, so it is the only reason to prune. Pruning unconditionally
    // would be wrong: between a preset being applied and its gaps being filled
    // the tree deliberately holds an empty leaf per gap (`presets::plan`), and
    // one prune after the first fill deletes the panes the rest were to land in.
    if moved {
        tree.prune();
    }
    placed
}

/// Close Home in every pane it now shares with something else.
///
/// `dismiss_takeover` above handles every arrival that lands in one named pane at
/// a time, because it knows in advance which pane that is. Applying a preset
/// does not fit that shape: `presets::plan` rebuilds the whole tree in a
/// single step, and a preset never claims Home — see `presets::builtins`'s
/// doc comment — so an unclaimed Home is swept, along with whatever else the
/// preset did not mention, into whichever pane `plan` decided the leftovers
/// belong in. This walks the *finished* tree instead of trying to predict
/// which pane that will be, which keeps it from caring how `plan` makes that
/// choice — that is `presets` module's business, not this one's.
///
/// Only a pane sharing Home with something else is touched. A pane where Home
/// ended up alone is left alone too: nothing else arrived there, so nothing
/// arrived *into Home's pane*, which is the one rule this whole mechanism
/// exists to enforce.
fn dismiss_crowded_takeover(tree: &mut PaneNode, instances: &mut Vec<SurfaceInstance>) {
    let leaves: Vec<String> = tree.leaf_ids().into_iter().map(str::to_string).collect();
    for pane_id in leaves {
        let crowded = tree.tabs_in(&pane_id).is_some_and(|tabs| tabs.len() > 1);
        if crowded {
            dismiss_takeover(tree, &pane_id, instances);
        }
    }
    // No `prune` to finish with, and that is a decision rather than an
    // omission. `dismiss_takeover` no longer prunes for itself, so this is
    // where one would go — but nothing here can empty a pane (only a *crowded*
    // one is touched), and the tree this runs against deliberately holds empty
    // leaves: `presets::plan` leaves one per gap for `fill_preset_gaps` to
    // land in, and pruning would delete every pane the preset had just
    // reserved. Not pruning is also what keeps the ids collected above valid
    // for the whole loop.
}

/// Fold a preset into one cluster's tree: match existing surfaces to slots,
/// leave every leftover exactly where `presets::plan` puts it, then apply
/// `dismiss_crowded_takeover` — the one Home-dismissal case that only makes sense
/// once the whole tree has been rebuilt. Shared by `apply_preset` and
/// `apply_preset_to_cluster`, which differ only in how they find the cluster.
fn rearrange(
    cluster: &mut Cluster,
    instances: &mut Vec<SurfaceInstance>,
    terminals: &[TerminalSession],
    root: &presets::PresetNode,
    ids: &mut presets::Ids,
) -> Vec<presets::Gap> {
    let existing: Vec<presets::Existing> = cluster
        .tree
        .tabs()
        .iter()
        .map(|id| presets::Existing {
            instance_id: (*id).to_string(),
            fills: resolve_slot(instances, terminals, id),
        })
        .collect();

    let (tree, gaps) = presets::plan(root, &existing, ids);
    cluster.tree = tree;
    dismiss_crowded_takeover(&mut cluster.tree, instances);
    gaps
}

/// Fresh pane and split ids for applying `root`, minted before the state lock
/// is taken — the ordering `split_with_instance` already uses, and for the
/// same reason: minting an id and publishing the thing it names must not be
/// two separately-observable events. Ids handed out for an apply that then
/// finds no cluster are simply skipped, which costs a gap in the numbering and
/// nothing else — a counter that went backwards on a refusal would be the far
/// worse trade.
fn mint_preset_ids(counters: &RwLock<Counters>, root: &presets::PresetNode) -> presets::Ids {
    let mut counters = counters.write_or_panic();
    let panes = (0..root.pane_count())
        .map(|_| {
            counters.panes += 1;
            format!("pane-{}", counters.panes)
        })
        .collect();
    let splits = (0..root.split_count())
        .map(|_| {
            counters.splits += 1;
            format!("split-{}", counters.splits)
        })
        .collect();
    presets::Ids::new(panes, splits)
}

/// Split the tabs a closing cluster held into `(terminals, instances)`.
///
/// A tree holds both under one kind of id, and the caller disposes of them
/// differently — a terminal has a pty behind it that has to be killed. The input
/// is the cluster's *tree*, never the whole terminal list, so this answers only
/// "which of these tabs are terminals". Its caller adds the band's separately;
/// see `close_cluster`.
fn sort_held(held: Vec<String>, terminals: &[TerminalSession]) -> (Vec<String>, Vec<String>) {
    held.into_iter()
        .partition(|id| terminals.iter().any(|t| &t.id == id))
}

/// Every session in a cluster's band, by id.
///
/// The other half of what `close_cluster` has to dispose of, and separate from
/// [`sort_held`] because it is a different question asked of a different list: a
/// band terminal is not a tab in the tree, so nothing in the tree names it.
fn terminals_of_cluster(terminals: &[TerminalSession], cluster_id: &str) -> Vec<String> {
    terminals
        .iter()
        .filter(|t| t.cluster_id == cluster_id)
        .map(|t| t.id.clone())
        .collect()
}

/// Lift a cluster out of a window, and let the window's selection fall to a
/// survivor if it named the one that left.
///
/// The neighbour rule — whatever slid into the vacated position, or the last one
/// — is the same one tabs use, and it is written once here because closing a
/// cluster and moving one to another window are the same event as far as the
/// window losing it is concerned.
///
/// A page is never the survivor. Closing the last real cluster leaves the
/// window on `NoClustersState` — with the page chips still there to click —
/// rather than landing it on whichever page happened to sit beside it, which
/// would read as the close having opened something.
fn take_cluster(w: &mut WindowPlacement, cluster_id: &str) -> Option<Cluster> {
    let i = w.clusters.iter().position(|c| c.id == cluster_id)?;
    let gone = w.clusters.remove(i);

    if w.active_cluster_id.as_deref() == Some(cluster_id) {
        w.active_cluster_id = w.clusters[i..]
            .iter()
            .find(|c| !c.is_page())
            .or_else(|| w.clusters.iter().rev().find(|c| !c.is_page()))
            .map(|c| c.id.clone());
    }
    Some(gone)
}

/// Move a cluster into `to_label`'s window, creating that window's entry if it does not have one.
/// The whole of `ShellState::move_cluster`, minus the lock and the broadcast, so that it can be
/// tested against a bare `ShellSnapshot`.
///
/// One refusal, returning `false` with nothing changed: **a cluster nobody holds**, which has
/// already been closed or never existed. **The last cluster in a window may be moved out**, and
/// that is a change — it used to be a second refusal, and the argument for dropping it is in
/// `docs/design-notes/backend-core.md`. Moving a cluster to the window it is already in is not a
/// refusal either: nothing happens and `true` is returned, because the cluster *is* where the
/// caller asked for it to be.
///
/// What travels with it: the tree, therefore every tab in the tree, and — since terminals name a
/// cluster — every terminal in its band, with nothing here having to move any of them. This used
/// to rewrite a `window_label` on every terminal held in the tree; that field is gone, and the
/// docs page above records the bug its absence removed. Instances never needed one: they are a
/// flat global list keyed by id, and the tree is the only thing that says where any of them are.
///
/// A page is refused too: each window has its own, so there is nothing to carry across.
fn move_cluster_pure(s: &mut ShellSnapshot, cluster_id: &str, to_label: &str) -> bool {
    if is_page_cluster(s, cluster_id) {
        return false;
    }
    let Some(source) = s
        .windows
        .iter_mut()
        .find(|w| w.clusters.iter().any(|c| c.id == cluster_id))
    else {
        return false;
    };
    if source.label == to_label {
        return true;
    }
    // No count check. `take_cluster` already leaves a window that has just lost
    // its only cluster with `active_cluster_id: None`, which is the same state
    // `close_cluster` leaves and the state `NoClustersState` draws.
    let Some(cluster) = take_cluster(source, cluster_id) else {
        return false;
    };

    match s.windows.iter_mut().find(|w| w.label == to_label) {
        Some(w) => {
            w.active_cluster_id = Some(cluster.id.clone());
            w.clusters.push(cluster);
        }
        None => s.windows.push(WindowPlacement {
            label: to_label.to_string(),
            active_cluster_id: Some(cluster.id.clone()),
            clusters: vec![cluster],
            geometry: None,
        }),
    }
    true
}

// --- pages ---------------------------------------------------------------------
//
// A page cluster is one pane holding one instance of its page's app, and stays
// that way: see `Cluster::page`. Each mutator a page could be named to is split
// out here as a pure function over a bare `ShellSnapshot`, which is where the
// refusal lives and where it is tested — not in the cluster bar, which merely
// never offers the gesture.

fn is_page_cluster(s: &ShellSnapshot, cluster_id: &str) -> bool {
    s.windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .any(|c| c.id == cluster_id && c.is_page())
}

/// The pinned Design canvas cluster, and only it — see `Cluster::pinned`.
/// Checked by `close_cluster_pure` the same way `is_page_cluster` is: refused
/// there, rather than left off the switcher's × in the first place, so the
/// invariant holds even for a close reached some other way (a keyboard
/// shortcut, a future "close all") that never consulted the chip.
fn is_pinned_cluster(s: &ShellSnapshot, cluster_id: &str) -> bool {
    s.windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .any(|c| c.id == cluster_id && c.pinned)
}

/// The pure core of [`ShellState::project_live_counts`] — see that method's
/// doc for what it answers and why. Pulled out to the usual pattern: this
/// type's getters take `&self` and lock internally, which a unit test cannot
/// reach without a real `AppHandle`, so the arithmetic lives here instead,
/// tested directly against a bare snapshot.
fn project_live_counts_pure(s: &ShellSnapshot, path: &str) -> ProjectLiveCounts {
    let clusters: Vec<&Cluster> = s
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .filter(|c| c.project.as_deref() == Some(path))
        .collect();

    let mut environments: Vec<String> = clusters
        .iter()
        .filter_map(|c| {
            c.environment
                .as_ref()
                .map(crate::environments::Environment::identity)
        })
        .collect();
    environments.sort();
    environments.dedup();

    ProjectLiveCounts {
        open: !clusters.is_empty(),
        cluster_count: clusters.len(),
        environment_count: environments.len(),
    }
}

/// Whether a page's tree holds this tab — the one tab that is not draggable.
fn pinned_to_page(s: &ShellSnapshot, tab_id: &str) -> bool {
    s.windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .any(|c| c.is_page() && c.tree.tabs().contains(&tab_id))
}

fn pane_in_page(s: &ShellSnapshot, pane_id: &str) -> bool {
    s.windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .any(|c| c.is_page() && c.tree.holds_pane(pane_id))
}

/// The cluster a window is *working* in: its active one, unless that is a page.
///
/// What every "where does this go" question asks — a terminal, the Apps menu, a
/// preset, a project — because a page's pane is its app's and it has no band.
fn work_cluster(w: &WindowPlacement) -> Option<&Cluster> {
    let active = w.active_cluster_id.as_deref()?;
    w.clusters.iter().find(|c| c.id == active && !c.is_page())
}

/// Which cluster `open_instance` puts a new surface in: the one owning the
/// named pane, or failing that the active one — and neither, if it is a page.
/// A page's pane named explicitly is refused rather than redirected, because
/// sending the surface somewhere else would be a cluster switch nobody asked for.
fn open_target<'w>(w: &'w mut WindowPlacement, pane_id: Option<&str>) -> Option<&'w mut Cluster> {
    let owner = pane_id.and_then(|p| w.clusters.iter().position(|c| c.tree.holds_pane(p)));
    let cluster = match owner {
        Some(i) => w.clusters.get_mut(i),
        None => w.active_cluster_mut(),
    }?;
    (!cluster.is_page()).then_some(cluster)
}

/// The whole of `ShellState::add_design_cluster`, minus the lock and the id
/// minting — see that method's doc for what each rule here means in
/// practice. `None` when `label` names no window, or when that window
/// already holds a pinned cluster.
fn add_design_cluster_pure(
    s: &mut ShellSnapshot,
    label: &str,
    cluster_id: &str,
    pane_id: &str,
    project: &str,
    environment: crate::environments::Environment,
) -> Option<String> {
    let w = s.windows.iter_mut().find(|w| w.label == label)?;
    if w.clusters.iter().any(|c| c.pinned) {
        return None;
    }
    w.clusters.insert(
        0,
        Cluster {
            id: cluster_id.to_string(),
            name: "Design".to_string(),
            tree: PaneNode::leaf(pane_id.to_string()),
            project: Some(project.to_string()),
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: Some(environment),
            pinned: true,
        },
    );
    Some(cluster_id.to_string())
}

/// Rename a cluster; `false`, unchanged, for a page or an id naming nothing.
/// A page's name is its chip's label, which is the page table's to decide.
fn rename_cluster_pure(s: &mut ShellSnapshot, cluster_id: &str, name: &str) -> bool {
    if is_page_cluster(s, cluster_id) {
        return false;
    }
    for w in s.windows.iter_mut() {
        if let Some(c) = w.cluster_mut(cluster_id) {
            c.name = name.to_string();
            return true;
        }
    }
    false
}

/// The whole of `ShellState::close_cluster`, minus the lock: returns the
/// `(instances, terminals)` that went with it. A page is never closed — it has
/// no ×, and there is no gesture that would bring it back other than its chip,
/// which would only make another — so both lists come back empty for one. The
/// pinned Design canvas cluster is refused the same way, for the reason
/// `is_pinned_cluster` gives — it has no × either, but nothing stops a close
/// reached some other way.
fn close_cluster_pure(s: &mut ShellSnapshot, cluster_id: &str) -> (Vec<String>, Vec<String>) {
    if is_page_cluster(s, cluster_id) || is_pinned_cluster(s, cluster_id) {
        return (Vec::new(), Vec::new());
    }
    let Some(w) = s
        .windows
        .iter_mut()
        .find(|w| w.clusters.iter().any(|c| c.id == cluster_id))
    else {
        return (Vec::new(), Vec::new());
    };
    let Some(gone) = take_cluster(w, cluster_id) else {
        return (Vec::new(), Vec::new());
    };
    let held: Vec<String> = gone.tree.tabs().iter().map(|t| t.to_string()).collect();

    let (mut terminals, instances) = sort_held(held, &s.terminals);
    // And the band's, which are not in the tree and are this cluster's
    // all the same. A second call rather than something folded into
    // `sort_held`: that function answers "which of these tabs are
    // terminals", and this is a different question with no tabs in it.
    for id in terminals_of_cluster(&s.terminals, cluster_id) {
        if !terminals.contains(&id) {
            terminals.push(id);
        }
    }
    s.terminals.retain(|t| !terminals.contains(&t.id));
    s.instances.retain(|i| !instances.contains(&i.id));
    (instances, terminals)
}

/// The whole of `ShellState::close_instance`, minus the lock. A page's own
/// instance is refused: closing it would leave a page cluster with nothing in it.
fn close_instance_pure(s: &mut ShellSnapshot, instance_id: &str) -> bool {
    if pinned_to_page(s, instance_id) {
        return false;
    }
    let mut found = false;
    for w in s.windows.iter_mut() {
        for c in w.clusters.iter_mut() {
            if c.tree.remove_tab(instance_id) {
                found = true;
            }
        }
    }
    if found {
        s.instances.retain(|i| i.id != instance_id);
    }
    found
}

/// The whole of `ShellState::move_instance`, minus the lock and the broadcast.
///
/// Refuses — `false`, nothing changed — a target that is a page, and a tab a
/// page holds: nothing is dropped into a page, and its tab is not dragged out.
fn move_instance_pure(
    s: &mut ShellSnapshot,
    instance_id: &str,
    to_cluster: &str,
    to_pane: &str,
    index: Option<usize>,
) -> bool {
    if is_page_cluster(s, to_cluster) || pinned_to_page(s, instance_id) {
        return false;
    }
    let ShellSnapshot {
        windows, instances, ..
    } = s;

    // Look before leaping, for the reason `split_with_instance`'s doc
    // comment sets out at length: the sweep below takes the tab out of
    // wherever it was, and running that ahead of a target that turns
    // out not to exist is how a drop *deletes* what was dragged.
    //
    // It also holds `place_surface`'s first-pane fallback off this one
    // gesture, deliberately. An open must produce a surface somewhere,
    // so falling back is right for it; a drop onto a pane that has gone
    // should leave the tab exactly where it was, because that is what a
    // cancelled drag looks like and the user is watching.
    let known = windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .any(|c| c.id == to_cluster && c.tree.holds_pane(to_pane));
    if !known {
        return false;
    }

    // Every *other* cluster loses the tab before anything gains it, so a
    // drag across clusters cannot leave two copies behind. The target
    // cluster is deliberately not swept here: `place_surface` removes
    // the tab from that tree itself, without pruning, because the pane
    // being dropped into may be the pane the tab was the only occupant
    // of. Sweeping it here with the pruning `remove_tab` would delete
    // that pane and the drop would land nowhere.
    for w in windows.iter_mut() {
        for c in w.clusters.iter_mut() {
            if c.id != to_cluster {
                c.tree.remove_tab(instance_id);
            }
        }
    }

    for w in windows.iter_mut() {
        if let Some(c) = w.cluster_mut(to_cluster) {
            // Dragging Home itself must not evict Home; every other
            // tab landing in its pane does — see `dismiss_takeover`.
            // Read before the call rather than in the argument list,
            // which would want `instances` shared and mutable at once.
            let evict = !is_takeover(instances, instance_id);
            let moved = place_surface(
                &mut c.tree,
                instances,
                instance_id,
                Some(to_pane),
                index,
                None,
                evict,
            );
            if moved {
                w.active_cluster_id = Some(to_cluster.to_string());
            }
            return moved;
        }
    }
    false
}

/// The whole of `ShellState::split_with_instance`, minus the lock and the id
/// minting. `ids` is the `(split, new pane)` pair minted before the lock. A
/// page's pane is never split, and a page's tab never dragged out to split one.
fn split_with_instance_pure(
    s: &mut ShellSnapshot,
    pane_id: &str,
    dir: SplitDir,
    ids: (&str, &str),
    instance_id: &str,
    before: bool,
) -> bool {
    if pane_in_page(s, pane_id) || pinned_to_page(s, instance_id) {
        return false;
    }
    // Look before leaping. A pane nobody holds means the drop named
    // somewhere that is not on screen, and the right answer to that is to
    // change nothing at all — see the method's doc comment for what the
    // other order cost.
    let known = s
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .any(|c| c.tree.holds_pane(pane_id));
    if !known {
        return false;
    }

    let (split_id, new_pane_id) = ids;
    for w in s.windows.iter_mut() {
        for c in w.clusters.iter_mut() {
            c.tree.remove_tab(instance_id);
        }
    }
    for w in s.windows.iter_mut() {
        for c in w.clusters.iter_mut() {
            if c.tree
                .split_pane(pane_id, dir, split_id, new_pane_id, instance_id, before)
            {
                w.active_cluster_id = Some(c.id.clone());
                return true;
            }
        }
    }
    false
}

/// The whole of `ShellState::detach_instance`, minus the lock and the id
/// minting. A page's tab is refused: it does not leave its page.
fn detach_instance_pure(
    s: &mut ShellSnapshot,
    instance_id: &str,
    new_label: &str,
    cluster_id: &str,
    pane_id: &str,
) -> bool {
    if pinned_to_page(s, instance_id) {
        return false;
    }
    if !s.instances.iter().any(|i| i.id == instance_id)
        && !s.terminals.iter().any(|t| t.id == instance_id)
    {
        return false;
    }

    let name = s
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .map(|i| i.title.clone())
        .or_else(|| {
            s.terminals
                .iter()
                .find(|t| t.id == instance_id)
                .map(|t| t.title.clone())
        })
        .unwrap_or_else(|| "Workspace".to_string());

    // The project the surface was already working in, read *before* the
    // tab is pulled out of the tree that answers this.
    //
    // Inherited here where `add_cluster` deliberately does not inherit,
    // and the two are not inconsistent: adding a cluster starts a new
    // piece of work, while detaching *moves an existing surface* that is
    // already rooted somewhere. A Files dragged onto a second monitor
    // that came back rooted at nothing would read as the drag having
    // broken it.
    let project = s
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.tree.tabs().contains(&instance_id))
        .and_then(|c| c.project.clone());

    for w in s.windows.iter_mut() {
        for c in w.clusters.iter_mut() {
            c.tree.remove_tab(instance_id);
        }
    }

    let mut tree = PaneNode::leaf(pane_id);
    tree.insert_tab(pane_id, instance_id, None);

    let cluster = Cluster {
        id: cluster_id.to_string(),
        name,
        tree,
        project,
        worktree: None,
        active_terminal: None,
        band_height: None,
        page: None,
        environment: None,
        pinned: false,
    };

    // A terminal dragged out has to bring its band home with it. It is
    // drawn in the new cluster's tree, so it is not in a band at all
    // right now — but the moment it is dragged back out of that tree it
    // lands in one, and it must be the band of the cluster it is
    // actually on screen in.
    if let Some(t) = s.terminals.iter_mut().find(|t| t.id == instance_id) {
        t.cluster_id = cluster_id.to_string();
    }

    match s.windows.iter_mut().find(|w| w.label == new_label) {
        Some(w) => {
            w.clusters.push(cluster);
            w.active_cluster_id = Some(cluster_id.to_string());
        }
        None => s.windows.push(WindowPlacement {
            label: new_label.to_string(),
            clusters: vec![cluster],
            active_cluster_id: Some(cluster_id.to_string()),
            geometry: None,
        }),
    }
    true
}

/// The ids a new page cluster needs, minted by `ShellState::open_page` before
/// it takes the state lock.
struct PageSeed {
    cluster_id: String,
    pane_id: String,
    instance_id: String,
}

/// Whether `label`'s window already has this page's cluster with something in it
/// — the peek that decides whether `open_page` mints any ids at all.
fn page_cluster_is_whole(s: &ShellSnapshot, label: &str, page_id: &str) -> bool {
    s.windows
        .iter()
        .find(|w| w.label == label)
        .and_then(|w| {
            w.clusters
                .iter()
                .find(|c| c.page.as_deref() == Some(page_id))
        })
        .is_some_and(|c| !c.tree.tabs().is_empty())
}

/// Find `label`'s page cluster for `page`, or make it from `seed`, and show it.
///
/// Returns its id, or `None` when the window does not exist or there is nothing
/// to reuse and no seed to build from. A page cluster found empty — its instance
/// lost to a state no path here produces, but a hand-edited `layout.json` could —
/// is refilled from the seed rather than shown blank.
fn open_page_pure(
    s: &mut ShellSnapshot,
    label: &str,
    page: &crate::pages::Page,
    seed: Option<PageSeed>,
) -> Option<String> {
    let ShellSnapshot {
        windows, instances, ..
    } = s;
    let w = windows.iter_mut().find(|w| w.label == label)?;
    let instance = |seed: &PageSeed| SurfaceInstance {
        id: seed.instance_id.clone(),
        app_id: page.app_id.to_string(),
        kind: SurfaceKind::App,
        title: page.name.to_string(),
    };

    let id = match w
        .clusters
        .iter_mut()
        .find(|c| c.page.as_deref() == Some(page.id))
    {
        Some(c) => {
            if c.tree.tabs().is_empty() {
                let seed = seed?;
                let pane = c.tree.first_pane_id().to_string();
                c.tree.insert_tab(&pane, &seed.instance_id, None);
                instances.push(instance(&seed));
            }
            c.id.clone()
        }
        None => {
            let seed = seed?;
            let mut tree = PaneNode::leaf(seed.pane_id.clone());
            tree.insert_tab(&seed.pane_id, &seed.instance_id, None);
            instances.push(instance(&seed));
            w.clusters.push(Cluster {
                id: seed.cluster_id.clone(),
                name: page.name.to_string(),
                tree,
                project: None,
                worktree: None,
                active_terminal: None,
                band_height: None,
                page: Some(page.id.to_string()),
                environment: None,
                pinned: false,
            });
            seed.cluster_id
        }
    };
    w.active_cluster_id = Some(id.clone());
    Some(id)
}

/// The whole of `ShellState::reclaim_window` once the close is confirmed: fold a
/// closing window's clusters into `main`.
///
/// Its **pages are dropped**, instances and all, rather than folded. Pages are
/// one per page per window; `main` has its own or makes one on the next click,
/// and folding would give it two Agents chips.
fn reclaim_window_pure(s: &mut ShellSnapshot, label: &str) {
    let Some(i) = s.windows.iter().position(|w| w.label == label) else {
        return;
    };
    let gone = s.windows.remove(i);
    let (pages, clusters): (Vec<Cluster>, Vec<Cluster>) =
        gone.clusters.into_iter().partition(Cluster::is_page);
    let dropped: Vec<String> = pages
        .iter()
        .flat_map(|c| c.tree.tabs())
        .map(str::to_string)
        .collect();
    s.instances.retain(|i| !dropped.contains(&i.id));

    // The terminals need no attention here, and their absence is the
    // point of naming a cluster. They travel with the clusters being
    // folded in, because that is the only thing they name — where this
    // used to rewrite a window label on every one of them, and would
    // have stranded any it missed as a live shell with no tab.
    if let Some(main) = s.windows.iter_mut().find(|w| w.label == "main") {
        if main.active_cluster_id.is_none() {
            main.active_cluster_id = clusters.first().map(|c| c.id.clone());
        }
        main.clusters.extend(clusters);
    }
}

/// Drop every page cluster whose page this build cannot draw, with its instance.
///
/// Reached from `restore` only. A layout saved by a build that had a page this
/// one lacks would otherwise restore a cluster no chip offers — possibly as the
/// active one, drawing a frame with no app behind it and no way to leave.
fn drop_unavailable_pages(s: &mut ShellSnapshot, available: &dyn Fn(&str) -> bool) {
    let mut dropped = Vec::new();
    for w in s.windows.iter_mut() {
        let gone: Vec<String> = w
            .clusters
            .iter()
            .filter(|c| c.page.as_deref().is_some_and(|p| !available(p)))
            .map(|c| c.id.clone())
            .collect();
        for id in gone {
            if let Some(c) = take_cluster(w, &id) {
                dropped.extend(c.tree.tabs().into_iter().map(str::to_string));
            }
        }
    }
    s.instances.retain(|i| !dropped.contains(&i.id));
}

/// Populate `Cluster::environment` from the legacy `Cluster::worktree`, for a
/// state restored from a `layout.json` written before the field existed.
///
/// Only fills the gap — a cluster that already has an `environment` (any
/// build new enough to have written one) is left exactly as stored, and a
/// cluster with neither field stays `None` rather than being guessed at; see
/// `crate::environments::migrate_environment`'s own doc for why "no worktree"
/// is not read as `Main`.
fn migrate_environments(snapshot: &mut ShellSnapshot) {
    for w in snapshot.windows.iter_mut() {
        for c in w.clusters.iter_mut() {
            if c.environment.is_none() {
                c.environment = crate::environments::migrate_environment(c.worktree.as_ref());
            }
        }
    }
}

/// Give every terminal a cluster, for a state restored from a file that did not
/// record one.
///
/// The only source of a terminal with no cluster is a `layout.json` written
/// while the field was a window label — see [`TerminalSession::cluster_id`]. That
/// file says which *window* each shell was under and nothing about which of that
/// window's clusters should claim it, and there is no way to recover the missing
/// half, so this does not try: every orphan goes to the first cluster of the
/// first window that has one. One migration, one visible consequence, in one
/// place someone can read.
///
/// An orphan with nowhere at all to go is dropped rather than kept. At restore
/// there is no pty behind it yet — `lib.rs` spawns those from this list
/// afterwards — so dropping costs nothing that exists, where keeping it would
/// mint a shell that no band anywhere could draw or close.
///
/// A page has no band, so a terminal naming one is an orphan too.
fn adopt_orphan_terminals(snapshot: &mut ShellSnapshot) {
    let live: Vec<&str> = snapshot
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .filter(|c| !c.is_page())
        .map(|c| c.id.as_str())
        .collect();

    let Some(fallback) = live.first().map(|id| id.to_string()) else {
        snapshot.terminals.clear();
        return;
    };
    let known: Vec<String> = live.into_iter().map(str::to_string).collect();

    for t in snapshot.terminals.iter_mut() {
        if !known.contains(&t.cluster_id) {
            t.cluster_id = fallback.clone();
        }
    }
}

/// The whole of `ShellState::add_cluster_for_environment`, minus the lock, the
/// id minting and the broadcast — written as a free function for the same
/// reason `set_cluster_band_height` below is: there is no `AppHandle` to hand
/// a `#[cfg(test)]` module, and the property worth pinning (the new cluster's
/// `project`/`worktree` match `source_cluster`'s) is a property of this walk,
/// not of the broadcast around it.
fn add_cluster_for_environment_pure(
    s: &mut ShellSnapshot,
    label: &str,
    name: &str,
    source_cluster: &str,
    cluster_id: &str,
    pane_id: &str,
) -> Option<(String, String)> {
    let source = s
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.id == source_cluster);
    let (project, worktree, environment) = match source {
        Some(c) => (c.project.clone(), c.worktree.clone(), c.environment.clone()),
        // The source cluster closed between the release and this call — a
        // narrow race, not a reason to fail the drop. The tab still gets a
        // home; it opens to Home's picker exactly as a plain `add_cluster`
        // would.
        None => (None, None, None),
    };

    let w = s.windows.iter_mut().find(|w| w.label == label)?;
    w.clusters.push(Cluster {
        id: cluster_id.to_string(),
        name: name.to_string(),
        tree: PaneNode::leaf(pane_id.to_string()),
        project,
        worktree,
        active_terminal: None,
        band_height: None,
        page: None,
        environment,
        pinned: false,
    });
    w.active_cluster_id = Some(cluster_id.to_string());
    Some((cluster_id.to_string(), pane_id.to_string()))
}

/// Record how tall one cluster's terminal band was left, wherever that cluster is.
///
/// Written as a free function so it can be unit-tested: every `ShellState` mutator takes an
/// `AppHandle` to broadcast through, and there is none to hand it in a `#[cfg(test)]` module. The
/// property worth pinning — a height lands on the named cluster and on no other — is a property of
/// this walk rather than of the broadcast around it, so this is the half that gets the test.
///
/// A cluster id that names nothing is a no-op rather than an error: the only way to ask is to have
/// a cluster on screen, and one closed between the pointer going down and coming up has no band
/// left to size.
fn set_cluster_band_height(snapshot: &mut ShellSnapshot, cluster_id: &str, height: f32) {
    for w in snapshot.windows.iter_mut() {
        if let Some(c) = w.cluster_mut(cluster_id) {
            c.band_height = Some(height);
            return;
        }
    }
}

/// Make every cluster's band selection name something that band is drawing.
///
/// Run after every mutation, from `mutate`. The rule it enforces is the one the
/// band renders by: a cluster's `active_terminal` is one of *its* terminals, and
/// not one that has been dragged into a pane tree, because a terminal in a tree
/// is a surface in the pane area and the band does not draw it at all.
///
/// A selection that survives the check is left exactly as it is — this only ever
/// repairs, so a deliberate `set_active_terminal` is never second-guessed. When
/// it does have to repair, it falls back to that cluster's first band terminal
/// rather than to nothing, since a band with sessions in it and none selected
/// shows an empty deck beside a list of entries.
fn reseat_active_terminals(snapshot: &mut ShellSnapshot) {
    let ShellSnapshot {
        windows, terminals, ..
    } = snapshot;

    for w in windows.iter_mut() {
        // Owned rather than borrowed from the trees, so that nothing is still
        // holding `w.clusters` when a selection is written back into it. It is
        // every cluster in the window and not just this one's, because "dragged
        // into the layout" is true of a tree in any of them.
        let in_a_tree: Vec<String> = w
            .clusters
            .iter()
            .flat_map(|c| c.tree.tabs())
            .map(str::to_string)
            .collect();

        for c in w.clusters.iter_mut() {
            let cluster_id = c.id.clone();
            let is_band_terminal = |id: &str| {
                terminals
                    .iter()
                    .any(|t| t.id == id && t.cluster_id == cluster_id)
                    && !in_a_tree.iter().any(|held| held == id)
            };

            if c.active_terminal.as_deref().is_some_and(&is_band_terminal) {
                continue;
            }
            c.active_terminal = terminals
                .iter()
                .map(|t| t.id.as_str())
                .find(|id| is_band_terminal(id))
                .map(str::to_string);
        }
    }
}

/// Rebuild the id counters from a restored state.
///
/// Every counter is set past the highest id already in use rather than to the
/// count of things present, because a session that opened five Files and closed
/// four still has a live `files-5`, and a counter derived from "one Files
/// exists" would hand out `files-2` and then collide on the next four.
fn counters_for(snapshot: &ShellSnapshot) -> Counters {
    let mut counters = Counters::default();

    for instance in &snapshot.instances {
        if let Some(n) = trailing_ordinal(&instance.id) {
            let slot = counters
                .instances
                .entry(instance.app_id.clone())
                .or_insert(0);
            *slot = (*slot).max(n);
        }
    }
    for terminal in &snapshot.terminals {
        if let Some(n) = trailing_ordinal(&terminal.id) {
            counters.terminals = counters.terminals.max(n);
        }
    }
    for window in &snapshot.windows {
        if let Some(n) = trailing_ordinal(&window.label) {
            counters.windows = counters.windows.max(n);
        }
        for cluster in &window.clusters {
            if let Some(n) = trailing_ordinal(&cluster.id) {
                counters.clusters = counters.clusters.max(n);
            }
            walk_ids(&cluster.tree, &mut counters);
        }
    }

    counters
}

fn walk_ids(node: &PaneNode, counters: &mut Counters) {
    match node {
        PaneNode::Leaf { id, .. } => {
            if let Some(n) = trailing_ordinal(id) {
                counters.panes = counters.panes.max(n);
            }
        }
        PaneNode::Split { id, children, .. } => {
            if let Some(n) = trailing_ordinal(id) {
                counters.splits = counters.splits.max(n);
            }
            for child in children {
                walk_ids(child, counters);
            }
        }
    }
}

/// The number off the end of `files-12`, or `None` for an id that does not end
/// in one. Ids restored from a file this module did not write are not assumed
/// to follow the scheme.
fn trailing_ordinal(id: &str) -> Option<u32> {
    id.rsplit_once('-')?.1.parse().ok()
}

/// ConPTY and PowerShell commonly set a terminal's title to the full working
/// directory rather than a name — `C:\Users\bjsea\...\orchestrator` is a
/// useless tab label where `orchestrator` is a good one. So: when the whole
/// reported title parses as an absolute path, this keeps only its last
/// component; anything else — a program's own chosen name, like a coding
/// harness's session name — passes through untouched.
///
/// "Absolute" is judged loosely on purpose — a leading `/` (POSIX) or a drive
/// letter followed by `:\` or `:/` (Windows) — rather than a strict parse, and
/// both separator styles are recognised regardless of which OS this binary is
/// running on: a Windows shell's report is a Windows path even if this were
/// ever compiled for another platform, and `std::path::Path` would only honour
/// the separator of whatever platform it was built for.
fn shorten_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let bytes = trimmed.as_bytes();
    let is_windows_abs = bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_posix_abs = trimmed.starts_with('/');

    if !is_windows_abs && !is_posix_abs {
        return trimmed.to_string();
    }

    trimmed
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

// --- grouping ----------------------------------------------------------------
//
// Split out of the `&AppHandle`-taking methods above so the logic can be unit
// tested against a bare `Vec<TerminalSession>` — nothing here talks to Tauri,
// and nothing here should have to.

/// Remove `id`, and tidy up the group it leaves behind.
///
/// A group of one is not a group — grouping exists so a split's panes have
/// something to sit beside, and a lone survivor has nothing to. Clearing its
/// `group_id` here is what makes "closing the last member removes the group"
/// true as a matter of state, not just a coincidence of nobody else sharing
/// the id.
fn close_terminal_pure(terminals: &mut Vec<TerminalSession>, id: &str) {
    let group = terminals
        .iter()
        .find(|t| t.id == id)
        .and_then(|t| t.group_id.clone());
    terminals.retain(|t| t.id != id);

    if let Some(gid) = group {
        let mut members = terminals
            .iter_mut()
            .filter(|t| t.group_id.as_deref() == Some(gid.as_str()));
        if let Some(only) = members.next() {
            if members.next().is_none() {
                only.group_id = None;
            }
        }
    }
}

/// Put `id` into `sibling_id`'s group, creating one if `sibling_id` doesn't
/// have one yet. Returns the group id assigned, or `None` if `sibling_id`
/// isn't a live session.
fn group_with_pure(
    terminals: &mut [TerminalSession],
    sibling_id: &str,
    id: &str,
) -> Option<String> {
    let existing = terminals
        .iter()
        .find(|t| t.id == sibling_id)?
        .group_id
        .clone();
    let gid = existing.unwrap_or_else(|| format!("group-{sibling_id}"));

    for t in terminals.iter_mut() {
        if t.id == sibling_id || t.id == id {
            t.group_id = Some(gid.clone());
        }
    }
    Some(gid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, group: Option<&str>) -> TerminalSession {
        in_cluster("cluster-1", id, group)
    }

    fn in_cluster(cluster_id: &str, id: &str, group: Option<&str>) -> TerminalSession {
        TerminalSession {
            id: id.to_string(),
            title: id.to_string(),
            cluster_id: cluster_id.to_string(),
            agent_finished: false,
            group_id: group.map(str::to_string),
        }
    }

    #[test]
    fn splitting_assigns_a_shared_group() {
        let mut terminals = vec![session("term-1", None), session("term-2", None)];
        let gid = group_with_pure(&mut terminals, "term-1", "term-2").expect("term-1 exists");

        assert_eq!(terminals[0].group_id.as_deref(), Some(gid.as_str()));
        assert_eq!(terminals[1].group_id.as_deref(), Some(gid.as_str()));
    }

    #[test]
    fn splitting_reuses_an_existing_group_rather_than_minting_a_second_one() {
        let mut terminals = vec![
            session("term-1", Some("group-term-1")),
            session("term-2", Some("group-term-1")),
            session("term-3", None),
        ];
        let gid = group_with_pure(&mut terminals, "term-1", "term-3").expect("term-1 exists");

        assert_eq!(
            gid, "group-term-1",
            "a third pane joins the group that's already there"
        );
        assert_eq!(terminals[2].group_id.as_deref(), Some("group-term-1"));
    }

    #[test]
    fn splitting_from_an_unknown_session_assigns_nothing() {
        let mut terminals = vec![session("term-1", None)];
        assert_eq!(
            group_with_pure(&mut terminals, "term-missing", "term-1"),
            None
        );
        assert_eq!(terminals[0].group_id, None);
    }

    #[test]
    fn closing_one_member_leaves_the_other() {
        let mut terminals = vec![
            session("term-1", Some("group-term-1")),
            session("term-2", Some("group-term-1")),
        ];
        close_terminal_pure(&mut terminals, "term-2");

        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].id, "term-1");
        assert_eq!(
            terminals[0].group_id, None,
            "a group of one stops being a group"
        );
    }

    #[test]
    fn closing_the_last_member_removes_the_group() {
        let mut terminals = vec![
            session("term-1", Some("group-term-1")),
            session("term-2", Some("group-term-1")),
        ];
        close_terminal_pure(&mut terminals, "term-1");
        close_terminal_pure(&mut terminals, "term-2");

        assert!(
            terminals.is_empty(),
            "no empty tab and no orphan group left behind"
        );
    }

    #[test]
    fn closing_an_ungrouped_session_touches_no_one_else() {
        let mut terminals = vec![session("term-1", None), session("term-2", None)];
        close_terminal_pure(&mut terminals, "term-1");

        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].id, "term-2");
    }

    #[test]
    fn shorten_title_keeps_the_last_segment_of_an_absolute_path() {
        assert_eq!(
            shorten_title(r"C:\Users\bjsea\Documents\Viestra\code\helve\orchestrator"),
            "orchestrator",
            "a Windows path collapses to its final component"
        );
        assert_eq!(
            shorten_title("/home/braden/code/helve/orchestrator"),
            "orchestrator",
            "a POSIX path collapses to its final component"
        );
    }

    #[test]
    fn shorten_title_passes_a_plain_name_through_untouched() {
        assert_eq!(
            shorten_title("kaava-shell-finishing-touches"),
            "kaava-shell-finishing-touches",
            "a title that isn't a path form must not be mistaken for one"
        );
    }

    #[test]
    fn shorten_title_of_empty_string_is_empty() {
        assert_eq!(
            shorten_title(""),
            "",
            "an empty report has nothing to shorten"
        );
    }

    // --- id counters, the part a restore gets wrong quietly -----------------

    fn snapshot_with(instances: &[(&str, &str)], panes: &[&str]) -> ShellSnapshot {
        let mut tree = PaneNode::leaf(panes[0]);
        for (i, pane) in panes.iter().enumerate().skip(1) {
            tree.split_pane(
                panes[0],
                SplitDir::Row,
                &format!("split-{i}"),
                pane,
                instances.get(i).map_or("x", |(id, _)| *id),
                false,
            );
        }
        ShellSnapshot {
            windows: vec![WindowPlacement {
                label: "main".to_string(),
                clusters: vec![Cluster {
                    id: "cluster-3".to_string(),
                    name: "w".to_string(),
                    tree,
                    project: None,
                    worktree: None,
                    active_terminal: None,
                    band_height: None,
                    page: None,
                    environment: None,
                    pinned: false,
                }],
                active_cluster_id: Some("cluster-3".to_string()),
                geometry: None,
            }],
            instances: instances
                .iter()
                .map(|(id, app_id)| SurfaceInstance {
                    id: (*id).to_string(),
                    app_id: (*app_id).to_string(),
                    kind: SurfaceKind::App,
                    title: (*id).to_string(),
                })
                .collect(),
            terminals: vec![in_cluster("cluster-3", "term-7", None)],
        }
    }

    /// The bug this catches: a session that opened five Files and closed four
    /// leaves one live `files-5`. A counter derived from "one Files exists"
    /// hands out `files-2`, and four opens later two surfaces share an id —
    /// at which point every message for either reaches whichever the lookup
    /// happens to find first.
    #[test]
    fn restored_counters_resume_past_the_highest_id_not_the_count() {
        let snapshot = snapshot_with(&[("files-5", "files")], &["pane-9"]);
        let counters = counters_for(&snapshot);

        assert_eq!(counters.instances.get("files"), Some(&5));
        assert_eq!(counters.terminals, 7);
        assert_eq!(counters.panes, 9);
        assert_eq!(counters.clusters, 3);
    }

    #[test]
    fn restored_counters_are_per_app_not_shared() {
        let snapshot = snapshot_with(&[("files-4", "files"), ("home-1", "home")], &["pane-2"]);
        let counters = counters_for(&snapshot);

        assert_eq!(counters.instances.get("files"), Some(&4));
        assert_eq!(
            counters.instances.get("home"),
            Some(&1),
            "home must not inherit files' high-water mark"
        );
    }

    #[test]
    fn an_id_that_does_not_follow_the_scheme_is_ignored_rather_than_panicking() {
        assert_eq!(trailing_ordinal("files-3"), Some(3));
        assert_eq!(trailing_ordinal("files"), None);
        assert_eq!(trailing_ordinal("files-abc"), None);
        assert_eq!(trailing_ordinal(""), None);
    }

    #[test]
    fn a_seeded_window_has_somewhere_to_put_things() {
        let mut counters = Counters::default();
        let window = seed_window(&mut counters, "main");

        assert_eq!(window.clusters.len(), 1, "a window always has a cluster");
        assert!(
            window.active_cluster_id.is_some(),
            "and is always showing one of them"
        );
        assert!(
            !window.clusters[0].tree.first_pane_id().is_empty(),
            "and that cluster always has a pane to receive a surface"
        );
    }

    /// The whole state goes to disk and comes back at launch. A field that
    /// serializes and does not deserialize is a layout that silently resets on
    /// every restart, which is the one failure this feature exists to prevent.
    #[test]
    fn the_whole_snapshot_survives_a_json_round_trip() {
        let snapshot = snapshot_with(
            &[("files-1", "files"), ("files-2", "files")],
            &["pane-1", "pane-2"],
        );

        let json = serde_json::to_string(&snapshot).expect("a snapshot serializes");
        let back: ShellSnapshot = serde_json::from_str(&json).expect("and reads back");

        assert_eq!(back.instances.len(), snapshot.instances.len());
        assert_eq!(
            back.windows[0].clusters[0].tree,
            snapshot.windows[0].clusters[0].tree
        );
        assert_eq!(back.terminals[0].cluster_id, "cluster-3");
    }

    // --- the band belongs to the cluster ------------------------------------

    fn window(label: &str, cluster: &str, tabs: &[&str]) -> WindowPlacement {
        let mut tree = PaneNode::leaf("pane-1");
        for tab in tabs {
            tree.insert_tab("pane-1", tab, None);
        }
        WindowPlacement {
            label: label.to_string(),
            clusters: vec![Cluster {
                id: cluster.to_string(),
                name: cluster.to_string(),
                tree,
                project: None,
                worktree: None,
                active_terminal: None,
                band_height: None,
                page: None,
                environment: None,
                pinned: false,
            }],
            active_cluster_id: Some(cluster.to_string()),
            geometry: None,
        }
    }

    /// The first cluster of the first window, by the name `window` gives it.
    fn cluster_mut<'a>(s: &'a mut ShellSnapshot, id: &str) -> &'a mut Cluster {
        s.windows
            .iter_mut()
            .flat_map(|w| w.clusters.iter_mut())
            .find(|c| c.id == id)
            .expect("a cluster by that name")
    }

    fn state(windows: Vec<WindowPlacement>, terminals: Vec<TerminalSession>) -> ShellSnapshot {
        ShellSnapshot {
            windows,
            instances: Vec::new(),
            terminals,
        }
    }

    /// The whole point of the change: a band terminal is its **cluster's**, so
    /// the cluster beside it does not draw it and does not select it.
    ///
    /// This is the inverse of what the same arrangement used to assert. Under
    /// the window-scoped model both clusters shared one panel, and the property
    /// worth pinning was that switching between them left the selection alone.
    #[test]
    fn a_band_terminal_belongs_to_exactly_one_cluster() {
        let mut s = state(
            vec![window("main", "cluster-1", &[])],
            vec![session("term-1", None)],
        );
        s.windows[0].clusters.push(Cluster {
            id: "cluster-2".to_string(),
            name: "cluster-2".to_string(),
            tree: PaneNode::leaf("pane-2"),
            project: None,
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: None,
            pinned: false,
        });

        reseat_active_terminals(&mut s);
        assert_eq!(
            s.windows[0].clusters[0].active_terminal.as_deref(),
            Some("term-1"),
            "the cluster that holds it shows it"
        );
        assert_eq!(
            s.windows[0].clusters[1].active_terminal, None,
            "and the one beside it has an empty band, not a borrowed terminal"
        );
    }

    // --- new-cluster-from-drop inherits its source's environment -----------

    #[test]
    fn a_new_cluster_inherits_its_sources_project_and_worktree() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        cluster_mut(&mut s, "cluster-1").project = Some("/repo".to_string());
        cluster_mut(&mut s, "cluster-1").worktree = Some(WorktreeRef {
            path: "/repo/../.worktrees/repo/flashlight".to_string(),
            branch: Some("wt/flashlight".to_string()),
            base: None,
        });

        let created = add_cluster_for_environment_pure(
            &mut s,
            "main",
            "New",
            "cluster-1",
            "cluster-2",
            "pane-2",
        )
        .expect("main exists");
        assert_eq!(created, ("cluster-2".to_string(), "pane-2".to_string()));

        let made = cluster_mut(&mut s, "cluster-2");
        assert_eq!(made.project.as_deref(), Some("/repo"));
        assert_eq!(
            made.worktree.as_ref().map(|w| w.path.as_str()),
            Some("/repo/../.worktrees/repo/flashlight")
        );
        assert_eq!(
            s.windows[0].active_cluster_id.as_deref(),
            Some("cluster-2"),
            "the new cluster becomes the one on screen, same as add_cluster"
        );
    }

    #[test]
    fn a_new_cluster_from_an_unknown_source_gets_no_environment() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());

        let created = add_cluster_for_environment_pure(
            &mut s,
            "main",
            "New",
            "cluster-missing",
            "cluster-2",
            "pane-2",
        )
        .expect("main exists");

        let made = cluster_mut(&mut s, &created.0);
        assert!(made.project.is_none());
        assert!(made.worktree.is_none());
    }

    #[test]
    fn add_cluster_for_environment_is_refused_for_an_unknown_window() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());

        assert_eq!(
            add_cluster_for_environment_pure(
                &mut s,
                "win-missing",
                "New",
                "cluster-1",
                "cluster-2",
                "pane-2"
            ),
            None
        );
    }

    /// The band's height is the cluster's, and the reported bug is what a single
    /// window-wide height looked like: pull the band up in one cluster, pull it
    /// halfway in the next, and going back showed the second cluster's height.
    ///
    /// Walked in the order the report describes, because the order is the bug —
    /// each write has to land on the cluster that was in front when it happened,
    /// and neither may be readable through the other afterwards.
    #[test]
    fn each_cluster_keeps_its_own_band_height() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        s.windows[0].clusters.push(Cluster {
            id: "cluster-2".to_string(),
            name: "cluster-2".to_string(),
            tree: PaneNode::leaf("pane-2"),
            project: None,
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: None,
            pinned: false,
        });

        // Cluster 1, dragged nearly to the top of the window.
        set_cluster_band_height(&mut s, "cluster-1", 720.0);
        // Then cluster 2 is opened and its band pulled only halfway up.
        set_cluster_band_height(&mut s, "cluster-2", 300.0);

        assert_eq!(
            cluster_mut(&mut s, "cluster-1").band_height,
            Some(720.0),
            "switching back shows the height cluster 1 was left at"
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-2").band_height,
            Some(300.0),
            "and cluster 2 keeps its own rather than inheriting the taller one"
        );
    }

    /// A cluster nobody has dragged the band in has no opinion, which is what
    /// lets the view fall back to `BOTTOM_DEFAULT` instead of to a neighbour's
    /// height. Resizing one must not invent a height for the others.
    #[test]
    fn an_unresized_cluster_has_no_band_height() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        s.windows.push(window("win-2", "cluster-2", &[]));

        set_cluster_band_height(&mut s, "cluster-1", 480.0);

        assert_eq!(
            cluster_mut(&mut s, "cluster-2").band_height,
            None,
            "a cluster in another window is not sized by this one's drag"
        );
    }

    /// A terminal dragged into the layout draws in the pane area, so the band
    /// must stop pointing at it — otherwise the deck and a pane both claim it.
    #[test]
    fn a_terminal_in_a_tree_is_not_the_band_selection() {
        let mut s = state(
            vec![window("main", "cluster-1", &["term-1"])],
            vec![session("term-1", None), session("term-2", None)],
        );
        cluster_mut(&mut s, "cluster-1").active_terminal = Some("term-1".to_string());

        reseat_active_terminals(&mut s);
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").active_terminal.as_deref(),
            Some("term-2"),
            "the band falls back to one it is actually drawing"
        );
    }

    /// What `add_terminal_in_pane` produces: a session that is in the tree from
    /// the moment it exists, and a band selection nobody touched.
    ///
    /// The property is that opening a terminal *in a pane* does not change which
    /// terminal the **band** is showing. Built here as a finished snapshot
    /// rather than by calling the method, which needs an `AppHandle` — what is
    /// worth pinning is that `reseat_active_terminals` sees nothing to repair,
    /// because that is the whole reason the method publishes in one step instead
    /// of adding to the band and moving out of it a broadcast later.
    #[test]
    fn a_terminal_born_in_a_pane_leaves_the_band_selection_alone() {
        let mut s = state(
            vec![window("main", "cluster-1", &["term-3"])],
            vec![
                session("term-1", None),
                session("term-2", None),
                session("term-3", None),
            ],
        );
        cluster_mut(&mut s, "cluster-1").active_terminal = Some("term-2".to_string());

        reseat_active_terminals(&mut s);

        assert_eq!(
            cluster_mut(&mut s, "cluster-1").active_terminal.as_deref(),
            Some("term-2"),
            "the band is still showing what it was showing, not the new terminal \
             and not whichever band terminal happens to be first"
        );
    }

    #[test]
    fn the_active_pane_falls_back_rather_than_addressing_nothing() {
        let shell = ShellState::default();
        shell.restore(state(vec![window("main", "cluster-1", &[])], Vec::new()));

        let first = Some(("cluster-1".to_string(), "pane-1".to_string()));
        assert_eq!(
            shell.active_pane("main", None),
            first,
            "no opinion means the first pane"
        );
        assert_eq!(
            shell.active_pane("main", Some("pane-99")),
            first,
            "a pane id from a layout that has since changed is not addressed"
        );
        assert_eq!(
            shell.active_pane("main", Some("pane-1")),
            first,
            "a pane that is really there is honoured"
        );
        assert_eq!(
            shell.active_pane("nonesuch", None),
            None,
            "no window, no pane"
        );
    }

    #[test]
    fn a_window_with_no_clusters_has_no_pane_to_open_into() {
        let shell = ShellState::default();
        let mut snapshot = state(vec![window("main", "cluster-1", &[])], Vec::new());
        snapshot.windows[0].clusters.clear();
        snapshot.windows[0].active_cluster_id = None;
        shell.restore(snapshot);

        assert_eq!(
            shell.active_pane("main", None),
            None,
            "there is no tree, so there is no pane — the menu disables the row for this"
        );
    }

    #[test]
    fn a_band_never_selects_another_clusters_terminal() {
        let mut s = state(
            vec![
                window("main", "cluster-1", &[]),
                window("win-1", "cluster-2", &[]),
            ],
            vec![in_cluster("cluster-2", "term-1", None)],
        );
        cluster_mut(&mut s, "cluster-1").active_terminal = Some("term-1".to_string());

        reseat_active_terminals(&mut s);
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").active_terminal,
            None,
            "cluster-1 has no terminals"
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-2").active_terminal.as_deref(),
            Some("term-1")
        );
    }

    #[test]
    fn a_live_selection_is_left_exactly_where_it_is() {
        let mut s = state(
            vec![window("main", "cluster-1", &[])],
            vec![session("term-1", None), session("term-2", None)],
        );
        cluster_mut(&mut s, "cluster-1").active_terminal = Some("term-2".to_string());

        reseat_active_terminals(&mut s);
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").active_terminal.as_deref(),
            Some("term-2"),
            "repair only; a deliberate selection is not second-guessed"
        );
    }

    /// `sort_held`'s own narrow job: split a tree's tabs into terminals and
    /// instances. It is deliberately blind to the band — a terminal that was
    /// never in the tree is not in its input at all — which is why
    /// `close_cluster` asks the second question separately.
    #[test]
    fn a_trees_tabs_are_sorted_into_terminals_and_instances() {
        let terminals = vec![session("term-1", None), session("term-2", None)];
        let held = vec!["term-1".to_string(), "files-1".to_string()];

        let (gone, instances) = sort_held(held, &terminals);

        assert_eq!(gone, ["term-1"], "the one that was a tab");
        assert_eq!(instances, ["files-1"], "and the apps go as instances");
    }

    /// The band's half of the same question, and the rule the user asked for:
    /// closing a cluster kills its terminals.
    ///
    /// This inverts what the window-scoped model asserted here. A band terminal
    /// used to survive the cluster it was opened beside, because it was the
    /// window's; it names the cluster now, so leaving it behind would strand a
    /// live shell with no band anywhere that draws it.
    #[test]
    fn closing_a_cluster_takes_its_band_terminals_with_it() {
        let terminals = vec![
            in_cluster("cluster-1", "term-1", None),
            in_cluster("cluster-2", "term-2", None),
        ];

        assert_eq!(
            terminals_of_cluster(&terminals, "cluster-1"),
            ["term-1"],
            "its own band's, and never the cluster beside it"
        );
        assert_eq!(terminals_of_cluster(&terminals, "cluster-2"), ["term-2"]);
        assert!(
            terminals_of_cluster(&terminals, "cluster-9").is_empty(),
            "a cluster nobody holds has no terminals to take"
        );
    }

    // --- a cluster moving between windows -----------------------------------
    //
    // `move_cluster_pure` is the whole of `detach_cluster`'s bookkeeping. Every
    // test below runs `reseat_active_terminals` after it, because `mutate` does
    // and the band invariant is part of what the move has to leave intact.

    /// Two clusters in `main`, one of them holding `tabs` in its tree.
    fn two_clusters(tabs: &[&str]) -> ShellSnapshot {
        let mut placement = window("main", "cluster-1", &[]);
        let mut tree = PaneNode::leaf("pane-2");
        for tab in tabs {
            tree.insert_tab("pane-2", tab, None);
        }
        placement.clusters.push(Cluster {
            id: "cluster-2".to_string(),
            name: "auth".to_string(),
            tree,
            project: None,
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: None,
            pinned: false,
        });
        state(vec![placement], Vec::new())
    }

    fn moved(s: &mut ShellSnapshot, cluster_id: &str, to_label: &str) -> bool {
        let ok = move_cluster_pure(s, cluster_id, to_label);
        reseat_active_terminals(s);
        ok
    }

    /// This was a refusal, and the refusal was the bug. A window holding one
    /// cluster is the commonest window there is, and it is exactly the one
    /// somebody wants to pull onto a second monitor — refusing it meant the
    /// gesture was unavailable in the case it was built for.
    #[test]
    fn detaching_the_only_cluster_in_a_window_empties_that_window() {
        let mut s = state(vec![window("main", "cluster-1", &["files-1"])], Vec::new());

        assert!(moved(&mut s, "cluster-1", "win-1"), "allowed");
        assert_eq!(s.windows.len(), 2, "and a window entry was made for it");
        assert_eq!(s.windows[1].label, "win-1");
        assert_eq!(s.windows[1].clusters.len(), 1, "the cluster arrived");
        assert!(
            s.windows[0].clusters.is_empty(),
            "and the window it left is empty, which NoClustersState draws"
        );
        assert_eq!(
            s.windows[0].active_cluster_id, None,
            "with nothing selected, rather than naming a cluster that has gone"
        );
    }

    #[test]
    fn a_detached_cluster_arrives_with_its_whole_tree() {
        let mut s = two_clusters(&["files-1", "files-2"]);
        let before = s.windows[0].clusters[1].tree.clone();

        assert!(moved(&mut s, "cluster-2", "win-1"));

        assert_eq!(s.windows.len(), 2, "a window entry was made for it");
        let new = &s.windows[1];
        assert_eq!(new.label, "win-1");
        assert_eq!(new.clusters.len(), 1);
        assert_eq!(
            new.clusters[0].tree, before,
            "the tree came across unchanged"
        );
        assert_eq!(new.active_cluster_id.as_deref(), Some("cluster-2"));
        assert_eq!(
            s.windows[0].clusters.len(),
            1,
            "and it is no longer in the window it left"
        );
    }

    /// A detached cluster takes its terminals with it, and nothing in
    /// `move_cluster_pure` has to arrange that — they name the cluster, and the
    /// cluster is what moved.
    ///
    /// The failure this used to prevent no longer exists in the same shape: a
    /// terminal could be drawn as a tab in the new window while still claiming
    /// the old window's panel, so the move had to rewrite a label on every one
    /// it found in the tree, and anything it missed landed two monitors from
    /// where it was on screen. There is no label to miss now.
    #[test]
    fn terminals_travel_with_the_cluster_they_belong_to() {
        let mut s = two_clusters(&["term-1", "files-1"]);
        s.terminals = vec![
            in_cluster("cluster-2", "term-1", None), // dragged into cluster-2's tree
            in_cluster("cluster-1", "term-2", None), // sitting in cluster-1's band
        ];

        assert!(moved(&mut s, "cluster-2", "win-1"));

        assert_eq!(
            s.terminals[0].cluster_id, "cluster-2",
            "unchanged, and now on screen in win-1 because its cluster is"
        );
        assert_eq!(
            s.terminals[1].cluster_id, "cluster-1",
            "the other cluster's band terminal stays where it was"
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").active_terminal.as_deref(),
            Some("term-2"),
            "cluster-1's band is unmoved"
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-2").active_terminal,
            None,
            "and a terminal drawn in a tree is not its cluster's band selection"
        );
    }

    #[test]
    fn the_source_windows_active_cluster_falls_to_a_survivor() {
        let mut s = two_clusters(&[]);
        s.windows[0].active_cluster_id = Some("cluster-2".to_string());

        assert!(moved(&mut s, "cluster-2", "win-1"));
        assert_eq!(
            s.windows[0].active_cluster_id.as_deref(),
            Some("cluster-1"),
            "the window it left is still showing something"
        );
    }

    /// Released over another OpenKaava window. A cluster is appended to that
    /// window's list, so a label is the whole of the address — which is why this
    /// works where the same drop for a single tab does not.
    #[test]
    fn a_cluster_dropped_over_another_window_joins_it_rather_than_making_one() {
        let mut s = two_clusters(&["files-1"]);
        s.windows.push(window("win-1", "cluster-9", &[]));

        assert!(moved(&mut s, "cluster-2", "win-1"));

        assert_eq!(s.windows.len(), 2, "no third window");
        assert_eq!(
            s.windows[1].clusters.len(),
            2,
            "it joined the ones already there"
        );
        assert_eq!(s.windows[1].active_cluster_id.as_deref(), Some("cluster-2"));
    }

    #[test]
    fn moving_a_cluster_to_the_window_it_is_already_in_changes_nothing() {
        let mut s = two_clusters(&["files-1"]);

        assert!(
            moved(&mut s, "cluster-2", "main"),
            "it is where it was asked to be"
        );
        assert_eq!(s.windows.len(), 1);
        assert_eq!(
            s.windows[0].clusters.len(),
            2,
            "and it was not moved to the end"
        );
        assert_eq!(s.windows[0].clusters[1].id, "cluster-2");
    }

    // --- a cluster owns its project -----------------------------------------

    /// The lookup every app call now depends on: an `invoke` arrives naming an
    /// instance, and the project it is answered against is whichever cluster's
    /// tree holds that instance. Getting this wrong roots a Files at the wrong
    /// project rather than failing, which is the reason it is tested at all.
    #[test]
    fn an_instance_resolves_to_the_cluster_whose_tree_holds_it() {
        let s = two_clusters(&["files-2"]);

        assert_eq!(
            cluster_of_instance_pure(&s, "files-2").as_deref(),
            Some("cluster-2"),
            "the second cluster's tree is the one holding it"
        );
        assert_eq!(
            cluster_of_instance_pure(&s, "files-99"),
            None,
            "an instance nobody holds resolves to no cluster rather than to the first one"
        );
    }

    /// Two clusters, two projects, at once. This is the whole feature stated as
    /// a property: nothing about setting one cluster's project can reach
    /// another's, because there is no shared field left for it to reach.
    #[test]
    fn two_clusters_hold_two_different_projects() {
        let mut s = two_clusters(&[]);
        s.windows[0].clusters[0].project = Some(r"C:\code\aurora".to_string());
        s.windows[0].clusters[1].project = Some(r"C:\code\borealis".to_string());

        assert_eq!(
            s.windows[0].clusters[0].project.as_deref(),
            Some(r"C:\code\aurora")
        );
        assert_eq!(
            s.windows[0].clusters[1].project.as_deref(),
            Some(r"C:\code\borealis")
        );
    }

    /// A cluster's project travels with it into another window, which is what
    /// makes "a project per monitor" the same act as "a cluster per monitor".
    #[test]
    fn a_detached_cluster_takes_its_project_with_it() {
        let mut s = two_clusters(&["files-1"]);
        s.windows[0].clusters[1].project = Some(r"C:\code\auth".to_string());

        assert!(moved(&mut s, "cluster-2", "win-1"));

        assert_eq!(
            s.windows[1].clusters[0].project.as_deref(),
            Some(r"C:\code\auth"),
            "the cluster is the project's owner, so moving one moves the other"
        );
    }

    /// Braden has a `layout.json` on disk right now, written before a cluster
    /// had a project. A missing key must read as "no project yet" — the
    /// migration in `lib.rs` then seeds it — and never as a parse failure,
    /// which would silently reset the whole saved session.
    #[test]
    fn a_cluster_stored_without_a_project_still_loads() {
        let json = r#"{
            "id": "cluster-1",
            "name": "orchestrator",
            "tree": { "kind": "leaf", "id": "pane-1", "tabs": [], "activeTab": null },
            "worktree": null
        }"#;

        let restored: Cluster = serde_json::from_str(json).expect("an older cluster still reads");
        assert_eq!(restored.project, None);
        assert_eq!(restored.id, "cluster-1");
    }

    /// The counterpart: a project written today comes back tomorrow. A field
    /// that serializes and does not deserialize would be a project that resets
    /// on every launch, which is the failure the whole per-cluster model exists
    /// to make impossible.
    #[test]
    fn a_clusters_project_survives_a_json_round_trip() {
        let mut s = two_clusters(&[]);
        s.windows[0].clusters[0].project = Some(r"C:\code\aurora".to_string());

        let json = serde_json::to_string(&s).expect("a snapshot serializes");
        let back: ShellSnapshot = serde_json::from_str(&json).expect("and reads back");

        assert_eq!(
            back.windows[0].clusters[0].project.as_deref(),
            Some(r"C:\code\aurora")
        );
        assert_eq!(back.windows[0].clusters[1].project, None);
    }

    /// The shells go where their cluster goes, and that is what makes an emptied
    /// window an honestly empty one.
    ///
    /// This test used to assert the opposite, and the reversal is the change in
    /// one line: the panel was the *window's*, so dragging the last cluster out
    /// left the shells behind beside an empty app area, still selected. That was
    /// the argument for allowing the drag at all. The band is the cluster's, so
    /// they leave with it — and what is left behind is a window with nothing in
    /// it, which `NoClustersState` already draws and names the way out of.
    #[test]
    fn a_window_emptied_by_a_drag_keeps_none_of_the_clusters_terminals() {
        let mut s = state(
            vec![window("main", "cluster-1", &["files-1"])],
            vec![session("term-1", None)],
        );
        cluster_mut(&mut s, "cluster-1").active_terminal = Some("term-1".to_string());

        assert!(moved(&mut s, "cluster-1", "win-1"));

        assert!(s.windows[0].clusters.is_empty(), "the cluster left");
        assert_eq!(
            s.terminals[0].cluster_id, "cluster-1",
            "the shell still names it, and is therefore drawn in win-1 now"
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").active_terminal.as_deref(),
            Some("term-1"),
            "and its band is still showing it, wherever that band is on screen"
        );
    }

    // --- restoring a layout that predates any of this ------------------------

    /// A `layout.json` written while a terminal named a window has a
    /// `windowLabel` and no cluster id. That deserializes to `""`, which names
    /// no cluster, and `adopt_orphan_terminals` is what stops every restored
    /// shell from being drawn by no band anywhere while `respawn_terminals`
    /// starts it anyway — which looks exactly like the ptys having failed.
    #[test]
    fn a_terminal_stored_without_a_cluster_is_adopted_by_the_first_one() {
        let mut s = state(
            vec![window("main", "cluster-1", &[])],
            vec![in_cluster("", "term-1", None)],
        );

        adopt_orphan_terminals(&mut s);
        assert_eq!(s.terminals[0].cluster_id, "cluster-1");
    }

    /// A terminal naming a cluster that has since gone is the same problem
    /// arriving by a different road — a file hand-edited, or one written by a
    /// build that closed clusters differently. Same answer.
    #[test]
    fn a_terminal_naming_a_cluster_that_is_gone_is_adopted_too() {
        let mut s = state(
            vec![window("main", "cluster-1", &[])],
            vec![in_cluster("cluster-99", "term-1", None)],
        );

        adopt_orphan_terminals(&mut s);
        assert_eq!(s.terminals[0].cluster_id, "cluster-1");
    }

    /// With no cluster anywhere there is nothing to adopt into, and a session
    /// kept in that state would be an entry no band could ever draw or close.
    /// Nothing is lost by dropping it: at restore there is no pty behind it yet.
    #[test]
    fn a_terminal_with_nowhere_to_go_is_dropped_rather_than_kept() {
        let mut s = state(Vec::new(), vec![session("term-1", None)]);

        adopt_orphan_terminals(&mut s);
        assert!(s.terminals.is_empty());
    }

    /// And a terminal that already names a live cluster is not touched — this
    /// runs on every restore, including the ones with nothing to migrate.
    #[test]
    fn adoption_leaves_a_terminal_that_already_has_a_cluster_alone() {
        let mut s = state(
            vec![
                window("main", "cluster-1", &[]),
                window("win-1", "cluster-2", &[]),
            ],
            vec![in_cluster("cluster-2", "term-1", None)],
        );

        adopt_orphan_terminals(&mut s);
        assert_eq!(
            s.terminals[0].cluster_id, "cluster-2",
            "not re-homed onto the first cluster it could find"
        );
    }

    // --- Home's dismissal ----------------------------------------------------

    fn home_instance(id: &str) -> SurfaceInstance {
        SurfaceInstance {
            id: id.to_string(),
            app_id: "home".to_string(),
            kind: SurfaceKind::App,
            title: "Home".to_string(),
        }
    }

    fn app_instance(id: &str, app_id: &str) -> SurfaceInstance {
        SurfaceInstance {
            id: id.to_string(),
            app_id: app_id.to_string(),
            kind: SurfaceKind::App,
            title: id.to_string(),
        }
    }

    #[test]
    fn dismiss_takeover_closes_it_when_it_shares_a_pane_with_something_else() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "home-1", None);
        tree.insert_tab("p1", "files-1", None);
        let mut instances = vec![home_instance("home-1"), app_instance("files-1", "files")];

        let evicted = dismiss_takeover(&mut tree, "p1", &mut instances);

        assert_eq!(evicted.as_deref(), Some("home-1"));
        assert_eq!(tree.tabs_in("p1"), Some(&["files-1".to_string()][..]));
        assert!(
            !instances.iter().any(|i| i.id == "home-1"),
            "the instance is closed, not just the tab"
        );
    }

    /// Tutorials covers the cluster the same way Home does, so it is dismissed
    /// by the same arrival. Without this it would be a pane with no tab in the
    /// switcher row and no close button — unreachable and unremovable.
    #[test]
    fn dismiss_takeover_closes_a_tutorial_too() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "tutorial-1", None);
        tree.insert_tab("p1", "files-1", None);
        let mut instances = vec![
            app_instance("tutorial-1", "tutorial"),
            app_instance("files-1", "files"),
        ];

        assert_eq!(
            dismiss_takeover(&mut tree, "p1", &mut instances).as_deref(),
            Some("tutorial-1")
        );
        assert!(!instances.iter().any(|i| i.id == "tutorial-1"));
    }

    /// The rule `open_instance` guards on. A tutorial opened from a card on
    /// Home must *cover* that Home rather than evict it — closing the tutorial
    /// has to put the reader back on the screen they left, and on a cluster
    /// holding nothing else an eviction would strand them on an empty pane.
    #[test]
    fn one_takeover_surface_does_not_evict_another() {
        assert!(is_takeover_app("home"));
        assert!(is_takeover_app("tutorial"));
        assert!(!is_takeover_app("files"));
        assert!(!is_takeover_app("viewer"));
        assert!(
            !is_takeover_app(crate::apps::TERMINAL_ID),
            "a terminal takes a pane like anything else"
        );
    }

    #[test]
    fn dismiss_takeover_does_nothing_to_a_pane_without_home_in_it() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        let mut instances = vec![app_instance("files-1", "files")];

        assert_eq!(dismiss_takeover(&mut tree, "p1", &mut instances), None);
        assert_eq!(tree.tabs_in("p1"), Some(&["files-1".to_string()][..]));
        assert_eq!(instances.len(), 1);
    }

    /// The mechanism behind the single-pane case: `open_into` only splits a
    /// pane that is not empty, so a pane holding nothing but Home has to read
    /// as empty *before* `open_into` decides, or the surface opened over Home
    /// gains a sibling pane instead of taking Home's.
    #[test]
    fn dismiss_takeover_leaves_a_home_only_pane_empty_afterward() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "home-1", None);
        let mut instances = vec![home_instance("home-1")];

        dismiss_takeover(&mut tree, "p1", &mut instances);

        assert_eq!(tree.tabs_in("p1"), Some(&[][..]));
    }

    // --- `place_surface` ----------------------------------------------------
    //
    // Every property an arrival into a pane has, exercised against the one
    // function that now provides them all. Three of these are defects that
    // shipped: opening an app over a Home alone in a split cluster placed
    // nothing at all, dragging a tab between two panes of one cluster drew it
    // in both, and a pane id a render out of date refused the open outright.
    // Every one of them was invisible in a cluster of a single pane, which is
    // the shape the tests that came before these all used.

    /// The `#45` case, and the one the single-pane test above cannot reach.
    ///
    /// Opening an app while Home covers a **split** cluster: Home is alone in
    /// its pane, so evicting it empties that pane, and pruning there deleted it
    /// — leaving `open_into` naming a pane that no longer existed. The open
    /// returned false, `open_instance` handed the command an `UnknownTool`
    /// error, and the app the user asked for simply never appeared.
    #[test]
    fn opening_over_a_takeover_alone_in_a_split_cluster_takes_its_pane() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        tree.split_pane("p1", SplitDir::Row, "s1", "p2", "home-1", false);
        let mut instances = vec![app_instance("files-1", "files"), home_instance("home-1")];

        let placed = place_surface(
            &mut tree,
            &mut instances,
            "design-1",
            Some("p2"),
            None,
            Some((SplitDir::Row, "s2", "p3")),
            true,
        );

        assert!(placed, "the surface has to land somewhere");
        assert_eq!(
            tree.tabs_in("p2"),
            Some(&["design-1".to_string()][..]),
            "it takes the pane the takeover surface was in, rather than splitting it"
        );
        assert!(
            !instances.iter().any(|i| i.id == "home-1"),
            "and the takeover surface is closed, not merely hidden"
        );
    }

    /// A tab dragged from one pane to another **inside one cluster**.
    ///
    /// `move_instance` swept every cluster but the target one, and `insert_tab`
    /// only ever removed within the pane it was inserting into — so the tab was
    /// copied rather than moved. Two panes then named one instance, which is
    /// one surface drawn twice and two tabs that disagree about where it is.
    #[test]
    fn moving_a_tab_between_two_panes_of_one_cluster_moves_it() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        tree.split_pane("p1", SplitDir::Row, "s1", "p2", "viewer-1", false);
        let mut instances = vec![
            app_instance("files-1", "files"),
            app_instance("viewer-1", "viewer"),
        ];

        assert!(place_surface(
            &mut tree,
            &mut instances,
            "files-1",
            Some("p2"),
            None,
            None,
            true,
        ));

        assert_eq!(
            tree.tabs(),
            vec!["viewer-1", "files-1"],
            "one copy, in the pane it was dropped into"
        );
        assert_eq!(
            tree.tabs_in("p1"),
            None,
            "the pane it emptied collapsed with it — the one case `place_surface` prunes for"
        );
        assert_eq!(tree.pane_count(), 1);
    }

    /// Dropping a tab back into the pane it was the only occupant of.
    ///
    /// The case that makes the removal in `place_surface` have to be unpruned:
    /// taking the tab out empties the pane, and a prune there would delete the
    /// very pane the drop names.
    #[test]
    fn dropping_a_pane_s_only_tab_back_into_it_keeps_the_pane() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        tree.split_pane("p1", SplitDir::Row, "s1", "p2", "viewer-1", false);
        let mut instances = vec![
            app_instance("files-1", "files"),
            app_instance("viewer-1", "viewer"),
        ];

        assert!(place_surface(
            &mut tree,
            &mut instances,
            "viewer-1",
            Some("p2"),
            Some(0),
            None,
            true,
        ));

        assert_eq!(tree.tabs_in("p2"), Some(&["viewer-1".to_string()][..]));
        assert_eq!(tree.pane_count(), 2, "nothing collapsed under it");
    }

    /// A pane id from a layout that has since changed lands in the first pane
    /// rather than refusing the open — the same forgiveness `active_pane`
    /// documents, and the thing that keeps the close-then-open pair the shell
    /// fires when it uncovers Home from racing itself into a silent failure.
    #[test]
    fn placing_into_a_pane_that_has_gone_falls_back_to_the_first_one() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        let mut instances = vec![app_instance("files-1", "files")];

        assert!(place_surface(
            &mut tree,
            &mut instances,
            "design-1",
            Some("pane-99"),
            None,
            None,
            true,
        ));

        assert!(tree.tabs().contains(&"design-1"));
    }

    /// A takeover surface arriving does not evict the one already there, and
    /// the caller says so rather than this deciding — `open_instance` passes
    /// `false` for Home and Tutorials, every other path passes `true`.
    #[test]
    fn placing_without_eviction_leaves_the_takeover_surface_alone() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "home-1", None);
        let mut instances = vec![home_instance("home-1")];

        assert!(place_surface(
            &mut tree,
            &mut instances,
            "tutorial-1",
            Some("p1"),
            None,
            None,
            false,
        ));

        assert_eq!(
            tree.tabs_in("p1"),
            Some(&["home-1".to_string(), "tutorial-1".to_string()][..]),
            "the tutorial covers Home; closing it has to put Home back"
        );
        assert!(instances.iter().any(|i| i.id == "home-1"));
    }

    #[test]
    fn dismiss_takeover_leaves_the_panes_other_tabs_and_active_tab_alone() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        tree.insert_tab("p1", "home-1", None);
        tree.insert_tab("p1", "viewer-1", None);
        tree.activate_tab("files-1");
        let mut instances = vec![
            app_instance("files-1", "files"),
            home_instance("home-1"),
            app_instance("viewer-1", "viewer"),
        ];

        dismiss_takeover(&mut tree, "p1", &mut instances);

        let PaneNode::Leaf {
            tabs, active_tab, ..
        } = &tree
        else {
            panic!("expected a leaf");
        };
        assert_eq!(tabs, &["files-1".to_string(), "viewer-1".to_string()]);
        assert_eq!(
            active_tab.as_deref(),
            Some("files-1"),
            "closing a tab that was not active must not move the active one"
        );
    }

    #[test]
    fn dismiss_crowded_takeover_evicts_home_from_whichever_pane_it_ended_up_sharing() {
        // The shape a preset's leftover sweep produces: an unclaimed Home
        // lands in the last pane alongside whatever else is already there.
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "files-1", None);
        tree.split_pane("p1", SplitDir::Row, "s1", "p2", "term-1", false);
        tree.insert_tab("p2", "home-1", None);

        let mut instances = vec![app_instance("files-1", "files"), home_instance("home-1")];

        dismiss_crowded_takeover(&mut tree, &mut instances);

        assert_eq!(
            tree.tabs_in("p1"),
            Some(&["files-1".to_string()][..]),
            "untouched — Home was never here"
        );
        assert_eq!(
            tree.tabs_in("p2"),
            Some(&["term-1".to_string()][..]),
            "Home is gone, the terminal it was swept in beside stays"
        );
        assert!(!instances.iter().any(|i| i.id == "home-1"));
    }

    /// The other half of the rule: a pane Home ended up in alone is not
    /// touched, because nothing else arrived *into that pane* for it to be
    /// dismissed on behalf of.
    #[test]
    fn dismiss_crowded_takeover_leaves_home_alone_when_nothing_shares_its_pane() {
        let mut tree = PaneNode::leaf("p1");
        tree.insert_tab("p1", "home-1", None);
        let mut instances = vec![home_instance("home-1")];

        dismiss_crowded_takeover(&mut tree, &mut instances);

        assert_eq!(tree.tabs_in("p1"), Some(&["home-1".to_string()][..]));
        assert_eq!(instances.len(), 1);
    }

    /// The case only the post-apply sweep can catch: both slots a preset asks
    /// for are already open, so `plan` claims them directly and leaves zero
    /// gaps — nothing opens afterward to run `dismiss_takeover`'s pre-insertion
    /// check, so if the leftover sweep crowds Home's pane, `rearrange` itself
    /// has to be what clears it.
    #[test]
    fn applying_a_preset_closes_home_when_the_leftover_sweep_crowds_its_pane() {
        let mut placement = window("main", "cluster-1", &["files-1", "files-2", "home-1"]);
        let mut instances = vec![
            app_instance("files-1", "files"),
            app_instance("files-2", "files"),
            home_instance("home-1"),
        ];
        let terminals = Vec::new();

        let root = presets::builtins()[1].root.clone(); // "Two Files"
        let mut ids = presets::Ids::new(
            vec!["pane-1".to_string(), "pane-2".to_string()],
            vec!["split-1".to_string()],
        );

        let gaps = rearrange(
            &mut placement.clusters[0],
            &mut instances,
            &terminals,
            &root,
            &mut ids,
        );

        assert!(gaps.is_empty(), "both Files were already open");
        assert!(
            !instances.iter().any(|i| i.id == "home-1"),
            "the leftover sweep crowded Home's pane, and rearrange closed it there"
        );
        assert_eq!(
            placement.clusters[0].tree.tabs(),
            vec!["files-1", "files-2"],
            "both files kept their place; nothing but Home was closed"
        );
    }

    /// The sequence `project::open` actually runs: a brand-new cluster holding
    /// only Home applies `PROJECT_OPEN_PRESET_ID`, then `fill_preset_gaps`
    /// opens Files, the viewer, and a terminal into the panes the
    /// apply left as gaps. Home is unclaimed by every slot, so it survives the
    /// apply itself, alone in the pane the leftover sweep put it in — and is
    /// only closed once something is opened *into that exact pane*, which is
    /// what filling the terminal gap does. This drives both halves in the
    /// order production does, through the same `dismiss_takeover`/`open_into`
    /// pair `add_terminal_in_pane` calls, to prove the two mechanisms this
    /// module has for dismissing Home actually compose into "gone by the time
    /// a project finishes opening" rather than each looking sufficient in
    /// isolation.
    #[test]
    fn a_project_opening_onto_an_empty_cluster_ends_with_home_closed() {
        let mut placement = window("main", "cluster-1", &["home-1"]);
        let mut instances = vec![home_instance("home-1")];
        let terminals: Vec<TerminalSession> = Vec::new();

        let preset = presets::builtins()
            .into_iter()
            .find(|p| p.id == presets::PROJECT_OPEN_PRESET_ID)
            .expect("it is one of the built-ins");
        let mut ids = presets::Ids::new(
            (1..=preset.root.pane_count())
                .map(|n| format!("pane-{n}"))
                .collect(),
            (1..=preset.root.split_count())
                .map(|n| format!("split-{n}"))
                .collect(),
        );

        let gaps = rearrange(
            &mut placement.clusters[0],
            &mut instances,
            &terminals,
            &preset.root,
            &mut ids,
        );

        assert!(
            instances.iter().any(|i| i.id == "home-1"),
            "Home is still open — the apply only rearranged, it did not close anything"
        );
        assert_eq!(
            gaps.len(),
            3,
            "files, viewer and a terminal are all missing"
        );

        // Filling the app gaps (Files, the viewer) lands in panes Home was
        // never in, so they evict too but find nothing to evict.
        for gap in &gaps {
            if let presets::PresetSlot::App { app_id } = &gap.slot {
                let instance_id = format!("{app_id}-1");
                assert!(place_surface(
                    &mut placement.clusters[0].tree,
                    &mut instances,
                    &instance_id,
                    Some(&gap.pane_id),
                    None,
                    None,
                    true,
                ));
            }
        }
        assert!(
            instances.iter().any(|i| i.id == "home-1"),
            "Home was in none of those panes, so it is still here"
        );

        // The terminal gap is the pane the leftover sweep actually put Home
        // in — `add_terminal_in_pane`'s own `place_surface` call, run here
        // directly since spawning a real pty needs an `AppHandle`.
        let terminal_gap = gaps
            .iter()
            .find(|g| g.slot == presets::PresetSlot::Terminal)
            .expect("the preset asks for a terminal");
        assert!(place_surface(
            &mut placement.clusters[0].tree,
            &mut instances,
            "term-1",
            Some(&terminal_gap.pane_id),
            None,
            None,
            true,
        ));

        assert!(
            !instances.iter().any(|i| i.id == "home-1"),
            "Home is gone once a project has finished opening"
        );
        assert!(
            !placement.clusters[0].tree.tabs().contains(&"home-1"),
            "and not just closed as an instance — no pane still names it"
        );
        // The assertion this test was missing, and the reason `#45` survived it:
        // it proved Home had gone without ever proving the terminal had
        // arrived. It had not — evicting Home pruned the pane away underneath
        // the very call that was about to fill it, so a project opened with a
        // terminal slot in its preset and no terminal in its layout.
        assert_eq!(
            placement.clusters[0].tree.tabs_in(&terminal_gap.pane_id),
            Some(&["term-1".to_string()][..]),
            "the terminal is in the pane the preset asked for, not banished to the band"
        );
    }

    // --- pages ---------------------------------------------------------------

    fn agents() -> &'static crate::pages::Page {
        crate::pages::find("agents").expect("Agents is a page in this build")
    }

    fn seed(n: u32) -> Option<PageSeed> {
        Some(PageSeed {
            cluster_id: format!("cluster-{n}"),
            pane_id: format!("pane-{n}"),
            instance_id: format!("agents-{n}"),
        })
    }

    /// `main` with a real cluster holding `files-1`, then the Agents page
    /// opened into it as `cluster-9`, which leaves the page in front.
    fn with_agents_page() -> ShellSnapshot {
        let mut s = state(vec![window("main", "cluster-1", &["files-1"])], Vec::new());
        s.instances.push(app_instance("files-1", "files"));
        open_page_pure(&mut s, "main", agents(), seed(9)).expect("the page opens");
        s
    }

    #[test]
    fn a_page_cluster_is_made_the_first_time_it_is_opened() {
        let s = with_agents_page();
        let w = &s.windows[0];

        assert_eq!(w.clusters.len(), 2);
        let page = &w.clusters[1];
        assert_eq!(page.id, "cluster-9");
        assert_eq!(page.page.as_deref(), Some("agents"));
        assert_eq!(page.name, "Agents");
        assert_eq!(page.project, None);
        assert_eq!(page.tree.leaf_ids(), vec!["pane-9"], "one pane");
        assert_eq!(page.tree.tabs(), vec!["agents-9"], "one instance");
        assert!(s
            .instances
            .iter()
            .any(|i| i.id == "agents-9" && i.app_id == "agents"));
        assert_eq!(w.active_cluster_id.as_deref(), Some("cluster-9"));
    }

    #[test]
    fn a_page_cluster_is_reused_rather_than_made_twice() {
        let mut s = with_agents_page();
        s.windows[0].active_cluster_id = Some("cluster-1".to_string());

        assert!(
            page_cluster_is_whole(&s, "main", "agents"),
            "so no seed is minted"
        );
        let again = open_page_pure(&mut s, "main", agents(), None);

        assert_eq!(again.as_deref(), Some("cluster-9"));
        assert_eq!(
            s.windows[0].clusters.len(),
            2,
            "not a second Agents cluster"
        );
        assert_eq!(s.instances.len(), 2, "not a second Agents instance");
        assert_eq!(s.windows[0].active_cluster_id.as_deref(), Some("cluster-9"));
    }

    #[test]
    fn a_page_is_one_per_window() {
        let mut s = with_agents_page();
        s.windows.push(window("tear-1", "cluster-2", &[]));

        assert!(!page_cluster_is_whole(&s, "tear-1", "agents"));
        let opened = open_page_pure(&mut s, "tear-1", agents(), seed(10));

        assert_eq!(opened.as_deref(), Some("cluster-10"));
        assert_eq!(s.windows[1].clusters.len(), 2);
        assert_eq!(s.windows[0].clusters.len(), 2, "main's page is its own");
    }

    #[test]
    fn a_page_cluster_found_empty_is_refilled_not_shown_blank() {
        let mut s = with_agents_page();
        cluster_mut(&mut s, "cluster-9")
            .tree
            .remove_tab_unpruned("agents-9");
        s.instances.retain(|i| i.id != "agents-9");

        assert!(!page_cluster_is_whole(&s, "main", "agents"));
        let opened = open_page_pure(&mut s, "main", agents(), seed(11));

        assert_eq!(opened.as_deref(), Some("cluster-9"));
        assert_eq!(
            cluster_mut(&mut s, "cluster-9").tree.tabs(),
            vec!["agents-11"]
        );
    }

    #[test]
    fn a_page_opens_nowhere_in_a_window_that_does_not_exist() {
        let mut s = with_agents_page();
        assert_eq!(open_page_pure(&mut s, "nonesuch", agents(), seed(12)), None);
    }

    #[test]
    fn a_page_is_not_renamed() {
        let mut s = with_agents_page();

        assert!(!rename_cluster_pure(&mut s, "cluster-9", "mine"));
        assert_eq!(cluster_mut(&mut s, "cluster-9").name, "Agents");
        assert!(
            rename_cluster_pure(&mut s, "cluster-1", "mine"),
            "a real one is"
        );
    }

    #[test]
    fn a_page_is_not_closed() {
        let mut s = with_agents_page();

        let (instances, terminals) = close_cluster_pure(&mut s, "cluster-9");

        assert!(instances.is_empty() && terminals.is_empty());
        assert_eq!(s.windows[0].clusters.len(), 2);
        assert!(s.instances.iter().any(|i| i.id == "agents-9"));
    }

    #[test]
    fn a_pages_instance_is_not_closed() {
        let mut s = with_agents_page();

        assert!(!close_instance_pure(&mut s, "agents-9"));
        assert_eq!(
            cluster_mut(&mut s, "cluster-9").tree.tabs(),
            vec!["agents-9"]
        );
        assert!(close_instance_pure(&mut s, "files-1"), "a real tab is");
    }

    #[test]
    fn a_page_is_not_moved_to_another_window() {
        let mut s = with_agents_page();
        s.windows.push(window("tear-1", "cluster-2", &[]));

        assert!(!move_cluster_pure(&mut s, "cluster-9", "tear-1"));
        assert!(!move_cluster_pure(&mut s, "cluster-9", "tear-new"));
        assert_eq!(s.windows[0].clusters.len(), 2);
        assert_eq!(s.windows.len(), 2, "no window was made for it");
    }

    #[test]
    fn nothing_is_dropped_into_a_page() {
        let mut s = with_agents_page();

        assert!(!move_instance_pure(
            &mut s,
            "files-1",
            "cluster-9",
            "pane-9",
            None
        ));
        assert_eq!(
            cluster_mut(&mut s, "cluster-9").tree.tabs(),
            vec!["agents-9"]
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").tree.tabs(),
            vec!["files-1"]
        );
    }

    #[test]
    fn a_pages_tab_is_not_dragged_out() {
        let mut s = with_agents_page();

        assert!(!move_instance_pure(
            &mut s,
            "agents-9",
            "cluster-1",
            "pane-1",
            None
        ));
        assert!(!detach_instance_pure(
            &mut s,
            "agents-9",
            "tear-1",
            "cluster-3",
            "pane-3"
        ));
        assert_eq!(
            cluster_mut(&mut s, "cluster-9").tree.tabs(),
            vec!["agents-9"]
        );
        assert_eq!(s.windows.len(), 1, "no window was torn off for it");
    }

    #[test]
    fn a_pages_pane_is_not_split() {
        let mut s = with_agents_page();
        let ids = ("split-1", "pane-20");

        assert!(!split_with_instance_pure(
            &mut s,
            "pane-9",
            SplitDir::Row,
            ids,
            "files-1",
            false
        ));
        assert!(
            !split_with_instance_pure(&mut s, "pane-1", SplitDir::Row, ids, "agents-9", false),
            "nor its tab used to split somebody else's"
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-9").tree.leaf_ids(),
            vec!["pane-9"]
        );
        assert_eq!(
            cluster_mut(&mut s, "cluster-1").tree.leaf_ids(),
            vec!["pane-1"]
        );
    }

    #[test]
    fn nothing_opens_into_a_page() {
        let mut s = with_agents_page();
        let w = &mut s.windows[0];

        assert!(
            open_target(w, None).is_none(),
            "the page is the active cluster"
        );
        assert!(
            open_target(w, Some("pane-9")).is_none(),
            "its pane, by name"
        );
        assert_eq!(
            open_target(w, Some("pane-1"))
                .map(|c| c.id.clone())
                .as_deref(),
            Some("cluster-1"),
            "a real cluster's pane, by name, still works from behind a page"
        );
    }

    #[test]
    fn a_page_in_front_is_nowhere_to_work() {
        let shell = ShellState::default();
        shell.restore(with_agents_page());

        assert_eq!(shell.active_cluster_of("main"), None);
        assert_eq!(shell.active_pane("main", None), None);
    }

    #[test]
    fn closing_the_last_real_cluster_does_not_land_on_a_page() {
        let mut s = with_agents_page();
        s.windows[0].active_cluster_id = Some("cluster-1".to_string());

        close_cluster_pure(&mut s, "cluster-1");

        assert_eq!(s.windows[0].active_cluster_id, None);
        assert_eq!(
            s.windows[0].clusters.len(),
            1,
            "the page is still there to click"
        );
    }

    #[test]
    fn a_closed_cluster_falls_to_a_real_neighbour_past_a_page() {
        let mut s = with_agents_page();
        s.windows[0]
            .clusters
            .push(window("x", "cluster-2", &[]).clusters.remove(0));
        s.windows[0].active_cluster_id = Some("cluster-1".to_string());

        close_cluster_pure(&mut s, "cluster-1");

        assert_eq!(s.windows[0].active_cluster_id.as_deref(), Some("cluster-2"));
    }

    #[test]
    fn a_closing_windows_pages_are_dropped_not_folded_into_main() {
        let mut s = with_agents_page();
        s.windows.push(window("tear-1", "cluster-2", &[]));
        open_page_pure(&mut s, "tear-1", agents(), seed(10));

        reclaim_window_pure(&mut s, "tear-1");

        let main = &s.windows[0];
        assert_eq!(s.windows.len(), 1);
        assert_eq!(
            main.clusters.iter().filter(|c| c.is_page()).count(),
            1,
            "main keeps its own Agents and gains no second one"
        );
        assert!(
            main.clusters.iter().any(|c| c.id == "cluster-2"),
            "real ones fold in"
        );
        assert!(!s.instances.iter().any(|i| i.id == "agents-10"));
    }

    #[test]
    fn a_page_this_build_cannot_draw_is_dropped_on_restore() {
        let mut s = with_agents_page();

        drop_unavailable_pages(&mut s, &|_| false);

        assert_eq!(s.windows[0].clusters.len(), 1);
        assert!(!s.instances.iter().any(|i| i.id == "agents-9"));
        assert_eq!(
            s.windows[0].active_cluster_id.as_deref(),
            Some("cluster-1"),
            "the window falls back to a real cluster"
        );
    }

    #[test]
    fn a_page_survives_a_json_round_trip_and_a_real_cluster_omits_the_key() {
        let s = with_agents_page();
        let json = serde_json::to_string(&s).expect("serializes");
        let back: ShellSnapshot = serde_json::from_str(&json).expect("deserializes");

        assert_eq!(back.windows[0].clusters[1].page.as_deref(), Some("agents"));
        assert_eq!(back.windows[0].clusters[0].page, None);
        assert_eq!(
            json.matches("\"page\"").count(),
            1,
            "only the page writes one"
        );
    }

    // --- environments and the pinned Design cluster ---------------------------

    fn design_environment() -> crate::environments::Environment {
        crate::environments::Environment::Design {
            path: "C:/proj/.kaava/worktrees/design".to_string(),
            branch: "wt/design".to_string(),
        }
    }

    #[test]
    fn add_design_cluster_is_inserted_first_and_does_not_steal_focus() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());

        let created = add_design_cluster_pure(
            &mut s,
            "main",
            "cluster-9",
            "pane-9",
            "C:/proj",
            design_environment(),
        );

        assert_eq!(created.as_deref(), Some("cluster-9"));
        let w = &s.windows[0];
        assert_eq!(w.clusters[0].id, "cluster-9", "first in the switcher");
        assert!(w.clusters[0].pinned);
        assert_eq!(w.clusters[0].environment, Some(design_environment()));
        assert_eq!(w.clusters[0].project.as_deref(), Some("C:/proj"));
        assert_eq!(
            w.active_cluster_id.as_deref(),
            Some("cluster-1"),
            "the cluster that was already active stays active"
        );
    }

    #[test]
    fn add_design_cluster_is_idempotent_per_window() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        add_design_cluster_pure(
            &mut s,
            "main",
            "cluster-9",
            "pane-9",
            "C:/proj",
            design_environment(),
        );

        let second = add_design_cluster_pure(
            &mut s,
            "main",
            "cluster-10",
            "pane-10",
            "C:/proj",
            design_environment(),
        );

        assert_eq!(second, None, "a window keeps at most one pinned cluster");
        assert_eq!(s.windows[0].clusters.len(), 2, "no second one was added");
    }

    #[test]
    fn add_design_cluster_finds_nothing_in_an_unknown_window() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        assert_eq!(
            add_design_cluster_pure(
                &mut s,
                "nonesuch",
                "cluster-9",
                "pane-9",
                "C:/proj",
                design_environment(),
            ),
            None
        );
    }

    /// The one write-side guarantee this workstream adds outside `git.rs`:
    /// the pinned cluster has no × and no other route to `close_cluster_pure`
    /// closes it either.
    #[test]
    fn a_pinned_cluster_is_not_closed() {
        let mut s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        add_design_cluster_pure(
            &mut s,
            "main",
            "cluster-9",
            "pane-9",
            "C:/proj",
            design_environment(),
        );

        let (instances, terminals) = close_cluster_pure(&mut s, "cluster-9");

        assert!(instances.is_empty() && terminals.is_empty());
        assert_eq!(
            s.windows[0].clusters.len(),
            2,
            "the pin survives the attempt"
        );
        assert!(
            s.windows[0].clusters.iter().any(|c| c.id == "cluster-9"),
            "still there afterward"
        );

        close_cluster_pure(&mut s, "cluster-1");
        assert_eq!(
            s.windows[0].clusters.len(),
            1,
            "an ordinary cluster beside the pin is still closable"
        );
    }

    /// The bridge from the legacy `worktree` field, exercised at the
    /// `ShellState::restore` boundary rather than by calling
    /// `crate::environments::migrate_environment` directly (which has its
    /// own unit tests in `environments.rs`) — this is the guarantee that
    /// actually matters: an old `layout.json` comes back with `environment`
    /// filled in, not just a function that could fill it in if called.
    #[test]
    fn restoring_a_legacy_layout_migrates_worktree_into_environment() {
        let mut w = window("main", "cluster-1", &[]);
        w.clusters[0].worktree = Some(WorktreeRef {
            path: "C:/proj/../.worktrees/proj/feat-x".to_string(),
            branch: Some("feat-x".to_string()),
            base: Some("main".to_string()),
        });
        let mut snapshot = state(vec![w], Vec::new());

        migrate_environments(&mut snapshot);

        assert_eq!(
            snapshot.windows[0].clusters[0].environment,
            Some(crate::environments::Environment::LocalWorktree {
                name: "feat-x".to_string(),
                path: "C:/proj/../.worktrees/proj/feat-x".to_string(),
                branch: "feat-x".to_string(),
                base: "main".to_string(),
            })
        );
    }

    /// A cluster with no worktree at all is left `None` rather than guessed
    /// at as `Main` — see `crate::environments::migrate_environment`'s doc
    /// for why locking every project-only cluster to read-only on the first
    /// load of a new build would be the wrong call.
    #[test]
    fn restoring_a_legacy_layout_does_not_invent_main_for_a_projectonly_cluster() {
        let mut snapshot = state(vec![window("main", "cluster-1", &[])], Vec::new());
        snapshot.windows[0].clusters[0].project = Some("C:/proj".to_string());

        migrate_environments(&mut snapshot);

        assert_eq!(snapshot.windows[0].clusters[0].environment, None);
    }

    /// `cluster_root` prefers `environment` over the legacy `worktree` the
    /// moment both are set — see `Cluster::environment`'s doc on precedence.
    #[test]
    fn cluster_root_prefers_environment_over_legacy_worktree() {
        let mut w = window("main", "cluster-1", &[]);
        w.clusters[0].project = Some("C:/proj".to_string());
        w.clusters[0].worktree = Some(WorktreeRef {
            path: "C:/old-worktree".to_string(),
            branch: None,
            base: None,
        });
        w.clusters[0].environment = Some(crate::environments::Environment::LocalWorktree {
            name: "feat-x".to_string(),
            path: "C:/new-worktree".to_string(),
            branch: "wt/feat-x".to_string(),
            base: "main".to_string(),
        });
        let snapshot = state(vec![w], Vec::new());
        let shell = ShellState::default();
        *shell.inner.write_or_panic() = snapshot;

        assert_eq!(
            shell.cluster_root("cluster-1"),
            Some("C:/new-worktree".to_string())
        );
    }

    /// A cluster on `Cloud` has no local path — `cluster_root` answers `None`
    /// honestly rather than falling back to the project it is nominally
    /// about, which would have a terminal open against a folder the cloud
    /// session never touches.
    #[test]
    fn cluster_root_is_none_for_a_cloud_cluster_even_with_a_project_set() {
        let mut w = window("main", "cluster-1", &[]);
        w.clusters[0].project = Some("C:/proj".to_string());
        w.clusters[0].environment = Some(crate::environments::Environment::Cloud {
            session_id: "s1".to_string(),
            vm: "vm1".to_string(),
            branch: None,
        });
        let snapshot = state(vec![w], Vec::new());
        let shell = ShellState::default();
        *shell.inner.write_or_panic() = snapshot;

        assert_eq!(shell.cluster_root("cluster-1"), None);
    }

    // --- the Switch Project dialog's per-row summary ---------------------------

    #[test]
    fn project_live_counts_is_zero_for_a_project_nobody_has_open() {
        let s = state(vec![window("main", "cluster-1", &[])], Vec::new());
        let counts = project_live_counts_pure(&s, "C:/proj");
        assert!(!counts.open);
        assert_eq!(counts.cluster_count, 0);
        assert_eq!(counts.environment_count, 0);
    }

    #[test]
    fn project_live_counts_counts_clusters_across_every_window() {
        let mut w1 = window("main", "cluster-1", &[]);
        w1.clusters[0].project = Some("C:/proj".to_string());
        let mut w2 = window("second", "cluster-2", &[]);
        w2.clusters[0].project = Some("C:/proj".to_string());
        // A cluster on a different project must not be counted in.
        let mut w3 = window("third", "cluster-3", &[]);
        w3.clusters[0].project = Some("C:/other".to_string());
        let s = state(vec![w1, w2, w3], Vec::new());

        let counts = project_live_counts_pure(&s, "C:/proj");

        assert!(counts.open);
        assert_eq!(counts.cluster_count, 2);
    }

    #[test]
    fn project_live_counts_dedups_two_clusters_on_the_same_environment() {
        let mut w = window("main", "cluster-1", &[]);
        w.clusters[0].project = Some("C:/proj".to_string());
        w.clusters[0].environment = Some(design_environment());
        w.clusters.push(Cluster {
            id: "cluster-2".to_string(),
            name: "cluster-2".to_string(),
            tree: PaneNode::leaf("pane-2"),
            project: Some("C:/proj".to_string()),
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            // Same environment as cluster-1 — one worktree, opened twice.
            environment: Some(design_environment()),
            pinned: false,
        });
        let s = state(vec![w], Vec::new());

        let counts = project_live_counts_pure(&s, "C:/proj");

        assert_eq!(counts.cluster_count, 2, "both clusters count");
        assert_eq!(
            counts.environment_count, 1,
            "one environment, shared by both"
        );
    }
}
