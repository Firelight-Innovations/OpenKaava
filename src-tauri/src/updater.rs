//! Finding out that a newer Veistra exists, and replacing this one with it.
//!
//! The mechanism is `tauri-plugin-updater`: it fetches the `latest.json` named
//! in `plugins.updater.endpoints`, verifies its minisign signature against
//! `plugins.updater.pubkey`, downloads the NSIS installer and runs it. What is
//! here is the part that plugin has no opinion about — when a check happens,
//! what the interface is told while it is happening, and what a failure reads
//! like on screen. `docs/dev/releases.md` has the pipeline behind it, and why
//! that minisign key is not the code signing certificate this app still lacks.
//!
//! **Driven from Rust, not from the webview.** `@tauri-apps/plugin-updater`
//! exists and would have been fewer lines, but STANDARDS.md §1 is that Rust
//! owns everything touching the machine, and this downloads a file and runs an
//! installer. It also puts the launch check in `lib.rs`'s setup beside
//! `mcp::start` rather than in a React effect that runs in whichever window
//! mounted first, and leaves `capabilities/default.json` granting no updater
//! permission to a webview that never calls one.

use crate::error::{AppError, Result};
use crate::settings;
use crate::sync::MutexExt;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Broadcast on every state change, to every window.
///
/// The whole state rather than a delta, for `settings:changed`'s reason: it is
/// one small object, and a window that mounted late could never have heard the
/// transitions it missed since Tauri events have no replay. A window that
/// arrives mid-download asks [`state`] once and then follows this.
pub const UPDATE_CHANGED_EVENT: &str = "updater:changed";

/// Longest release note the shell is handed. See [`summarise`].
const MAX_NOTES: usize = 400;

/// Where the updater is in its one linear job.
///
/// Internally tagged, like `boot::BootStatus` and `tool::ToolStatus`, so it
/// lands in TypeScript as a discriminated union — narrow on `state` and the
/// fields that variant has appear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UpdateState {
    /// Nothing has been asked yet. The state every launch starts in, including
    /// one where the automatic check is switched off.
    Idle,
    Checking,
    /// The endpoint answered and this build is the newest there is. Carries the
    /// running version so the interface can say *which* version is current
    /// without asking a second question.
    UpToDate {
        version: String,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        /// Already trimmed by [`summarise`] — a status bar is not a changelog.
        notes: String,
    },
    /// `total` is `None` when the release asset was served without a
    /// `Content-Length`, which is why `percent` is separate rather than derived
    /// on the other side: there is nothing to derive it from.
    Downloading {
        received: u64,
        total: Option<u64>,
        percent: Option<u8>,
    },
    /// The installer is running. On Windows this is the last thing anything
    /// hears — see [`install`].
    Installing,
    /// Something to *show*. Offline is the common case and is not an error the
    /// user did anything about, so the interface keeps this quiet unless the
    /// check was asked for by hand.
    Failed {
        message: String,
    },
    /// This build cannot install an update over itself. Distinct from
    /// [`UpdateState::Failed`] because nothing is wrong and retrying will not
    /// help — see [`unsupported`].
    Unsupported {
        reason: String,
    },
}

impl UpdateState {
    /// Whether [`install`] may run from here.
    ///
    /// Only from a standing offer. Installing from `Idle` would mean checking
    /// and installing on one click, which is a download nobody agreed to; from
    /// `Downloading` or `Installing` it would start a second installer over the
    /// first.
    pub fn installable(&self) -> bool {
        matches!(self, UpdateState::Available { .. })
    }
}

/// The current state, shared by every window.
///
/// Managed state, mutex'd rather than atomic because the value is a string-
/// carrying enum. No method returns a guard — the same invariant
/// `settings::Registry` holds, so a lock can never be held across an `.await`
/// in a command.
pub struct UpdateStatus(Mutex<UpdateState>);

impl Default for UpdateStatus {
    fn default() -> Self {
        Self(Mutex::new(UpdateState::Idle))
    }
}

impl UpdateStatus {
    fn get(&self) -> UpdateState {
        self.0.lock_or_panic().clone()
    }

    fn set(&self, next: UpdateState) {
        *self.0.lock_or_panic() = next;
    }
}

/// The state without touching the network. What a window asks on mount.
pub fn state(app: &AppHandle) -> UpdateState {
    app.state::<UpdateStatus>().get()
}

/// The background check, once, at launch.
///
/// Spawned rather than awaited: this is a network round trip and nothing on
/// screen waits for it. Skipped entirely when `updates.checkAutomatically` is
/// off, which is why that setting is declared `Applies::Restart` — this line is
/// the only moment it is read, and the Help menu's item is the way to check
/// without it.
pub fn start(app: AppHandle) {
    if !settings::flag(&app, settings::keys::UPDATES_CHECK_AUTOMATICALLY) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        check(&app).await;
    });
}

/// Ask the endpoint, publishing every transition on the way.
///
/// Returns the state it settled in rather than a `Result`: a failed check is a
/// state the interface draws, not an error a caller recovers from, and the
/// command that calls this wants the same value the event just carried.
pub async fn check(app: &AppHandle) -> UpdateState {
    if let Some(reason) = unsupported() {
        return publish(app, UpdateState::Unsupported { reason });
    }

    publish(app, UpdateState::Checking);

    let settled = match app.updater() {
        Err(e) => UpdateState::Failed {
            message: describe("check for", &e.to_string()),
        },
        Ok(updater) => match updater.check().await {
            Err(e) => UpdateState::Failed {
                message: describe("check for", &e.to_string()),
            },
            Ok(None) => UpdateState::UpToDate {
                version: app.package_info().version.to_string(),
            },
            Ok(Some(update)) => UpdateState::Available {
                version: update.version.clone(),
                notes: summarise(update.body.as_deref().unwrap_or_default()),
            },
        },
    };

    publish(app, settled)
}

/// Download the offered release and run its installer.
///
/// Re-checks first rather than holding the `Update` the offer came from. That
/// value carries the resolved download URL and its signature, and keeping it in
/// managed state would mean an offer made an hour ago installing an artifact
/// the release has since been re-uploaded over. One more request to a JSON file
/// is cheaper than being wrong about which bytes are about to be run.
///
/// **This does not return on Windows.** `download_and_install` hands off to the
/// NSIS installer and ends this process, so the restart below is the branch for
/// a platform that lets the call finish. Both arms leave the user in a running
/// application; neither leaves them looking at a window that has quietly become
/// the previous version.
pub async fn install(app: &AppHandle) -> Result<()> {
    if !state(app).installable() {
        return Err(AppError::Update {
            op: "install",
            reason: "there is no update on offer — check for one first".to_string(),
        });
    }

    let updater = failed(app, app.updater())?;
    let found = failed(app, updater.check().await)?;

    let Some(update) = found else {
        // The release was pulled between the offer and the click. Not an error:
        // the app is on the newest version there is, which is what the offer
        // was trying to achieve.
        publish(
            app,
            UpdateState::UpToDate {
                version: app.package_info().version.to_string(),
            },
        );
        return Ok(());
    };

    let mut received: u64 = 0;
    let result = update
        .download_and_install(
            |chunk, total| {
                received = received.saturating_add(chunk as u64);
                publish(
                    app,
                    UpdateState::Downloading {
                        received,
                        total,
                        percent: percent(received, total),
                    },
                );
            },
            || {
                publish(app, UpdateState::Installing);
            },
        )
        .await;

    failed(app, result)?;

    app.restart()
}

/// Turn a failed step of [`install`] into both halves of a report.
///
/// The **state** carries [`describe`]'s sentence, which is what the status bar
/// draws. The **error** carries the plugin's own text, which is what reaches
/// the browser console. They are deliberately different: rewriting an error for
/// a person is right on screen and lossy in a log, and this is the one place
/// both readers exist.
///
/// Publishing here rather than at each call site is what makes it impossible to
/// return early from a download and leave the bar still offering the update
/// that just failed.
fn failed<T>(
    app: &AppHandle,
    result: std::result::Result<T, tauri_plugin_updater::Error>,
) -> Result<T> {
    result.map_err(|e| {
        let raw = e.to_string();
        publish(
            app,
            UpdateState::Failed {
                message: describe("install", &raw),
            },
        );
        AppError::Update {
            op: "install",
            reason: raw,
        }
    })
}

/// Store the state and tell every window. The one way it moves.
fn publish(app: &AppHandle, next: UpdateState) -> UpdateState {
    app.state::<UpdateStatus>().set(next.clone());
    if let Err(e) = app.emit(UPDATE_CHANGED_EVENT, &next) {
        eprintln!("veistra: could not announce the update state: {e}");
    }
    next
}

/// Why this build cannot update itself, or `None` if it can.
///
/// A debug build was started by `cargo` out of a target directory, and the
/// installer would put a *release* Veistra in Program Files and leave the
/// developer looking at the one they are still compiling. Offering that is
/// worse than saying so.
fn unsupported() -> Option<String> {
    cfg!(debug_assertions).then(|| {
        "This is a development build. Updates replace an installed Veistra, and there is not one \
         here to replace."
            .to_string()
    })
}

/// How far a download has got, or `None` when nobody said how far there was.
///
/// Clamped rather than trusted: `total` comes off a `Content-Length` header on
/// a response we did not write, and a progress bar past its own end is the kind
/// of wrong that looks like a bug in the shell.
fn percent(received: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    let ratio = (received as f64 / total as f64) * 100.0;
    Some(ratio.clamp(0.0, 100.0) as u8)
}

/// A release note, cut down to something a status bar can hold.
///
/// The first paragraph, because release notes are written with the headline
/// first and `--generate-notes` puts the change list under it. Hard-capped
/// after that on a word boundary: a single-paragraph note can still be a
/// thousand characters, and the interface has no way to refuse one.
fn summarise(notes: &str) -> String {
    let first = notes
        .split("\n\n")
        .map(str::trim)
        .find(|p| !p.is_empty())
        .unwrap_or("");

    let flattened = first.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= MAX_NOTES {
        return flattened;
    }

    let mut cut: String = flattened.chars().take(MAX_NOTES).collect();
    if let Some(space) = cut.rfind(' ') {
        cut.truncate(space);
    }
    format!("{cut}…")
}

/// The plugin's error, as a sentence to put in front of somebody.
///
/// The plugin's own messages name the transport (`Reqwest`, `Io`), which
/// answers a question nobody asked. Two cases are worth recognising by hand
/// because they are the two that actually happen; everything else keeps the
/// original text, since inventing a category for an error nobody has seen is
/// how a diagnostic becomes a lie.
fn describe(op: &'static str, raw: &str) -> String {
    let lower = raw.to_lowercase();

    if lower.contains("signature") || lower.contains("minisign") {
        return "The update was signed by a key this build does not trust. Download the release \
                from GitHub instead."
            .to_string();
    }
    if lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") {
        return format!("Could not reach the releases endpoint to {op} an update.");
    }
    format!("Could not {op} an update: {raw}")
}

// --- commands ---------------------------------------------------------------
//
// Declared here rather than in `commands.rs` for the reason `git`, `search`,
// `mcp` and `settings` declare their own: the command is the module's public
// surface, and separating the two means a change to what the updater exposes is
// one file rather than two that have to agree.

/// Where the updater is, without touching the network.
///
/// What a window asks on mount, because `updater:changed` has no replay and a
/// window opened after the launch check would otherwise never learn its result.
#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateState {
    state(&app)
}

/// Ask the releases endpoint now, resolving with the state it settled in.
///
/// Safe to call twice: a second check restarts the request rather than
/// queueing, and the worst case is one wasted round trip to a JSON file.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> UpdateState {
    check(&app).await
}

/// Download the standing offer and run its installer.
///
/// **Does not resolve on Windows** — the installer ends this process. Refuses
/// unless a check has actually produced an offer; see [`UpdateState::installable`].
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<()> {
    install(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_standing_offer_can_be_installed() {
        assert!(UpdateState::Available {
            version: "0.2.0".to_string(),
            notes: String::new(),
        }
        .installable());

        for state in [
            UpdateState::Idle,
            UpdateState::Checking,
            UpdateState::UpToDate {
                version: "0.1.1".to_string(),
            },
            UpdateState::Downloading {
                received: 1,
                total: Some(2),
                percent: Some(50),
            },
            UpdateState::Installing,
            UpdateState::Failed {
                message: "nope".to_string(),
            },
            UpdateState::Unsupported {
                reason: "dev".to_string(),
            },
        ] {
            assert!(
                !state.installable(),
                "{state:?} would install without an offer standing"
            );
        }
    }

    #[test]
    fn progress_is_none_when_nobody_declared_a_total() {
        assert_eq!(percent(512, None), None);
        assert_eq!(percent(512, Some(0)), None, "a zero total is not a total");
    }

    #[test]
    fn progress_is_clamped_to_the_bar_it_draws() {
        assert_eq!(percent(0, Some(100)), Some(0));
        assert_eq!(percent(50, Some(100)), Some(50));
        assert_eq!(percent(100, Some(100)), Some(100));
        assert_eq!(
            percent(400, Some(100)),
            Some(100),
            "a server that under-reported its own length must not push the bar past its end"
        );
    }

    #[test]
    fn a_note_is_cut_to_its_first_paragraph() {
        let notes = "Fixes the terminal.\n\n- one thing\n- another thing";
        assert_eq!(summarise(notes), "Fixes the terminal.");
    }

    #[test]
    fn a_note_is_flattened_and_leading_blank_lines_are_skipped() {
        assert_eq!(
            summarise("\n\n  Fixes\n  the terminal.  "),
            "Fixes the terminal."
        );
        assert_eq!(summarise(""), "");
    }

    /// A single-paragraph note has no structure to cut on, and the interface
    /// has no way to refuse one, so the cap is the only thing between a status
    /// bar and a thousand characters.
    #[test]
    fn a_long_note_is_cut_on_a_word_boundary() {
        let long = "word ".repeat(200);
        let cut = summarise(&long);
        assert!(
            cut.chars().count() <= MAX_NOTES + 1,
            "cut to the cap plus its ellipsis"
        );
        assert!(cut.ends_with('…'));
        assert!(!cut.contains("wor…"), "the cap landed mid-word");
    }

    #[test]
    fn a_signature_failure_says_what_to_do_instead() {
        let message = describe("install", "Error: signature verification failed");
        assert!(message.contains("does not trust"));
        assert!(
            !message.contains("Error:"),
            "the transport's own wording is dropped"
        );
    }

    #[test]
    fn an_unreachable_endpoint_reads_as_one() {
        assert_eq!(
            describe("check for", "error sending request: dns error"),
            "Could not reach the releases endpoint to check for an update."
        );
    }

    /// An error nobody has seen keeps its own text. Inventing a category for it
    /// would replace the one clue with a guess.
    #[test]
    fn an_unrecognised_failure_keeps_its_own_words() {
        assert_eq!(
            describe("install", "the target directory is read-only"),
            "Could not install an update: the target directory is read-only"
        );
    }
}
