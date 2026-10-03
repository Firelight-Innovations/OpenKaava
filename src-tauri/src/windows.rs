//! Creating and destroying the windows a detached surface lives in. Every window loads the same
//! `index.html` with a `?window=<label>` query — no second frontend, no reduced build: a detached
//! window mounts the same `WindowRoot`, state, title bar, switcher bar and panel as the main one —
//! which is what makes it feel like the same application rather than a stripped-down popup.
//!
//! Labels are opaque `win-<n>` values minted by `ShellState`, and Tauri scopes capabilities per
//! window label: `capabilities/default.json` globs on those labels, and a window matching none of
//! them silently gets no permissions and so no events at all. The glob and `create` have to change
//! together — full account, and the `tool-<id>` scheme this replaced, in
//! `docs/design-notes/backend-core.md`.

use crate::branding;
use crate::error::{AppError, Result};
use crate::shell_state::{ShellState, WindowGeometry};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Default size for a window with no remembered geometry. Logical pixels, because it is a design
/// figure rather than a measurement — `create` keeps the two carefully apart everywhere else.
const DEFAULT_SIZE: (f64, f64) = (900.0, 620.0);
const MIN_SIZE: (f64, f64) = (480.0, 360.0);

/// The shell's own title bar height in logical pixels — `--h-titlebar`, which `Frame` draws at
/// 34px. `at_drop_point` drops the cursor on the new window's bar, the way tab tear-off does.
const TITLEBAR_HEIGHT: f64 = 34.0;

/// Build a window for a label the state already knows about.
///
/// `geometry` is a rectangle in **physical** pixels — a remembered one, already clamped to a
/// display that exists (`shell_store::clamp_to_visible`), or the drop point of the drag that asked
/// for this window (`at_drop_point`). `None` means "put it wherever Windows would", the fallback
/// for a restored window whose saved monitor is gone and for a drag whose cursor could not be read.
///
/// The rectangle is applied after the build, not in the builder: the builder takes **logical**
/// pixels and every rectangle here is physical. The window is built hidden and shown at the end,
/// so nothing is on screen at the wrong place. See `docs/design-notes/backend-core.md`.
pub fn create(
    app: &AppHandle,
    label: &str,
    geometry: Option<WindowGeometry>,
    visible: bool,
) -> Result<()> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?window={label}").into());
    let window = WebviewWindowBuilder::new(app, label, url)
        // The custom title bar is part of the design, in a detached window as in the main one.
        .decorations(false)
        // Replaced a moment later by `project::retitle`, which is what puts this window's own
        // project in front of the name. This is what the taskbar shows in between.
        .title(branding::product_name())
        .visible(false)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .build()
        .map_err(|source| AppError::Window {
            label: label.to_string(),
            source,
        })?;

    apply_geometry(&window, geometry);

    if visible {
        // `visible` is false only while restoring a session: those windows are built behind the
        // splash and shown together by `boot::finish`, so none is caught half-drawn. A window
        // created by a drag has no splash to wait for and must appear at once — an invisible one
        // would read as the drag having silently lost the tab.
        let _ = window.show();
        // A drag ending outside OpenKaava releases over *another* application, which takes the
        // foreground with it; Windows will not let a background process raise a new window over
        // the foreground one, so without this the torn-off window opens behind whatever was
        // dropped on and blinks in the taskbar — indistinguishable from the gesture doing nothing.
        let _ = window.set_focus();
    }

    Ok(())
}

/// Put a hidden window where it should appear, in the state it was left in.
///
/// `Some`: the rectangle first, then maximize or fullscreen on top of it, so the remembered normal
/// bounds are what un-maximizing returns to. `None` (first launch, or no monitor information):
/// centre on a monitor rather than leave it wherever the OS cascades it. Callers have already
/// clamped `geometry` onto a display that exists. Errors are ignored on purpose; a window that
/// could not be moved is still a window, and failing to start over it would be worse.
pub fn apply_geometry(window: &WebviewWindow, geometry: Option<WindowGeometry>) {
    let Some(g) = geometry else {
        let _ = window.center();
        return;
    };
    let _ = window.set_position(PhysicalPosition::new(g.x, g.y));
    let _ = window.set_size(PhysicalSize::new(g.width, g.height));
    if g.fullscreen {
        let _ = window.set_fullscreen(true);
    } else if g.maximized {
        let _ = window.maximize();
    }
}

/// Where a window torn off by a drag should appear: under the cursor that dropped it.
///
/// Without this both detach paths passed `None`, and Windows cascades an unpositioned window from
/// the top-left of the **primary** monitor — dragging a cluster onto the second screen opened it
/// on the first, every time. Physical pixels throughout, scale factor read from the monitor under
/// the cursor, not the primary one. Both failures are in `docs/design-notes/backend-core.md`.
///
/// The cursor lands centred on the new window's title bar, the way tearing a tab out of a browser
/// does. `clamp_to_visible` is the last word: a window whose centre is on a monitor is left
/// exactly where it was put, and only one that landed nowhere is recentred.
///
/// `None` means the cursor could not be read at all, leaving `create` to fall back to Windows'
/// placement. Better a window in the wrong corner than no window.
fn at_drop_point(app: &AppHandle) -> Option<WindowGeometry> {
    let cursor = app.cursor_position().ok()?;
    let scale = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .map_or(1.0, |m| m.scale_factor());

    let width = (DEFAULT_SIZE.0 * scale).round().max(1.0) as u32;
    let height = (DEFAULT_SIZE.1 * scale).round().max(1.0) as u32;

    crate::shell_store::clamp_to_visible(
        app,
        WindowGeometry {
            x: (cursor.x - f64::from(width) / 2.0).round() as i32,
            y: (cursor.y - TITLEBAR_HEIGHT * scale / 2.0).round() as i32,
            width,
            height,
            maximized: false,
            fullscreen: false,
        },
    )
}

/// Pull a surface out of its window and into a new one.
///
/// Bookkeeping first, window second. `detach_instance` returning false means the surface is not on
/// screen anywhere — creating a window for it would put an empty frame on screen with nothing to
/// show and no way to get it back.
///
/// The cursor is read *after* the bookkeeping: `at_drop_point` asks Windows where the pointer is
/// now, a few hundred microseconds of lock and broadcast later than the release, and a hand does
/// not move meaningfully in that time. The alternative — carrying a screen point up from the
/// webview — means converting CSS pixels to physical across monitors that may not share a scale
/// factor, the class of arithmetic this module has already been bitten by once.
pub fn detach(app: &AppHandle, state: &ShellState, instance_id: &str) -> Result<()> {
    let label = state.claim_window_label();

    if !state.detach_instance(app, instance_id, &label) {
        return Err(AppError::UnknownTool(instance_id.to_string()));
    }

    create(app, &label, at_drop_point(app), true)
}

/// Pull a whole cluster out of its window and into a new one.
///
/// Same shape and ordering as `detach` above, one level up: a cluster is not a surface lifted into
/// a fresh cluster, it *is* the cluster, so its tree arrives in the new window exactly as it left.
///
/// `move_cluster` returning false now means one thing only: no window holds that cluster, so it
/// has already been closed or never existed. It used to also mean "that was the last cluster in
/// its window", and that refusal is gone — see `move_cluster_pure`. Building the window first
/// would still put an empty frame on screen for a move that never happened, so the ordering stays.
pub fn detach_cluster(app: &AppHandle, state: &ShellState, cluster_id: &str) -> Result<()> {
    let label = state.claim_window_label();

    if !state.move_cluster(app, cluster_id, &label) {
        return Err(AppError::UnknownTool(cluster_id.to_string()));
    }

    create(app, &label, at_drop_point(app), true)
}

/// Which OpenKaava window the cursor is over, if any.
///
/// A tab moves between windows by being dropped into another window, and no window's frontend can
/// work out where that is: each window is its own webview with its own DOM and coordinate space,
/// and a page's pointer events stop at that page's edge, so the window holding the drag cannot see
/// another window's geometry. Only the process that owns all of them can hit-test a screen point
/// against all of them, which is why this is here and not in TypeScript.
///
/// The splash window is deliberately not a candidate — it is not a place anything can live, and by
/// the time anyone is dragging it is closed.
pub fn at_cursor(app: &AppHandle) -> Option<String> {
    let cursor = app.cursor_position().ok()?;

    let candidates: Vec<(String, WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != "splash")
        .filter(|(_, w)| w.is_visible().unwrap_or(false))
        .filter(|(_, w)| contains(w, cursor.x, cursor.y))
        .collect();

    // Windows overlap and `webview_windows` is a map with no z-order in it. The focused window is
    // the one under the cursor in every case that matters — you are dragging in it — so prefer it,
    // and fall back to any hit rather than refusing to answer.
    candidates
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .or_else(|| candidates.first())
        .map(|(label, _)| label.clone())
}

/// Where a window is now, in physical pixels.
///
/// Physical on both sides deliberately: `outer_position`, `outer_size` and `available_monitors`
/// all agree on that, which is the only reason a restored rectangle can be compared against a
/// display at all. Mixing in a scale factor is how a window restores half-size on a scaled monitor.
///
/// Takes a `Window` rather than a `WebviewWindow` because the only caller, `on_window_event`, is
/// handed the former — a window's position belongs to the OS window, not the webview inside it.
///
/// `None` while minimized: Windows parks a minimized window at (-32000, -32000), and remembering
/// that sent the next launch's window to the primary monitor's centre instead of where it was.
/// The maximized and fullscreen flags ride along; `WindowGeometry::observe` decides whether the
/// rectangle is trustworthy.
pub fn geometry_of(window: &tauri::Window) -> Option<WindowGeometry> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return None;
    };
    Some(WindowGeometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    })
}

/// Whether a window's outer rectangle contains a screen point. Physical pixels
/// on both sides — see `geometry_of`.
fn contains(window: &WebviewWindow, x: f64, y: f64) -> bool {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let (left, top) = (f64::from(pos.x), f64::from(pos.y));
    x >= left && x < left + f64::from(size.width) && y >= top && y < top + f64::from(size.height)
}

/// The one place a window's close is handled, regardless of who asked for it.
///
/// Runs from `WindowEvent::CloseRequested`, which fires whether the request came from our own
/// titlebar's × (`commands::close_window` calls `WebviewWindow::close`, which "emits
/// `CloseRequested` first like a user-initiated close request" — see its doc comment), Alt+F4, the
/// taskbar's "Close window", or a graceful OS shutdown closing each window in turn. Before this
/// lived here only the first went through bookkeeping, leaving the resurrection bug `reclaim`
/// prevents reachable by three routes `close_window` missed — `docs/design-notes/backend-core.md`.
///
/// `CloseRequested` never fires for the shutdown `AppHandle::exit` triggers below: that goes
/// straight to the runtime requesting the event loop stop, without visiting any window's close
/// path, so it can never be mistaken for one of these.
pub fn request_close(app: &AppHandle, state: &ShellState, label: &str) {
    if label == "main" {
        // `main` is the session, not just a window: closing it ends OpenKaava rather than leaving
        // secondaries stranded on screen with no way back to `main`. Whatever is open at this
        // moment is what gets persisted — a three-window session closed via `main` restores as
        // three windows next launch. Flush first: `set_geometry` records position and size without
        // writing them, and this is the last moment to commit that before the process ends.
        state.flush(app);
        app.exit(0);
        return;
    }

    // Marked and reclaimed together, synchronously, in this same call — `reclaim_window`'s own
    // `mutate` persists, so `label` is off disk before any later close (of `main`, or of another
    // window) can flush a snapshot that still lists it. See `ShellState::reclaim_window`.
    state.mark_closing(label);
    state.reclaim_window(app, label);
}

/// Called when a window finishes closing: fold its clusters back into the main window so nothing
/// is stranded in a window that no longer exists.
///
/// Does nothing unless the close was announced through `mark_closing`, and usually nothing at all,
/// since `request_close` reclaims from `CloseRequested` first. What is left is a fallback for a
/// window the OS destroys directly — and the marker check is what stops a shutdown's `Destroyed`
/// storm collapsing a three-window session into one and persisting that as the layout to restore.
/// See `ShellState::closing` and `docs/design-notes/backend-core.md`.
pub fn reclaim(app: &AppHandle, state: &ShellState, label: &str) {
    state.reclaim_window(app, label);
}
