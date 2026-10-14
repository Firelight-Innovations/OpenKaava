//! ACP's `session/update` stream, turned into [`Event`]s.
//!
//! Pure: no process, no clock, no I/O. The session feeds it what the agent
//! says and sends on whatever comes out, which is what lets every rule below
//! be tested one update at a time.
//!
//! What it does with each update kind:
//!
//! - message and thought chunks become one text or reasoning item per ACP
//!   `messageId`, started and then appended to; when an adapter sends no
//!   `messageId`, consecutive chunks of one kind are one item.
//! - `tool_call` and `tool_call_update` become one tool item per `toolCallId`.
//!   A field an update leaves out, or sends as `null`, is unchanged.
//! - `plan` is one item for the whole session, replaced in place.
//! - `usage_update` is remembered and drawn once, as the turn ends.
//! - `current_mode_update` changes the status, not the transcript.
//! - everything else is counted and dropped, `plan_update` and `_`-prefixed
//!   kinds among them.

use std::collections::HashMap;

use serde_json::Value;

use crate::event::{ApprovalOption, Event, FileDiff, Hint, Item, ItemKind, PlanEntry, ToolStatus};
use crate::guard::request_paths;
use crate::mask::mask;

/// The most tool output kept per tool item, in bytes.
pub const OUTPUT_LIMIT: usize = 16 * 1024;

/// The most bytes kept of either side of a diff. A half-shown diff would
/// mislead, so past this the texts are dropped whole.
pub const DIFF_LIMIT: usize = 256 * 1024;

/// The most text kept per message or reasoning item, in bytes. Chunks past it
/// are counted and dropped.
pub const TEXT_LIMIT: usize = 256 * 1024;

/// One session's translation state.
#[derive(Debug)]
pub struct Normalizer {
    prefix: String,
    next: u64,
    turn: Option<String>,
    open: Option<OpenText>,
    tools: HashMap<String, Item>,
    plan: Option<Item>,
    usage: Option<(u64, u64)>,
    mode: Option<String>,
    dropped: u64,
}

#[derive(Debug)]
struct OpenText {
    item: Item,
    message_id: Option<String>,
}

impl Normalizer {
    /// A normalizer whose item and turn ids all start with `prefix`, so two
    /// sessions in one tab never mint the same id.
    pub fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.to_string(),
            next: 0,
            turn: None,
            open: None,
            tools: HashMap::new(),
            plan: None,
            usage: None,
            mode: None,
            dropped: 0,
        }
    }

    fn mint(&mut self, kind: char) -> String {
        self.next += 1;
        format!("{}-{kind}{}", self.prefix, self.next)
    }

    fn item(&mut self, kind: ItemKind) -> Item {
        Item {
            id: self.mint('i'),
            turn_id: self.turn.clone().unwrap_or_default(),
            kind,
        }
    }

    /// Updates dropped so far: unknown kinds, chunks outside a turn, text past
    /// [`TEXT_LIMIT`].
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// The mode the agent last reported, taken so it is reported once.
    pub fn take_mode(&mut self) -> Option<String> {
        self.mode.take()
    }

    /// The open turn, if any.
    pub fn turn(&self) -> Option<&str> {
        self.turn.as_deref()
    }

    /// A prompt starts a turn: the turn, then the user's message, complete.
    pub fn begin_turn(&mut self, text: &str) -> Vec<Event> {
        let turn_id = self.mint('t');
        self.turn = Some(turn_id.clone());
        self.usage = None;
        let item = self.item(ItemKind::UserMessage {
            text: text.to_string(),
        });
        vec![
            Event::TurnStarted { turn_id },
            Event::ItemCompleted { item },
        ]
    }

    /// The turn ended: close what is open, draw the usage, end the turn.
    /// Nothing happens if no turn is open.
    pub fn end_turn(&mut self, stop_reason: &str) -> Vec<Event> {
        let Some(turn_id) = self.turn.clone() else {
            return Vec::new();
        };
        let mut events = self.close_text();
        let mut tools: Vec<Item> = self.tools.drain().map(|(_, item)| item).collect();
        tools.sort_by(|a, b| a.id.cmp(&b.id));
        for mut item in tools {
            if let ItemKind::ToolCall { status, .. } = &mut item.kind {
                if matches!(status, ToolStatus::Pending | ToolStatus::InProgress)
                    && stop_reason != "end_turn"
                {
                    *status = ToolStatus::Failed;
                }
            }
            events.push(Event::ItemCompleted { item });
        }
        if let Some((used, size)) = self.usage.take() {
            let item = self.item(ItemKind::Usage { used, size });
            events.push(Event::ItemCompleted { item });
        }
        self.turn = None;
        events.push(Event::TurnCompleted {
            turn_id,
            stop_reason: stop_reason.to_string(),
        });
        events
    }

    /// An error, drawn as one finished item. `message` is masked here.
    pub fn error(&mut self, message: &str, hint: Option<Hint>) -> Vec<Event> {
        let mut events = self.close_text();
        let item = self.item(ItemKind::Error {
            message: mask(message),
            hint,
        });
        events.push(Event::ItemCompleted { item });
        events
    }

    /// Close the open text or reasoning item, if there is one.
    pub fn close_text(&mut self) -> Vec<Event> {
        self.open
            .take()
            .map(|open| Event::ItemCompleted { item: open.item })
            .into_iter()
            .collect()
    }

    /// The item for a `session/request_permission`. `paths` are the ones the
    /// request names; with none, `allow_always` is not offered.
    pub fn approval(&mut self, params: &Value, paths: Vec<String>) -> Item {
        let call = params.get("toolCall").unwrap_or(&Value::Null);
        let offer_always = !paths.is_empty();
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|o| {
                Some(ApprovalOption {
                    option_id: o.get("optionId")?.as_str()?.to_string(),
                    kind: text(o, "kind"),
                    name: text(o, "name"),
                })
            })
            .filter(|o| offer_always || o.kind != "allow_always")
            .collect();
        let diffs = diffs(call);
        let input = call.get("rawInput");
        let command = input
            .and_then(|i| i.get("command").or_else(|| i.get("url")))
            .and_then(Value::as_str)
            .map(str::to_string);
        // Not every tool has a command or a diff; for the rest, the exact
        // input the agent sent is the honest "exact change".
        let detail = command.or_else(|| match input {
            Some(input) if diffs.is_empty() && !input.is_null() => {
                let pretty = serde_json::to_string_pretty(input).unwrap_or_default();
                Some(cut(&pretty, OUTPUT_LIMIT).0)
            }
            _ => None,
        });
        self.item(ItemKind::Approval {
            title: text(call, "title"),
            tool_call_id: call
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string),
            detail,
            paths,
            diffs,
            options,
            answer: None,
        })
    }

    /// One `session/update`'s `update` object.
    pub fn update(&mut self, update: &Value) -> Vec<Event> {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "agent_message_chunk" => self.chunk(update, false),
            "agent_thought_chunk" => self.chunk(update, true),
            "tool_call" | "tool_call_update" => self.tool(update),
            "plan" => self.plan(update),
            "usage_update" => {
                let used = number(update, "used");
                let size = number(update, "size");
                self.usage = Some((used, size));
                Vec::new()
            }
            "current_mode_update" => {
                self.mode = update
                    .get("currentModeId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Vec::new()
            }
            _ => {
                self.dropped += 1;
                Vec::new()
            }
        }
    }

    fn chunk(&mut self, update: &Value, reasoning: bool) -> Vec<Event> {
        let content = update.get("content").unwrap_or(&Value::Null);
        let Some(chunk) = content.get("text").and_then(Value::as_str) else {
            self.dropped += 1;
            return Vec::new();
        };
        if self.turn.is_none() {
            self.dropped += 1;
            return Vec::new();
        }
        let message_id = update
            .get("messageId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let continues = self.open.as_ref().is_some_and(|open| {
            is_reasoning(&open.item.kind) == reasoning
                && (message_id.is_none() || open.message_id == message_id)
        });
        if continues {
            let Some(open) = self.open.as_mut() else {
                return Vec::new();
            };
            let Some(text) = item_text(&mut open.item.kind) else {
                return Vec::new();
            };
            if text.len() + chunk.len() > TEXT_LIMIT {
                self.dropped += 1;
                return Vec::new();
            }
            text.push_str(chunk);
            return vec![Event::ItemDelta {
                item_id: open.item.id.clone(),
                text: chunk.to_string(),
            }];
        }
        let mut events = self.close_text();
        let text = cut(chunk, TEXT_LIMIT).0;
        let kind = if reasoning {
            ItemKind::Reasoning { text }
        } else {
            ItemKind::AssistantText { text }
        };
        let item = self.item(kind);
        events.push(Event::ItemStarted { item: item.clone() });
        self.open = Some(OpenText { item, message_id });
        events
    }

    fn tool(&mut self, update: &Value) -> Vec<Event> {
        let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
            self.dropped += 1;
            return Vec::new();
        };
        if self.turn.is_none() {
            self.dropped += 1;
            return Vec::new();
        }
        let mut events = self.close_text();
        let known = self.tools.remove(id);
        let started = known.is_none();
        let mut item = match known {
            Some(item) => item,
            None => self.item(ItemKind::ToolCall {
                title: String::new(),
                tool_kind: "other".to_string(),
                status: ToolStatus::Pending,
                output: String::new(),
                truncated: false,
                paths: Vec::new(),
                diffs: Vec::new(),
            }),
        };
        merge_tool(&mut item.kind, update);
        let done = matches!(
            item.kind,
            ItemKind::ToolCall {
                status: ToolStatus::Completed | ToolStatus::Failed,
                ..
            }
        );
        let event = match (started, done) {
            (_, true) => Event::ItemCompleted { item },
            (true, false) => Event::ItemStarted { item },
            (false, false) => Event::ItemUpdated { item },
        };
        if let Event::ItemStarted { item } | Event::ItemUpdated { item } = &event {
            self.tools.insert(id.to_string(), item.clone());
        }
        events.push(event);
        events
    }

    fn plan(&mut self, update: &Value) -> Vec<Event> {
        let entries = update
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|e| PlanEntry {
                content: text(e, "content"),
                status: text(e, "status"),
                priority: text(e, "priority"),
            })
            .collect();
        match self.plan.as_mut() {
            Some(item) => {
                item.kind = ItemKind::Plan { entries };
                vec![Event::ItemUpdated { item: item.clone() }]
            }
            None => {
                let mut events = self.close_text();
                let item = self.item(ItemKind::Plan { entries });
                self.plan = Some(item.clone());
                events.push(Event::ItemStarted { item });
                events
            }
        }
    }
}

fn merge_tool(kind: &mut ItemKind, update: &Value) {
    let ItemKind::ToolCall {
        title,
        tool_kind,
        status,
        output,
        truncated,
        paths,
        diffs: tool_diffs,
    } = kind
    else {
        return;
    };
    if let Some(t) = update.get("title").and_then(Value::as_str) {
        *title = t.to_string();
    }
    if let Some(k) = update.get("kind").and_then(Value::as_str) {
        *tool_kind = k.to_string();
    }
    if let Some(s) = update.get("status").and_then(Value::as_str) {
        *status = match s {
            "in_progress" => ToolStatus::InProgress,
            "completed" => ToolStatus::Completed,
            "failed" => ToolStatus::Failed,
            _ => ToolStatus::Pending,
        };
    }
    if update.get("content").is_some_and(Value::is_array) {
        let joined = update
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("content"))
            .filter_map(|b| b.get("content")?.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        (*output, *truncated) = cut(&joined, OUTPUT_LIMIT);
        *tool_diffs = diffs(update);
    }
    let named = request_paths(update);
    if !named.is_empty() {
        *paths = named;
    }
}

fn diffs(value: &Value) -> Vec<FileDiff> {
    value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("diff"))
        .map(|b| {
            let old_text = b.get("oldText").and_then(Value::as_str);
            let new_text = b.get("newText").and_then(Value::as_str).unwrap_or_default();
            let too_large =
                new_text.len() > DIFF_LIMIT || old_text.is_some_and(|t| t.len() > DIFF_LIMIT);
            FileDiff {
                path: text(b, "path"),
                old_text: old_text.filter(|_| !too_large).map(str::to_string),
                new_text: if too_large {
                    String::new()
                } else {
                    new_text.to_string()
                },
                too_large,
            }
        })
        .collect()
}

fn is_reasoning(kind: &ItemKind) -> bool {
    matches!(kind, ItemKind::Reasoning { .. })
}

fn item_text(kind: &mut ItemKind) -> Option<&mut String> {
    match kind {
        ItemKind::AssistantText { text } | ItemKind::Reasoning { text } => Some(text),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// `s` cut to at most `limit` bytes on a character boundary, and whether it
/// was cut.
fn cut(s: &str, limit: usize) -> (String, bool) {
    if s.len() <= limit {
        return (s.to_string(), false);
    }
    let mut end = limit;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn started() -> Normalizer {
        let mut n = Normalizer::new("s1");
        n.begin_turn("hi");
        n
    }

    fn chunk(text: &str, id: Option<&str>) -> Value {
        let mut v = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": text}
        });
        if let Some(id) = id {
            v["messageId"] = json!(id);
        }
        v
    }

    #[test]
    fn a_turn_starts_with_the_users_message() {
        let mut n = Normalizer::new("s1");
        let events = n.begin_turn("hello");
        assert!(matches!(&events[0], Event::TurnStarted { turn_id } if turn_id == "s1-t1"));
        assert!(matches!(
            &events[1],
            Event::ItemCompleted { item: Item { kind: ItemKind::UserMessage { text }, .. } }
                if text == "hello"
        ));
    }

    #[test]
    fn chunks_of_one_message_are_one_item() {
        let mut n = started();
        let first = n.update(&chunk("Hel", Some("m1")));
        assert!(matches!(&first[..], [Event::ItemStarted { .. }]));
        let second = n.update(&chunk("lo", Some("m1")));
        assert!(matches!(&second[..], [Event::ItemDelta { text, .. }] if text == "lo"));
        let third = n.update(&chunk("New", Some("m2")));
        assert!(
            matches!(&third[..], [Event::ItemCompleted { item }, Event::ItemStarted { .. }]
                if matches!(&item.kind, ItemKind::AssistantText { text } if text == "Hello"))
        );
    }

    #[test]
    fn without_message_ids_a_kind_change_splits_items() {
        let mut n = started();
        n.update(&chunk("a", None));
        let thought = n.update(&json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "hmm"}
        }));
        assert!(matches!(
            &thought[..],
            [Event::ItemCompleted { .. }, Event::ItemStarted { item }]
                if matches!(item.kind, ItemKind::Reasoning { .. })
        ));
    }

    #[test]
    fn chunks_outside_a_turn_are_dropped() {
        let mut n = Normalizer::new("s1");
        assert!(n.update(&chunk("stray", None)).is_empty());
        assert_eq!(n.dropped(), 1);
    }

    #[test]
    fn a_tool_call_merges_updates_and_completes() {
        let mut n = started();
        let a = n.update(&json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read a.rs",
            "kind": "read", "status": "pending", "locations": [{"path": "/w/a.rs"}]
        }));
        assert!(matches!(&a[..], [Event::ItemStarted { .. }]));
        let b = n.update(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress",
            "title": null
        }));
        let [Event::ItemUpdated { item }] = &b[..] else {
            panic!("{b:?}")
        };
        let ItemKind::ToolCall {
            title,
            status,
            paths,
            ..
        } = &item.kind
        else {
            panic!()
        };
        assert_eq!(title, "Read a.rs", "null leaves a field unchanged");
        assert_eq!(*status, ToolStatus::InProgress);
        assert_eq!(paths, &vec!["/w/a.rs".to_string()]);
        let c = n.update(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
            "content": [
                {"type": "content", "content": {"type": "text", "text": "line one"}},
                {"type": "diff", "path": "/w/a.rs", "oldText": "x", "newText": "y"},
                {"type": "terminal", "terminalId": "term-1"}
            ]
        }));
        let [Event::ItemCompleted { item }] = &c[..] else {
            panic!("{c:?}")
        };
        let ItemKind::ToolCall { output, diffs, .. } = &item.kind else {
            panic!()
        };
        assert_eq!(output, "line one");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].old_text.as_deref(), Some("x"));
        assert!(!diffs[0].too_large);
    }

    #[test]
    fn a_diff_over_the_limit_keeps_only_its_path() {
        let big = "x".repeat(DIFF_LIMIT + 1);
        let got = diffs(&json!({
            "content": [{"type": "diff", "path": "/w/big.rs", "oldText": "a", "newText": big}]
        }));
        assert_eq!(got.len(), 1);
        assert!(got[0].too_large);
        assert_eq!(got[0].path, "/w/big.rs");
        assert!(got[0].old_text.is_none() && got[0].new_text.is_empty());
    }

    #[test]
    fn tool_output_is_cut_at_the_limit() {
        let mut n = started();
        let long = "é".repeat(OUTPUT_LIMIT);
        let events = n.update(&json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": long}}]
        }));
        let [Event::ItemCompleted { item }] = &events[..] else {
            panic!()
        };
        let ItemKind::ToolCall {
            output, truncated, ..
        } = &item.kind
        else {
            panic!()
        };
        assert!(*truncated);
        assert!(output.len() <= OUTPUT_LIMIT);
    }

    #[test]
    fn the_plan_is_one_item_across_turns() {
        let mut n = started();
        let plan = |s: &str| {
            json!({"sessionUpdate": "plan", "entries": [
                {"content": "step", "status": s, "priority": "high"}
            ]})
        };
        let first = n.update(&plan("pending"));
        let [Event::ItemStarted { item }] = &first[..] else {
            panic!()
        };
        let id = item.id.clone();
        n.end_turn("end_turn");
        n.begin_turn("again");
        let second = n.update(&plan("completed"));
        let [Event::ItemUpdated { item }] = &second[..] else {
            panic!("{second:?}")
        };
        assert_eq!(item.id, id);
        assert!(matches!(&item.kind, ItemKind::Plan { entries }
            if entries[0].status == "completed" && entries[0].priority == "high"));
    }

    #[test]
    fn usage_is_drawn_once_as_the_turn_ends() {
        let mut n = started();
        n.update(&json!({"sessionUpdate": "usage_update", "used": 10, "size": 200}));
        n.update(&json!({"sessionUpdate": "usage_update", "used": 12, "size": 200}));
        n.update(&chunk("done", None));
        let events = n.end_turn("end_turn");
        assert!(matches!(
            &events[..],
            [
                Event::ItemCompleted { .. },
                Event::ItemCompleted {
                    item: Item {
                        kind: ItemKind::Usage {
                            used: 12,
                            size: 200
                        },
                        ..
                    }
                },
                Event::TurnCompleted { .. }
            ]
        ));
        assert!(n.turn().is_none());
    }

    #[test]
    fn a_cancelled_turn_fails_its_running_tools() {
        let mut n = started();
        n.update(
            &json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress"}),
        );
        let events = n.end_turn("cancelled");
        assert!(matches!(
            &events[0],
            Event::ItemCompleted {
                item: Item {
                    kind: ItemKind::ToolCall {
                        status: ToolStatus::Failed,
                        ..
                    },
                    ..
                }
            }
        ));
    }

    #[test]
    fn mode_changes_are_reported_and_unknown_kinds_dropped() {
        let mut n = started();
        n.update(&json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"}));
        assert_eq!(n.take_mode().as_deref(), Some("plan"));
        assert_eq!(n.take_mode(), None);
        for kind in [
            "plan_update",
            "available_commands_update",
            "_kaava/whatever",
        ] {
            assert!(n.update(&json!({"sessionUpdate": kind})).is_empty());
        }
        assert_eq!(n.dropped(), 3);
    }

    #[test]
    fn an_approval_without_paths_offers_no_always() {
        let mut n = started();
        let params = json!({
            "toolCall": {"toolCallId": "t9", "title": "Run ls", "rawInput": {"command": "ls -la"}},
            "options": [
                {"optionId": "a", "kind": "allow_once", "name": "Allow"},
                {"optionId": "b", "kind": "allow_always", "name": "Always allow"},
                {"optionId": "c", "kind": "reject_once", "name": "Reject"}
            ]
        });
        let item = n.approval(&params, Vec::new());
        let ItemKind::Approval {
            options,
            detail,
            title,
            ..
        } = &item.kind
        else {
            panic!()
        };
        assert_eq!(title, "Run ls");
        assert_eq!(detail.as_deref(), Some("ls -la"));
        let ids: Vec<_> = options.iter().map(|o| o.option_id.as_str()).collect();
        assert_eq!(ids, ["a", "c"]);
        let item = n.approval(&params, vec!["/w/a.rs".into()]);
        let ItemKind::Approval { options, .. } = &item.kind else {
            panic!()
        };
        assert_eq!(options.len(), 3);
    }

    #[test]
    fn errors_are_masked() {
        let mut n = started();
        let events = n.error("failed for someone@example.com", None);
        assert!(
            matches!(&events[..], [Event::ItemCompleted { item: Item { kind: ItemKind::Error { message, .. }, .. } }]
            if message == "failed for <email>")
        );
    }
}
