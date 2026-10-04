//! Telling the File Explorer that its project folder changed under it.
//!
//! The explorer re-lists on its own actions and when a Viewer reports a save, and nothing
//! else: a file created, dropped or deleted from outside (a terminal, the OS, an agent)
//! stayed invisible until someone pressed refresh, and the git badges with it. This watches
//! a project root and emits one [`FILES_CHANGED_EVENT`] when the changes settle.
//!
//! `notify` is already a dependency, used by `plugins::watch` for a different job (two
//! narrow paths, one callback). That module is not reusable here: it reloads a plugin, and
//! its filter is "this exact path". What is shared is the shape, a debounce built on
//! `recv_timeout`.
//!
//! **What is not watched.** `.git` internals (a commit or an index write inside a repo
//! fires dozens of events and the working tree did not change), `node_modules` and
//! `target` (build output, tens of thousands of files and never in the explorer's way),
//! and `.kaava/worktrees` (other clusters' checkouts: their churn is not this tree's).
//! The cost of skipping `.git`: a `git add` or a checkout from a terminal moves badges
//! only when it also moves a file, which a checkout does and a bare `add` does not; the
//! explorer's own refresh and focus reload still pick that up.

use crate::sync::MutexExt;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The Tauri event the shell relays to every Files frame. Payload: `{ "root": "<path>" }`.
pub const FILES_CHANGED_EVENT: &str = "files:changed";

/// How long the folder has to hold still before the explorer is told. A `git checkout` or
/// an unzip writes hundreds of files in a burst; each event restarts this window, so the
/// explorer re-lists once, after the last of them.
const QUIET: Duration = Duration::from_millis(300);

/// Folder names whose contents never count, wherever they sit under the root.
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target"];

/// Whether a change at `path` is one the explorer should react to.
///
/// Pure, so the filter is tested without a filesystem. `.kaava/worktrees` is two
/// components, not a name, so it is matched as a pair.
pub fn is_relevant(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let parts: Vec<&std::ffi::OsStr> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    if parts.iter().any(|p| IGNORED_DIRS.iter().any(|d| p == d)) {
        return false;
    }
    !parts
        .windows(2)
        .any(|pair| pair[0] == ".kaava" && pair[1] == "worktrees")
}

/// The live watchers, one per project root. Managed state.
///
/// The watcher is kept only so dropping it stops the watch; its thread ends on its own when
/// the channel closes. Roots are never removed while the app runs: a project folder that
/// was opened once is cheap to keep watching, and removing on "no Files shows it" would
/// need a signal this has no source for.
#[derive(Default)]
pub struct FileWatches {
    inner: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

impl FileWatches {
    /// Watch `root` if it is not watched yet. Idempotent; the `files/watch` method calls
    /// it every time a Files frame mounts or changes root.
    pub fn ensure(&self, app: &AppHandle, root: &Path) {
        let mut watches = self.inner.lock_or_panic();
        if watches.contains_key(root) {
            return;
        }
        let app = app.clone();
        let announced = root.display().to_string();
        let started = spawn_watch(root, move || {
            let _ = app.emit(FILES_CHANGED_EVENT, json!({ "root": announced }));
        });
        match started {
            Some(watcher) => {
                watches.insert(root.to_path_buf(), watcher);
            }
            // Not fatal: the explorer still refreshes by hand and on its own actions.
            None => eprintln!("kaava: not watching {} for file changes", root.display()),
        }
    }
}

/// Watch `root` recursively and call `on_change` once per settled burst of relevant
/// changes. Split from [`FileWatches::ensure`] so a test can drive it without an app.
pub(crate) fn spawn_watch(
    root: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|e| eprintln!("kaava: could not create a file watcher: {e}"))
        .ok()?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| eprintln!("kaava: could not watch {}: {e}", root.display()))
        .ok()?;

    let root = root.to_path_buf();
    std::thread::Builder::new()
        .name("files-watch".to_string())
        .spawn(move || loop {
            // Block for the first relevant event, then keep absorbing until quiet.
            let mut pending = false;
            loop {
                let timeout = if pending {
                    QUIET
                } else {
                    Duration::from_secs(3600)
                };
                match rx.recv_timeout(timeout) {
                    Ok(Ok(event)) => {
                        if event.paths.iter().any(|p| is_relevant(&root, p)) {
                            pending = true;
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(RecvTimeoutError::Timeout) => {
                        if pending {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            on_change();
        })
        .ok()?;

    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    fn rel(path: &str) -> bool {
        is_relevant(Path::new("/proj"), &Path::new("/proj").join(path))
    }

    #[test]
    fn ordinary_files_count() {
        assert!(rel("src/main.rs"));
        assert!(rel("notes.txt"));
        assert!(rel(".gitignore"));
        assert!(rel(".kaava/layout/stack.json"));
    }

    #[test]
    fn git_internals_node_modules_and_target_do_not() {
        assert!(!rel(".git/index"));
        assert!(!rel(".git/refs/heads/main"));
        assert!(!rel("node_modules/left-pad/index.js"));
        assert!(!rel("apps/x/node_modules/y.js"));
        assert!(!rel("target/debug/app.exe"));
    }

    #[test]
    fn other_clusters_worktrees_do_not() {
        assert!(!rel(".kaava/worktrees/feat/src/a.rs"));
        assert!(rel(".kaava/other"));
    }

    fn wait_for(count: &AtomicUsize, at_least: usize, within: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < within {
            if count.load(Ordering::SeqCst) >= at_least {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn a_created_file_is_announced_once_and_ignored_folders_stay_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let _watcher = spawn_watch(&root, move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .expect("the temp folder can be watched");

        // Noise in ignored places announces nothing.
        std::fs::write(root.join("node_modules/a.js"), "x").unwrap();
        std::fs::write(root.join(".git/index"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(count.load(Ordering::SeqCst), 0);

        // A burst of real files announces once, after it settles.
        for i in 0..5 {
            std::fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        assert!(wait_for(&count, 1, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(1000));
        assert_eq!(count.load(Ordering::SeqCst), 1);

        // And a delete announces too.
        std::fs::remove_file(root.join("f0.txt")).unwrap();
        assert!(wait_for(&count, 2, Duration::from_secs(5)));
    }
}
