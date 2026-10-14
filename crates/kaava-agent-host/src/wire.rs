//! JSON-RPC 2.0, one message per line, as ACP carries it on stdio.
//!
//! Not `kaava-rpc`'s codec, though it is the same framing: that crate's request
//! id is a `u64` and its reader and writer are crate-private, while an ACP agent
//! may number its own requests with strings (the permission request is one the
//! *agent* sends). What is shared is the error vocabulary: [`RemoteError`]
//! never leaves this crate (the session turns it into an error item or a
//! hint), and it is [`HostError`](crate::host::HostError) that
//! `apps::agent_tab` maps onto `kaava_rpc::RpcError`, with code `-32010`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A request id, as either side may mint it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id {
    /// What this host mints.
    Number(i64),
    /// What some agents mint.
    Text(String),
}

/// An error object from the other side.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RemoteError {
    /// JSON-RPC's code. ACP's `authRequired` is [`AUTH_REQUIRED`].
    pub code: i64,
    /// The other side's message. May carry anything; mask before showing.
    #[serde(default)]
    pub message: String,
}

/// ACP's "authentication required" error code.
pub const AUTH_REQUIRED: i64 = -32000;
/// JSON-RPC's "method not found".
pub const METHOD_NOT_FOUND: i64 = -32601;

/// One line from the agent, classified.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// An answer to one of ours.
    Response {
        /// Which request.
        id: Id,
        /// Its result or its error.
        outcome: Result<Value, RemoteError>,
    },
    /// The agent asks us something and waits.
    Request {
        /// What to answer to.
        id: Id,
        /// What it asks.
        method: String,
        /// With what.
        params: Value,
    },
    /// The agent tells us something.
    Notification {
        /// What about.
        method: String,
        /// The content.
        params: Value,
    },
}

/// Classify one line. `None` for anything that is not a JSON-RPC message —
/// a stray `console.log` in an adapter must not stop the session.
pub fn parse(line: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let object = value.as_object()?;
    let id = object
        .get("id")
        .and_then(|id| serde_json::from_value::<Id>(id.clone()).ok());
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    match (object.get("method").and_then(Value::as_str), id) {
        (Some(method), Some(id)) => Some(Incoming::Request {
            id,
            method: method.to_string(),
            params,
        }),
        (Some(method), None) => Some(Incoming::Notification {
            method: method.to_string(),
            params,
        }),
        (None, Some(id)) => {
            let outcome = match object.get("error") {
                Some(error) => Err(remote_error(error)),
                None => Ok(object.get("result").cloned().unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, outcome })
        }
        (None, None) => None,
    }
}

/// Read an error object. ACP's TypeScript SDK answers a thrown error with
/// "Internal error" and puts the reason in `data.details`, so the reason is
/// kept: "Internal error" alone tells the user nothing.
fn remote_error(error: &Value) -> RemoteError {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let details = error
        .pointer("/data/details")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty());
    let message = match details {
        Some(d) if message.is_empty() => d.to_string(),
        Some(d) => format!("{message}: {d}"),
        None => message.to_string(),
    };
    RemoteError { code, message }
}

/// A request line, without its newline.
pub fn request(id: &Id, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

/// A notification line, without its newline.
pub fn notification(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

/// A result line answering `id`, without its newline.
pub fn result(id: &Id, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// An error line answering `id`, without its newline.
pub fn error(id: &Id, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_string_id_request_from_the_agent_is_a_request() {
        let line = r#"{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"a":1}}"#;
        assert_eq!(
            parse(line),
            Some(Incoming::Request {
                id: Id::Text("perm-1".into()),
                method: "session/request_permission".into(),
                params: json!({"a": 1}),
            })
        );
    }

    #[test]
    fn responses_carry_a_result_or_an_error() {
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}"#),
            Some(Incoming::Response {
                id: Id::Number(4),
                outcome: Ok(json!({"stopReason": "end_turn"})),
            })
        );
        let Some(Incoming::Response { outcome, .. }) = parse(
            r#"{"jsonrpc":"2.0","id":5,"error":{"code":-32000,"message":"Authentication required"}}"#,
        ) else {
            panic!("not a response");
        };
        assert_eq!(outcome.unwrap_err().code, AUTH_REQUIRED);
    }

    #[test]
    fn the_reason_behind_an_internal_error_is_kept() {
        let Some(Incoming::Response { outcome, .. }) = parse(
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error","data":{"details":"Model gone is not available"}}}"#,
        ) else {
            panic!("not a response");
        };
        assert_eq!(
            outcome.unwrap_err().message,
            "Internal error: Model gone is not available"
        );
    }

    #[test]
    fn a_null_result_is_still_a_response() {
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":2,"result":null}"#),
            Some(Incoming::Response {
                id: Id::Number(2),
                outcome: Ok(Value::Null),
            })
        );
    }

    #[test]
    fn notifications_have_no_id() {
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Some(Incoming::Notification { .. })
        ));
    }

    #[test]
    fn noise_is_not_a_message() {
        assert_eq!(parse("Debugger attached."), None);
        assert_eq!(parse("[1,2,3]"), None);
        assert_eq!(parse(r#"{"jsonrpc":"2.0"}"#), None);
    }

    #[test]
    fn lines_round_trip_through_the_parser() {
        let id = Id::Number(9);
        assert!(matches!(
            parse(&request(&id, "initialize", json!({}))),
            Some(Incoming::Request { .. })
        ));
        assert_eq!(
            parse(&error(&Id::Text("x".into()), METHOD_NOT_FOUND, "no")),
            Some(Incoming::Response {
                id: Id::Text("x".into()),
                outcome: Err(RemoteError {
                    code: METHOD_NOT_FOUND,
                    message: "no".into()
                }),
            })
        );
    }
}
