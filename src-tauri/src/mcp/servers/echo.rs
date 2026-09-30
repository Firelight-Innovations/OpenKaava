//! The server that exists to prove the plumbing, and nothing else.
//!
//! Every other server here will answer a question about OpenKaava that a harness
//! could not answer for itself. This one answers nothing. It is here because the
//! path from "a client discovered the endpoint" to "a tool ran" crosses a
//! listener, a bearer token, a route, a protocol handshake and a registry
//! lookup, and when that path breaks it is worth being able to ask which of the
//! six failed without a real server's own logic in the way.
//!
//! It is a fixture, so keep it boring. If it ever needs application state to
//! answer, something has gone wrong with what it is for.

use crate::mcp::{McpServer, McpTool, ToolAnswer};
use kaava_rpc::{RpcError, INVALID_PARAMS};
use serde_json::{json, Value};
use tauri::AppHandle;

pub static SERVER: McpServer = McpServer {
    id: "echo",
    name: "Echo",
    description: "A test server. Proves an agent can reach OpenKaava, and nothing more.",
    tools: TOOLS,
    call,
    // A plumbing fixture, of use to whoever is working on OpenKaava and nobody else.
    dev_only: true,
};

static TOOLS: &[McpTool] = &[
    McpTool {
        name: "ping",
        // Says out loud that it is diagnostic. A model reading this list should
        // not come away thinking it has found something worth using during real
        // work — a tool with a vague description gets called speculatively.
        description: "Diagnostic only. Confirms the OpenKaava MCP endpoint is reachable.",
        schema: ping_schema,
    },
    McpTool {
        name: "echo",
        description: "Diagnostic only. Returns the message it was given, unchanged.",
        schema: echo_schema,
    },
];

fn ping_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
}

fn echo_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "Any text. It comes back unchanged.",
            },
        },
        "required": ["message"],
        "additionalProperties": false,
    })
}

/// An unknown tool cannot arrive here — `Registry::call` checks the name
/// against `TOOLS` before dispatching — so the final arm is a genuine
/// impossibility rather than a second copy of that error message.
fn call(_app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    match tool {
        "ping" => Ok(ping().into()),
        "echo" => echo(params).map(Into::into),
        other => Err(RpcError::new(
            kaava_rpc::METHOD_NOT_FOUND,
            format!("the echo server has no tool named `{other}`"),
        )),
    }
}

/// Reports this process's id, which is the point.
///
/// A `{"ok": true}` would prove only that *something* answered on that port. The
/// pid is checkable against the running orchestrator, so a green ping is
/// evidence the request reached this process rather than a stale listener left
/// behind by a previous run.
fn ping() -> Value {
    json!({
        "ok": true,
        "server": "echo",
        "pid": std::process::id(),
    })
}

fn echo(params: Option<Value>) -> Result<Value, RpcError> {
    let message = params
        .as_ref()
        .and_then(|p| p.get("message"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                "echo needs a `message` parameter, and it has to be a string",
            )
        })?;

    Ok(json!({ "message": message }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_reports_this_process() {
        let answer = ping();
        assert_eq!(answer["ok"], true);
        assert_eq!(answer["pid"], std::process::id());
    }

    #[test]
    fn echo_returns_the_message_unchanged() {
        let params = Some(json!({ "message": "over the wire — and back" }));
        let answer = echo(params).expect("a string message is valid");
        assert_eq!(answer["message"], "over the wire — and back");
    }

    /// The three ways a caller gets this wrong all have to be one clear refusal
    /// rather than a panic or a silent empty string.
    #[test]
    fn echo_refuses_a_missing_or_mistyped_message() {
        for bad in [None, Some(json!({})), Some(json!({ "message": 42 }))] {
            let err = echo(bad).expect_err("should be rejected");
            assert_eq!(err.code, INVALID_PARAMS);
        }
    }

    /// The registry is what stops an unknown name reaching `call`, so this
    /// records that the arm exists rather than claiming it is reachable.
    #[test]
    fn the_server_declares_exactly_the_two_diagnostic_tools() {
        let names: Vec<&str> = SERVER.tools.iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["ping", "echo"]);
    }

    /// A model picks tools by description. Both of these say "diagnostic only"
    /// so that one left registered in a shipping build is not quietly used as
    /// though it did something.
    #[test]
    fn both_tools_announce_that_they_are_diagnostic() {
        for tool in SERVER.tools {
            assert!(
                tool.description.contains("Diagnostic only"),
                "tool {:?} should say it is diagnostic",
                tool.name
            );
        }
    }
}
