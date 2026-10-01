//! MCP servers OpenKaava hosts for whatever coding agent the user brought — BYOH,
//! so assume nothing about it. Design: `docs/mcp-server-manager.md`; the rule
//! about what may be added is in [`servers`].

// Public so `tauri::generate_handler!` can name each command directly. The
// macro emits hidden helper items beside every `#[tauri::command]`, and a
// `pub use` of the function alone does not carry them — the same reason `git`
// and `search` are reached as modules in `lib.rs` rather than re-exported.
pub mod commands;

mod config;
mod focus;
mod handoff;
mod listener;
mod registry;
mod servers;
mod store;
mod subscriptions;

pub use config::sync_all;
pub use focus::{FocusReport, FocusState};
pub use listener::{start, Endpoint};
pub use registry::{
    config_key, route, McpServer, McpTool, Registry, ServerInfo, ToolAnswer, ToolDescriptor,
};
use std::time::Duration;
pub use subscriptions::Subscriptions;
use tauri::{AppHandle, Manager};

/// Register every server this build hosts, then put back the switches somebody
/// moved on a previous run.
///
/// One function rather than two calls in `lib.rs`, because doing the first
/// without the second is a silent bug: everything works, and every switch is
/// where it shipped rather than where it was left.
pub fn seed(app: &AppHandle) {
    let registry = app.state::<Registry>();
    servers::seed(&registry);
    registry.hydrate(store::load(app).switched);
}

/// Write down where the switches are now.
pub fn remember(app: &AppHandle) {
    let switched = app.state::<Registry>().switched();
    store::save(app, &store::Stored { switched });
}

/// Whether developer-only servers are visible, advertised and dispatchable.
///
/// Read here rather than cached in [`Registry`], and read again on every call
/// that depends on it. The cost is a map lookup; what it buys is that switching
/// the setting off takes a server away from a connected client on its next
/// request, with nothing to invalidate and no window in which the two
/// disagree.
pub fn dev_mode(app: &AppHandle) -> bool {
    crate::settings::flag(app, crate::settings::keys::DEVELOPER_MODE)
}

/// How long a change waits before subscribers are told, so that a burst (focus
/// leaving one window as it arrives in another) is one notification, not two.
const FOCUS_COALESCE: Duration = Duration::from_millis(50);

/// Tell every session subscribed to the focus resource that it changed.
///
/// Called after [`FocusState::update`] says a report was news. The notification
/// carries no payload by design: MCP's `resources/updated` only names the uri,
/// and the client re-reads it, so what it sees is always the state at read time
/// rather than a snapshot that could arrive out of order.
pub fn notify_focus_changed(app: &AppHandle) {
    if !app.state::<FocusState>().burst.arm() {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FOCUS_COALESCE).await;
        app.state::<FocusState>().burst.fire();
        app.state::<Subscriptions>()
            .notify(servers::workspace::ID, servers::workspace::FOCUS_URI);
    });
}
