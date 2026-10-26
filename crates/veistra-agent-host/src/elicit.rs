//! ACP's form `elicitation/create`, read into a question card and answered
//! from the user's replies.
//!
//! Every harness asks the user a question this way, once the client declares
//! `elicitation.form` at `initialize` (see `session::hello`):
//!
//! - Claude's adapter turns the AskUserQuestion tool into a form with one
//!   `question_<n>` field per question, a `oneOf` string or an `anyOf` array,
//!   and beside each a `question_<n>_custom` string titled "Other". Without
//!   the declaration it disallows the tool, so Claude cannot ask at all.
//! - Codex's adapter turns `request_user_input` into one field per question,
//!   keyed by the question's id, the question in `title` and the header in
//!   `description`, with a `user_note` field beside any question that takes a
//!   typed answer. It lists every question in `required`, in order.
//! - Either adapter forwards an MCP server's own form elicitation unchanged.
//!
//! The schema arrives as a JSON object, whose keys `serde_json` sorts, so the
//! questions are put back in order from `required`, then by the number in
//! their key.

use std::cmp::Ordering;

use serde_json::{json, Map, Value};

use crate::event::{Question, QuestionChoice, QuestionOutcome, QuestionReply};
use crate::host::HostError;

/// The most questions one card holds; the rest are not asked.
pub const MAX_QUESTIONS: usize = 20;

/// The most choices one question offers.
pub const MAX_CHOICES: usize = 50;

/// The longest message, question or label kept, in bytes.
const TEXT_LIMIT: usize = 4 * 1024;

/// The longest typed answer sent back, in bytes.
const ANSWER_LIMIT: usize = 16 * 1024;

/// What the host needs to answer a form: one entry per question, in the
/// card's order.
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq)]
struct Field {
    key: String,
    /// The field the typed answer goes in, when it is not `key` itself.
    other_key: Option<String>,
    multi: bool,
    kind: Kind,
    choices: Vec<String>,
}

/// What a field's value is on the wire.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Number,
    Integer,
    Boolean,
}

/// What a form elicitation shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    /// The agent's line.
    pub message: String,
    /// The tool call it is about, if named.
    pub tool_call_id: Option<String>,
    /// The questions, in order.
    pub questions: Vec<Question>,
}

/// Read an `elicitation/create`'s params. `None` for anything but form mode:
/// a URL elicitation is not declared, so it is declined.
pub fn read(params: &Value) -> Option<(Card, Form)> {
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return None;
    }
    let schema = params.get("requestedSchema").unwrap_or(&Value::Null);
    let empty = Map::new();
    let props = schema
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let companions = companions(props);
    let mut keys: Vec<&String> = props
        .keys()
        .filter(|k| !companions.iter().any(|(c, _)| c == *k))
        .collect();
    keys.sort_by(|a, b| natural(a, b));
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let rank = |k: &str| required.iter().position(|r| *r == k).unwrap_or(usize::MAX);
    keys.sort_by_key(|k| rank(k));

    let mut questions = Vec::new();
    let mut fields = Vec::new();
    for key in keys.into_iter().take(MAX_QUESTIONS) {
        let prop = &props[key];
        let other_key = companions
            .iter()
            .find(|(_, q)| q == key)
            .map(|(c, _)| c.clone());
        let (question, field) = question(key, prop, other_key);
        questions.push(question);
        fields.push(field);
    }
    let card = Card {
        message: cut(params.get("message").and_then(Value::as_str).unwrap_or("")),
        tool_call_id: params
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        questions,
    };
    Some((card, Form { fields }))
}

/// Each typed-answer field and the question it belongs to: Codex marks its
/// own, and Claude's is the question's key plus `_custom`.
fn companions(props: &Map<String, Value>) -> Vec<(String, String)> {
    props
        .iter()
        .filter_map(|(key, prop)| {
            let codex = prop.pointer("/_meta/codex");
            let noted = codex
                .filter(|c| c.get("role").and_then(Value::as_str) == Some("user_note"))
                .and_then(|c| c.get("questionId"))
                .and_then(Value::as_str)
                .filter(|q| props.contains_key(*q));
            if let Some(question) = noted {
                return Some((key.clone(), question.to_string()));
            }
            let base = key.strip_suffix("_custom")?;
            let target = props.get(base)?;
            (is_text(prop) && !choices_of(target).is_empty())
                .then(|| (key.clone(), base.to_string()))
        })
        .collect()
}

fn is_text(prop: &Value) -> bool {
    prop.get("type").and_then(Value::as_str) == Some("string") && choices_of(prop).is_empty()
}

fn question(key: &str, prop: &Value, other_key: Option<String>) -> (Question, Field) {
    let ty = prop.get("type").and_then(Value::as_str).unwrap_or("string");
    let multi = ty == "array";
    let kind = match ty {
        "number" => Kind::Number,
        "integer" => Kind::Integer,
        "boolean" => Kind::Boolean,
        _ => Kind::Text,
    };
    let mut choices = choices_of(prop);
    if kind == Kind::Boolean {
        choices = vec![choice("true", "Yes", None), choice("false", "No", None)];
    }
    choices.truncate(MAX_CHOICES);
    let title = string(prop, "title");
    let description = string(prop, "description");
    // Codex puts the question in the title and the header in the description.
    let (header, text) = if prop.pointer("/_meta/codex").is_some() {
        (description, title)
    } else {
        (title, description)
    };
    let other = other_key.is_some() || choices.is_empty();
    let field = Field {
        key: key.to_string(),
        other_key,
        multi,
        kind,
        choices: choices.iter().map(|c| c.value.clone()).collect(),
    };
    let question = Question {
        id: key.to_string(),
        header,
        text,
        choices,
        multi,
        other,
    };
    (question, field)
}

/// A field's choices: titled `oneOf` or `anyOf` entries, or a plain `enum`,
/// on the field itself or, for an array, on its items.
fn choices_of(prop: &Value) -> Vec<QuestionChoice> {
    let holder = match prop.get("items") {
        Some(items) if prop.get("type").and_then(Value::as_str) == Some("array") => items,
        _ => prop,
    };
    let titled = holder
        .get("oneOf")
        .or_else(|| holder.get("anyOf"))
        .and_then(Value::as_array);
    if let Some(entries) = titled {
        return entries
            .iter()
            .filter_map(|e| {
                let value = e.get("const")?.as_str()?;
                let label = string(e, "title").unwrap_or_else(|| value.to_string());
                Some(choice(value, &label, string(e, "description")))
            })
            .collect();
    }
    let names = holder.get("enumNames").and_then(Value::as_array);
    holder
        .get("enum")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, v)| {
            let value = v.as_str()?;
            let label = names
                .and_then(|n| n.get(i))
                .and_then(Value::as_str)
                .unwrap_or(value);
            Some(choice(value, label, None))
        })
        .collect()
}

fn choice(value: &str, label: &str, description: Option<String>) -> QuestionChoice {
    QuestionChoice {
        value: value.to_string(),
        label: cut(label),
        description,
    }
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(cut)
}

fn cut(s: &str) -> String {
    cut_to(s, TEXT_LIMIT)
}

fn cut_to(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut end = limit;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Compare keys with their digit runs as numbers, so `question_2` comes
/// before `question_10`.
fn natural(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a, b);
    loop {
        match (a.is_empty(), b.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        let (ra, rest_a) = run(a);
        let (rb, rest_b) = run(b);
        let order = match (ra.parse::<u64>(), rb.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y).then(ra.len().cmp(&rb.len())),
            _ => ra.cmp(rb),
        };
        if order != Ordering::Equal {
            return order;
        }
        a = rest_a;
        b = rest_b;
    }
}

/// The leading run of digits, or of anything else, and the rest.
fn run(s: &str) -> (&str, &str) {
    let digits = s.starts_with(|c: char| c.is_ascii_digit());
    let end = s
        .find(|c: char| c.is_ascii_digit() != digits)
        .unwrap_or(s.len());
    s.split_at(end)
}

impl Form {
    /// The `elicitation/create` result for `outcome`. A pick the form did not
    /// offer, or a typed answer it cannot take, is refused, and nothing is sent.
    pub fn response(&self, outcome: &QuestionOutcome) -> Result<Value, HostError> {
        let replies = match outcome {
            QuestionOutcome::Skipped => return Ok(json!({ "action": "decline" })),
            QuestionOutcome::Cancelled => return Ok(json!({ "action": "cancel" })),
            QuestionOutcome::Answered { replies } => replies,
        };
        if replies.len() > self.fields.len() {
            return Err(HostError::UnknownOption);
        }
        let mut content = Map::new();
        let none = QuestionReply::default();
        for (i, field) in self.fields.iter().enumerate() {
            let reply = replies.get(i).unwrap_or(&none);
            field.fill(reply, &mut content)?;
        }
        Ok(json!({ "action": "accept", "content": content }))
    }
}

impl Field {
    fn fill(
        &self,
        reply: &QuestionReply,
        content: &mut Map<String, Value>,
    ) -> Result<(), HostError> {
        if reply.picks.iter().any(|p| !self.choices.contains(p)) {
            return Err(HostError::UnknownOption);
        }
        if !self.multi && reply.picks.len() > 1 {
            return Err(HostError::UnknownOption);
        }
        let other = reply
            .other
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| cut_to(t, ANSWER_LIMIT));
        if self.multi {
            if !reply.picks.is_empty() {
                content.insert(self.key.clone(), json!(reply.picks));
            }
        } else if let Some(pick) = reply.picks.first() {
            content.insert(self.key.clone(), self.value(pick)?);
        }
        let Some(other) = other else {
            return Ok(());
        };
        match &self.other_key {
            Some(key) => {
                content.insert(key.clone(), Value::String(other));
            }
            // A free-text question takes the typed answer as its own value.
            None if self.choices.is_empty() && !self.multi && reply.picks.is_empty() => {
                content.insert(self.key.clone(), self.value(&other)?);
            }
            None => return Err(HostError::UnknownOption),
        }
        Ok(())
    }

    /// `text` as this field's wire type.
    fn value(&self, text: &str) -> Result<Value, HostError> {
        match self.kind {
            Kind::Text => Ok(Value::String(text.to_string())),
            Kind::Boolean => match text {
                "true" => Ok(Value::Bool(true)),
                "false" => Ok(Value::Bool(false)),
                _ => Err(HostError::UnknownOption),
            },
            Kind::Integer => text
                .trim()
                .parse::<i64>()
                .map(Value::from)
                .map_err(|_| HostError::UnknownOption),
            Kind::Number => text
                .trim()
                .parse::<f64>()
                .ok()
                .and_then(|n| serde_json::Number::from_f64(n).map(Value::Number))
                .ok_or(HostError::UnknownOption),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What claude-agent-acp 0.90.0 sends for AskUserQuestion
    /// (`askUserQuestionsToCreateRequest` in its `elicitation.js`).
    fn claude() -> Value {
        json!({
            "sessionId": "s", "toolCallId": "toolu_1", "mode": "form",
            "message": "Please answer the following questions.",
            "requestedSchema": { "type": "object", "properties": {
                "question_0": { "type": "string", "title": "Grapple",
                    "description": "How should the grapple let go?",
                    "oneOf": [
                        { "const": "On button release", "title": "On button release" },
                        { "const": "At the top of the swing", "title": "At the top of the swing",
                          "description": "Feels floaty" },
                        { "const": "Both, test each", "title": "Both, test each" }
                    ] },
                "question_0_custom": { "type": "string", "title": "Other" },
                "question_1": { "type": "array", "title": "Targets", "description": "Which surfaces?",
                    "items": { "anyOf": [
                        { "const": "Wood", "title": "Wood" }, { "const": "Stone", "title": "Stone" }
                    ] } },
                "question_1_custom": { "type": "string", "title": "Other" },
                "question_10": { "type": "string", "oneOf": [{ "const": "x", "title": "x" }] }
            } }
        })
    }

    /// What codex-acp 2.2.2 sends for `request_user_input`
    /// (`buildUserInputRequest` in its `CodexElicitationHandler.ts`).
    fn codex() -> Value {
        json!({
            "sessionId": "t", "toolCallId": "item_1", "mode": "form",
            "message": "Codex needs your input to continue.",
            "requestedSchema": { "type": "object", "required": ["zeta", "alpha"], "properties": {
                "zeta": { "type": "string", "title": "Which database?", "description": "Storage",
                    "_meta": { "codex": { "isOther": true, "isSecret": false } },
                    "oneOf": [
                        { "const": "Postgres", "title": "Postgres" },
                        { "const": "None of the above", "title": "None of the above" }
                    ] },
                "zeta_note": { "type": "string", "title": "Additional answer or note",
                    "_meta": { "codex": { "questionId": "zeta", "role": "user_note" } } },
                "alpha": { "type": "string", "title": "Project name?",
                    "_meta": { "codex": { "isOther": false, "isSecret": false } } }
            } }
        })
    }

    #[test]
    fn claudes_questions_keep_their_order_and_their_other_box() {
        let (card, _) = read(&claude()).unwrap();
        let ids: Vec<&str> = card.questions.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(ids, ["question_0", "question_1", "question_10"]);
        let first = &card.questions[0];
        assert_eq!(first.header.as_deref(), Some("Grapple"));
        assert_eq!(
            first.text.as_deref(),
            Some("How should the grapple let go?")
        );
        assert_eq!(first.choices.len(), 3);
        assert_eq!(
            first.choices[1].description.as_deref(),
            Some("Feels floaty")
        );
        assert!(first.other && !first.multi);
        assert!(card.questions[1].multi && card.questions[1].other);
        assert!(!card.questions[2].other, "no companion, no typed answer");
        assert_eq!(card.tool_call_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn codex_questions_follow_required_and_read_title_as_the_question() {
        let (card, _) = read(&codex()).unwrap();
        let ids: Vec<&str> = card.questions.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(ids, ["zeta", "alpha"]);
        assert_eq!(card.questions[0].text.as_deref(), Some("Which database?"));
        assert_eq!(card.questions[0].header.as_deref(), Some("Storage"));
        assert!(card.questions[0].other);
        assert!(card.questions[1].choices.is_empty() && card.questions[1].other);
    }

    #[test]
    fn a_pick_and_a_typed_answer_go_in_the_fields_the_adapter_reads() {
        let (_, form) = read(&claude()).unwrap();
        let outcome = QuestionOutcome::Answered {
            replies: vec![
                QuestionReply {
                    picks: vec!["At the top of the swing".into()],
                    other: None,
                },
                QuestionReply {
                    picks: vec!["Wood".into(), "Stone".into()],
                    other: Some(" Glass ".into()),
                },
            ],
        };
        assert_eq!(
            form.response(&outcome).unwrap(),
            json!({ "action": "accept", "content": {
                "question_0": "At the top of the swing",
                "question_1": ["Wood", "Stone"],
                "question_1_custom": "Glass"
            } })
        );
        let typed = QuestionOutcome::Answered {
            replies: vec![QuestionReply {
                picks: vec![],
                other: Some("Never".into()),
            }],
        };
        assert_eq!(
            form.response(&typed).unwrap(),
            json!({ "action": "accept", "content": { "question_0_custom": "Never" } })
        );
    }

    #[test]
    fn codex_free_text_and_notes_reach_their_fields() {
        let (_, form) = read(&codex()).unwrap();
        let outcome = QuestionOutcome::Answered {
            replies: vec![
                QuestionReply {
                    picks: vec![],
                    other: Some("SQLite".into()),
                },
                QuestionReply {
                    picks: vec![],
                    other: Some("veistra".into()),
                },
            ],
        };
        assert_eq!(
            form.response(&outcome).unwrap(),
            json!({ "action": "accept", "content": { "zeta_note": "SQLite", "alpha": "veistra" } })
        );
    }

    #[test]
    fn a_pick_the_form_did_not_offer_is_refused() {
        let (_, form) = read(&claude()).unwrap();
        let bad = |replies| form.response(&QuestionOutcome::Answered { replies });
        assert!(bad(vec![QuestionReply {
            picks: vec!["Teleport".into()],
            other: None
        }])
        .is_err());
        assert!(
            bad(vec![QuestionReply {
                picks: vec!["On button release".into(), "Both, test each".into()],
                other: None
            }])
            .is_err(),
            "one pick for a single-select"
        );
        let typed_without_a_box = vec![
            QuestionReply::default(),
            QuestionReply::default(),
            QuestionReply {
                picks: vec![],
                other: Some("y".into()),
            },
        ];
        assert!(bad(typed_without_a_box).is_err());
    }

    #[test]
    fn skip_declines_and_cancel_cancels() {
        let (_, form) = read(&claude()).unwrap();
        assert_eq!(
            form.response(&QuestionOutcome::Skipped).unwrap(),
            json!({ "action": "decline" })
        );
        assert_eq!(
            form.response(&QuestionOutcome::Cancelled).unwrap(),
            json!({ "action": "cancel" })
        );
    }

    #[test]
    fn typed_values_take_the_fields_wire_type() {
        let params = json!({ "mode": "form", "message": "m", "requestedSchema": { "properties": {
            "a": { "type": "integer" }, "b": { "type": "boolean" }
        } } });
        let (card, form) = read(&params).unwrap();
        assert_eq!(card.questions[1].choices.len(), 2);
        let outcome = QuestionOutcome::Answered {
            replies: vec![
                QuestionReply {
                    picks: vec![],
                    other: Some("42".into()),
                },
                QuestionReply {
                    picks: vec!["false".into()],
                    other: None,
                },
            ],
        };
        assert_eq!(
            form.response(&outcome).unwrap(),
            json!({ "action": "accept", "content": { "a": 42, "b": false } })
        );
    }

    #[test]
    fn only_form_mode_is_read() {
        assert!(read(&json!({ "mode": "url", "url": "https://x", "message": "m" })).is_none());
    }
}
