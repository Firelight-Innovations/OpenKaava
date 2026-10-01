//! Godot integration: finding the engine, running a project, capturing a frame,
//! and reading a scene's tree.
//!
//! `docs/KAAVA-UX-REWORK.md` §3.1 is the rule everything here obeys: **Godot is
//! never embedded in the webview.** It runs as its own native process - the
//! editor in its own window when someone opens it, the game in its own window
//! when someone plays it, and a windowless `--headless` process when the viewer
//! reads a scene. Kaava holds the process handles, the logs and the results;
//! it does not draw the engine.
//!
//! * [`detect`] - the executable and the projects inside an environment.
//! * [`runner`] - a game run as a child process, with a bounded classified log.
//! * [`addon`]  - the opt-in capture script and its file channel.
//! * [`scene`]  - the viewer's headless tree read, render and cache.
//! * [`preview`] - a scene exported to glTF for the viewer's interactive 3D view.
//! * [`rpc`]    - the methods `play` and `godot-viewer` answer.

pub mod addon;
pub mod detect;
pub mod preview;
pub mod rpc;
pub mod runner;
pub mod scene;
#[cfg(test)]
mod testing;

use crate::sync::MutexExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// The settings section, registered from `apps::settings_groups`.
pub static SETTINGS: crate::settings::Group = crate::settings::Group {
    id: "godot",
    title: "Godot",
    description: "The engine Play and the Godot Viewer run, and how to reach it.",
    order: 111,
    settings: SETTINGS_ROWS,
};

pub const KEY_EXECUTABLE_PATH: &str = "godot.executablePath";

pub const KEY_MARKUP_AUTO_SEND: &str = "godot.markupAutoSend";
pub const KEY_MARKUP_TIP: &str = "godot.markupTip";

static SETTINGS_ROWS: &[crate::settings::Setting] = &[
    crate::settings::Setting {
        key: KEY_EXECUTABLE_PATH,
        title: "Godot 4 executable",
        description: "Leave empty to look for it: GODOT4 and GODOT environment variables, PATH, \
                      common install folders and Steam. A path set here is used as it is and is \
                      never replaced by another install. A folder works too.",
        control: crate::settings::Control::Text {
            default: "",
            placeholder: "C:\\Tools\\Godot\\Godot_v4.3-stable_win64.exe",
        },
        applies: crate::settings::Applies::Next {
            what: "the next time Play or the Godot Viewer looks for it",
        },
    },
    crate::settings::Setting {
        key: KEY_MARKUP_AUTO_SEND,
        title: "Send markup to the agent automatically",
        description: "Pressing Done in the Godot Viewer's markup mode puts the drawing and its \
                      notes in front of the agent at once. Off, you press Send markup yourself.",
        control: crate::settings::Control::Toggle { default: false },
        applies: crate::settings::Applies::Now,
    },
    crate::settings::Setting {
        key: KEY_MARKUP_TIP,
        title: "Suggest sending markup automatically",
        description: "The note the Godot Viewer shows the first time you send markup by hand, \
                      offering to make it automatic. Switch this back on to see it again.",
        control: crate::settings::Control::Toggle { default: true },
        applies: crate::settings::Applies::Now,
    },
];

/// Everything Godot-related this process holds: the runs, the viewer's jobs,
/// and the last executable that was found.
#[derive(Default)]
pub struct Godot {
    pub runner: runner::Runner,
    pub jobs: scene::Jobs,
    resolved: Mutex<Option<(String, detect::Found)>>,
    next_command: AtomicU64,
}

impl Godot {
    /// The executable for `setting`, probing only when nothing usable is cached.
    ///
    /// A found path is remembered against the setting text that produced it and
    /// dropped if the file disappears or `refresh` asks; a failed search is not
    /// remembered, so installing Godot and pressing Play again just works.
    pub fn executable(
        &self,
        probe: &detect::Probe,
        refresh: bool,
        check: &dyn Fn(&std::path::Path) -> Result<String, String>,
    ) -> detect::Resolution {
        if !refresh {
            let cached = self.resolved.lock_or_panic().clone();
            if let Some((setting, found)) = cached {
                if setting == probe.setting && found.path.is_file() {
                    return detect::Resolution {
                        found: Some(found),
                        problems: Vec::new(),
                    };
                }
            }
        }
        let resolution = detect::resolve(probe, check);
        *self.resolved.lock_or_panic() = resolution
            .found
            .clone()
            .map(|found| (probe.setting.clone(), found));
        resolution
    }

    pub fn next_command_id(&self) -> u64 {
        self.next_command.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Called at application exit: no game outlives the window that started it.
    pub fn shutdown(&self) {
        self.runner.stop_all();
    }
}

/// The folder run channels and scratch files live in. The OS temp directory,
/// never the project: a channel is throwaway, and writing it into a checkout
/// would be a change to a repository nobody asked for.
pub fn scratch_root() -> PathBuf {
    std::env::temp_dir().join("kaava-godot")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_found_executable_is_remembered_until_the_setting_changes_or_refresh_asks() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe = dir.path().join("godot-x");
        std::fs::write(&exe, "x").unwrap();
        let godot = Godot::default();
        let calls = std::cell::Cell::new(0);
        let check = |_: &std::path::Path| {
            calls.set(calls.get() + 1);
            Ok("4.3.stable".to_string())
        };
        let mut probe = detect::Probe {
            setting: exe.display().to_string(),
            ..detect::Probe::default()
        };

        assert!(godot.executable(&probe, false, &check).found.is_some());
        assert!(godot.executable(&probe, false, &check).found.is_some());
        assert_eq!(calls.get(), 1, "the second call is answered from memory");

        godot.executable(&probe, true, &check);
        assert_eq!(calls.get(), 2, "refresh probes again");

        probe.setting = String::new();
        assert!(godot.executable(&probe, false, &check).found.is_none());
        assert_eq!(calls.get(), 2, "nothing to try, so nothing is asked");
    }

    #[test]
    fn a_failed_search_is_not_cached() {
        let godot = Godot::default();
        let probe = detect::Probe::default();
        assert!(godot
            .executable(&probe, false, &|_| Err("no".into()))
            .found
            .is_none());
        assert!(godot.resolved.lock_or_panic().is_none());
    }
}
