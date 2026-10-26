//! Noticing that a plugin under development has been rebuilt.
//!
//! The half of the reload loop nobody has to ask for. `plugins::reload` already
//! does the work — stop the core, tell every window to re-read the manifest —
//! and this is what calls it when `cargo build` finishes in a terminal beside
//! the shell rather than when somebody clicks something.
//!
//! Two narrow paths per plugin, and only for a [`Source::Folder`] install.
//! `docs/design-notes/backend-plugins.md` has why those two rather than the
//! checkout, and why a downloaded copy is not worth a handle.

use crate::plugins::{self, Registry};
use crate::sync::MutexExt;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
// `Manager` is the trait that puts `.state()` on `AppHandle`; Rust only exposes
// a trait's methods where the trait is in scope.
use tauri::{AppHandle, Manager};

/// How long the files have to hold still before a rebuild counts as finished.
///
/// A build touches the binary several times — the linker's temporary, the
/// rename, sometimes a debug-info file beside it — and reloading on the first of
/// those would restart the core against a half-written binary. Every event
/// restarts this window, so the reload happens once, after the last one.
///
/// 400ms is long enough to cover a link step's own writes and short enough that
/// it reads as immediate. It is not long enough to cover a *whole* compile, and
/// does not need to be: nothing is written to the output path until the end.
const QUIET: Duration = Duration::from_millis(400);

/// The live watchers, one per folder-installed plugin. Managed state.
///
/// The `RecommendedWatcher` is kept only so that dropping it stops the watch —
/// nothing ever calls a method on it. That is why the map holds the watcher
/// rather than a thread handle: the thread ends on its own when the channel
/// closes, which happens when the watcher is dropped, so one `remove` unwinds
/// both halves.
#[derive(Default)]
pub struct Watchers {
    inner: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl Watchers {
    /// Bring the watch set in line with what is installed.
    ///
    /// Idempotent, and the only entry point — called after every change to the
    /// registry rather than having install, uninstall and enable each maintain
    /// the set themselves. Three callers each doing half of this is how a
    /// watcher gets left running on a plugin nobody has any more.
    pub fn sync(&self, app: &AppHandle) {
        let wanted: Vec<(String, PathBuf)> = app
            .state::<Registry>()
            .records()
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| {
                let path = r.source.path().clone();
                (r.id, path)
            })
            .filter(|(_, path)| path.is_dir())
            .collect();

        let mut watchers = self.inner.lock_or_panic();
        watchers.retain(|id, _| wanted.iter().any(|(w, _)| w == id));

        for (id, path) in wanted {
            if watchers.contains_key(&id) {
                continue;
            }
            match start(app.clone(), id.clone(), &path) {
                Some(watcher) => {
                    watchers.insert(id, watcher);
                }
                // Not fatal, and not silent. Losing a watch costs the automatic
                // half of the reload loop; the Reload action still works, which
                // is why this is a line on stderr rather than a refused install.
                None => eprintln!("veistra: not watching {id} for rebuilds"),
            }
        }
    }

    /// Stop every watch. For application exit.
    pub fn stop_all(&self) {
        self.inner.lock_or_panic().clear();
    }
}

/// Watch one plugin's two interesting paths, and reload it when they settle.
fn start(app: AppHandle, id: String, checkout: &Path) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|e| eprintln!("veistra: could not create a watcher for {id}: {e}"))
        .ok()?;

    // The manifest, through its directory. A watch on the checkout root
    // non-recursively sees `veistra-tool.toml` being rewritten and sees nothing
    // from `src/` or `target/`, which is the whole point.
    if let Err(e) = watcher.watch(checkout, RecursiveMode::NonRecursive) {
        eprintln!("veistra: could not watch {}: {e}", checkout.display());
        return None;
    }

    // The binary's directory, when the plugin has one and it has been built at
    // least once. An unbuilt plugin simply is not watched here yet — the
    // manifest watch above still fires, and `sync` runs again on the reload that
    // follows, which is when the directory exists to be watched.
    if let Some(dir) = core_dir(checkout) {
        if dir != checkout {
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                eprintln!("veistra: could not watch {}: {e}", dir.display());
            }
        }
    }

    std::thread::spawn(move || debounce(&app, &id, &rx));
    Some(watcher)
}

/// Block until something changes, wait for it to stop, then reload once.
///
/// Ends when `recv` returns `Disconnected`, which is what dropping the watcher
/// does — so removing an entry from [`Watchers`] reaps this thread without
/// needing a flag to check or a handle to join.
fn debounce(app: &AppHandle, id: &str, rx: &mpsc::Receiver<notify::Result<Event>>) {
    while rx.recv().is_ok() {
        // Drain whatever else the build is still producing. Every event pushes
        // the deadline out, so this returns when the directory has been quiet
        // for `QUIET` rather than `QUIET` after the first event.
        loop {
            match rx.recv_timeout(QUIET) {
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                // The watcher was dropped mid-build. Nothing to reload into.
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        // `reload` is safe on a plugin whose core was never started, and returns
        // false only if the plugin has been uninstalled — which can happen
        // between the event and here, and is not worth reporting.
        plugins::reload(app, id);
    }
}

/// The directory holding a plugin's built binary, if it has one and it exists.
fn core_dir(checkout: &Path) -> Option<PathBuf> {
    let manifest = veistra_tool_manifest::ToolManifest::load(checkout).ok()?;
    let bin = manifest.resolve_bin(checkout).ok()?;
    bin.parent().map(Path::to_path_buf).filter(|d| d.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The debounce window is the difference between one reload per build and
    /// one per file the linker touches. Asserted as a range rather than a value
    /// so tuning it stays possible without editing a test to match.
    #[test]
    fn the_quiet_window_is_long_enough_to_cover_a_link_step() {
        assert!(QUIET >= Duration::from_millis(200));
        assert!(QUIET <= Duration::from_secs(2));
    }

    /// An unbuilt plugin has no binary directory to watch, and that is an
    /// ordinary state rather than a failure — it is what every plugin looks like
    /// before its first `cargo build`.
    #[test]
    fn an_unbuilt_checkout_has_no_core_directory() {
        assert_eq!(core_dir(Path::new("C:/definitely/not/here")), None);
    }

    #[test]
    fn stopping_all_watchers_is_safe_when_there_are_none() {
        let watchers = Watchers::default();
        watchers.stop_all();
        assert!(watchers.inner.lock_or_panic().is_empty());
    }
}
