//! The webview this process is already running, reached through the COM
//! interface Tauri already holds rather than over a socket.
//!
//! **The DevTools Protocol.** WebView2 is Chromium, and
//! `ICoreWebView2::CallDevToolsProtocolMethod` is the same protocol Chrome
//! exposes over `--remote-debugging-port`. No socket, no debug port and no
//! second process is the whole reason this module exists; the argument for it
//! is in `docs/design-notes/agent-ui-driving.md`.
//!
//! **Document-created scripts.** [`install_script`] is WebView2's own
//! `AddScriptToExecuteOnDocumentCreated`, which is not part of that protocol
//! and lives here because it is the same COM object reached the same way.
//!
//! Everything here is transport. What the calls *mean* belongs to
//! `mcp::servers::ui` and `apps::design`.

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};

/// How long one call may take before we stop waiting for it.
///
/// Generous, because the answer comes back through the main thread and a shell
/// busy laying out a large tree can take a moment to get to it. Bounded, because
/// the caller is an HTTP request from an agent, and a hung tool is worse than a
/// failed one: the agent has nothing to read and no reason to stop waiting.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Never a target. The splash window has no shell in it, and picking it because
/// it happened to have focus during boot would answer a question about OpenKaava
/// with a screenshot of a progress bar.
const SPLASH: &str = "splash";

/// Why a call did not produce an answer.
///
/// Deliberately not a `tauri::Error` or a bare `String`: each of these means
/// something different to whoever reads it, and the tool layer turns them into
/// sentences a model can act on.
#[derive(Debug)]
pub enum Error {
    /// No window to act on, or none by that name.
    NoWindow(String),
    /// The call could not be made, or was made and came back a failure.
    ///
    /// One variant rather than two because the distinction is not one the caller
    /// can act on: either way nothing happened to the window, and either way the
    /// string is what says why.
    Refused(String),
    /// [`TIMEOUT`] elapsed with nothing back.
    TimedOut,
}

impl Error {
    pub fn message(&self) -> String {
        match self {
            Error::NoWindow(what) => what.clone(),
            Error::Refused(why) => why.clone(),
            Error::TimedOut => format!(
                "the webview did not answer within {}s — it may be blocked on a native dialog, \
                 which nothing here can dismiss",
                TIMEOUT.as_secs()
            ),
        }
    }
}

/// One DevTools Protocol call, and its result.
///
/// **Never call this from the main thread.** The work is posted there and this
/// blocks until it comes back, so the main thread waiting on itself is a
/// deadlock that lasts until [`TIMEOUT`]. Every caller today is an MCP tool,
/// which runs on a runtime worker.
pub fn call(
    app: &AppHandle,
    window: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, Error> {
    dispatch(&pick(app, window)?, method, params.to_string())
}

/// Every window a call could act on, splash excluded, sorted by label so two
/// calls in a row walk them in the same order.
pub fn window_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| label != SPLASH)
        .collect();
    labels.sort();
    labels
}

/// Which window a call acts on.
///
/// Named, else focused, else whichever sorts first — and never the splash. The
/// fallback is deterministic rather than arbitrary because an agent that takes
/// two screenshots in a row should get two of the same window, and a `HashMap`'s
/// iteration order would not promise that.
fn pick(app: &AppHandle, wanted: Option<&str>) -> Result<WebviewWindow, Error> {
    if let Some(label) = wanted {
        return app
            .get_webview_window(label)
            .ok_or_else(|| Error::NoWindow(format!("no window is labelled `{label}` right now")));
    }

    let mut open: Vec<WebviewWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != SPLASH)
        .map(|(_, window)| window)
        .collect();

    if let Some(focused) = open.iter().find(|w| w.is_focused().unwrap_or(false)) {
        return Ok(focused.clone());
    }

    open.sort_by(|a, b| a.label().cmp(b.label()));
    open.into_iter()
        .next()
        .ok_or_else(|| Error::NoWindow("no shell window is open".to_string()))
}

#[cfg(windows)]
fn dispatch(window: &WebviewWindow, method: &str, params: String) -> Result<Value, Error> {
    use std::sync::mpsc::{self, RecvTimeoutError};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    let (tx, rx) = mpsc::channel();
    let wanted = method.to_string();

    // `with_webview` posts to the main thread, where the WebView2 COM objects
    // live and are the only place they may be touched. The closure returns
    // nothing, so both the failure to start the call and its eventual answer
    // come back the same way: down the channel.
    let posted = window.with_webview(move |webview| {
        let answer = tx.clone();
        let started = (|| -> windows_core::Result<()> {
            let core = unsafe { webview.controller().CoreWebView2() }?;
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    let _ = answer.send(result.map(|()| json));
                    Ok(())
                },
            ));

            unsafe {
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from(wanted.as_str()),
                    &HSTRING::from(params.as_str()),
                    &handler,
                )
            }
        })();

        if let Err(e) = started {
            let _ = tx.send(Err(e));
        }
    });

    if let Err(e) = posted {
        return Err(Error::Refused(format!(
            "the window would not take the call: {e}"
        )));
    }

    match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(json)) => serde_json::from_str(&json)
            .map_err(|e| Error::Refused(format!("`{method}` answered something unreadable: {e}"))),
        Ok(Err(e)) => Err(Error::Refused(format!("`{method}` was refused: {e}"))),
        Err(RecvTimeoutError::Timeout) => Err(Error::TimedOut),
        Err(RecvTimeoutError::Disconnected) => Err(Error::Refused(format!(
            "the window went away while `{method}` was in flight"
        ))),
    }
}

/// Nothing to talk to. WebView2 is what speaks this protocol, and it is the
/// Windows webview — so on any other platform every tool on the UI server fails
/// with this rather than the module being compiled out. A server that is missing
/// on one platform and present on another is a harder thing to explain to
/// somebody than a tool that says why it cannot run.
#[cfg(not(windows))]
fn dispatch(_window: &WebviewWindow, _method: &str, _params: String) -> Result<Value, Error> {
    Err(Error::Refused(
        "driving the UI needs WebView2, which only the Windows build has".to_string(),
    ))
}

/// Have every document this window's webview loads from now on run `script`
/// before any of the page's own code, and hand back the id that undoes it.
///
/// **This reaches into child frames, including cross-origin ones**, which is
/// the entire reason it is here: same-origin policy means no amount of
/// JavaScript in the shell can put a listener inside an iframe pointed at
/// somebody else's dev server.
///
/// The DevTools Protocol's near-namesake,
/// `Page.addScriptToEvaluateOnNewDocument`, would need no new plumbing and was
/// rejected — it is scoped to one *target*, and a cross-site iframe is a target
/// of its own. `docs/design-notes/design-mode.md` has the whole argument.
///
/// Never call this from the main thread; see [`call`] for why.
#[cfg_attr(not(feature = "design-mode"), allow(dead_code))]
pub fn install_script(
    app: &AppHandle,
    window: Option<&str>,
    script: &str,
) -> Result<String, Error> {
    add_script(&pick(app, window)?, script.to_string())
}

/// Undo one [`install_script`]. Documents already loaded keep the script they
/// were given — this stops the next one getting it, and nothing more, which is
/// why Design Mode reloads the frame it is finished with rather than trusting
/// this to clean a live page.
#[cfg_attr(not(feature = "design-mode"), allow(dead_code))]
pub fn remove_script(app: &AppHandle, window: Option<&str>, id: &str) -> Result<(), Error> {
    drop_script(&pick(app, window)?, id.to_string())
}

#[cfg(windows)]
fn add_script(window: &WebviewWindow, script: String) -> Result<String, Error> {
    use std::sync::mpsc::{self, RecvTimeoutError};
    use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
    use windows_core::HSTRING;

    let (tx, rx) = mpsc::channel();

    let posted = window.with_webview(move |webview| {
        let answer = tx.clone();
        let started = (|| -> windows_core::Result<()> {
            let core = unsafe { webview.controller().CoreWebView2() }?;
            let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(
                move |result, id| {
                    let _ = answer.send(result.map(|()| id));
                    Ok(())
                },
            ));

            unsafe { core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler) }
        })();

        if let Err(e) = started {
            let _ = tx.send(Err(e));
        }
    });

    if let Err(e) = posted {
        return Err(Error::Refused(format!(
            "the window would not take the script: {e}"
        )));
    }

    match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(id)) => Ok(id),
        Ok(Err(e)) => Err(Error::Refused(format!("the script was refused: {e}"))),
        Err(RecvTimeoutError::Timeout) => Err(Error::TimedOut),
        Err(RecvTimeoutError::Disconnected) => Err(Error::Refused(
            "the window went away while the script was being installed".to_string(),
        )),
    }
}

#[cfg(windows)]
fn drop_script(window: &WebviewWindow, id: String) -> Result<(), Error> {
    use std::sync::mpsc::{self, RecvTimeoutError};
    use windows_core::HSTRING;

    // Synchronous on the COM side, unlike its counterpart above, so what comes
    // back down the channel is the call's own result rather than a callback's.
    let (tx, rx) = mpsc::channel();
    let posted = window.with_webview(move |webview| {
        let outcome = (|| -> windows_core::Result<()> {
            let core = unsafe { webview.controller().CoreWebView2() }?;
            unsafe { core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id)) }
        })();
        let _ = tx.send(outcome);
    });

    if let Err(e) = posted {
        return Err(Error::Refused(format!(
            "the window would not take the removal: {e}"
        )));
    }

    match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(Error::Refused(format!("the removal was refused: {e}"))),
        Err(RecvTimeoutError::Timeout) => Err(Error::TimedOut),
        Err(RecvTimeoutError::Disconnected) => Err(Error::Refused(
            "the window went away while the script was being removed".to_string(),
        )),
    }
}

/// See the note on the non-Windows [`dispatch`]: absent everywhere else, and
/// answering rather than being compiled out, so the failure is a sentence
/// instead of a missing feature.
#[cfg(not(windows))]
fn add_script(_window: &WebviewWindow, _script: String) -> Result<String, Error> {
    Err(Error::Refused(UNSUPPORTED.to_string()))
}

#[cfg(not(windows))]
fn drop_script(_window: &WebviewWindow, _id: String) -> Result<(), Error> {
    Err(Error::Refused(UNSUPPORTED.to_string()))
}

#[cfg(not(windows))]
const UNSUPPORTED: &str = "reaching into the webview needs WebView2, which only the Windows build \
                           has";

#[cfg(test)]
mod tests {
    use super::*;

    /// Each variant has to say something different, because they are the whole
    /// of what a model gets back when a tool fails: "no window" and "the webview
    /// is stuck" call for opposite next moves.
    #[test]
    fn every_failure_explains_itself_differently() {
        let messages = [
            Error::NoWindow("no window is labelled `main` right now".to_string()).message(),
            Error::Refused("`Input.dispatchMouseEvent` was refused".to_string()).message(),
            Error::TimedOut.message(),
        ];

        for message in &messages {
            assert!(!message.trim().is_empty(), "a failure must say something");
        }

        let unique: std::collections::HashSet<&String> = messages.iter().collect();
        assert_eq!(unique.len(), messages.len(), "two failures read the same");
    }

    /// A timeout is the one failure whose cause is usually a native dialog, and
    /// that is not guessable from "it did not answer" — so the message names it.
    #[test]
    fn the_timeout_names_the_thing_that_usually_caused_it() {
        let message = Error::TimedOut.message();
        assert!(message.contains("dialog"), "unhelpful timeout: {message}");
        assert!(message.contains(&TIMEOUT.as_secs().to_string()));
    }
}
