//! The Plane child webview — `OPENKAAVA-PLANE-DESIGN.md` §11, B1.4/B1.5.
//!
//! A Tauri v2 **child webview** of the main window, deliberately not an
//! `<iframe>`: a cross-origin iframe inside the shell's own WebView2 runs
//! into third-party cookie blocking, which breaks Plane's login session on
//! every restart (§11). A child webview is its own WebView2 instance with
//! its own cookie jar, addressed by [`LABEL`] and pointed at a dedicated
//! profile directory (§11: `<app data>/plane-webview/`) so the owner signs
//! in once.
//!
//! **This needs the `unstable` Cargo feature** (`Window::add_child` is gated
//! behind it) — flagged in the PR this shipped with as a decision for the
//! owner. If it is rejected, §11's fallback is a separate `WebviewWindow`
//! docked beside the main one; that would replace [`open`]'s `add_child`
//! call with `WebviewWindowBuilder`, and everything else here (the origin
//! check, the data directory, the bounds tracking) carries over unchanged.
//!
//! **Not exercised against a real WebView2** — V7 in the design's verify-first
//! table, and this PR does not launch the app to check it. What is checked
//! here is [`is_plane_url`], the one piece that is pure.

use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

/// The child webview's label, and the canonical Plane host it may ever be
/// pointed at. `OPENKAAVA-PLANE-DESIGN.md` §2/§3.
pub const LABEL: &str = "plane";
pub const PLANE_HOST: &str = "plane.kaava.internal";

/// §11: "The webview uses a dedicated data directory (`<app data>/plane-webview/`)".
pub const DATA_DIR_NAME: &str = "plane-webview";

/// Whatever the frontend's pane measures, in logical pixels — the same units
/// `add_child`/`set_position`/`set_size` take, so no DPI conversion happens
/// on this side.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Whether the child webview currently exists. Tauri's own webview registry
/// already knows this ([`tauri::Manager::get_webview`]); this is kept beside
/// it only so [`open`] can tell "create" from "navigate the existing one"
/// without a second lookup on every call.
#[derive(Default)]
pub struct PlaneWebview {
    open: Mutex<bool>,
}

impl PlaneWebview {
    pub fn is_open(&self) -> bool {
        *self.open.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Same-origin check against [`PLANE_HOST`]. Every entry point below runs a
/// URL through this before it ever reaches the webview, so `projects/plane-*`
/// and a compromised or mistaken `planeRoutes.ts` entry cannot turn this
/// dedicated webview into a way to browse somewhere else.
pub fn is_plane_url(url: &Url) -> bool {
    url.host_str() == Some(PLANE_HOST)
}

/// Create the child webview if it does not exist yet, or navigate the
/// existing one — either way, landing on `url`. `bounds` is the frontend
/// pane's measured rect at the moment of the call; [`set_bounds`] is what
/// keeps it in step with a resize afterwards.
///
/// Design rule 1 (§0/§11): this and [`navigate`] only ever move the webview
/// or point it at a new URL — neither calls `eval` or an init script against
/// a Plane page.
pub fn open(app: &AppHandle, bounds: Bounds, url: Url) -> Result<(), String> {
    if !is_plane_url(&url) {
        return Err(format!("refusing to open a non-Plane URL: {url}"));
    }
    let state = app.state::<PlaneWebview>();
    if state.is_open() {
        return navigate(app, url);
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window to attach the Plane webview to".to_string())?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(DATA_DIR_NAME);

    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .data_directory(data_dir);

    window
        .as_ref()
        .window()
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;

    *state.open.lock().unwrap_or_else(|e| e.into_inner()) = true;
    Ok(())
}

/// Point the existing webview at a new Plane URL — a project switch, or a
/// deep link from a native panel. No-op-safe to call before [`open`] has
/// ever run: it answers with the "not open yet" error rather than a panic,
/// so a stray poll racing app start fails quietly.
pub fn navigate(app: &AppHandle, url: Url) -> Result<(), String> {
    if !is_plane_url(&url) {
        return Err(format!("refusing to navigate to a non-Plane URL: {url}"));
    }
    let webview = app
        .get_webview(LABEL)
        .ok_or_else(|| "the Plane webview is not open".to_string())?;
    webview.navigate(url).map_err(|e| e.to_string())
}

/// Track the app pane: the frontend reports its rect (`ResizeObserver`, most
/// likely), and this repositions the child webview to match. Rust places the
/// webview because Tauri's webview position is a platform (HWND) property, not
/// something CSS can reach across the process boundary an `<iframe>` would
/// otherwise have hidden.
pub fn set_bounds(app: &AppHandle, bounds: Bounds) -> Result<(), String> {
    let webview = app
        .get_webview(LABEL)
        .ok_or_else(|| "the Plane webview is not open".to_string())?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())
}

/// Close the webview — leaving the app, or switching away from a view that
/// needs it. Its data directory is untouched, so the next [`open`] finds the
/// same signed-in session.
pub fn close(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<PlaneWebview>();
    if !state.is_open() {
        return Ok(());
    }
    if let Some(webview) = app.get_webview(LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    *state.open.lock().unwrap_or_else(|e| e.into_inner()) = false;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn the_canonical_plane_url_is_accepted() {
        assert!(is_plane_url(&url(
            "http://plane.kaava.internal:8765/veistra/projects/abc/issues/"
        )));
    }

    #[test]
    fn a_different_host_is_refused() {
        assert!(!is_plane_url(&url("http://localhost:8765/")));
        assert!(!is_plane_url(&url(
            "https://evil.example/plane.kaava.internal"
        )));
    }
}
