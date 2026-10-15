//! OpenKaava's own MCP servers, offered to an agent's session.
//!
//! The tab names them in the [`LaunchSpec`](crate::LaunchSpec); the session
//! hands them to the agent in `session/new`. Each carries a bearer token of
//! its own, scoped to that server, which the agent sends back on every call.
//! The host never logs one: `Debug` leaves it out, and the session scrubs
//! each from the stderr tail it keeps.

use std::fmt;

use serde_json::{json, Value};

/// One MCP server OpenKaava hosts for the session.
#[derive(Clone, PartialEq, Eq)]
pub struct McpServer {
    /// The name the agent knows it by. Claude prefixes its tools with it.
    pub name: String,
    /// Its HTTP endpoint.
    pub url: String,
    /// The token the server accepts, sent as `Authorization: Bearer`.
    pub bearer: String,
}

impl fmt::Debug for McpServer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpServer")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("bearer", &"<redacted>")
            .finish()
    }
}

/// The `mcpServers` list for `session/new`, in ACP's HTTP form. Empty unless
/// the agent said it takes HTTP servers: ACP requires only stdio of every
/// agent, and these servers are HTTP only.
pub fn wire(servers: &[McpServer], http: bool) -> Value {
    if !http {
        return json!([]);
    }
    servers
        .iter()
        .map(|s| {
            json!({
                "type": "http",
                "name": s.name,
                "url": s.url,
                "headers": [{ "name": "Authorization", "value": format!("Bearer {}", s.bearer) }],
            })
        })
        .collect()
}

/// `text` with every server's bearer replaced, for anything the host keeps
/// that the agent's process wrote.
pub fn scrub(text: &str, servers: &[McpServer]) -> String {
    servers
        .iter()
        .filter(|s| !s.bearer.is_empty())
        .fold(text.to_string(), |t, s| t.replace(&s.bearer, "<redacted>"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show() -> McpServer {
        McpServer {
            name: "kaava-context".into(),
            url: "http://127.0.0.1:4100/mcp/context".into(),
            bearer: "s3cret-token".into(),
        }
    }

    #[test]
    fn a_server_goes_to_the_agent_in_acps_http_form() {
        let wired = wire(&[show()], true);
        assert_eq!(
            wired,
            json!([{
                "type": "http",
                "name": "kaava-context",
                "url": "http://127.0.0.1:4100/mcp/context",
                "headers": [{ "name": "Authorization", "value": "Bearer s3cret-token" }],
            }])
        );
    }

    #[test]
    fn an_agent_without_http_gets_none() {
        assert_eq!(wire(&[show()], false), json!([]));
        assert_eq!(wire(&[], true), json!([]));
    }

    #[test]
    fn the_bearer_never_shows_in_debug_or_scrubbed_text() {
        let s = show();
        assert!(!format!("{s:?}").contains("s3cret-token"));
        let line = "connecting with Bearer s3cret-token";
        assert_eq!(scrub(line, &[s]), "connecting with Bearer <redacted>");
    }
}
