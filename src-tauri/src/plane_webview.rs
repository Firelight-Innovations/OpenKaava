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
//! behind it) — approved by the owner (`Cargo.toml`'s own comment on the
//! feature has the same note). If that ever changes, §11's fallback is a
//! separate `WebviewWindow` docked beside the main one; that would replace
//! [`open`]'s `add_child` call with `WebviewWindowBuilder`, and everything
//! else here (the origin check, the data directory, the bounds tracking, the
//! navigation guard) carries over unchanged.
//!
//! **Not exercised against a real WebView2** (V7 in the design's verify-first
//! table); the tests cover only the pure pieces.

use crate::shell_state::ShellSnapshot;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

/// The child webview's label, and the canonical Plane host it may ever be
/// pointed at. `OPENKAAVA-PLANE-DESIGN.md` §2/§3.
pub const LABEL: &str = "plane";
pub const PLANE_HOST: &str = "plane.kaava.internal";

/// `pages.rs`'s row id for this app, and the one page [`sync_visibility`]
/// ever shows the webview for. Hardcoded rather than looked up: `PAGES` is
/// keyed by which *app* draws a page, not the other way around, and this is
/// the one spot that needs the reverse answer.
const PLANE_PAGE_ID: &str = "plane";

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
    /// Whether [`sync_visibility`] believes the webview is on screen right
    /// now — its own record of the last `hide`/`show` it issued, so a
    /// mutation that leaves the decision unchanged costs nothing. Meaningless
    /// while `open` is false; [`open`] sets it to `true` itself, matching
    /// what `add_child` actually does (a freshly created webview is on
    /// screen), rather than trusting this field's struct-default.
    showing: Mutex<bool>,
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

    // Guards every navigation after the first, not just the ones this app's
    // own `projects/plane-*` routes ask for — a link on a Plane page, a
    // redirect from a misconfigured integration, anything. `allow_navigation`
    // is the same check as the one above; kept as its own call so a test can
    // exercise the decision without building a webview.
    let app_for_nav = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .data_directory(data_dir)
        .on_navigation(move |nav_url| {
            if allow_navigation(nav_url) {
                return true;
            }
            let _ = tauri_plugin_opener::OpenerExt::opener(&app_for_nav)
                .open_url(nav_url.as_str(), None::<&str>);
            false
        });

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
    // `add_child` leaves the webview on screen, matching `showing`'s own
    // default meaning — see its doc comment.
    *state.showing.lock().unwrap_or_else(|e| e.into_inner()) = true;

    // Reconciles the ordinary case (the projects page is what the user just
    // opened this from) into a no-op, and the unlikely one (the window went
    // minimized in the instant between the frontend's call and this line)
    // into an immediate `hide`, rather than leaving the webview shown until
    // whatever mutation happens to run next.
    sync_visibility(
        app,
        &app.state::<crate::shell_state::ShellState>().snapshot(),
    );
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
    *state.showing.lock().unwrap_or_else(|e| e.into_inner()) = true;
    Ok(())
}

/// Hide the webview without closing it: the WebView2 instance, and the
/// signed-in session it holds, both survive — only what [`sync_visibility`]
/// draws changes. The pair to [`show`].
///
/// A quiet no-op before [`open`] has run, same as [`close`] and [`navigate`]
/// answering rather than panicking when there is nothing to act on yet.
pub fn hide(app: &AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview.hide().map_err(|e| e.to_string())
}

/// Show a webview [`hide`] put away. See its doc comment.
pub fn show(app: &AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview.show().map_err(|e| e.to_string())
}

/// Whether a navigation inside the Plane webview should be allowed to
/// proceed. The same question [`is_plane_url`] answers for the URLs this app
/// hands the webview directly; kept as its own name for the one caller that
/// is a navigation decision rather than an input validation.
fn allow_navigation(url: &Url) -> bool {
    is_plane_url(url)
}

/// Which page, if any, `label`'s window is showing on its rail right now.
/// A page is a fact about the window (`WindowPlacement::right_page`), not
/// about whichever cluster is active underneath it — unlike the old page
/// clusters, opening the Plane page no longer changes which cluster the
/// window's panes are showing.
fn active_page<'a>(snapshot: &'a ShellSnapshot, label: &str) -> Option<&'a str> {
    let window = snapshot.windows.iter().find(|w| w.label == label)?;
    Some(window.right_page.as_ref()?.id.as_str())
}

/// Whether the Plane webview belongs on screen right now: the Plane page is
/// open on `main`'s rail (docked or expanded — both place the webview, just
/// at a different rect), and the window is not minimized. Pure — no lookup,
/// no I/O — so this is exercised without a real window, webview or
/// `ShellState`. See [`sync_visibility`] for where its two inputs come from.
pub fn should_show(main_active_page: Option<&str>, minimized: bool) -> bool {
    !minimized && main_active_page == Some(PLANE_PAGE_ID)
}

/// Recompute whether the webview should be visible, and `hide`/`show` it if
/// that disagrees with what it is doing now.
///
/// Called from two places: `shell_state::ShellState::mutate`, after every
/// change to the shared shell state (a page switch, a cluster switch, a
/// window closing), and `lib.rs`'s `on_window_event`, on every resize of
/// `main` — `WindowEvent` has no dedicated minimize/restore variant, so a
/// resize is the signal Tauri gives for it too. Both call sites hand this the
/// whole snapshot; a no-op before [`open`] has ever run, since there is
/// nothing yet to place regardless of what either says.
pub fn sync_visibility(app: &AppHandle, snapshot: &ShellSnapshot) {
    let state = app.state::<PlaneWebview>();
    if !state.is_open() {
        return;
    }
    let minimized = app
        .get_webview_window("main")
        .and_then(|w| w.is_minimized().ok())
        .unwrap_or(false);
    let visible = should_show(active_page(snapshot, "main"), minimized);

    let mut showing = state.showing.lock().unwrap_or_else(|e| e.into_inner());
    if *showing == visible {
        return;
    }
    let result = if visible { show(app) } else { hide(app) };
    if result.is_ok() {
        *showing = visible;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::PaneNode;
    use crate::pages::PageMode;
    use crate::shell_state::{Cluster, RightPage, WindowPlacement};

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

    #[test]
    fn navigation_follows_the_same_rule_as_opening() {
        assert!(allow_navigation(&url("http://plane.kaava.internal/x")));
        assert!(!allow_navigation(&url("https://evil.example/")));
    }

    fn window(label: &str, cluster: Cluster, right_page: Option<&str>) -> WindowPlacement {
        WindowPlacement {
            label: label.to_string(),
            active_cluster_id: Some(cluster.id.clone()),
            clusters: vec![cluster],
            geometry: None,
            right_page: right_page.map(|id| RightPage {
                id: id.to_string(),
                mode: PageMode::Expanded,
                width: 380.0,
                instance_id: None,
            }),
        }
    }

    fn cluster(id: &str) -> Cluster {
        Cluster {
            id: id.to_string(),
            name: id.to_string(),
            tree: PaneNode::leaf("pane-1"),
            project: None,
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
        }
    }

    #[test]
    fn active_page_reads_the_windows_right_page() {
        let snapshot = ShellSnapshot {
            windows: vec![window("main", cluster("cluster-1"), Some("plane"))],
            instances: vec![],
            terminals: vec![],
        };
        assert_eq!(active_page(&snapshot, "main"), Some("plane"));
    }

    #[test]
    fn active_page_is_none_with_no_page_open() {
        let snapshot = ShellSnapshot {
            windows: vec![window("main", cluster("cluster-1"), None)],
            instances: vec![],
            terminals: vec![],
        };
        assert_eq!(active_page(&snapshot, "main"), None);
    }

    #[test]
    fn active_page_is_none_for_an_unknown_window() {
        let snapshot = ShellSnapshot {
            windows: vec![],
            instances: vec![],
            terminals: vec![],
        };
        assert_eq!(active_page(&snapshot, "main"), None);
    }

    #[test]
    fn should_show_wants_the_plane_page_active_and_unminimized() {
        assert!(should_show(Some("plane"), false));
        assert!(!should_show(Some("plane"), true));
        assert!(!should_show(Some("costs"), false));
        assert!(!should_show(None, false));
    }
}
