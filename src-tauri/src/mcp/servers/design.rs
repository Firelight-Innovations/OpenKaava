//! The comments somebody left on a running page, for the agent that has to act
//! on them.
//!
//! [`servers`](super)'s rule is that a server answers what no harness could
//! answer for itself. A sentence a person typed against one `<button>` in a
//! page they had open ten seconds ago is in no file, in no commit and in no
//! terminal; it is in `design_comments`, and this is how it gets out.
//!
//! **This server writes, and is not `dev_only`.** `mcp::handoff` says the token
//! in a file is only a reasonable trade while the served surface is read-only,
//! so this reopens that decision rather than inheriting it. Both halves of the
//! argument — what a leaked token can reach here, and why gating this behind
//! developer mode would serve the people who least need it — are in
//! `docs/design-notes/design-comments.md`.

use crate::design_comments::{Author, Comment, Comments, Status};
use crate::mcp::{McpServer, McpTool, ToolAnswer};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INVALID_PARAMS};

pub static SERVER: McpServer = McpServer {
    id: "design",
    name: "Design",
    description: "Read the comments left on elements of a running page in Design Mode, and \
                  answer, question or resolve them.",
    tools: TOOLS,
    // Not developer-only, and it does write. See the module doc for why those
    // two facts sit together here and not in `ui`.
    dev_only: false,
    call,
};

/// The longest request text `list_comments` prints per row.
///
/// A digest, not the record. Somebody who pastes three paragraphs into one
/// comment should not push the other nine off the end of a model's attention;
/// `read_comment` is one call away and answers in full.
const REQUEST_DIGEST: usize = 400;

static TOOLS: &[McpTool] = &[
    McpTool {
        name: "list_comments",
        description: "Every comment left on a page in Design Mode that is still outstanding: its \
                      id, which page and element it is against, what was asked for, and whose \
                      turn it is. Start here — the ids from this list are what the other tools \
                      take.",
        schema: list_schema,
    },
    McpTool {
        name: "read_comment",
        description: "One comment in full: the whole thread, and the element's markup, computed \
                      styles, attributes and box as they were when it was picked. Call this \
                      before changing code — the list deliberately omits all of it.",
        schema: id_schema,
    },
    McpTool {
        name: "comment_screenshot",
        description: "A PNG of the element this comment is about, cropped to it, taken when the \
                      comment was left. Answers what something looked like, which the markup \
                      does not.",
        schema: id_schema,
    },
    McpTool {
        name: "resolve_comment",
        description: "Mark a comment done, saying what was changed. The note is required and is \
                      shown to the person who wrote the comment — it is the only thing telling \
                      them what happened.",
        schema: resolve_schema,
    },
    McpTool {
        name: "ask_comment",
        description: "Ask the person a question about their comment instead of guessing. Moves \
                      it to `question` and waits: their answer arrives on the thread and puts it \
                      back to `open`.",
        schema: ask_schema,
    },
];

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "page": {
                "type": "string",
                "description": "Only comments on pages whose URL contains this. Use it when \
                                several pages are under review at once.",
            },
            "includeResolved": {
                "type": "boolean",
                "description": "Also list comments that are already done. Off by default — \
                                resolved comments are history, not work.",
            },
        },
        "additionalProperties": false,
    })
}

fn id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "id": id_property() },
        "required": ["id"],
        "additionalProperties": false,
    })
}

fn resolve_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": id_property(),
            "note": {
                "type": "string",
                "description": "What you changed, in a sentence or two. Shown to the person who \
                                left the comment.",
            },
        },
        "required": ["id", "note"],
        "additionalProperties": false,
    })
}

fn ask_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": id_property(),
            "question": {
                "type": "string",
                "description": "What you need to know before you can make the change.",
            },
        },
        "required": ["id", "question"],
        "additionalProperties": false,
    })
}

fn id_property() -> Value {
    json!({
        "type": "string",
        "description": "A comment id from `list_comments`, like `c7`.",
    })
}

/// An unknown tool cannot arrive here — `Registry::call` checks the name against
/// `TOOLS` first — so the final arm is a genuine impossibility rather than a
/// second copy of that error message.
fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    let params = params.unwrap_or(Value::Null);

    match tool {
        "list_comments" => Ok(list(app, &params).into()),
        "read_comment" => read(app, &params).map(Into::into),
        "comment_screenshot" => screenshot(app, &params),
        "resolve_comment" => {
            let note = text(&params, "note")?;
            speak(app, &params, Author::Agent, &note, Status::Resolved).map(Into::into)
        }
        "ask_comment" => {
            let question = text(&params, "question")?;
            speak(app, &params, Author::Agent, &question, Status::Question).map(Into::into)
        }
        other => Err(RpcError::new(
            veistra_rpc::METHOD_NOT_FOUND,
            format!("the design server has no tool named `{other}`"),
        )),
    }
}

/// A required non-empty string parameter, or `None` if it is missing or blank.
fn some(params: &Value, field: &str) -> Option<String> {
    let value = params
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();

    (!value.is_empty()).then(|| value.to_string())
}

/// The `note` or the `question`, refused when it says nothing.
///
/// Blank is refused rather than accepted because each of these is the entire
/// message to a person: a resolution with no note tells them nothing was
/// recorded about a change that did happen.
fn text(params: &Value, field: &str) -> Result<String, RpcError> {
    some(params, field).ok_or_else(|| {
        RpcError::new(
            INVALID_PARAMS,
            format!(
                "`{field}` has to say something — it is what the person who left this comment \
                 will read"
            ),
        )
    })
}

fn id(params: &Value) -> Result<String, RpcError> {
    some(params, "id").ok_or_else(|| {
        RpcError::new(
            INVALID_PARAMS,
            "this tool needs a comment id — `list_comments` has the current ones",
        )
    })
}

/// What is outstanding, in one row each.
fn list(app: &AppHandle, params: &Value) -> Value {
    let filter = params.get("page").and_then(Value::as_str);
    let resolved_too = params
        .get("includeResolved")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let comments: Vec<Value> = app
        .state::<Comments>()
        .all()
        .iter()
        .filter(|c| resolved_too || c.status.active())
        .filter(|c| filter.is_none_or(|needle| c.page.url.contains(needle)))
        .map(digest)
        .collect();

    json!({
        "comments": comments,
        // Said out loud because an empty list is ambiguous, and the reading a
        // model reaches for — "there is nothing to do" — is right only half the
        // time. The other half is that nobody has left one yet.
        "covers": "Comments left in Design Mode on this machine. An empty list means none are \
                   outstanding, not that the page is fine.",
    })
}

/// One row: enough to decide whether to open it, and no markup at all.
fn digest(comment: &Comment) -> Value {
    let last = comment.thread.last();

    json!({
        "id": comment.id,
        "status": comment.status,
        "page": comment.page.url,
        "element": comment.element.selector,
        "request": clip(&comment.request, REQUEST_DIGEST),
        "replies": comment.thread.len(),
        "lastSaid": last.map(|r| json!({ "author": r.author, "text": clip(&r.text, REQUEST_DIGEST) })),
        "hasScreenshot": comment.has_shot,
    })
}

/// Cut a string to `limit` characters, saying so when anything was cut.
///
/// Counts `char`s rather than bytes, which matters because a cut through a
/// multi-byte character would panic on the slice rather than shorten anything.
fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }

    let kept: String = text.chars().take(limit).collect();
    format!("{kept}… (truncated — read_comment has the whole thing)")
}

/// The whole record, including everything the digest left out.
fn read(app: &AppHandle, params: &Value) -> Result<Value, RpcError> {
    let id = id(params)?;
    Ok(full(&find(app, &id)?))
}

/// One comment, spelled out. Split from [`read`] so the shape can be asserted
/// without an `AppHandle`, which a unit test cannot build.
fn full(comment: &Comment) -> Value {
    let element = &comment.element;

    json!({
        "id": comment.id,
        "status": comment.status,
        "page": comment.page,
        "request": comment.request,
        "thread": comment.thread,
        "created": comment.created,
        "updated": comment.updated,
        "hasScreenshot": comment.has_shot,
        "element": {
            "tag": element.tag,
            "selector": element.selector,
            "inside": element.ancestors,
            "text": element.text,
            "html": element.html,
            "attributes": element.attributes,
            "styles": element.styles,
            "box": element.rect,
        },
    })
}

/// The picture, as MCP's own image content rather than as a base64 string in a
/// JSON field. A screenshot spelled as characters is not a screenshot as far as
/// a client is concerned — see [`ToolAnswer`].
fn screenshot(app: &AppHandle, params: &Value) -> Result<ToolAnswer, RpcError> {
    let id = id(params)?;
    let comment = find(app, &id)?;

    let png = crate::design_comments::read_shot(app, &comment.id).ok_or_else(|| {
        RpcError::new(
            INVALID_PARAMS,
            format!(
                "`{}` has no screenshot — the window was not in front when it was left, or the \
                 element had no area on screen. Its markup and styles are in `read_comment`.",
                comment.id
            ),
        )
    })?;

    Ok(ToolAnswer::Image {
        mime: "image/png".to_string(),
        data: BASE64.encode(png),
    })
}

/// Add the agent's turn to a thread and report where that left the comment.
fn speak(
    app: &AppHandle,
    params: &Value,
    author: Author,
    said: &str,
    status: Status,
) -> Result<Value, RpcError> {
    let id = id(params)?;

    let comment = app
        .state::<Comments>()
        .say(app, &id, author, said, status)
        .ok_or_else(|| unknown(&id))?;

    Ok(json!({
        "id": comment.id,
        "status": comment.status,
        // Echoed back so the model can see its own turn landed, rather than
        // inferring it from an empty success.
        "thread": comment.thread,
    }))
}

fn find(app: &AppHandle, id: &str) -> Result<Comment, RpcError> {
    app.state::<Comments>().get(id).ok_or_else(|| unknown(id))
}

/// One message for every miss, naming the tool that lists valid ids. A model
/// that guessed an id needs to be told where real ones come from, not that this
/// one was absent.
fn unknown(id: &str) -> RpcError {
    RpcError::new(
        INVALID_PARAMS,
        format!("no comment with id `{id}` — `list_comments` has the current ids"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design_comments::{Element, Page, Remark};

    fn comment() -> Comment {
        Comment {
            id: "c7".to_string(),
            status: Status::Open,
            page: Page {
                url: "http://localhost:5173/settings".to_string(),
                title: "Settings".to_string(),
            },
            element: Element {
                tag: "button".to_string(),
                selector: ".cta".to_string(),
                html: "<button class=\"cta\">Save</button>".to_string(),
                ..Element::default()
            },
            request: "make this bigger".to_string(),
            thread: vec![Remark {
                author: Author::Agent,
                text: "how much bigger?".to_string(),
                at: 1,
            }],
            created: 1,
            updated: 2,
            has_shot: true,
        }
    }

    #[test]
    fn the_server_declares_the_five_comment_tools() {
        let names: Vec<&str> = SERVER.tools.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            vec![
                "list_comments",
                "read_comment",
                "comment_screenshot",
                "resolve_comment",
                "ask_comment",
            ]
        );
    }

    /// The listener hands `rmcp` a map for `inputSchema`, so a schema that were
    /// an array or a string would have nowhere to go.
    #[test]
    fn every_schema_is_an_object() {
        for tool in SERVER.tools {
            assert!(
                (tool.schema)().is_object(),
                "schema for {:?} must be a JSON object",
                tool.name
            );
        }
    }

    /// This server writes, so the reason it is still reachable without
    /// developer mode has to be a decision somebody made rather than a default
    /// nobody looked at. See the module doc.
    #[test]
    fn the_comment_server_is_reachable_without_developer_mode() {
        assert!(!SERVER.dev_only);
    }

    /// A row exists to be scanned. Markup in one would push the other comments
    /// out of a model's attention for no gain — `read_comment` is one call away.
    #[test]
    fn a_digest_row_carries_no_markup_and_no_styles() {
        let row = digest(&comment());
        let printed = row.to_string();

        assert_eq!(row["id"], "c7");
        assert_eq!(row["status"], "open");
        assert_eq!(row["element"], ".cta");
        assert_eq!(row["replies"], 1);
        assert_eq!(row["hasScreenshot"], true);
        assert!(!printed.contains("<button"), "the row printed markup");
    }

    /// The last turn is in the row because it is what says whether the ball is
    /// still in the agent's court after a look at one line.
    #[test]
    fn a_digest_row_says_what_was_said_last() {
        let row = digest(&comment());
        assert_eq!(row["lastSaid"]["author"], "agent");
        assert_eq!(row["lastSaid"]["text"], "how much bigger?");
    }

    #[test]
    fn a_comment_nobody_has_answered_has_no_last_word() {
        let mut fresh = comment();
        fresh.thread.clear();
        assert!(digest(&fresh)["lastSaid"].is_null());
    }

    #[test]
    fn a_long_request_is_clipped_and_says_it_was() {
        let long = "x".repeat(REQUEST_DIGEST + 50);
        let clipped = clip(&long, REQUEST_DIGEST);
        assert!(clipped.len() > REQUEST_DIGEST);
        assert!(clipped.contains("read_comment"));

        let short = clip("make this bigger", REQUEST_DIGEST);
        assert_eq!(short, "make this bigger");
    }

    /// A cut through a multi-byte character would panic on the slice rather
    /// than shorten anything, and a comment is prose somebody typed.
    #[test]
    fn clipping_counts_characters_rather_than_bytes() {
        let emoji = "🙂".repeat(10);
        assert_eq!(clip(&emoji, 10), emoji);
        assert!(clip(&emoji, 3).starts_with("🙂🙂🙂…"));
    }

    /// The whole point of `read_comment`: the markup, the thread and the box
    /// the digest deliberately left out.
    #[test]
    fn the_full_record_carries_the_markup_the_row_omitted() {
        let record = full(&comment());

        assert_eq!(record["id"], "c7");
        assert_eq!(record["request"], "make this bigger");
        assert_eq!(record["page"]["title"], "Settings");
        assert_eq!(record["element"]["tag"], "button");
        assert!(record["element"]["html"]
            .as_str()
            .is_some_and(|html| html.contains("<button")));
        assert_eq!(record["thread"][0]["text"], "how much bigger?");
        assert!(record["element"]["box"].is_object());
    }

    /// Both of these fields are the entire message to a person. An empty one is
    /// a resolution that tells them nothing about a change that did happen.
    #[test]
    fn a_note_or_question_that_says_nothing_is_refused() {
        for empty in [json!({ "note": "" }), json!({ "note": "   " }), json!({})] {
            assert!(text(&empty, "note").is_err(), "{empty} should be refused");
        }
        assert_eq!(
            text(&json!({ "note": "  padding halved  " }), "note").ok(),
            Some("padding halved".to_string())
        );
    }

    /// A missing id is a different mistake from a blank note, and gets a
    /// different sentence — the one that says where real ids come from.
    #[test]
    fn a_missing_id_is_refused_in_its_own_words() {
        let complaint = id(&json!({})).expect_err("an id is required").message;
        assert!(complaint.contains("list_comments"));
        assert!(!complaint.contains("will read"));
        assert_eq!(id(&json!({ "id": " c7 " })).ok(), Some("c7".to_string()));
    }

    /// A model that guessed an id needs to be told where real ones come from,
    /// not merely that this one was absent.
    #[test]
    fn an_unknown_id_points_at_the_tool_that_lists_them() {
        let message = unknown("c99").message;
        assert!(message.contains("c99"));
        assert!(message.contains("list_comments"));
    }
}
