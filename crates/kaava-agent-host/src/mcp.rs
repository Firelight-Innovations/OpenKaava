//! OpenKaava's own MCP servers, offered to an agent's session.
//!
//! The tab names them in the [`LaunchSpec`](crate::LaunchSpec); the session
//! hands them to the agent in `session/new`. Each carries a bearer token of
//! its own, scoped to that server, which the agent sends back on every call.
//! The host never logs one: `Debug` leaves it out, and the session scrubs
//! each from everything the agent's process writes: every line it reads from
//! stdout, before parsing, so no transcript item, approval or error holds
//! one, and the stderr tail it keeps.
//!
//! The agent's own process does hold it. Claude's SDK hands `mcpServers` to
//! the `claude` CLI as `--mcp-config` JSON, so the bearer is on that process's
//! command line, where other processes of the same user can read it.

use std::borrow::Cow;
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

/// Whether `server` goes to the agent. Not unless the agent said it takes
/// HTTP servers: ACP requires only stdio of every agent, and these servers
/// are HTTP only. Nor unless its URL is on this machine, since the bearer goes
/// wherever the URL points.
pub fn offered(server: &McpServer, http: bool) -> bool {
    http && on_this_machine(&server.url)
}

/// An `http` or `https` URL whose host is the loopback interface. Anything
/// else is refused, user info included.
fn on_this_machine(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// The `mcpServers` list for `session/new`, in ACP's HTTP form: the servers
/// [`offered`] to the agent.
pub fn wire(servers: &[McpServer], http: bool) -> Value {
    servers
        .iter()
        .filter(|s| offered(s, http))
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
/// that the agent's process wrote. A bearer is URL-safe, which JSON never
/// escapes, so a raw JSON line can be scrubbed before it is parsed.
pub fn scrub<'a>(text: &'a str, servers: &[McpServer]) -> Cow<'a, str> {
    let mut out = Cow::Borrowed(text);
    for bearer in servers.iter().map(|s| s.bearer.as_str()) {
        if !bearer.is_empty() && out.contains(bearer) {
            out = Cow::Owned(out.replace(bearer, "<redacted>"));
        }
    }
    out
}

/// [`scrub`] for a line cut short. A bearer that ran past the cut left only
/// its start, which `scrub` cannot know, so the end of the line goes too:
/// one byte short of the longest bearer.
pub fn scrub_cut(text: &str, servers: &[McpServer]) -> String {
    let mut out = scrub(text, servers).into_owned();
    let longest = servers.iter().map(|s| s.bearer.len()).max().unwrap_or(0);
    let mut end = out.len().saturating_sub(longest.saturating_sub(1));
    while !out.is_char_boundary(end) {
        end -= 1;
    }
    out.truncate(end);
    out
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
    fn only_a_server_on_this_machine_is_offered() {
        for url in [
            "http://127.0.0.1:4100/mcp/context",
            "http://localhost:4100",
            "https://[::1]:4100/mcp",
        ] {
            let s = McpServer {
                url: url.into(),
                ..show()
            };
            assert!(offered(&s, true), "{url}");
            assert!(!offered(&s, false), "{url} without HTTP");
        }
        for url in [
            "http://example.com/mcp",
            "http://127.0.0.1.example.com/mcp",
            "http://localhost.example.com",
            "http://127.0.0.1@example.com/mcp",
            "http://user@127.0.0.1:4100",
            "ftp://127.0.0.1/mcp",
            "127.0.0.1:4100",
            "",
        ] {
            let s = McpServer {
                url: url.into(),
                ..show()
            };
            assert!(!offered(&s, true), "{url}");
            assert_eq!(wire(&[s], true), json!([]), "{url}");
        }
    }

    #[test]
    fn each_server_keeps_its_own_bearer_and_an_empty_one_scrubs_nothing() {
        let other = McpServer {
            name: "kaava-other".into(),
            bearer: "other-token".into(),
            ..show()
        };
        let blank = McpServer {
            name: "kaava-blank".into(),
            bearer: String::new(),
            ..show()
        };
        let servers = [show(), other, blank];
        let wired = wire(&servers, true);
        let names: Vec<&str> = wired
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["kaava-context", "kaava-other", "kaava-blank"]);
        assert_eq!(wired[1]["headers"][0]["value"], json!("Bearer other-token"));
        let line = "s3cret-token then other-token, and nothing else";
        assert_eq!(
            scrub(line, &servers),
            "<redacted> then <redacted>, and nothing else"
        );
        assert!(matches!(scrub("plain", &servers), Cow::Borrowed("plain")));
    }

    #[test]
    fn a_cut_line_loses_any_bearer_it_cut() {
        let servers = [show()];
        // The cut left "s3cret-t" of "s3cret-token".
        let cut = "a long line ending in s3cret-t";
        let kept = scrub_cut(cut, &servers);
        assert!(!kept.contains("s3cret"), "{kept}");
        assert!(kept.starts_with("a long line"), "{kept}");
        // A bearer whole before the cut is scrubbed as usual.
        let whole = format!("s3cret-token {}", "x".repeat(20));
        assert_eq!(scrub_cut(&whole, &servers), "<redacted> xxxxxxxxx");
        assert_eq!(scrub_cut("ab", &servers), "");
        assert_eq!(scrub_cut("é…", &[]), "é…", "nothing to hold back");
    }

    #[test]
    fn the_bearer_never_shows_in_debug_or_scrubbed_text() {
        let s = show();
        assert!(!format!("{s:?}").contains("s3cret-token"));
        let line = "connecting with Bearer s3cret-token";
        assert_eq!(scrub(line, &[s]), "connecting with Bearer <redacted>");
    }
}
