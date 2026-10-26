//! How an agent that Veistra did not spawn finds the MCP endpoint.
//!
//! [`Endpoint::env`](super::listener::Endpoint::env) hands the port and token to
//! every terminal Veistra opens, which covers the agent working *inside* Veistra and
//! nothing else. An agent in Windows Terminal, in an editor, or in a session
//! started before Veistra was, inherits neither and has no way to ask. This writes
//! them down so it can.
//!
//! **The token is a bearer credential and this puts it in a file**, readable by
//! anything running as this user. That is only a reasonable trade while the
//! served surface stays read-only, and a server that mutates anything has to
//! reopen the decision rather than inherit it. `mcp::servers::design` is the
//! first that has; `docs/design-notes/design-comments.md` is where. Nothing
//! deletes the file either; `pid` is what tells a reader whether it is live.
//!
//! Both arguments in full: `docs/design-notes/agent-debugging.md`.

use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE: &str = "mcp-endpoint.json";

/// Write the endpoint where an outside agent can find it.
///
/// Never fatal, on the same rule the four other stores follow: a machine that
/// will not take this file is one where Veistra should still open. It costs the
/// out-of-process agent path and nothing else — terminals Veistra spawns still get
/// the environment variables.
/// Temp file then rename, like every other store here, through
/// `userdata::store::write_raw` — the same mechanism without the format stamp
/// the eight config stores carry. This file records a fact about *this launch*
/// rather than a document with a format: it is rewritten every time, nothing
/// reads it back into Rust, and versioning it would version a port number.
pub fn publish(app: &AppHandle, port: u16, token: &str) {
    let Some(path) = file(app) else { return };

    crate::userdata::store::write_raw(
        &path,
        &document(std::process::id(), port, token),
        "the MCP endpoint",
    );
}

/// The file's contents.
///
/// Split out from [`publish`] so the shape can be tested without an `AppHandle`,
/// which a unit test cannot build.
///
/// `url` is included even though it is `port` with a prefix. The alternative is
/// every reader concatenating it, and a reader that gets that wrong fails with a
/// connection error rather than with anything that names this file.
fn document(pid: u32, port: u16, token: &str) -> String {
    let contents = json!({
        "pid": pid,
        "port": port,
        "token": token,
        "url": format!("http://127.0.0.1:{port}"),
        // Spelled out because the alternative is a reader guessing, and the
        // guess that fails silently is sending the token as a query parameter.
        "authorization": format!("Bearer {token}"),
    });

    format!("{contents:#}\n")
}

/// Where the file lives. `None` on a machine with no resolvable config dir,
/// which is the same condition that stops `layout.json` from being written.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parsed() -> Value {
        serde_json::from_str(&document(4321, 51234, "sekrit")).expect("the document is JSON")
    }

    #[test]
    fn the_document_carries_everything_a_client_needs_to_connect() {
        let doc = parsed();
        assert_eq!(doc["pid"], 4321);
        assert_eq!(doc["port"], 51234);
        assert_eq!(doc["token"], "sekrit");
        assert_eq!(doc["url"], "http://127.0.0.1:51234");
        assert_eq!(doc["authorization"], "Bearer sekrit");
    }

    /// Loopback, and spelled as an address rather than as `localhost`. The
    /// listener binds `127.0.0.1`, and on a machine where `localhost` resolves
    /// to `::1` first a client following that name would be refused.
    #[test]
    fn the_url_is_the_loopback_address_the_listener_actually_bound() {
        let doc = parsed();
        let url = doc["url"].as_str().expect("url is a string");
        assert!(url.starts_with("http://127.0.0.1:"));
    }

    /// Written for a person to read as well as a program: this is the file
    /// somebody opens when the connection is not working.
    #[test]
    fn the_document_is_pretty_printed_and_newline_terminated() {
        let raw = document(1, 2, "t");
        assert!(raw.contains('\n'));
        assert!(raw.ends_with('\n'));
    }
}
