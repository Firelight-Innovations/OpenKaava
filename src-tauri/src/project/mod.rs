//! What an OpenKaava project is, and which one is open.
//!
//! A project is **a folder** — chosen, not defaulted to: a game is already a
//! tree of files a person moves, copies and version-controls, and any other
//! definition owes an answer for what happens when the folder moves without it.
//!
//! A folder becomes an *OpenKaava* project when it holds a `<name>.kaava` manifest —
//! see [`marker`] for why that name and not `.kaava`. An un-marked folder still
//! opens, so OpenKaava can be pointed at a game that exists today, before the
//! format is finished, and "what happens when the `.kaava` format changes" is
//! never answered with "it stops opening"; [`ProjectInfo::initialized`] tells
//! the two apart, so the frontend can offer to set one up rather than refuse it.
//!
//! **[`crate::shell_state::Cluster::project`] is the authority** on which
//! project is open. What stays here was never per-cluster: the global Recent
//! list in [`store::Stored`], and the filesystem knowledge. Why that moved, and
//! why every mutator broadcasts [`PROJECT_CHANGED_EVENT`] with a whole snapshot
//! stamped with its cluster, is in `docs/design-notes/backend-project.md`.

pub mod create;
mod marker;
mod store;

/// Re-exported because `.kaava` is a wire format rather than a name (STANDARDS.md §7), so the one
/// literal belongs in one place. `review::store` writes inside this directory and would otherwise
/// hold a second copy of the string to drift from this one.
pub use marker::TRACE_DIR;

use crate::branding;
use crate::commands;
use crate::error::{AppError, Result};
use crate::shell_state::ShellState;
use crate::sync::RwLockExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Emitter, Manager};

/// The event a project switch broadcasts on, carrying a [`ProjectChanged`] —
/// the whole new snapshot, and the cluster it is about. Not a filesystem
/// watcher: it fires when *which project a cluster is pointed at* changes, and
/// never because something inside one did.
pub const PROJECT_CHANGED_EVENT: &str = "project:changed";

/// One project, as a frontend needs to see it.
///
/// Paths are `String`, not `PathBuf`: this crosses into JSON, a Windows path is
/// not guaranteed to be UTF-8, and `PathBuf` would serialize as whatever
/// `Display` produced anyway. Converting here makes it one decision in one place
/// instead of an accident at the boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    /// The manifest's stable id, when there is one. `None` for a folder not set
    /// up yet — which is why the *path* identifies a frontend row, not this.
    /// Here because it is the only handle that survives a rename or a move, and
    /// the first thing anything cross-referencing projects will want.
    pub id: Option<String>,
    /// Whether a `<name>.kaava` manifest was found. `false` is a plain folder
    /// OpenKaava has been pointed at — openable, and offered a setup.
    pub initialized: bool,
    /// Whether the folder is still on disk. A recent entry can outlive the
    /// project it names — a moved folder, an unplugged drive — and a row that
    /// silently failed on click would be worse than one drawn as unavailable.
    pub exists: bool,
    /// The manifest's `format`. Greater than [`marker::FORMAT`] means a newer
    /// OpenKaava wrote it and this build is reading it partially.
    pub format: Option<i64>,
    /// Milliseconds since the Unix epoch, when OpenKaava last opened it. `None` for
    /// a project opened for the first time this session.
    pub last_opened: Option<u64>,
    /// The folder's own mtime, in the same units. What *the work* last changed,
    /// as opposed to when it was last looked at.
    pub modified: Option<u64>,
}

/// One cluster's project and the global history, in one payload.
///
/// `open` is the *asking cluster's* project, not a process-wide one: two Home
/// surfaces in two clusters get two different answers to `home/state`, each
/// drawing the project of the work it is sitting in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub open: Option<ProjectInfo>,
    pub recents: Vec<ProjectInfo>,
}

/// What [`PROJECT_CHANGED_EVENT`] carries.
///
/// A [`ProjectSnapshot`] with the cluster stamped on it. The stamp is the
/// load-bearing part: `ToolWindow` relays this into app frames, and it must
/// relay it *only* into frames in `cluster_id` — an unfiltered relay would
/// re-root every Files in the process at a project it is not in, the bug the
/// per-cluster model exists to prevent. Why the payload is a whole snapshot
/// rather than a delta is in `docs/design-notes/backend-project.md`.
///
/// Written out rather than composed with `#[serde(flatten)]` so the wire shape
/// is legible from this one declaration; the frontend reads `clusterId`, `open`
/// and `recents` off one object either way.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChanged {
    pub cluster_id: String,
    pub open: Option<ProjectInfo>,
    pub recents: Vec<ProjectInfo>,
}

/// The Recent list, behind a lock.
///
/// All that is left in this state once the open project moved onto the cluster.
/// `RwLock` for the same reason `AppState` and `ShellState` use one: read on
/// every Home render, written only when someone opens something.
#[derive(Default)]
pub struct ProjectState {
    inner: RwLock<store::Stored>,
}

impl ProjectState {
    fn read(&self) -> store::Stored {
        self.inner.read_or_panic().clone()
    }
}

/// Load the store from disk. Called once, from `lib.rs`'s setup, before the
/// layout is restored — the migration below reads `Stored::open` out of it.
pub fn restore(app: &AppHandle) {
    let stored = store::load(app);
    *app.state::<ProjectState>().inner.write_or_panic() = stored;
}

/// Take the pre-per-cluster global open project, consuming it.
///
/// **The migration, and it runs once by construction.** Nothing writes
/// `Stored::open` now and only this reads it, so `lib.rs` can move an existing
/// session onto the first cluster instead of opening the upgraded build to an
/// empty workspace. Consuming it — taking the value and persisting the `None` —
/// makes "once" a property of the data rather than of a flag someone has to
/// remember to set; without that, closing the project in cluster 1 would leave
/// the seed sitting in `projects.json` and the next launch would helpfully open
/// it again. See [`store::Stored::open`] for why the field is kept rather than
/// deleted.
pub fn take_migration_seed(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<ProjectState>();
    let mut guard = state.inner.write_or_panic();
    let taken = guard.open.take();
    if taken.is_some() {
        store::save(app, &guard);
    }
    taken.filter(|p| p.is_dir())
}

/// Where a cluster's work actually happens, for everything that needs to start
/// somewhere: a Files app's root, a new terminal's working directory, a
/// search's scope. A worktree wins over the project when the cluster has one,
/// and `None` covers "that root is no longer on disk" as well as "no cluster,
/// no root" — a caller wanting a directory to work in should not be handed a
/// path that was true last week. That disk filter is the one case where this
/// differs from [`cluster_pointer`], and it is drawn rather than hidden;
/// `docs/design-notes/backend-project.md` has the argument in full.
pub fn cluster_path(app: &AppHandle, cluster_id: &str) -> Option<PathBuf> {
    cluster_root_pointer(app, cluster_id).filter(|p| p.is_dir())
}

/// What a cluster is pointed at, whether or not it is still there. The
/// *project*, never the worktree — deliberately, and unlike [`cluster_path`]
/// and [`cluster_root_pointer`], which follow a worktree when one is set.
/// Nothing here touches the disk, which is what makes it the right thing for
/// the window title to read; `docs/design-notes/backend-project.md` has why
/// both of those choices are load-bearing for Home and the title bar.
pub fn cluster_pointer(app: &AppHandle, cluster_id: &str) -> Option<PathBuf> {
    app.state::<ShellState>()
        .cluster_project(cluster_id)
        .map(PathBuf::from)
}

/// What a cluster's work is pointed at, whether or not it is still there — the
/// worktree-aware counterpart to [`cluster_pointer`], which stays on the project
/// on purpose. See [`cluster_path`] for the disk-existence filter this
/// deliberately omits, and `ShellState::cluster_root` for the precedence itself.
pub fn cluster_root_pointer(app: &AppHandle, cluster_id: &str) -> Option<PathBuf> {
    app.state::<ShellState>()
        .cluster_root(cluster_id)
        .map(PathBuf::from)
}

/// Everything Home draws, from the asking cluster's point of view.
///
/// `cluster_id` is `None` for a caller with no cluster to speak of — an app
/// frame whose instance has just closed, or the shell asking before any cluster
/// exists. That reads as "nothing open", the truthful answer: no cluster exists
/// whose project could be reported.
pub fn snapshot(app: &AppHandle, cluster_id: Option<&str>) -> ProjectSnapshot {
    let stored = app.state::<ProjectState>().read();
    // `cluster_pointer`, not `cluster_path`: a project whose folder is deleted
    // or unplugged is still the one this cluster is open on, and Home draws it
    // as unavailable — that is `ProjectInfo::exists`. Filtering it out would
    // report "nothing is open" under a title bar still naming the project, and
    // swap Home's "this folder is gone" state for its "pick a project" one.
    let open_path = cluster_id.and_then(|id| cluster_pointer(app, id));

    // `last_opened` for the open project comes from the recents entry, the same
    // record — opening a project and recording it are one act, even though one
    // is now the cluster's and the other global.
    let open = open_path.as_ref().map(|path| {
        let last_opened = stored
            .recents
            .iter()
            .find(|r| &r.path == path)
            .map(|r| r.last_opened);
        describe(path, None, last_opened)
    });

    let recents = stored
        .recents
        .iter()
        .map(|r| describe(&r.path, Some(&r.name), Some(r.last_opened)))
        .collect();

    ProjectSnapshot { open, recents }
}

/// Open a folder as a project **in `cluster_id`**. Creates nothing — a folder
/// with no manifest opens as one that is not initialized, and the frontend
/// offers to fix that.
///
/// Two stores are touched, deliberately different in scope: the cluster is
/// pointed at the folder, which is what "open" means now, and the Recent list
/// stays global, so opening the same project in a second cluster is one recent
/// entry, not two. Finishes via `commands::apply_project_open_preset`, hooked
/// here rather than at each caller since `create` and `initialize` both end by
/// calling `open`.
pub fn open(app: &AppHandle, path: &Path, cluster_id: &str) -> Result<ProjectSnapshot> {
    if !path.is_dir() {
        return Err(AppError::NotAProject(path.display().to_string()));
    }

    // The manifest's name wins over the folder's: when they differ it is because
    // someone renamed the folder, and the name they typed into the project is
    // the one they meant.
    let name = marker::find(path)
        .and_then(|m| marker::load(&m).ok())
        .map(|m| m.name)
        .unwrap_or_else(|| folder_name(path));

    {
        let state = app.state::<ProjectState>();
        let mut guard = state.inner.write_or_panic();
        guard.touch(path, &name, marker::now_ms());
        store::save(app, &guard);
    }

    // The lock above is dropped first, for the reason `changed` documents: this
    // goes through `ShellState::mutate`, which emits and writes to disk, and one
    // store's lock held across another's broadcast is how a deadlock is written.
    let shell = app.state::<ShellState>();

    // Clearing the worktree is not optional. A worktree belongs to the
    // repository it was cut from, so a cluster now pointed at a *different*
    // project holds a binding to a checkout of something else — and since a
    // worktree outranks the project in `cluster_root`, leaving it set would send
    // this cluster's terminals, file tree and search into the old project's
    // worktree while the title bar named the new one. Opening is the one moment
    // we know for certain the old binding cannot still be right. It goes first
    // so no subscriber observes the pair mid-swap: the intermediate state is
    // "new project, no worktree", which is what a freshly opened project looks
    // like anyway.
    shell.set_cluster_worktree(app, cluster_id, None);
    shell.set_cluster_project(app, cluster_id, Some(path.display().to_string()));

    retitle(app);
    commands::apply_project_open_preset(app, cluster_id);
    open_design_cluster_if_present(app, &shell, path, cluster_id);

    // No emit here: `set_cluster_project` above went through `ShellState::
    // mutate`, which announces a repointed cluster itself. Emitting here too
    // would fire twice per switch, and a subscriber cannot tell that from two
    // real switches.
    Ok(snapshot(app, Some(cluster_id)))
}

/// The auto-create half of the pinned Design canvas — see
/// `KAAVA-UX-REWORK.md` §5. Only the *auto*-create half: a project with no
/// `wt/design` worktree yet is left alone here, and is offered the canvas
/// through a dialog instead (not part of this module — see the New Cluster
/// / Design canvas UI). Silent on every kind of "cannot", the same way the
/// rest of `open` already is about the preset it applies: a project that
/// happens not to be a git repository, or whose worktree list a `git` call
/// fails to read, opens exactly as it would have before this feature
/// existed, rather than failing the whole open over a cosmetic extra.
fn open_design_cluster_if_present(
    app: &AppHandle,
    shell: &ShellState,
    path: &Path,
    cluster_id: &str,
) {
    let Some(main_repo) = crate::git::main_repo_root(path) else {
        return;
    };
    let Some(environment) = crate::environments::detect_design_environment(&main_repo) else {
        return;
    };
    let Some(label) = shell.window_label_of_cluster(cluster_id) else {
        return;
    };
    shell.add_design_cluster(app, &label, &path.display().to_string(), environment);
}

/// Make `dir` an OpenKaava project and open it in `cluster_id`.
///
/// The project's name is the folder's, which is why this takes no name
/// argument: the native folder picker already names a folder, and a second name
/// field would be a second thing to keep in agreement with the first. The
/// manifest can be renamed later; the folder is the project.
pub fn create(app: &AppHandle, dir: &Path, cluster_id: &str) -> Result<ProjectSnapshot> {
    std::fs::create_dir_all(dir).map_err(|source| AppError::Io {
        path: dir.display().to_string(),
        source,
    })?;

    marker::create(dir, &folder_name(dir))?;
    open(app, dir, cluster_id)
}

/// Write a manifest into a folder that is already open without one — the "set
/// this up as an OpenKaava project" action.
///
/// Separate from [`create`] despite doing nearly the same thing, because the two
/// answer differently when the folder is already a project: creating over one is
/// a mistake worth refusing, while initializing one that got initialized in the
/// meantime is a no-op the user should not see an error for.
pub fn initialize(app: &AppHandle, dir: &Path, cluster_id: &str) -> Result<ProjectSnapshot> {
    if marker::find(dir).is_none() {
        marker::create(dir, &folder_name(dir))?;
    }
    open(app, dir, cluster_id)
}

/// Whether `dir` already has a `<name>.kaava` manifest.
///
/// For `project::create`'s land-the-code step: it needs to know, before it
/// writes anything, whether a folder is already a project — "Open existing"
/// only links one that is, and a fresh Game or Tool writes one only when
/// there isn't one already. Exposed rather than folded into [`create`] or
/// [`initialize`] because both of those are AppHandle-scoped mutators (they
/// point a *cluster* at the result), and a plain filesystem check has no
/// business needing one.
pub fn has_manifest(dir: &Path) -> bool {
    marker::find(dir).is_some()
}

/// Write a manifest into `dir` if it does not already have one. Returns
/// whether this call is the one that wrote it — `false` means a manifest was
/// already there and nothing changed.
///
/// The same distinction [`initialize`] draws, without the `AppHandle` and the
/// `open` that follows it: `project::create`'s land-the-code step needs to
/// write a manifest as part of preparing a folder, not as part of pointing a
/// cluster at it.
pub fn ensure_manifest(dir: &Path) -> Result<bool> {
    if marker::find(dir).is_some() {
        return Ok(false);
    }
    marker::create(dir, &folder_name(dir))?;
    Ok(true)
}

/// Undo [`ensure_manifest`]: delete the manifest it wrote, and the `.kaava/`
/// trace directory beside it if `ensure_manifest`'s `marker::create` left it
/// empty. Only called by `project::create`'s rollback, and only on a folder
/// [`ensure_manifest`] itself just wrote into — never on one this run merely
/// linked, whose manifest (if any) was already there before Kaava touched it.
pub fn remove_manifest(dir: &Path) -> Result<()> {
    let Some(path) = marker::find(dir) else {
        return Ok(());
    };
    std::fs::remove_file(&path).map_err(|source| AppError::Io {
        path: path.display().to_string(),
        source,
    })?;

    // Best-effort: `remove_dir` refuses a non-empty directory on its own, so
    // this is a no-op rather than a data-loss risk if anything (an agent
    // trace, a design canvas) has already been written into `.kaava/`.
    let _ = std::fs::remove_dir(dir.join(TRACE_DIR));
    Ok(())
}

/// Point `cluster_id` at nothing, without touching the history.
///
/// Scoped to the one cluster, like every other mutator here: closing the project
/// in the cluster you are looking at leaves the cluster on the next monitor
/// exactly where it was.
pub fn close(app: &AppHandle, cluster_id: &str) -> ProjectSnapshot {
    let shell = app.state::<ShellState>();

    // Both, for the reason `open` spells out: a worktree left behind outranks
    // the `None` project in `cluster_root`, so a cluster meant to have nothing
    // open would still hand out a directory to work in.
    shell.set_cluster_worktree(app, cluster_id, None);
    shell.set_cluster_project(app, cluster_id, None);

    retitle(app);
    // Announced by `mutate` already, as in `open`.
    snapshot(app, Some(cluster_id))
}

/// Drop one entry from the Recent list. Deletes nothing on disk — this is the
/// history forgetting a project, not OpenKaava removing one.
///
/// The Recent list is global, so this is too: forgetting forgets everywhere,
/// whichever cluster asked. `cluster_id` is only here so the snapshot handed
/// back reports the *asking* cluster's project, which is what Home redraws with.
///
/// The only mutator that does not broadcast, and provably safely: `Stored::
/// forget` touches `recents` and never any cluster's project, so nothing a
/// `project:changed` subscriber acts on can differ afterwards. Home gets the new
/// list as this call's return value; firing would wake every app frame in the
/// cluster to say the thing it watches did not change.
pub fn forget(app: &AppHandle, path: &Path, cluster_id: Option<&str>) -> ProjectSnapshot {
    {
        let state = app.state::<ProjectState>();
        let mut guard = state.inner.write_or_panic();
        guard.forget(path);
        store::save(app, &guard);
    }

    snapshot(app, cluster_id)
}

// --- helpers -----------------------------------------------------------------

/// Broadcast `cluster_id`'s new snapshot, stamped with its cluster.
///
/// Called by `ShellState::mutate` for every cluster whose project pointer a
/// mutation changed, and from nowhere else. That is what makes "every path
/// that repoints a cluster tells the frontend" a property of the state rather
/// than something each caller has to remember. The agent server's
/// `set_project` was the caller that forgot, and the shell stayed stale until
/// a reload.
///
/// Same posture as `mutate`, deliberately: `app.emit` with the result
/// dropped. A failed emit means there is no webview left to hear it, which no
/// mutator can act on and no caller can fix.
///
/// `mutate` has dropped the shell's write lock before calling this, for the
/// reason it documents: `emit` goes into Tauri's event machinery, and a lock
/// held across a call that may want to read the same state is how a deadlock
/// gets written. The `cluster_id` on the wire is what lets the relay in
/// `ToolWindow` be selective; see [`ProjectChanged`].
pub fn announce(app: &AppHandle, cluster_id: &str) {
    let snapshot = snapshot(app, Some(cluster_id));
    let _ = app.emit(
        PROJECT_CHANGED_EVENT,
        &ProjectChanged {
            cluster_id: cluster_id.to_string(),
            open: snapshot.open,
            recents: snapshot.recents,
        },
    );
}

/// Build a [`ProjectInfo`] by asking the filesystem what is true right now.
///
/// Every field but the cached name is read fresh on each call rather than
/// stored: a project can be initialized, renamed, or deleted by something that
/// is not OpenKaava, and a Recent list reporting its own last belief instead of the
/// disk's would be confidently wrong in exactly the cases that matter.
fn describe(path: &Path, cached_name: Option<&str>, last_opened: Option<u64>) -> ProjectInfo {
    let exists = path.is_dir();
    let found = if exists { marker::find(path) } else { None };
    let loaded = found.as_ref().and_then(|m| marker::load(m).ok());

    let name = loaded
        .as_ref()
        .map(|m| m.name.clone())
        .or_else(|| cached_name.map(str::to_owned))
        .unwrap_or_else(|| folder_name(path));

    ProjectInfo {
        name,
        path: path.display().to_string(),
        id: loaded
            .as_ref()
            .map(|m| m.id.clone())
            .filter(|id| !id.is_empty()),
        initialized: found.is_some(),
        exists,
        format: loaded.as_ref().map(|m| m.format),
        last_opened,
        modified: modified_ms(path),
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// A folder's last component, or its whole path if it has none — a drive root
/// like `D:\` has no file name, and calling that project "" would be worse than
/// calling it `D:\`.
fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// Put each window's own project in its OS window title.
///
/// **Per window, from the cluster that window is showing.** A window showing a
/// cluster with no project — or showing no cluster at all — falls back to the
/// product name alone rather than inheriting a neighbour's name. Why the title
/// is per window at all, and what it is read by, is in
/// `docs/design-notes/backend-project.md`.
///
/// Called after anything that can change the answer: a project opening or
/// closing, and every cluster command in `commands.rs` (adding, closing,
/// switching, detaching), since all of those change *which* cluster a window is
/// showing without touching any project.
pub fn retitle(app: &AppHandle) {
    for (label, project) in app.state::<ShellState>().window_projects() {
        let product = branding::product_name();
        let title = match project.as_deref() {
            Some(path) => format!("{} — {product}", folder_name(Path::new(path))),
            None => product.to_string(),
        };
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_title(&title);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_name_takes_the_last_component() {
        assert_eq!(folder_name(Path::new(r"C:\code\MyGame")), "MyGame");
        assert_eq!(folder_name(Path::new("/home/braden/MyGame")), "MyGame");
    }

    /// A drive root has no file name at all. `Path::file_name` returns `None`,
    /// and the fallback is what stops a project there being called "".
    #[test]
    fn folder_name_of_a_root_falls_back_to_the_path() {
        let root = Path::new(r"C:\");
        assert!(!folder_name(root).is_empty());
    }
}
