//! A stand-in ACP agent for the host's tests: a real child process speaking
//! JSON-RPC on stdio, so the tests exercise the same pipes, threads and
//! process handling a real adapter does.
//!
//! Flags shape the handshake; the prompt's text picks what a turn does (see
//! [`Mock::prompt`]). It exits when its stdin closes.

use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--sleep") {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    let mut mock = Mock {
        flags: args,
        cwd: String::new(),
        prompt_id: None,
        waiting: None,
        slow: false,
    };
    if mock.has("--secret") {
        eprintln!("debug: token sk-ant-oat01-AbCdEf0123456789xyzAbCd for someone@example.com");
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        mock.handle(&message);
    }
}

struct Mock {
    flags: Vec<String>,
    cwd: String,
    prompt_id: Option<Value>,
    /// The scenario waiting on our permission request's answer.
    waiting: Option<String>,
    slow: bool,
}

impl Mock {
    fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }

    fn flag_value(&self, flag: &str) -> Option<String> {
        let at = self.flags.iter().position(|f| f == flag)?;
        self.flags.get(at + 1).cloned()
    }

    fn send(&self, message: &Value) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }

    fn reply(&self, id: &Value, result: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn reply_error(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({
            "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message }
        }));
    }

    fn update(&self, update: Value) {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": "mock-1", "update": update }
        }));
    }

    fn chunk(&self, text: &str, message_id: &str) {
        self.update(json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": message_id,
            "content": { "type": "text", "text": text }
        }));
    }

    fn end_turn(&mut self, stop_reason: &str) {
        if let Some(id) = self.prompt_id.take() {
            self.reply(&id, json!({ "stopReason": stop_reason }));
        }
    }

    fn handle(&mut self, message: &Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (Some("initialize"), Some(id)) => {
                if self.has("--fail-init") {
                    eprintln!("mock-agent: refusing to start");
                    std::process::exit(3);
                }
                if self.has("--slow-init") {
                    std::thread::sleep(Duration::from_millis(500));
                }
                let version = self
                    .flag_value("--version")
                    .unwrap_or_else(|| "0.90.0".into());
                self.reply(
                    &id,
                    json!({
                        "protocolVersion": 1,
                        "agentCapabilities": {},
                        "agentInfo": { "name": "mock-agent", "version": version },
                        "authMethods": []
                    }),
                );
            }
            (Some("session/new"), Some(id)) => {
                if self.has("--signin") {
                    self.reply_error(&id, -32000, "Authentication required");
                    return;
                }
                self.cwd = params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if self.has("--secret") {
                    self.send(&json!({
                        "jsonrpc": "2.0",
                        "method": "_auth/status_update",
                        "params": { "authStatus": {
                            "kind": "none",
                            "label": "someone@example.com",
                            "organization": "Example Org"
                        } }
                    }));
                }
                self.reply(
                    &id,
                    json!({
                        "sessionId": "mock-1",
                        "modes": { "currentModeId": "auto", "availableModes": [] }
                    }),
                );
            }
            (Some("session/set_mode"), Some(id)) => {
                if self.has("--no-mode") {
                    self.reply_error(&id, -32602, "unknown mode");
                } else {
                    self.reply(&id, json!({}));
                }
            }
            (Some("session/prompt"), Some(id)) => {
                let text = params
                    .pointer("/prompt/0/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.prompt_id = Some(id);
                self.prompt(&text);
            }
            (Some("session/cancel"), None) => {
                if self.slow {
                    self.slow = false;
                    self.end_turn("cancelled");
                }
            }
            (Some(_), Some(id)) => self.reply_error(&id, -32601, "method not found"),
            (None, Some(_)) => self.answered(message),
            _ => {}
        }
    }

    /// One turn, chosen by the prompt's text.
    fn prompt(&mut self, text: &str) {
        match text {
            "stream" => {
                self.chunk("Hel", "m1");
                self.chunk("lo", "m1");
                self.update(json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "messageId": "m2",
                    "content": { "type": "text", "text": "thinking" }
                }));
                self.end_turn("end_turn");
            }
            "tool" => {
                let path = format!("{}/README.md", self.cwd);
                self.update(json!({
                    "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read README.md",
                    "kind": "read", "status": "pending", "locations": [{ "path": path }]
                }));
                self.update(json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress"
                }));
                self.update(json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                    "content": [{ "type": "content", "content": { "type": "text", "text": "# Readme" } }]
                }));
                self.end_turn("end_turn");
            }
            "approve" => self.ask(
                "approve",
                json!([{ "path": format!("{}/inside.txt", self.cwd) }]),
                json!({}),
            ),
            "bash" => self.ask("bash", json!([]), json!({ "command": "rm -rf build" })),
            "outside" => self.ask(
                "outside",
                json!([{ "path": format!("{}/../escape.txt", self.cwd) }]),
                json!({}),
            ),
            "cancelreq" => {
                self.ask("cancelreq", json!([]), json!({ "command": "ls" }));
                self.send(&json!({
                    "jsonrpc": "2.0", "method": "$/cancel_request",
                    "params": { "requestId": "perm-cancelreq" }
                }));
                self.waiting = None;
                self.end_turn("end_turn");
            }
            "plan" => {
                for status in ["pending", "completed"] {
                    self.update(json!({
                        "sessionUpdate": "plan",
                        "entries": [{ "content": "Do it", "status": status, "priority": "high" }]
                    }));
                }
                self.update(
                    json!({ "sessionUpdate": "usage_update", "used": 1200, "size": 200000 }),
                );
                self.end_turn("end_turn");
            }
            "mode" => {
                self.update(
                    json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" }),
                );
                self.end_turn("end_turn");
            }
            "slow" => {
                self.chunk("working", "m1");
                self.slow = true;
            }
            "crash" => {
                self.chunk("bye", "m1");
                std::process::exit(7);
            }
            "auth" => {
                if let Some(id) = self.prompt_id.take() {
                    self.reply_error(&id, -32000, "Authentication required");
                }
            }
            "secret" => {
                if let Some(id) = self.prompt_id.take() {
                    self.reply_error(
                        &id,
                        -32603,
                        "upstream refused key sk-ant-api03-ZyXwVu9876543210abcdEFGH for someone@example.com",
                    );
                }
            }
            "grandchild" => {
                // A process of our own that inherits stdout and outlives us
                // unless the host takes the whole tree.
                if let Ok(me) = std::env::current_exe() {
                    let _ = Command::new(me)
                        .arg("--sleep")
                        .stdin(Stdio::null())
                        .stdout(Stdio::inherit())
                        .spawn();
                }
                self.end_turn("end_turn");
            }
            other => {
                self.chunk(&format!("echo: {other}"), "m1");
                self.end_turn("end_turn");
            }
        }
    }

    /// Ask for permission, and wait for the answer in [`Mock::answered`].
    fn ask(&mut self, scenario: &str, locations: Value, raw_input: Value) {
        self.update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "t2", "title": format!("Do {scenario}"),
            "kind": "edit", "status": "pending", "locations": locations
        }));
        self.waiting = Some(scenario.to_string());
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": format!("perm-{scenario}"),
            "method": "session/request_permission",
            "params": {
                "sessionId": "mock-1",
                "toolCall": {
                    "toolCallId": "t2", "title": format!("Do {scenario}"),
                    "locations": locations, "rawInput": raw_input
                },
                "options": [
                    { "optionId": "o1", "kind": "allow_once", "name": "Allow" },
                    { "optionId": "o2", "kind": "allow_always", "name": "Always allow in this project" },
                    { "optionId": "o3", "kind": "reject_once", "name": "Reject" }
                ]
            }
        }));
    }

    /// The client answered our permission request. Report what it sent, word
    /// for word, so a test can check its exact shape; then finish the turn.
    fn answered(&mut self, message: &Value) {
        if self.waiting.take().is_none() {
            return;
        }
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        self.chunk(&format!("answer: {result}"), "m9");
        let allowed = result.pointer("/outcome/optionId").and_then(Value::as_str) == Some("o1")
            || result.pointer("/outcome/optionId").and_then(Value::as_str) == Some("o2");
        self.update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t2",
            "status": if allowed { "completed" } else { "failed" }
        }));
        self.end_turn("end_turn");
    }
}
