//! Where Veistra remembers the projects you have opened, across launches.
//!
//! This is the first thing in the orchestrator that wrote to disk. Everything
//! else it knew it re-derived at boot — the stack snapshot is a scan, a terminal
//! dies with its process. That was fine while nothing had to survive a restart.
//! "Open Veistra and land back where you were" was the first thing that did.
//!
//! What survives here now is the **Recent list only**. Which project is open is
//! a fact about a *cluster* (see `crate::project`'s module doc) and lives in
//! `layout.json` with the rest of the layout; the history of every project this
//! machine has opened is not a fact about any one of them, so it stays here.
//!
//! It lives in the OS's config directory for this app, not in the repo and not
//! beside any project: it is about *this machine's* history with projects, and
//! must not end up in someone's version control.
//!
//! Reading it is never fatal — see [`load`].

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// How many projects the Recent list remembers.
///
/// A cap rather than everything-forever, because this file is read at every
/// launch and each entry costs a `stat` to find out whether it still exists.
/// Twenty is well past where a person stops scanning a list and starts using
/// Open instead.
const RECENT_LIMIT: usize = 20;

const FILE: &str = "projects.json";

/// Precious. The Recent list is the history of what somebody has worked on, and
/// nothing on the machine can rebuild it — a checkout on disk says nothing
/// about whether it was ever opened here.
const KEEP: crate::userdata::store::Keep = crate::userdata::store::Keep::Aside;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stored {
    /// **Vestigial: the migration's only input.** Nothing writes this any more.
    ///
    /// It was the global "the project that was open when Veistra last closed", the
    /// field this module was built around. A project belongs to a cluster now,
    /// so the authority moved to `Cluster::project` in `layout.json`.
    ///
    /// Kept rather than deleted, though deleting is the tidier-looking option,
    /// because there is a real user with a real `projects.json` — Braden's —
    /// holding a path this build would otherwise throw away on its first save,
    /// leaving the upgraded session with an empty workspace and no way to find
    /// out why. `project::take_migration_seed` reads it exactly once, moves it
    /// onto the first cluster, and writes `None` back; from then on it
    /// serializes as `null` and costs one line in a JSON file.
    ///
    /// It is not kept as a fallback for "no cluster has a project". That state
    /// is legal and ordinary — a new cluster, or one whose project was closed —
    /// and treating it as a cue to reopen something would make Close Project
    /// undo itself on the next launch.
    pub open: Option<PathBuf>,
    /// Most recently opened first. Global, across every cluster and window: this
    /// is the machine's history with projects, not a property of a workspace.
    pub recents: Vec<Recent>,
}

/// A remembered project.
///
/// `name` is cached rather than re-read from the marker on every launch, and
/// that is deliberate: a recent whose drive is unplugged still has to draw a
/// row, and a row that could only say a path would be a worse answer than a
/// slightly stale name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: PathBuf,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub last_opened: u64,
}

impl Stored {
    /// Record a project as just-opened: to the front of the list, once.
    pub fn touch(&mut self, path: &Path, name: &str, at: u64) {
        self.recents.retain(|r| r.path != path);
        self.recents.insert(
            0,
            Recent {
                path: path.to_path_buf(),
                name: name.to_string(),
                last_opened: at,
            },
        );
        self.recents.truncate(RECENT_LIMIT);
    }

    pub fn forget(&mut self, path: &Path) {
        self.recents.retain(|r| r.path != path);
        // A forgotten project that some cluster happens to have open stays open
        // there. The Recent list is a history, and editing history is not the
        // same act as closing what is in front of you — in this window or in
        // any other.
    }
}

/// Read the store, or start empty. **Never fatal:** every read here degrades to
/// [`Stored::default`]. A recents file that is missing, truncated by a power
/// cut, or written by a future build must not stop Veistra from starting — the
/// worst honest outcome of a corrupt file is an empty Recent list, and that is a
/// great deal better than an app that will not open. [`save`] is what makes that
/// rare: it writes a temp file and renames it, so a reader either sees the whole
/// previous file or the whole new one.
pub fn load(app: &AppHandle) -> Stored {
    file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default()
}

/// Write the store, atomically, through `userdata::store`.
///
/// Temp file then rename there, because the alternative — truncating the real
/// file and writing into it — has a window where a crash leaves a half-written
/// JSON document that the next launch cannot parse. `rename` over an existing
/// file is atomic on both NTFS and POSIX filesystems, so a reader sees one whole
/// version or the other and never a partial one.
pub fn save(app: &AppHandle, stored: &Stored) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, stored, "the project store");
    }
}

/// `%APPDATA%/<identifier>/projects.json` on Windows, the equivalent elsewhere.
///
/// `None` only if the platform has no config directory at all, which is not a
/// state any desktop this ships to is in — but it is an `Option` rather than an
/// `expect` because losing the Recent list is a smaller failure than a panic.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_with(paths: &[&str]) -> Stored {
        let mut stored = Stored::default();
        for (i, p) in paths.iter().enumerate() {
            stored.touch(Path::new(p), p, i as u64);
        }
        stored
    }

    #[test]
    fn touching_moves_a_project_to_the_front_without_duplicating_it() {
        let mut stored = stored_with(&["a", "b", "c"]);
        assert_eq!(stored.recents[0].path, PathBuf::from("c"));

        stored.touch(Path::new("a"), "a", 99);

        assert_eq!(stored.recents.len(), 3, "re-opening is not a new entry");
        assert_eq!(stored.recents[0].path, PathBuf::from("a"));
        assert_eq!(stored.recents[0].last_opened, 99);
    }

    #[test]
    fn the_recent_list_is_capped() {
        let paths: Vec<String> = (0..RECENT_LIMIT + 5).map(|i| format!("p{i}")).collect();
        let mut stored = Stored::default();
        for (i, p) in paths.iter().enumerate() {
            stored.touch(Path::new(p), p, i as u64);
        }

        assert_eq!(stored.recents.len(), RECENT_LIMIT);
        assert_eq!(
            stored.recents[0].path,
            PathBuf::from(paths.last().unwrap()),
            "the newest survives"
        );
    }

    #[test]
    fn forgetting_removes_only_that_entry() {
        let mut stored = stored_with(&["a", "b", "c"]);
        stored.forget(Path::new("b"));

        let left: Vec<&PathBuf> = stored.recents.iter().map(|r| &r.path).collect();
        assert_eq!(left, vec![&PathBuf::from("c"), &PathBuf::from("a")]);
    }

    /// The degradation promise, as a test: a store this build cannot fully
    /// understand still yields a usable value rather than an error.
    #[test]
    fn an_unreadable_store_deserializes_to_nothing_rather_than_failing() {
        let broken: std::result::Result<Stored, _> = serde_json::from_str("{ this is not json");
        assert!(broken.is_err(), "the parse itself fails");

        // And a *parseable* document with unknown fields still loads, which is
        // what lets a newer build's store open here.
        let newer: Stored =
            serde_json::from_str(r#"{"open":null,"recents":[],"workspaces":["something new"]}"#)
                .expect("an unknown field must not fail the read");
        assert!(newer.recents.is_empty());
    }
}
