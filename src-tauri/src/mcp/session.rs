//! The MCP servers an agent the host launches for one cluster is given, and
//! the tokens that bind it to that cluster.
//!
//! A terminal agent reads the master token from its environment and may reach
//! every server, the developer ones included. An agent tab's session gets
//! less: a token minted for its cluster, accepted only on `/mcp/context` and
//! `/mcp/canvas`, and
//! answered from that cluster whatever the call names. Tokens live in memory,
//! so a restart mints new ones, as it does the master token.

use super::{route, Endpoint, Registry};
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The servers a session token reaches. Both answer from the token's own
/// cluster: the listener pins `cluster` on every call. `workspace` is left
/// out, since it lists every cluster and a pin would not narrow it.
pub const SERVER_IDS: [&str; 2] = ["context", "canvas"];

/// One entry for an ACP `mcpServers` list: an HTTP server and its bearer.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionServer {
    /// The key the agent names its tools by, `veistra-context`.
    pub name: String,
    pub url: String,
    pub bearer: String,
}

/// The bearer is a credential, so a log line never carries it.
impl fmt::Debug for SessionServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionServer")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("bearer", &"<redacted>")
            .finish()
    }
}

/// Session tokens, each bound to one cluster.
#[derive(Default)]
pub struct Sessions {
    by_token: Mutex<HashMap<String, String>>,
}

impl Sessions {
    /// The token for `cluster`, minted on first use and kept for this launch.
    /// An empty name gets none: the call would answer from whichever cluster
    /// the person is in, which is not a pin.
    pub fn token_for(&self, cluster: &str) -> Option<String> {
        if cluster.is_empty() {
            return None;
        }
        let mut tokens = self.by_token.lock().ok()?;
        if let Some((token, _)) = tokens.iter().find(|(_, c)| c.as_str() == cluster) {
            return Some(token.clone());
        }
        let token = super::listener::mint_token();
        tokens.insert(token.clone(), cluster.to_string());
        Some(token)
    }

    /// The cluster a token was minted for.
    pub fn cluster_of(&self, token: &str) -> Option<String> {
        self.by_token.lock().ok()?.get(token).cloned()
    }
}

/// The servers to hand an agent launched for `cluster`: those of
/// [`SERVER_IDS`] that are switched on, while the listener is up. Empty
/// otherwise, and the agent runs without them.
pub fn session_servers(app: &AppHandle, cluster: &str) -> Vec<SessionServer> {
    let Some((port, _)) = app.state::<Endpoint>().get() else {
        return Vec::new();
    };
    let registry = app.state::<Registry>();
    let dev = super::dev_mode(app);
    let bearer = app.state::<Sessions>().token_for(cluster);
    serve(port, |id| registry.is_reachable(id, dev), bearer)
}

fn serve(port: u16, on: impl Fn(&str) -> bool, bearer: Option<String>) -> Vec<SessionServer> {
    let Some(bearer) = bearer.filter(|b| !b.is_empty()) else {
        return Vec::new();
    };
    SERVER_IDS
        .iter()
        .filter(|id| on(id))
        .map(|id| SessionServer {
            name: super::config_key(id),
            url: format!("http://127.0.0.1:{port}{}", route(id)),
            bearer: bearer.clone(),
        })
        .collect()
}

/// The variables a project's `.mcp.json` expands `${VEISTRA_MCP_PORT}` and
/// `${VEISTRA_MCP_TOKEN}` from (see `config`). An agent the host launches
/// inherits neither, and Claude Code refuses a server whose URL or header
/// names a variable that is not set, as an invalid config, so the session's
/// own are set for it. The token is the cluster's, never the master.
pub fn session_env(servers: &[SessionServer]) -> Vec<(String, String)> {
    let Some(first) = servers.first() else {
        return Vec::new();
    };
    let port = first
        .url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default();
    vec![
        ("VEISTRA_MCP_PORT".to_string(), port.to_string()),
        ("VEISTRA_MCP_TOKEN".to_string(), first.bearer.clone()),
    ]
}

/// Whether a request may pass, and as whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// The master token: any route.
    Master,
    /// A session token on the context server's route, for this cluster.
    Session(String),
    Refused,
}

/// Admit a request to `path` that presented `token`. A session token opens the
/// context server's route and nothing else. An empty token, a bare `Bearer `,
/// is refused whatever else is empty.
pub fn admit(path: &str, token: Option<&str>, master: &str, sessions: &Sessions) -> Admission {
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return Admission::Refused;
    };
    if token == master {
        return Admission::Master;
    }
    let on_session_route = SERVER_IDS.iter().any(|id| {
        let route = route(id);
        path == route
            || path
                .strip_prefix(route.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    });
    match sessions.cluster_of(token) {
        Some(cluster) if on_session_route => Admission::Session(cluster),
        _ => Admission::Refused,
    }
}

/// The cluster a session-token request is answered from, left on the request
/// for the handler.
#[derive(Debug, Clone)]
pub struct SessionCluster(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cluster_keeps_its_token_and_two_clusters_never_share_one() {
        let sessions = Sessions::default();
        let a = sessions.token_for("cluster-a").unwrap();
        assert_eq!(sessions.token_for("cluster-a").unwrap(), a);
        let b = sessions.token_for("cluster-b").unwrap();
        assert_ne!(a, b);
        assert_eq!(sessions.cluster_of(&a).as_deref(), Some("cluster-a"));
        assert_eq!(sessions.cluster_of("made-up"), None);
        assert_eq!(sessions.token_for(""), None, "no cluster, no token");
    }

    #[test]
    fn a_session_token_opens_the_context_and_canvas_routes_and_no_other() {
        let sessions = Sessions::default();
        let token = sessions.token_for("cluster-a").unwrap();
        let ok = Admission::Session("cluster-a".into());
        assert_eq!(admit("/mcp/context", Some(&token), "m", &sessions), ok);
        assert_eq!(admit("/mcp/context/", Some(&token), "m", &sessions), ok);
        assert_eq!(admit("/mcp/canvas", Some(&token), "m", &sessions), ok);
        for elsewhere in [
            "/mcp/agent",
            "/mcp/ui",
            "/mcp/workspace",
            "/mcp/contextual",
            "/mcp/canvases",
            "/mcp",
            "/",
        ] {
            assert_eq!(
                admit(elsewhere, Some(&token), "m", &sessions),
                Admission::Refused,
                "{elsewhere}"
            );
        }
    }

    #[test]
    fn the_master_token_opens_every_route_and_nothing_else_opens_any() {
        let sessions = Sessions::default();
        assert_eq!(
            admit("/mcp/ui", Some("m"), "m", &sessions),
            Admission::Master
        );
        assert_eq!(
            admit("/mcp/context", Some("m"), "m", &sessions),
            Admission::Master
        );
        assert_eq!(
            admit("/mcp/context", None, "m", &sessions),
            Admission::Refused
        );
        assert_eq!(
            admit("/mcp/context", Some(""), "m", &sessions),
            Admission::Refused
        );
        assert_eq!(
            admit("/mcp/context", Some(""), "", &sessions),
            Admission::Refused
        );
        assert_eq!(
            admit("/mcp/context", Some("guess"), "m", &sessions),
            Admission::Refused
        );
    }

    #[test]
    fn a_session_is_offered_only_while_the_server_is_on_and_never_logs_its_bearer() {
        assert!(serve(4000, |_| false, Some("t".into())).is_empty());
        assert!(serve(4000, |_| true, None).is_empty());
        assert!(serve(4000, |_| true, Some(String::new())).is_empty());
        let offered = serve(4000, |_| true, Some("secret-bearer".into()));
        assert_eq!(offered[0].name, "veistra-context");
        assert_eq!(offered[0].url, "http://127.0.0.1:4000/mcp/context");
        let logged = format!("{offered:?}");
        assert!(!logged.contains("secret-bearer"), "{logged}");
    }

    #[test]
    fn canvas_is_offered_with_context_and_each_switch_is_honoured() {
        let both = serve(4000, |_| true, Some("t".into()));
        let names: Vec<&str> = both.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["veistra-context", "veistra-canvas"]);
        assert_eq!(both[1].url, "http://127.0.0.1:4000/mcp/canvas");
        let canvas_off = serve(4000, |id| id != "canvas", Some("t".into()));
        assert_eq!(canvas_off.len(), 1);
    }

    #[test]
    fn the_project_config_variables_are_set_to_the_sessions_own() {
        // A `.mcp.json` entry that names `${VEISTRA_MCP_PORT}` is an invalid
        // config to Claude Code while the variable is unset.
        let servers = serve(4321, |_| true, Some("tok".into()));
        let env = session_env(&servers);
        assert!(env.contains(&("VEISTRA_MCP_PORT".into(), "4321".into())));
        assert!(env.contains(&("VEISTRA_MCP_TOKEN".into(), "tok".into())));
        assert!(session_env(&[]).is_empty(), "no server, no variables");
    }
}
