//! Settings on the webview itself, as opposed to the window drawn around it.
//!
//! `windows.rs` builds windows; this changes what the engine inside one does.
//! There is exactly one such setting today, and it is here rather than there
//! because the two are reached through different objects — a window is a
//! `WebviewWindow`, this is `ICoreWebView2Settings`, behind the same COM
//! interface `devtools.rs` already uses.

/// Turn off WebView2's own right-click menu for this webview.
///
/// Back, Forward, Refresh, Print, Save as, View source: not one of the six is
/// an operation an IDE has. The shell draws its own menu instead — see
/// `src/shell/ContextMenuHost.tsx`.
///
/// This suppresses the *menu*, not the event, and it reaches child frames.
/// Why it cannot be done from `tauri.conf.json`, and what a failure costs:
/// `docs/design-notes/shell-chrome.md`.
#[cfg(windows)]
pub fn suppress_default_context_menu(webview: &tauri::Webview) {
    // Posted to the main thread, where the COM objects live, and not waited
    // for: a property setter has no answer to come back with.
    let posted = webview.with_webview(|platform| {
        let applied = (|| -> windows_core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2() }?;
            let settings = unsafe { core.Settings() }?;
            unsafe { settings.SetAreDefaultContextMenusEnabled(false) }
        })();

        if let Err(e) = applied {
            crate::veistra_log!("the webview kept its own context menu: {e}");
        }
    });

    if let Err(e) = posted {
        crate::veistra_log!("could not reach the webview to turn off its context menu: {e}");
    }
}

/// Nothing to turn off: WebView2 is the Windows webview. The shape `devtools.rs`
/// uses, and for its reason — a function that is absent on one platform is
/// harder to account for than one that does nothing there.
#[cfg(not(windows))]
pub fn suppress_default_context_menu(_webview: &tauri::Webview) {}
