//! The `kaava-context` server's show marker, lifted off a tool call's result
//! (docs/design/KAAVA-CONTEXT-REFS.md §5 and §6).
//!
//! The server answers `show` and `show_component` with
//! `{kaavaShow: {version, component, props}, failed?}` for the agent tab to
//! draw. Only the host can tell that answer from text that merely looks like
//! it: the tab sees a title the agent wrote and output cut at
//! [`crate::normalize::OUTPUT_LIMIT`]. So the marker is lifted here, before the
//! cut, and only from a call the harness itself names as one of those tools:
//!
//! - Claude: `_meta.claudeCode.toolName` is `mcp__kaava-context__show` or
//!   `mcp__kaava-context__show_component`.
//! - Codex: `_meta.is_mcp_tool_call` is true, `rawInput.server` is
//!   `kaava-context`, and `rawInput.tool` is `show` or `show_component`.
//!
//! A marker printed by any other tool stays text. The check here is of shape
//! only: the server has held the props to its catalogue, and the tab checks
//! them again against the version it draws.

use serde_json::Value;

use crate::event::{ShowFailure, ShowMarker};

/// The server's name in the session's MCP config.
pub const SERVER: &str = "kaava-context";

/// The server's tools that answer with a marker.
const TOOLS: [&str; 2] = ["show", "show_component"];

/// The most answer text lifted, in bytes. The server holds the props to
/// 64 KB, and `failed` repeats each reference that failed as it was sent, so
/// an answer can come to about twice that. Past this the call stays text.
pub const MARKER_LIMIT: usize = 256 * 1024;

/// Whether a `tool_call` or `tool_call_update` names one of the show tools.
pub fn is_show(update: &Value) -> bool {
    let meta = update.get("_meta");
    let claude = meta
        .and_then(|m| m.get("claudeCode"))
        .and_then(|c| c.get("toolName"))
        .and_then(Value::as_str)
        .and_then(|name| name.strip_prefix("mcp__"))
        .and_then(|name| name.strip_prefix(SERVER))
        .and_then(|name| name.strip_prefix("__"))
        .is_some_and(|tool| TOOLS.contains(&tool));
    let codex = meta.and_then(|m| m.get("is_mcp_tool_call")) == Some(&Value::Bool(true))
        && update.get("rawInput").is_some_and(|input| {
            input.get("server").and_then(Value::as_str) == Some(SERVER)
                && input
                    .get("tool")
                    .and_then(Value::as_str)
                    .is_some_and(|tool| TOOLS.contains(&tool))
        });
    claude || codex
}

/// The marker in a show call's result, or `None` when it holds none: the
/// server refused the call, or the answer is over [`MARKER_LIMIT`].
///
/// Each candidate is one whole text the server sent, never a string found
/// inside one, so a marker the agent wrote into a prop is never lifted.
pub fn lift(update: &Value) -> Option<ShowMarker> {
    let mut texts = Vec::new();
    if let Some(raw) = update.get("rawOutput") {
        result_texts(raw, true, &mut texts);
    }
    let blocks = update.get("content").and_then(Value::as_array);
    for block in blocks.into_iter().flatten() {
        if let Some(text) = block.get("content").and_then(|c| c.get("text")) {
            texts.extend(text.as_str().map(unfence));
        }
    }
    texts.into_iter().find_map(marker_in)
}

/// The texts of an MCP tool result: a string, a list of content blocks, or a
/// `CallToolResult` with its `content`, once wrapped in `result`.
fn result_texts<'a>(raw: &'a Value, unwrap: bool, out: &mut Vec<&'a str>) {
    match raw {
        Value::String(text) => out.push(text),
        Value::Array(blocks) => out.extend(
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str)),
        ),
        Value::Object(map) => {
            if let Some(content) = map.get("content").filter(|c| c.is_array()) {
                result_texts(content, false, out);
            }
            if let Some(result) = map.get("result").filter(|_| unwrap) {
                result_texts(result, false, out);
            }
        }
        _ => {}
    }
}

/// The text inside a fence of three or more backticks, which the Claude
/// adapter puts around a tool's text output; any other text as it is.
fn unfence(text: &str) -> &str {
    let text = text.trim();
    let ticks = text.len() - text.trim_start_matches('`').len();
    if ticks < 3 || !text.ends_with(&text[..ticks]) || text.len() < 2 * ticks {
        return text;
    }
    let inner = &text[ticks..text.len() - ticks];
    match inner.split_once('\n') {
        Some((_, body)) => body.trim(),
        None => text,
    }
}

fn marker_in(text: &str) -> Option<ShowMarker> {
    let text = text.trim();
    if text.len() > MARKER_LIMIT || !text.starts_with('{') || !text.contains("\"kaavaShow\"") {
        return None;
    }
    let answer: Value = serde_json::from_str(text).ok()?;
    let show = answer.get("kaavaShow")?;
    let failed = answer.get("failed").and_then(Value::as_array);
    Some(ShowMarker {
        version: u32::try_from(show.get("version")?.as_u64()?).ok()?,
        component: show.get("component")?.as_str()?.to_string(),
        props: show.get("props").filter(|p| p.is_object())?.clone(),
        failed: failed.into_iter().flatten().filter_map(failure).collect(),
    })
}

fn failure(entry: &Value) -> Option<ShowFailure> {
    let text = |key| entry.get(key).and_then(Value::as_str).map(str::to_string);
    Some(ShowFailure {
        uri: text("uri")?,
        reason: text("reason").unwrap_or_default(),
        message: text("message").unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answer() -> String {
        json!({
            "kaavaShow": {"version": 1, "component": "callout",
                "props": {"tone": "note", "body": "b", "refs": []}},
            "failed": [{"uri": "kaava://file/gone", "reason": "missing", "message": "no such file"},
                {"reason": "missing"}]
        })
        .to_string()
    }

    #[test]
    fn only_the_two_show_tools_of_the_context_server_are_named() {
        let claude = |name: &str| json!({"_meta": {"claudeCode": {"toolName": name}}});
        assert!(is_show(&claude("mcp__kaava-context__show")));
        assert!(is_show(&claude("mcp__kaava-context__show_component")));
        for other in [
            "mcp__kaava-context__read",
            "mcp__kaava-contextx__show",
            "mcp__other__show",
            "Bash",
            "show",
        ] {
            assert!(!is_show(&claude(other)), "{other}");
        }
        let codex = |flag: bool, server: &str, tool: &str| {
            json!({"_meta": {"is_mcp_tool_call": flag},
                "rawInput": {"server": server, "tool": tool, "arguments": {}}})
        };
        assert!(is_show(&codex(true, "kaava-context", "show_component")));
        assert!(!is_show(&codex(false, "kaava-context", "show")));
        assert!(!is_show(&codex(true, "other", "show")));
        assert!(!is_show(&codex(true, "kaava-context", "search_context")));
        // A title is the agent's own words, so it names nothing.
        assert!(!is_show(&json!({"title": "mcp__kaava-context__show"})));
    }

    #[test]
    fn the_marker_is_lifted_from_the_raw_result_or_the_fenced_text() {
        let raw = lift(&json!({"rawOutput": [{"type": "text", "text": answer()}]})).unwrap();
        assert_eq!((raw.version, raw.component.as_str()), (1, "callout"));
        assert_eq!(raw.props["body"], "b");
        assert_eq!(raw.failed.len(), 1, "an entry with no uri is dropped");
        assert_eq!(raw.failed[0].reason, "missing");

        let fenced = format!("````\n{}\n````", answer());
        let content = json!({"content": [{"type": "content",
            "content": {"type": "text", "text": fenced}}]});
        assert_eq!(lift(&content), Some(raw.clone()));
        let wrapped =
            json!({"rawOutput": {"result": {"content": [{"type": "text", "text": answer()}]}}});
        assert_eq!(lift(&wrapped), Some(raw.clone()));
        assert_eq!(lift(&json!({"rawOutput": answer()})), Some(raw));
    }

    #[test]
    fn a_marker_inside_a_prop_or_past_the_limit_stays_text() {
        let inner = json!({"kaavaShow": {"version": 1, "component": "choice", "props": {}}});
        let echoed = json!({"rawOutput": {"arguments": {"body": inner.to_string()}}});
        assert_eq!(lift(&echoed), None, "only a result's own texts are read");
        let quoted = json!({"rawOutput": format!("here: {inner}")});
        assert_eq!(
            lift(&quoted),
            None,
            "a text that is not the answer whole is not one"
        );
        let big = "x".repeat(MARKER_LIMIT);
        let over = json!({"kaavaShow": {"version": 1, "component": "callout",
            "props": {"tone": "note", "body": big}}});
        assert_eq!(lift(&json!({"rawOutput": over.to_string()})), None);
    }

    #[test]
    fn a_marker_out_of_shape_is_not_lifted() {
        for show in [
            json!({"version": "1", "component": "callout", "props": {}}),
            json!({"version": 1, "component": 7, "props": {}}),
            json!({"version": 1, "component": "callout", "props": []}),
            json!({"version": 1, "component": "callout"}),
            json!({"version": -1, "component": "callout", "props": {}}),
        ] {
            let text = json!({ "kaavaShow": show }).to_string();
            assert_eq!(lift(&json!({ "rawOutput": text })), None, "{show}");
        }
        assert_eq!(lift(&json!({"rawOutput": "{\"kaavaShow\": "})), None);
    }

    #[test]
    fn a_fence_is_taken_off_only_when_it_closes() {
        assert_eq!(unfence("```json\n{}\n```"), "{}");
        assert_eq!(unfence("  ```\n{}\n```  "), "{}");
        assert_eq!(unfence("```\n{}"), "```\n{}");
        assert_eq!(unfence("``x``"), "``x``");
        assert_eq!(unfence("```"), "```");
        assert_eq!(unfence("{}"), "{}");
    }
}
