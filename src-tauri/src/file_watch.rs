//! Telling the File Explorer that its project folder changed under it.
//!
//! The explorer re-lists on its own actions and when a Viewer reports a save, and nothing
//! else: a file created, dropped or deleted from outside (a terminal, the OS, an agent)
//! stayed invisible until someone pressed refresh, and the git badges with it. This watches
//! a project root and emits one [`FILES_CHANGED_EVENT`] when the changes settle.
//!
//! Not shared with `plugins::watch` (it reloads one exact path); only the `recv_timeout`
//! debounce shape is.
//!
//! **What is not watched.** `.git` internals (a commit writes dozens of objects and refs
//! and the working tree did not change), `node_modules` and `target` (build output, tens
//! of thousands of files and never in the explorer's way), and `.veistra/worktrees` (other
//! clusters' checkouts: their churn is not this tree's).
//!
//! **The two `.git` files that are.** `index` and `HEAD`: a `git add`, a commit or a
//! checkout in a terminal rewrites them, and that is the only sign a git badge changed
//! when no file did. Nothing else under `.git` counts. In a linked worktree `.git` is a
//! file pointing at a directory outside the root, so [`resolve_git_dir`] follows it and
//! that directory gets its own non-recursive watch.

use crate::sync::MutexExt;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
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
/// Pure, so the filter is tested without a filesystem. `.veistra/worktrees` is two
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
        .any(|pair| pair[0] == ".veistra" && pair[1] == "worktrees")
}

/// The directory holding `root`'s `index` and `HEAD`: `root/.git` when that is a
/// directory, or the `gitdir:` target when it is a file (a linked worktree). `None` for a
/// folder that is not a repository.
pub fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let target = Path::new(target);
    let full = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    full.is_dir().then_some(full)
}

/// Whether `path` is the `index` or `HEAD` file of `git_dir`, and nothing else in it.
pub fn is_git_signal(git_dir: &Path, path: &Path) -> bool {
    let named = path
        .file_name()
        .is_some_and(|n| n == "index" || n == "HEAD");
    if !named {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    };
    same(parent, git_dir)
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
            None => eprintln!("veistra: not watching {} for file changes", root.display()),
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
        .map_err(|e| eprintln!("veistra: could not create a file watcher: {e}"))
        .ok()?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| eprintln!("veistra: could not watch {}: {e}", root.display()))
        .ok()?;

    // A linked worktree's git directory sits outside `root`, so the recursive watch above
    // never sees it. A normal repository's is inside and already covered.
    let git_dir = resolve_git_dir(root);
    if let Some(dir) = git_dir.as_deref().filter(|d| !d.starts_with(root)) {
        if let Err(e) = watcher.watch(dir, RecursiveMode::NonRecursive) {
            eprintln!("veistra: could not watch {}: {e}", dir.display());
        }
    }

    let root = root.to_path_buf();
    let counts = move |p: &Path| {
        is_relevant(&root, p) || git_dir.as_deref().is_some_and(|g| is_git_signal(g, p))
    };
    std::thread::Builder::new()
        .name("files-watch".to_string())
        .spawn(move || settle(&rx, QUIET, counts, on_change))
        .ok()?;

    Some(watcher)
}

/// Call `on_change` once per burst of events that `counts`, after `quiet` passes with
/// no event at all. Returns when the channel closes, dropping a burst still settling.
fn settle(
    rx: &Receiver<notify::Result<Event>>,
    quiet: Duration,
    counts: impl Fn(&Path) -> bool,
    on_change: impl Fn(),
) {
    loop {
        // Block for the first relevant event, then keep absorbing until quiet.
        let mut pending = false;
        loop {
            let timeout = if pending {
                quiet
            } else {
                Duration::from_secs(3600)
            };
            match rx.recv_timeout(timeout) {
                Ok(Ok(event)) => {
                    if event.paths.iter().any(|p| counts(p)) {
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
    }
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
        assert!(rel(".veistra/layout/stack.json"));
    }

    #[test]
    fn git_internals_node_modules_and_target_do_not() {
        assert!(!rel(".git/index"));
        assert!(!rel(".git/objects/ab/cdef"));
        assert!(!rel(".git/refs/heads/main"));
        assert!(!rel("node_modules/left-pad/index.js"));
        assert!(!rel("apps/x/node_modules/y.js"));
        assert!(!rel("target/debug/app.exe"));
    }

    #[test]
    fn other_clusters_worktrees_do_not() {
        assert!(!rel(".veistra/worktrees/feat/src/a.rs"));
        assert!(rel(".veistra/other"));
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

    fn created(path: &str) -> notify::Result<Event> {
        let kind = notify::EventKind::Create(notify::event::CreateKind::File);
        Ok(Event::new(kind).add_path(PathBuf::from(path)))
    }

    /// The quiet window the [`settle`] tests use.
    const TEST_QUIET: Duration = Duration::from_millis(100);

    /// Long enough for a burst that counts to have been announced. A correct [`settle`]
    /// announces nothing new here whatever the timing, so waiting cannot flake.
    fn idle() {
        std::thread::sleep(TEST_QUIET * 3);
    }

    /// [`settle`] on a thread of its own, over `events` all queued before it starts, so
    /// how they group does not depend on how fast anything runs. Anything under `ignored`
    /// does not count.
    fn settling(
        events: Vec<notify::Result<Event>>,
    ) -> (
        mpsc::Sender<notify::Result<Event>>,
        Arc<AtomicUsize>,
        std::thread::JoinHandle<()>,
    ) {
        let (tx, rx) = mpsc::channel();
        for event in events {
            tx.send(event).unwrap();
        }
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let thread = std::thread::spawn(move || {
            let counts = |p: &Path| !p.starts_with("ignored");
            settle(&rx, TEST_QUIET, counts, move || {
                seen.fetch_add(1, Ordering::SeqCst);
            });
        });
        (tx, count, thread)
    }

    #[test]
    fn a_burst_is_announced_once_after_it_settles() {
        let mut burst: Vec<_> = (0..5).map(|i| created(&format!("f{i}.txt"))).collect();
        burst.push(created("ignored/a.js"));
        burst.push(Err(notify::Error::generic("lost")));
        let (tx, count, thread) = settling(burst);
        assert!(wait_for(&count, 1, Duration::from_secs(5)));
        // Once settled, it stays quiet until something changes.
        idle();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(tx);
        thread.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn events_that_do_not_count_announce_nothing() {
        let noise = vec![created("ignored/a.js"), Err(notify::Error::generic("lost"))];
        let (tx, count, thread) = settling(noise);
        // Held open, so noise that counted would be announced before the close.
        idle();
        assert_eq!(count.load(Ordering::SeqCst), 0);
        drop(tx);
        thread.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_change_after_the_folder_settled_is_announced_again() {
        let (tx, count, thread) = settling(vec![created("f0.txt")]);
        assert!(wait_for(&count, 1, Duration::from_secs(5)));
        tx.send(created("f1.txt")).unwrap();
        assert!(wait_for(&count, 2, Duration::from_secs(5)));
        drop(tx);
        thread.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    /// The real watcher, end to end. How a burst of writes groups is up to the machine:
    /// a loaded runner can stall between two of them for longer than [`QUIET`], and the
    /// burst is then announced twice. So this checks that changes are announced, that a
    /// burst is announced fewer times than it has writes, and that noise is not.
    /// [`settle`]'s own tests pin the exact grouping.
    #[test]
    fn created_and_deleted_files_are_announced_and_ignored_folders_stay_quiet() {
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
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/objects/blob"), "x").unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(count.load(Ordering::SeqCst), 0);

        // A burst of real files announces, and not once a write. Splitting it once
        // per write would take a stall longer than QUIET between every two of them.
        let writes = 10;
        for i in 0..writes {
            std::fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        assert!(wait_for(&count, 1, Duration::from_secs(5)));

        // And once that has settled, a delete announces too.
        std::thread::sleep(Duration::from_millis(1000));
        let settled = count.load(Ordering::SeqCst);
        assert!(
            settled < writes,
            "{settled} announcements for {writes} writes"
        );
        std::fs::remove_file(root.join("f0.txt")).unwrap();
        assert!(wait_for(&count, settled + 1, Duration::from_secs(5)));
    }

    #[test]
    fn only_index_and_head_of_the_git_dir_are_signals() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().canonicalize().unwrap().join(".git");
        std::fs::create_dir_all(&git).unwrap();
        assert!(is_git_signal(&git, &git.join("index")));
        assert!(is_git_signal(&git, &git.join("HEAD")));
        assert!(!is_git_signal(&git, &git.join("config")));
        assert!(!is_git_signal(&git, &git.join("refs").join("HEAD")));
    }

    #[test]
    fn a_worktrees_dot_git_file_resolves_to_its_real_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let real = base.join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&real).unwrap();
        let root = base.join("wt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".git"),
            format!(
                "gitdir: {}
",
                real.display()
            ),
        )
        .unwrap();
        assert_eq!(resolve_git_dir(&root), Some(real));
        assert_eq!(resolve_git_dir(&base.join("nothing")), None);
    }

    #[test]
    fn staging_or_committing_announces_but_other_git_writes_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let _watcher = spawn_watch(&root, move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .expect("the temp folder can be watched");

        std::fs::write(root.join(".git/COMMIT_EDITMSG"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        assert_eq!(count.load(Ordering::SeqCst), 0);

        std::fs::write(root.join(".git/index"), "x").unwrap();
        assert!(wait_for(&count, 1, Duration::from_secs(5)));
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/x").unwrap();
        assert!(wait_for(&count, 2, Duration::from_secs(5)));
    }

    #[test]
    fn a_linked_worktrees_index_outside_the_root_is_watched() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let real = base.join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&real).unwrap();
        let root = base.join("wt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(".git"),
            format!(
                "gitdir: {}
",
                real.display()
            ),
        )
        .unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let _watcher = spawn_watch(&root, move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .expect("the temp folder can be watched");

        std::fs::write(real.join("index"), "x").unwrap();
        assert!(wait_for(&count, 1, Duration::from_secs(5)));
    }
}
