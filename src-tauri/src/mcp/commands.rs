//! What the settings UI and the status bar call.
//!
//! Declared here rather than in `commands.rs` for the same reason `git` and
//! `search` declare their own: the command is the module's public surface, and
//! separating the two means a change to what MCP exposes is one file rather than
//! two that have to agree.

use super::{config, listener::Endpoint, FocusReport, FocusState, Registry, ServerInfo};
use serde::Serialize;
use tauri::{AppHandle, State};

/// Whether an agent could reach us at all, for the status bar.
///
/// `port` is `Option` because binding can fail and the UI has to say so rather
/// than draw a connected state over a listener that never came up. **The token
/// is deliberately not here.** Nothing on screen needs it, and a secret that
/// crosses into a renderer is a secret in a devtools console.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatus {
    pub port: Option<u16>,
    pub servers: Vec<ServerInfo>,
}

/// Every server the user should see, and where they answer.
///
/// "Should see" rather than "is registered": developer-only servers are left out
/// unless `developer.mode` is on, and this is where that happens. The panel
/// draws what it is given and knows nothing about the flag, which is what stops
/// a server appearing on screen because a `hidden` prop was forgotten.
#[tauri::command]
pub fn mcp_status(
    app: AppHandle,
    registry: State<'_, Registry>,
    endpoint: State<'_, Endpoint>,
) -> EndpointStatus {
    EndpointStatus {
        port: endpoint.get().map(|(port, _)| port),
        servers: registry.list(super::dev_mode(&app)),
    }
}

/// Everything the tools panel draws: each server's tools with their input
/// schemas, and the app methods `kaava-agent`'s `app_call` can reach.
///
/// Built from the registry the listener serves `tools/list` from, so the panel
/// cannot disagree with a client. Filtered by developer mode the same way
/// [`mcp_status`] is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalog {
    pub servers: Vec<super::registry::ServerCatalog>,
    pub app_methods: Vec<crate::apps::method_catalog::AppMethodGroup>,
}

pub fn build_catalog(registry: &Registry, dev_mode: bool) -> McpCatalog {
    let mut app_methods = crate::apps::method_catalog::catalog();
    for group in &mut app_methods {
        for method in &mut group.methods {
            method.blocked = super::servers::agent::blocked_reason(&method.method);
        }
    }
    McpCatalog {
        servers: registry.catalog(dev_mode),
        app_methods,
    }
}

#[tauri::command]
pub fn mcp_catalog(app: AppHandle, registry: State<'_, Registry>) -> McpCatalog {
    build_catalog(&registry, super::dev_mode(&app))
}

/// Switch a server on or off.
///
/// Two things happen on the way out, and both are the same idea: a toggle that
/// changed only our own in-memory state would be disagreed with by everything
/// that outlives this process. `.mcp.json` is what a client reads, so it is
/// rewritten; `mcp.json` in the config directory is what the next launch reads,
/// so it is written too.
///
/// The route stays mounted either way — see `listener::router`. What changes is
/// that the server stops being advertised and starts answering `tools/list`
/// with an empty list.
#[tauri::command]
pub fn mcp_set_server_enabled(
    app: AppHandle,
    registry: State<'_, Registry>,
    id: String,
    enabled: bool,
) -> bool {
    let changed = registry.set_enabled(&id, enabled);
    if changed {
        config::sync_all(&app);
        super::remember(&app);
    }
    changed
}

/// Rewrite `.mcp.json` for every open project.
///
/// Exposed because the file is the user's and they may have edited or deleted
/// it, and because a project opened mid-session has not been through the boot
/// path that writes it.
#[tauri::command]
pub fn mcp_sync_config(app: AppHandle) {
    config::sync_all(&app);
}

/// A window's shell reporting where focus is.
///
/// The webview debounces and only sends on a real change, but this checks again:
/// two windows can report the same state, and a repeat must not wake an agent.
/// `FocusState::update` is that check; the notification goes out only when it
/// says the report was news.
#[tauri::command]
pub fn report_focus(app: AppHandle, state: State<'_, FocusState>, report: FocusReport) {
    if state.update(report) {
        super::notify_focus_changed(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The token must never be part of anything serialised to a window.
    #[test]
    fn the_status_payload_carries_no_token() {
        let status = EndpointStatus {
            port: Some(4321),
            servers: Vec::new(),
        };

        let json = serde_json::to_string(&status).expect("status serialises");
        assert!(json.contains("4321"), "the port is what the UI needs");
        assert!(
            !json.to_lowercase().contains("token"),
            "no token field may exist on this payload: {json}"
        );
    }
}
