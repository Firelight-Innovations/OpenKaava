//! Where Veistra remembers the presets you have saved, across launches.
//!
//! The third thing in the orchestrator to touch the disk, after
//! [`crate::project::store`] and [`crate::shell_store`], and built to the same
//! four rules those two share — read them for the reasoning, which is unchanged
//! here: never fatal, atomic write, forward-compatible, and not in the repo.
//! Each rule is stated again on the item that keeps it.
//!
//! ## Why this is not in `layout.json`
//!
//! It would fit there, and it belongs somewhere else anyway. `layout.json` is
//! *what is on screen right now* — windows, their geometry, the trees inside
//! them — and it is rewritten on every mutation, which is to say on every drag
//! of a divider. Presets are none of that: they are a small, deliberate, rarely
//! changing library of user data that outlives every layout it was captured
//! from. Folding them in would mean one corrupt write costing both, and would
//! put a file rewritten hundreds of times a session in charge of something the
//! user expects to still be there next year.

use super::LayoutPreset;
use crate::userdata::store::Keep;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE: &str = "presets.json";

/// Precious. A preset library is built by hand, one preset at a time, and
/// nothing in the app or on the machine can reconstruct one.
const KEEP: Keep = Keep::Aside;

/// What is on disk: the user's own presets, and nothing else.
///
/// Not the built-ins. They are compiled in ([`super::builtins`]) and merged on
/// read, so this file holds only what the user saved. That is what makes a
/// built-in impossible to lose: there is nothing on disk to lose it *from*, and
/// [`super::merge`] refuses any entry claiming to be one.
///
/// **Forward-compatible.** `#[serde(default)]`, unknown fields ignored, so a
/// document written by a later build still reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stored {
    pub presets: Vec<LayoutPreset>,
}

/// Read the store, or start empty.
///
/// **Never fatal.** Every failure degrades to [`Stored::default`], which merges
/// to "just the built-ins". A presets file that is missing, truncated by a power
/// cut, or written by a future build must not stop Veistra from starting, and must
/// not empty the menu it is meant to fill.
pub fn load(app: &AppHandle) -> Stored {
    file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default()
}

/// Write the store, **atomically**, through `userdata::store`.
///
/// This was a copy of `project::store::save` down to the error handling,
/// deliberately, "because a second version of it that drifted would be a second
/// way to lose a file". The argument was right and the answer was not: eight
/// copies could not drift apart, and could all be wrong together — which is
/// what the missing format field turned out to be.
pub fn save(app: &AppHandle, stored: &Stored) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, stored, "the preset store");
    }
}

/// `%APPDATA%/<identifier>/presets.json` on Windows, the equivalent elsewhere.
///
/// **Not in the repo.** The OS config directory, beside `projects.json` and
/// `layout.json`, never inside a project.
///
/// `None` only if the platform has no config directory at all. An `Option`
/// rather than an `expect` for `project::store::file`'s reason: losing the saved
/// presets is a smaller failure than a panic.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presets::{merge, PresetNode, PresetSlot};

    /// The degradation promise, as a test. Both halves of it: a document this
    /// build cannot parse yields the built-ins rather than an error, and a
    /// document from a build that added a field still loads.
    #[test]
    fn an_unreadable_store_falls_back_to_the_built_ins() {
        let broken: std::result::Result<Stored, _> = serde_json::from_str("{ not json");
        assert!(broken.is_err(), "the parse itself fails");
        assert!(
            !merge(Stored::default().presets).is_empty(),
            "and what the caller falls back to is still a usable menu"
        );

        let newer: Stored =
            serde_json::from_str(r#"{"presets":[],"sharedWithTheTeam":["something new"]}"#)
                .expect("an unknown field must not fail the read");
        assert!(newer.presets.is_empty());
    }

    #[test]
    fn an_empty_document_is_a_store_with_nothing_in_it() {
        let stored: Stored =
            serde_json::from_str("{}").expect("`{}` is a store holding no presets");
        assert!(stored.presets.is_empty());
    }

    /// The file is the thing that survives a restart, so a preset that writes
    /// and does not read back is a preset that vanishes overnight.
    #[test]
    fn a_saved_preset_survives_a_round_trip_through_the_file_format() {
        let stored = Stored {
            presets: vec![LayoutPreset {
                id: "editor-and-shell".to_string(),
                name: "Editor and Shell".to_string(),
                builtin: false,
                root: PresetNode::Split {
                    dir: crate::layout::SplitDir::Row,
                    sizes: vec![0.7, 0.3],
                    children: vec![
                        PresetNode::Pane {
                            slots: vec![PresetSlot::App {
                                app_id: "files".to_string(),
                            }],
                        },
                        PresetNode::Pane {
                            slots: vec![PresetSlot::Terminal],
                        },
                    ],
                },
            }],
        };

        let json = serde_json::to_string_pretty(&stored).expect("serializes");
        let back: Stored = serde_json::from_str(&json).expect("and reads back");

        assert_eq!(back.presets.len(), 1);
        assert_eq!(back.presets[0].root, stored.presets[0].root);
        assert_eq!(back.presets[0].id, "editor-and-shell");
    }
}
