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

/// The modes on offer, as Claude's adapter names them.
const MODES: [(&str, &str); 5] = [
    ("default", "Manual"),
    ("acceptEdits", "Accept edits"),
    ("plan", "Plan"),
    ("auto", "Auto"),
    ("bypassPermissions", "Bypass permissions"),
];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--sleep") {
        // The grandchild: say who it is, so a test can look for it, then wait.
        if let Some(file) = args.get(1) {
            let _ = std::fs::write(file, std::process::id().to_string());
        }
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    if args.first().map(String::as_str) == Some("--orphan") {
        // Start a sleeper and go, so the sleeper's parent is gone.
        if let Ok(me) = std::env::current_exe() {
            let _ = Command::new(me)
                .arg("--sleep")
                .args(args.get(1))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        return;
    }
    let mut mock = Mock {
        flags: args,
        cwd: String::new(),
        prompt_id: None,
        waiting: None,
        slow: false,
        mode: "auto".into(),
        model: "default".into(),
        effort: "medium".into(),
        fast: "off".into(),
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
    mode: String,
    model: String,
    effort: String,
    fast: String,
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

    fn modes(&self) -> Value {
        let available: Vec<Value> = MODES
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect();
        json!({ "currentModeId": self.mode, "availableModes": available })
    }

    /// The settings, shaped as Claude's adapter shapes them: the mode again
    /// as an option, effort, and fast mode as an on/off select. The model
    /// option also lists `bypassPermissions`, a held-back value the host must
    /// drop from every option.
    fn config_options(&self) -> Value {
        let select = |id: &str, category: &str, current: &str, choices: &[&str]| {
            let options: Vec<Value> = choices
                .iter()
                .map(|c| json!({ "value": c, "name": c.to_uppercase() }))
                .collect();
            json!({ "id": id, "name": id.to_uppercase(), "category": category,
                    "type": "select", "currentValue": current, "options": options })
        };
        let mode_ids: Vec<&str> = MODES.iter().map(|(id, _)| *id).collect();
        let mut options = vec![
            select("mode", "mode", &self.mode, &mode_ids),
            select(
                "model",
                "model",
                &self.model,
                &["default", "opus", "haiku", "bypassPermissions"],
            ),
        ];
        options.push(select(
            "effort",
            "thought_level",
            &self.effort,
            &["low", "medium", "high"],
        ));
        options.push(select("fast", "model_config", &self.fast, &["on", "off"]));
        Value::Array(options)
    }

    fn config_update(&self) {
        if !self.has("--no-config") {
            self.update(json!({
                "sessionUpdate": "config_option_update",
                "configOptions": self.config_options()
            }));
        }
    }

    /// `session/set_config_option`, as Claude's adapter answers it: every
    /// option as it now stands, after a `current_mode_update` for a mode.
    /// With `--settles-elsewhere` a mode change settles on `acceptEdits`
    /// instead, and only the reply says so; the adapter does settle elsewhere
    /// when it falls back from `auto`. With `--slow-setting` every reply comes
    /// a second late.
    fn set_config(&mut self, id: &Value, params: &Value) {
        let config = params
            .get("configId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let value = params
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match config {
            "mode" if MODES.iter().any(|(m, _)| *m == value) => {
                if self.has("--settles-elsewhere") {
                    self.mode = "acceptEdits".into();
                } else {
                    self.mode = value;
                    self.update(json!({
                        "sessionUpdate": "current_mode_update", "currentModeId": self.mode
                    }));
                }
            }
            _ => return self.reply_error(id, -32602, "Unknown config option"),
        }
        if self.has("--slow-setting") {
            std::thread::sleep(Duration::from_secs(1));
        }
        self.reply(id, json!({ "configOptions": self.config_options() }));
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
                // Hold the handshake until the test creates the file, so a
                // test that needs the window open waits on a fact, not a clock.
                if let Some(gate) = self.flag_value("--init-gate") {
                    let give_up = std::time::Instant::now() + Duration::from_secs(30);
                    while !std::path::Path::new(&gate).exists()
                        && std::time::Instant::now() < give_up
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
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
                let mut result = json!({ "sessionId": "mock-1", "modes": self.modes() });
                if self.has("--no-session-id") {
                    result["sessionId"] = Value::Null;
                }
                if !self.has("--no-config") {
                    result["configOptions"] = self.config_options();
                }
                self.reply(&id, result);
            }
            (Some("session/set_mode"), Some(id)) => {
                let mode = params
                    .get("modeId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let known = match self.flag_value("--only-mode") {
                    Some(only) => only == mode,
                    None => MODES.iter().any(|(m, _)| *m == mode),
                };
                if self.has("--no-mode") || !known {
                    self.reply_error(&id, -32602, "unknown mode");
                } else {
                    // Under `--settles-elsewhere` every switch but the
                    // handshake's settles on `acceptEdits`, and says so in a
                    // notification, since this reply cannot.
                    let settled = if self.has("--settles-elsewhere") && mode != "default" {
                        "acceptEdits"
                    } else {
                        mode
                    };
                    self.mode = settled.to_string();
                    if settled != mode {
                        self.update(json!({
                            "sessionUpdate": "current_mode_update", "currentModeId": settled
                        }));
                    }
                    self.config_update();
                    self.reply(&id, json!({}));
                }
            }
            (Some("session/set_config_option"), Some(id)) => self.set_config(&id, &params),
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
                json!([]),
            ),
            "bash" => self.ask(
                "bash",
                json!([]),
                json!({ "command": "rm -rf build" }),
                json!([]),
            ),
            "outside" => self.ask(
                "outside",
                json!([{ "path": format!("{}/../escape.txt", self.cwd) }]),
                json!({}),
                json!([]),
            ),
            // An edit: the card carries the change itself.
            "diff" => {
                let path = format!("{}/inside.txt", self.cwd);
                self.ask(
                    "diff",
                    json!([{ "path": path }]),
                    json!({}),
                    json!([{ "type": "diff", "path": path, "oldText": "one\n", "newText": "two\n" }]),
                );
            }
            // An edit whose only mention of the file is its diff, and the file
            // is outside the worktree.
            "diffout" => {
                let path = format!("{}/../escape.txt", self.cwd);
                self.ask(
                    "diffout",
                    json!([]),
                    json!({}),
                    json!([{ "type": "diff", "path": path, "oldText": null, "newText": "x" }]),
                );
            }
            "cancelreq" => {
                self.ask(
                    "cancelreq",
                    json!([]),
                    json!({ "command": "ls" }),
                    json!([]),
                );
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
            // Settings the agent changes on its own, as Claude's adapter does
            // on leaving plan mode or when fast mode's state changes under it.
            // Then an update with no list, which changes nothing, and more
            // words, so a status held back to the turn's end would come last.
            "drift" => {
                self.mode = "acceptEdits".into();
                self.fast = "on".into();
                self.config_update();
                self.update(json!({ "sessionUpdate": "config_option_update" }));
                self.chunk("drifted", "drift-1");
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
            // Someone signed in while the turn ran; the turn itself failed for
            // another reason, so only the notification can clear the hint.
            "relogin" => {
                self.send(&json!({
                    "jsonrpc": "2.0",
                    "method": "_auth/status_update",
                    "params": { "authStatus": { "kind": "oauth" } }
                }));
                if let Some(id) = self.prompt_id.take() {
                    self.reply_error(&id, -32603, "upstream hiccup");
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
                    let mut grandchild = Command::new(me);
                    grandchild.arg("--sleep");
                    if let Some(file) = self.flag_value("--grandchild-pid") {
                        grandchild.arg(file);
                    }
                    let _ = grandchild
                        .stdin(Stdio::null())
                        .stdout(Stdio::inherit())
                        .spawn();
                }
                self.end_turn("end_turn");
            }
            "orphan" => {
                // A grandchild whose parent has exited by the time the turn ends.
                if let Ok(me) = std::env::current_exe() {
                    let mut middle = Command::new(me);
                    middle.arg("--orphan");
                    if let Some(file) = self.flag_value("--grandchild-pid") {
                        middle.arg(file);
                    }
                    let _ = middle
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
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
    fn ask(&mut self, scenario: &str, locations: Value, raw_input: Value, content: Value) {
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
                    "locations": locations, "rawInput": raw_input, "content": content
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
