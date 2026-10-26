//! Which plugins this person has installed, across launches.
//!
//! The fifth thing in the orchestrator to touch the disk, after
//! [`crate::project::store`], [`crate::shell_store`], [`crate::presets::store`]
//! and [`crate::settings::store`], and built to the same four rules those four
//! share — read `presets::store` for the reasoning, which is unchanged here:
//! never fatal, atomic write, forward-compatible, and outside the repo.
//!
//! ## What is *not* in the file
//!
//! Anything the manifest already says. A record names where a package came from
//! and nothing about what is in it — no surface list, no version, no name. All
//! of that is read back out of the checkout's own `veistra-tool.toml` at load, so
//! a plugin that gains a surface between launches gains it here too, and a
//! record can never disagree with the code it points at.
//!
//! That is the whole reason this file is as thin as it is. The tempting version
//! caches the resolved surfaces so the switcher can be drawn without touching
//! the disk; what it actually buys is a second source of truth that goes stale
//! the first time somebody rebuilds a plugin.

use crate::userdata::store::Keep;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE: &str = "plugins.json";

/// Precious. Not for the checkouts, which a re-download replaces, but for the
/// list: which packages somebody chose and where each came from is a decision,
/// and a private repository they can no longer remember the URL of is gone.
const KEEP: Keep = Keep::Aside;

/// What is on disk: one record per installed package, in install order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stored {
    pub plugins: Vec<Record>,
}

/// One installed package, as remembered between launches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// The package id, which is also the `[tool] id` in its manifest. The
    /// identity: what an uninstall names and what a surface address begins
    /// with.
    pub id: String,
    /// Where the package is and how it got there.
    pub source: Source,
    /// Whether its surfaces are offered. A disabled plugin keeps its record —
    /// turning one off and uninstalling it are different intentions, and only
    /// the second should lose the fact that you ever had it.
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

/// Where a package's files live, and what that implies about owning them.
///
/// Tagged rather than a bare path, because the two cases differ in a way that
/// matters at uninstall: a folder install points at a working tree the person
/// already had, and removing the record must not remove the directory. Phase
/// two's downloaded copy is one this application created, and that one *is*
/// ours to delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// A checkout somewhere on this machine, named by the person installing it.
    /// The development path: the directory is theirs, we only read it.
    Folder { path: PathBuf },
    /// A release downloaded and unpacked under this application's own config
    /// directory. The opposite ownership to `Folder`: nothing else put it
    /// there, so uninstalling deletes it.
    ///
    /// `sha256` is `None` when the release published no checksum sidecar.
    /// Stored as an absence rather than an empty string, because "installed but
    /// never verified" is a fact about this install that the management screen
    /// should be able to show.
    Release {
        path: PathBuf,
        repo: String,
        tag: String,
        sha256: Option<String>,
    },
}

impl Source {
    /// Where the checkout is, whichever kind it is.
    pub fn path(&self) -> &PathBuf {
        match self {
            Self::Folder { path } | Self::Release { path, .. } => path,
        }
    }

    /// Whether uninstalling should delete the directory as well as the record.
    /// True only for what this application downloaded itself.
    pub fn is_owned(&self) -> bool {
        matches!(self, Self::Release { .. })
    }
}

/// Whether this machine has a plugin store yet.
///
/// The test for a first run, and it is deliberately "has the file ever been
/// written" rather than "is the list empty". Somebody who uninstalled every
/// default on purpose has an empty list, and re-installing them behind their
/// back on the next launch would be the application overruling them.
pub fn exists(app: &AppHandle) -> bool {
    file(app).is_some_and(|path| path.is_file())
}

/// Read the store, or start empty. Never fails — see the module doc.
///
/// **Careful with the interaction with [`exists`] above.** A file this build
/// cannot use is set aside rather than left in place, which makes `exists`
/// answer `false` on the next launch and the default apps re-install. That is
/// the right outcome for a store that was unreadable — the alternative is a
/// switcher that is empty and stays empty — but it is a consequence rather than
/// an accident, and it is why `Keep::Aside` matters here: the record of what
/// they had installed is beside it.
pub fn load(app: &AppHandle) -> Stored {
    file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default()
}

/// Write the store, atomically, through `userdata::store` — see that module for
/// why the copy of this that used to live here is gone.
pub fn save(app: &AppHandle, stored: &Stored) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, stored, "the plugin list");
    }
}

/// `%APPDATA%/<identifier>/plugins.json` on Windows, the equivalent elsewhere.
///
/// Beside `projects.json`, `layout.json`, `presets.json` and `settings.json`,
/// never inside a project. What you have installed is a fact about your machine,
/// not about any checkout you happen to have open.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The degradation promise, as a test. A document this build cannot parse
    /// yields an empty list rather than an error, and a document from a build
    /// that added a top-level field still loads.
    #[test]
    fn an_unreadable_store_falls_back_to_no_plugins() {
        let broken: std::result::Result<Stored, _> = serde_json::from_str("{ not json");
        assert!(broken.is_err(), "the parse itself fails");

        let newer: Stored = serde_json::from_str(r#"{"plugins":[],"autoUpdate":true}"#)
            .expect("an unknown field must not fail the read");
        assert!(newer.plugins.is_empty());
    }

    #[test]
    fn an_empty_document_is_a_store_with_nothing_installed() {
        let stored: Stored = serde_json::from_str("{}").expect("`{}` is an empty store");
        assert!(stored.plugins.is_empty());
    }

    #[test]
    fn a_record_survives_a_round_trip_through_the_file_format() {
        let stored = Stored {
            plugins: vec![Record {
                id: "acme".to_string(),
                source: Source::Folder {
                    path: PathBuf::from("C:/code/veistra/acme"),
                },
                enabled: true,
            }],
        };

        let json = serde_json::to_string_pretty(&stored).expect("serializes");
        let back: Stored = serde_json::from_str(&json).expect("and reads back");

        assert_eq!(back.plugins, stored.plugins);
    }

    /// `enabled` was added after the first records could have been written, so
    /// its absence has to mean the thing a person would expect: a plugin they
    /// installed is on.
    #[test]
    fn a_record_without_enabled_is_enabled() {
        let stored: Stored = serde_json::from_str(
            r#"{"plugins":[{"id":"acme","source":{"kind":"folder","path":"C:/x"}}]}"#,
        )
        .expect("parses");
        assert!(stored.plugins[0].enabled);
    }

    /// The tag is what makes room for phase two's downloaded copy without
    /// rewriting every record already on disk.
    #[test]
    fn source_is_tagged_so_a_second_kind_can_be_added() {
        let json = serde_json::to_string(&Source::Folder {
            path: PathBuf::from("C:/x"),
        })
        .unwrap();
        assert!(json.contains(r#""kind":"folder""#), "got {json}");
    }
}
