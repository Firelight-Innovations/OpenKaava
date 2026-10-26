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
//! - what the agent sends is capped before it is kept (see the limits below).
//! - `usage_update` is remembered and drawn once, as the turn ends.
//! - `current_mode_update` and `config_option_update` change the status, not
//!   the transcript.
//! - everything else is counted and dropped, `plan_update` and `_`-prefixed
//!   kinds among them.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::config::{enters_held_back, settings, Settings};
use crate::event::{ApprovalOption, Event, FileDiff, Hint, Item, ItemKind, PlanEntry, ToolStatus};
use crate::guard::request_paths;
use crate::harness::Harness;
use crate::mask::mask;
use crate::veistra_call;

/// The most tool output kept per tool item, in bytes.
pub const OUTPUT_LIMIT: usize = 16 * 1024;

/// The most bytes kept of either side of a diff. A half-shown diff would
/// mislead, so past this the texts are dropped whole.
pub const DIFF_LIMIT: usize = 256 * 1024;

/// The most text kept per message or reasoning item, in bytes. A message that
/// reaches it is cut there, ends in [`CUT_NOTE`] and takes nothing more.
pub const TEXT_LIMIT: usize = 256 * 1024;

/// The most bytes of an approval's command, URL or raw input shown. Past it
/// the card says so, since the user decides on what they can read.
pub const DETAIL_LIMIT: usize = 64 * 1024;

/// The most bytes of a title or a plan step.
pub const TITLE_LIMIT: usize = 2 * 1024;

/// The most plan steps kept.
pub const MAX_PLAN_ENTRIES: usize = 100;

/// The most paths listed on one approval or tool call.
pub const MAX_PATHS: usize = 50;

/// The most tool calls tracked as open at once. A call past it is dropped.
pub const MAX_OPEN_TOOLS: usize = 500;

/// Appended to a message that was cut at [`TEXT_LIMIT`].
pub const CUT_NOTE: &str = "\n\n(message truncated)";

/// One session's translation state.
#[derive(Debug)]
pub struct Normalizer {
    prefix: String,
    harness: Harness,
    next: u64,
    turn: Option<String>,
    open: Option<OpenText>,
    tools: HashMap<String, Item>,
    /// The open tool calls the harness named as a context server show tool.
    /// An adapter may name the tool on one update only, so it is remembered.
    shows: HashSet<String>,
    named: HashMap<String, Vec<String>>,
    plan: Option<Item>,
    usage: Option<(u64, u64)>,
    mode: Option<String>,
    settings: Option<Settings>,
    dropped: u64,
}

#[derive(Debug)]
struct OpenText {
    item: Item,
    message_id: Option<String>,
    /// Set once the message hit [`TEXT_LIMIT`]: everything after it, from the
    /// same message, is dropped, so a later short chunk cannot leave a hole.
    cut: bool,
}

impl Normalizer {
    /// A normalizer whose item and turn ids all start with `prefix`, so two
    /// sessions in one tab never mint the same id. Its errors name `harness`.
    pub fn new(prefix: &str, harness: Harness) -> Self {
        Self {
            prefix: prefix.to_string(),
            harness,
            next: 0,
            turn: None,
            open: None,
            tools: HashMap::new(),
            shows: HashSet::new(),
            named: HashMap::new(),
            plan: None,
            usage: None,
            mode: None,
            settings: None,
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

    /// Count one request refused or update dropped by the session.
    pub fn drop_one(&mut self) {
        self.dropped += 1;
    }

    /// The mode the agent last reported, taken so it is reported once.
    pub fn take_mode(&mut self) -> Option<String> {
        self.mode.take()
    }

    /// The settings the agent last reported, taken so they are applied once.
    pub fn take_settings(&mut self) -> Option<Settings> {
        self.settings.take()
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
        self.shows.clear();
        self.named.clear();
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
            harness: self.harness,
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

    /// Every file a live tool call has named in any update so far: its paths,
    /// and the file each of its diffs writes, which for a move is where the
    /// file goes. A later update that names others adds to these, where the
    /// item drawn shows only the latest.
    pub fn tool_paths(&self, id: &str) -> Vec<String> {
        self.named.get(id).cloned().unwrap_or_default()
    }

    /// The item for a `session/request_permission`. `paths` are the ones the
    /// request names, listed on the card up to [`MAX_PATHS`]. An option
    /// that would enter a mode the tab holds back is never offered,
    /// whatever its kind.
    pub fn approval(&mut self, params: &Value, mut paths: Vec<String>) -> Item {
        let call = params.get("toolCall").unwrap_or(&Value::Null);
        paths.truncate(MAX_PATHS);
        // `allow_always` is never offered. It would make the agent stop asking
        // about later calls of that tool, and the path guard only sees what
        // the agent asks about, so a standing allow would switch it off.
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|o| {
                Some(ApprovalOption {
                    option_id: o.get("optionId")?.as_str()?.to_string(),
                    kind: text(o, "kind"),
                    name: cut(&text(o, "name"), TITLE_LIMIT).0,
                })
            })
            .filter(|o| o.kind != "allow_always")
            .filter(|o| !enters_held_back(&o.option_id))
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
                Some(serde_json::to_string_pretty(input).unwrap_or_default())
            }
            _ => None,
        });
        let (detail, detail_truncated) = match detail {
            Some(detail) => {
                let (shown, was_cut) = cut(&detail, DETAIL_LIMIT);
                (Some(shown), was_cut)
            }
            None => (None, false),
        };
        self.item(ItemKind::Approval {
            title: cut(&text(call, "title"), TITLE_LIMIT).0,
            tool_call_id: call
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string),
            detail,
            detail_truncated,
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
            // An update without a list says nothing, rather than that the
            // agent has no settings left.
            "config_option_update" => {
                if let Some(list) = update.get("configOptions").filter(|l| l.is_array()) {
                    self.settings = Some(settings(list));
                }
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
            if open.cut {
                self.dropped += 1;
                return Vec::new();
            }
            let Some(text) = item_text(&mut open.item.kind) else {
                return Vec::new();
            };
            let mut added = chunk.to_string();
            if text.len() + chunk.len() > TEXT_LIMIT {
                // Cut here and take nothing more from this message: dropping
                // only the chunk that did not fit would let a later, shorter
                // one through and leave a hole in the middle.
                added = cut(chunk, TEXT_LIMIT.saturating_sub(text.len())).0;
                added.push_str(CUT_NOTE);
                open.cut = true;
                self.dropped += 1;
            }
            text.push_str(&added);
            return vec![Event::ItemDelta {
                item_id: open.item.id.clone(),
                text: added,
            }];
        }
        let mut events = self.close_text();
        let (mut text, was_cut) = cut(chunk, TEXT_LIMIT);
        if was_cut {
            text.push_str(CUT_NOTE);
            self.dropped += 1;
        }
        let kind = if reasoning {
            ItemKind::Reasoning { text }
        } else {
            ItemKind::AssistantText { text }
        };
        let item = self.item(kind);
        events.push(Event::ItemStarted { item: item.clone() });
        self.open = Some(OpenText {
            item,
            message_id,
            cut: was_cut,
        });
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
        if !self.tools.contains_key(id) && self.tools.len() >= MAX_OPEN_TOOLS {
            self.dropped += 1;
            return Vec::new();
        }
        let mut events = self.close_text();
        let named = self.named.entry(id.to_string()).or_default();
        for path in request_paths(update) {
            if !named.contains(&path) {
                named.push(path);
            }
        }
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
                veistra: None,
            }),
        };
        merge_tool(&mut item.kind, update);
        // A show call to the context server also carries its component.
        if veistra_call::is_show(update) {
            self.shows.insert(id.to_string());
        }
        if let ItemKind::ToolCall {
            status: ToolStatus::Completed,
            veistra: veistra @ None,
            ..
        } = &mut item.kind
        {
            if self.shows.contains(id) {
                *veistra = veistra_call::lift(update);
            }
        }
        let done = matches!(
            item.kind,
            ItemKind::ToolCall {
                status: ToolStatus::Completed | ToolStatus::Failed,
                ..
            }
        );
        if done {
            self.named.remove(id);
        }
        let event = match (started, done) {
            (_, true) => Event::ItemCompleted { item },
            (true, false) => Event::ItemStarted { item },
            (false, false) => Event::ItemUpdated { item },
        };
        if let Event::ItemStarted { item } | Event::ItemUpdated { item } = &event {
            self.tools.insert(id.to_string(), item.clone());
        } else {
            self.shows.remove(id);
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
            .take(MAX_PLAN_ENTRIES)
            .map(|e| PlanEntry {
                content: cut(&text(e, "content"), TITLE_LIMIT).0,
                status: cut(&text(e, "status"), 64).0,
                priority: cut(&text(e, "priority"), 64).0,
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
        ..
    } = kind
    else {
        return;
    };
    if let Some(t) = update.get("title").and_then(Value::as_str) {
        *title = cut(t, TITLE_LIMIT).0;
    }
    if let Some(k) = update.get("kind").and_then(Value::as_str) {
        *tool_kind = cut(k, 64).0;
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
    let mut named = request_paths(update);
    if !named.is_empty() {
        named.truncate(MAX_PATHS);
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
        let mut n = Normalizer::new("s1", Harness::Claude);
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
        let mut n = Normalizer::new("s1", Harness::Claude);
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
        let mut n = Normalizer::new("s1", Harness::Claude);
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
    fn a_tool_call_remembers_every_file_it_named_until_it_completes() {
        let mut n = started();
        n.update(&json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "kind": "edit",
            "content": [{"type": "diff", "path": "/x/moved.rs", "oldText": "a", "newText": "a"}]
        }));
        n.update(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1",
            "locations": [{"path": "/w/a.rs"}],
            "content": [{"type": "content", "content": {"type": "text", "text": "working"}}]
        }));
        assert_eq!(n.tool_paths("t1"), ["/x/moved.rs", "/w/a.rs"]);
        assert!(n.tool_paths("t2").is_empty());
        n.update(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"
        }));
        assert!(n.tool_paths("t1").is_empty());
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

    fn shown(events: &[Event]) -> Option<crate::event::ShowMarker> {
        match events {
            [Event::ItemCompleted { item }] => match &item.kind {
                ItemKind::ToolCall { veistra, .. } => veistra.clone(),
                _ => panic!("{item:?}"),
            },
            _ => panic!("{events:?}"),
        }
    }

    #[test]
    fn a_show_call_carries_its_marker_and_any_other_tool_only_text() {
        let props = json!({"tone": "note", "body": "x".repeat(OUTPUT_LIMIT)});
        let answer = json!({"veistraShow": {"version": 1, "component": "callout", "props": props}});
        let result = |id: &str, status: &str| {
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": id, "status": status,
                "rawOutput": [{"type": "text", "text": answer.to_string()}],
                "content": [{"type": "content", "content": {"type": "text", "text": answer.to_string()}}]
            })
        };
        let start = |id: &str, tool: &str| {
            json!({"sessionUpdate": "tool_call", "toolCallId": id, "status": "pending",
                "title": "mcp__veistra-context__show", "_meta": {"claudeCode": {"toolName": tool}}})
        };
        let mut n = started();
        // Named on the call only, as an adapter may: the result is still lifted.
        n.update(&start("t1", "mcp__veistra-context__show_component"));
        let events = n.update(&result("t1", "completed"));
        let marker = shown(&events).expect("the show call's marker");
        assert_eq!(
            marker.props["body"].as_str().map(str::len),
            Some(OUTPUT_LIMIT)
        );
        let [Event::ItemCompleted { item }] = &events[..] else {
            panic!()
        };
        assert!(matches!(
            &item.kind,
            ItemKind::ToolCall {
                truncated: true,
                ..
            }
        ));

        n.update(&start("t2", "Bash"));
        assert_eq!(shown(&n.update(&result("t2", "completed"))), None);

        // Two calls at once: the other one finishing leaves the show call named.
        n.update(&start("t4", "mcp__veistra-context__show"));
        n.update(&start("t5", "Read"));
        assert_eq!(shown(&n.update(&result("t5", "completed"))), None);
        assert!(shown(&n.update(&result("t4", "completed"))).is_some());
        n.update(&start("t3", "mcp__veistra-context__show"));
        assert_eq!(shown(&n.update(&result("t3", "failed"))), None);
        assert!(n.shows.is_empty(), "a finished call is forgotten");
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
            "_veistra/whatever",
        ] {
            assert!(n.update(&json!({"sessionUpdate": kind})).is_empty());
        }
        assert_eq!(n.dropped(), 3);
    }

    #[test]
    fn a_settings_change_is_reported_once() {
        let mut n = started();
        let events = n.update(&json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{"id": "model", "name": "Model", "type": "select",
                "currentValue": "opus", "options": [{"value": "opus", "name": "Opus"}]}]
        }));
        assert!(events.is_empty(), "nothing is drawn in the transcript");
        let got = n.take_settings().unwrap();
        assert_eq!(got.options[0].value, "opus");
        assert!(n.take_settings().is_none());
        assert_eq!(n.dropped(), 0);
        n.update(&json!({"sessionUpdate": "config_option_update"}));
        assert!(
            n.take_settings().is_none(),
            "an update without a list clears nothing"
        );
    }

    fn ask(input: Value) -> Value {
        json!({
            "toolCall": {"toolCallId": "t9", "title": "Do it", "rawInput": input},
            "options": [
                {"optionId": "a", "kind": "allow_once", "name": "Allow"},
                {"optionId": "b", "kind": "allow_always", "name": "Always allow"},
                {"optionId": "c", "kind": "reject_once", "name": "Reject"}
            ]
        })
    }

    #[test]
    fn allow_always_is_never_offered() {
        let mut n = started();
        let params = ask(json!({"command": "ls -la"}));
        for paths in [Vec::new(), vec!["/w/a.rs".to_string()]] {
            let item = n.approval(&params, paths);
            let ItemKind::Approval {
                options,
                detail,
                detail_truncated,
                ..
            } = &item.kind
            else {
                panic!()
            };
            assert_eq!(detail.as_deref(), Some("ls -la"));
            assert!(!detail_truncated);
            let ids: Vec<_> = options.iter().map(|o| o.option_id.as_str()).collect();
            assert_eq!(
                ids,
                ["a", "c"],
                "a standing allow would switch the path guard off"
            );
        }
    }

    #[test]
    fn an_input_with_no_command_is_shown_whole_when_it_fits() {
        let mut n = started();
        let item = n.approval(&ask(json!({"content": "hello"})), Vec::new());
        let ItemKind::Approval {
            detail,
            detail_truncated,
            ..
        } = &item.kind
        else {
            panic!()
        };
        assert!(detail
            .as_deref()
            .is_some_and(|d| d.contains("\"content\": \"hello\"")));
        assert!(!detail_truncated);
    }

    #[test]
    fn an_approval_detail_over_the_limit_says_it_was_cut() {
        let mut n = started();
        let long = "é".repeat(DETAIL_LIMIT);
        for input in [json!({"command": long}), json!({"content": long})] {
            let item = n.approval(&ask(input), Vec::new());
            let ItemKind::Approval {
                detail,
                detail_truncated,
                ..
            } = &item.kind
            else {
                panic!()
            };
            assert!(*detail_truncated);
            assert!(detail.as_ref().is_some_and(|d| d.len() <= DETAIL_LIMIT));
        }
    }

    #[test]
    fn titles_paths_and_plans_are_capped() {
        let mut n = started();
        let paths: Vec<String> = (0..MAX_PATHS + 10).map(|i| format!("/w/{i}")).collect();
        let mut params = ask(json!({}));
        params["toolCall"]["title"] = json!("t".repeat(TITLE_LIMIT * 2));
        let item = n.approval(&params, paths);
        let ItemKind::Approval { title, paths, .. } = &item.kind else {
            panic!()
        };
        assert_eq!(title.len(), TITLE_LIMIT);
        assert_eq!(paths.len(), MAX_PATHS);

        let entries: Vec<Value> = (0..MAX_PLAN_ENTRIES + 5)
            .map(|_| json!({"content": "s", "status": "pending", "priority": "low"}))
            .collect();
        let events = n.update(&json!({"sessionUpdate": "plan", "entries": entries}));
        let [Event::ItemStarted { item }] = &events[..] else {
            panic!("{events:?}")
        };
        assert!(
            matches!(&item.kind, ItemKind::Plan { entries } if entries.len() == MAX_PLAN_ENTRIES)
        );
    }

    #[test]
    fn open_tool_calls_are_capped() {
        let mut n = started();
        for i in 0..MAX_OPEN_TOOLS + 3 {
            n.update(&json!({
                "sessionUpdate": "tool_call", "toolCallId": format!("t{i}"), "status": "pending"
            }));
        }
        assert_eq!(n.dropped(), 3);
        let known = n.update(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t0", "status": "in_progress"
        }));
        assert!(matches!(&known[..], [Event::ItemUpdated { .. }]));
    }

    #[test]
    fn a_message_past_the_limit_is_cut_once_and_takes_nothing_more() {
        let mut n = started();
        n.update(&chunk(&"a".repeat(TEXT_LIMIT - 4), Some("m1")));
        let over = n.update(&chunk("bcdefgh", Some("m1")));
        let [Event::ItemDelta { text, .. }] = &over[..] else {
            panic!("{over:?}")
        };
        assert_eq!(text, &format!("bcde{CUT_NOTE}"));
        assert!(
            n.update(&chunk("x", Some("m1"))).is_empty(),
            "a later short chunk must not leave a hole in the middle"
        );
        let closed = n.close_text();
        let [Event::ItemCompleted { item }] = &closed[..] else {
            panic!()
        };
        let ItemKind::AssistantText { text } = &item.kind else {
            panic!()
        };
        assert!(text.ends_with(&format!("bcde{CUT_NOTE}")));
        assert!(!text.contains('x'));
        // The next message starts clean.
        let next = n.update(&chunk("fresh", Some("m2")));
        assert!(matches!(&next[..], [Event::ItemStarted { .. }]));
    }

    #[test]
    fn a_first_chunk_over_the_limit_is_cut_and_marked() {
        let mut n = started();
        let events = n.update(&chunk(&"a".repeat(TEXT_LIMIT + 10), Some("m1")));
        let [Event::ItemStarted { item }] = &events[..] else {
            panic!()
        };
        let ItemKind::AssistantText { text } = &item.kind else {
            panic!()
        };
        assert!(text.ends_with(CUT_NOTE));
        assert!(n.update(&chunk("x", Some("m1"))).is_empty());
    }

    #[test]
    fn an_approval_never_offers_a_way_into_auto_or_bypass() {
        let mut n = started();
        let params = json!({
            "toolCall": {"toolCallId": "t9", "title": "Ready to code?"},
            "options": [
                {"optionId": "exit-plan-auto", "kind": "allow_once", "name": "Yes, and use auto mode"},
                {"optionId": "exit-plan-bypass", "kind": "allow_always", "name": "Yes, and bypass"},
                {"optionId": "exit-plan-clear-auto", "kind": "allow_once", "name": "Clear, then auto"},
                {"optionId": "exit-plan-default", "kind": "allow_once", "name": "Yes, manually approve edits"},
                {"optionId": "reject", "kind": "reject_once", "name": "No, keep planning"}
            ]
        });
        let item = n.approval(&params, vec!["/w/plan.md".into()]);
        let ItemKind::Approval { options, .. } = &item.kind else {
            panic!()
        };
        let ids: Vec<_> = options.iter().map(|o| o.option_id.as_str()).collect();
        assert_eq!(ids, ["exit-plan-default", "reject"]);
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

    #[test]
    fn an_error_names_the_harness_that_raised_it() {
        let mut n = Normalizer::new("s2", Harness::Codex);
        let events = n.error("not signed in", Some(Hint::SignedOut));
        assert!(matches!(
            &events[..],
            [Event::ItemCompleted {
                item: Item {
                    kind: ItemKind::Error {
                        harness: Harness::Codex,
                        hint: Some(Hint::SignedOut),
                        ..
                    },
                    ..
                }
            }]
        ));
    }
}
