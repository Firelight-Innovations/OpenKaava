//! `kaava-context`: references, both ways. The agent finds, reads and shows
//! the person files, canvas frames, comments, screenshots and assets by
//! `kaava://` reference (`docs/design/KAAVA-CONTEXT-REFS.md`), and reads what
//! the person has selected.
//!
//! What earns it a server (see [`super`]): most of what a reference names
//! exists only inside Kaava, such as a frame, a Design Mode comment or the
//! selection, and `show` puts a reference in front of the person, which no
//! file tool does. File references are here so one scheme covers everything;
//! plain files are still better read with the agent's own tools.
//!
//! Every call answers from one cluster: the one named in `cluster`, else the
//! one the person is working in.

use super::{workspace, McpResource};
use crate::apps::CallContext;
use crate::mcp::{Block, McpServer, McpTool, ToolAnswer};
use crate::refs::comments::{self, Wanted};
use crate::refs::fault::{Fault, Reason};
use crate::refs::live::{self, Actor};
use crate::refs::resolve::{Part, Resolved};
use crate::refs::search::{self, Query};
use crate::refs::uri::{self, CanvasPart, Ref};
use crate::shell_state::ShellState;
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

/// The server id: the route `/mcp/context` and the key `kaava-context`.
pub const ID: &str = "context";

/// Most references one `show` puts in front of the person.
const MAX_SHOWN: usize = 8;
/// Longest caption `show` accepts, in characters.
const MAX_CAPTION: usize = 500;
/// The version of the `refs` component's props that `show` writes.
const REFS_VERSION: u32 = 1;
/// Longest note `resolve_comment` writes, in characters: a sentence or two
/// for the person, well under what a comment record may hold.
const MAX_NOTE: usize = 4_000;

pub static SERVER: McpServer = McpServer {
    id: ID,
    name: "Context",
    description: "References, both ways: find, read and show the person files, canvas frames, \
                  comments, screenshots and assets by kaava:// reference, and read what they \
                  have selected.",
    tools: TOOLS,
    call,
    dev_only: false,
};

/// An object schema with these properties, plus the `cluster` every tool takes.
fn schema(mut props: Value, required: &[&str]) -> Value {
    props["cluster"] = json!({
        "type": "string",
        "description": "The cluster to answer from. Omit it for the one the person is working in.",
    });
    json!({ "type": "object", "properties": props, "required": required })
}

fn show_schema() -> Value {
    schema(
        json!({
            "refs": {
                "type": "array", "minItems": 1, "maxItems": MAX_SHOWN,
                "items": { "type": "string" },
                "description": "kaava:// references, shown in this order.",
            },
            "caption": { "type": "string", "description": "One line above them." },
        }),
        &["refs"],
    )
}

fn read_schema() -> Value {
    schema(
        json!({ "uri": { "type": "string", "description": "A kaava:// reference." } }),
        &["uri"],
    )
}

fn search_schema() -> Value {
    schema(
        json!({
            "query": {
                "type": "string",
                "description": "Words in the name. Empty lists everything but files and frames.",
            },
            "kinds": {
                "type": "array",
                "items": { "type": "string", "enum": search::KINDS },
                "description": "Only these kinds. Omit for all of them.",
            },
            "limit": { "type": "integer", "minimum": 1, "maximum": search::MAX_LIMIT },
        }),
        &[],
    )
}

fn comments_schema() -> Value {
    schema(
        json!({
            "status": {
                "type": "string", "enum": ["open", "resolved", "all"],
                "description": "Which comments. Open ones unless you say.",
            },
            "sources": {
                "type": "array",
                "items": { "type": "string", "enum": comments::SOURCES },
                "description": "Only comments left here. Omit for all of them.",
            },
        }),
        &[],
    )
}

fn resolve_schema() -> Value {
    schema(
        json!({
            "uri": { "type": "string", "description": "The comment's kaava:// reference." },
            "note": { "type": "string", "description": "What you did about it, for the person." },
        }),
        &["uri", "note"],
    )
}

fn selection_schema() -> Value {
    schema(json!({}), &[])
}

fn node_schema() -> Value {
    schema(
        json!({
            "canvas": { "type": "string", "description": "The canvas id, e.g. levels/hospital." },
            "node": { "type": "string", "description": "The frame's element id or exact name." },
        }),
        &["canvas", "node"],
    )
}

const TOOLS: &[McpTool] = &[
    McpTool {
        name: "show",
        description: "Show the person one to eight references inline, beside your reply: a file \
                      or lines of it, an image or model, a canvas frame, a comment and its \
                      screenshot. Use it when seeing the thing helps more than describing it. \
                      References look like kaava://file/src/main.gd#L10-L20.",
        schema: show_schema,
    },
    McpTool {
        name: "read",
        description: "Read a kaava:// reference: a file's lines, an image, a model's facts, a \
                      canvas's frames, a frame's properties and picture, a comment and its \
                      screenshot. Secrets and gitignored files are withheld and say why.",
        schema: read_schema,
    },
    McpTool {
        name: "search_context",
        description: "Find things in the person's project by name: files and folders, canvases \
                      and frames, viewer and Design Mode comments, context items and the \
                      selection. Each hit is a kaava:// reference to `read` or `show`. Names, \
                      not file contents: search inside files with your own tools. A comment is \
                      found by what it says.",
        schema: search_schema,
    },
    McpTool {
        name: "list_comments",
        description: "The comments the person left for you in the 3D and scene viewers, on \
                      canvases and in Design Mode, open ones unless you ask. Each has a \
                      kaava:// reference: `read` it for the whole comment and its screenshot.",
        schema: comments_schema,
    },
    McpTool {
        name: "resolve_comment",
        description: "Close a comment with a note saying what you did, once the work is done. \
                      Takes the comment's kaava:// reference from `list_comments`.",
        schema: resolve_schema,
    },
    McpTool {
        name: "get_selection",
        description: "What the person has selected right now: selected text, the frame or node \
                      each open app reports, and references to them. Call it when they say \
                      \"this\" or \"here\".",
        schema: selection_schema,
    },
    McpTool {
        name: "get_canvas_node",
        description: "One frame of a canvas by id or exact name: its type, properties, text and \
                      picture. The same as reading kaava://canvas/<canvas>#frame=<node>.",
        schema: node_schema,
    },
];

/// The selection, published so a client can subscribe to it.
pub const SELECTION_URI: &str = "kaava://selection";

pub static RESOURCES: &[McpResource] = &[McpResource {
    uri: SELECTION_URI,
    name: "selection",
    description: "What the person has selected in the cluster they are working in. \
                  Subscribe to hear when their focus moves; a selection made without moving \
                  focus is not announced, so read it again before acting on it.",
    mime_type: "text/plain",
}];

/// Every other reference reads as a resource too; these say how to write one.
pub static TEMPLATES: &[McpResource] = &[
    template(
        "kaava://file/{+path}",
        "file",
        "A file or folder in the project. Add #L10-L20 for some lines.",
    ),
    template(
        "kaava://canvas/{+id}",
        "canvas",
        "A canvas and its frames. Add #frame=<id> for one frame, #comment=<id> for a comment.",
    ),
    template(
        "kaava://comment/{id}",
        "comment",
        "A comment left in a viewer, with its screenshot.",
    ),
    template(
        "kaava://design-comment/{id}",
        "design-comment",
        "A Design Mode comment, with its screenshot.",
    ),
    template(
        "kaava://context/{id}",
        "context",
        "An item in the context store.",
    ),
];

const fn template(uri: &'static str, name: &'static str, about: &'static str) -> McpResource {
    McpResource {
        uri,
        name,
        description: about,
        mime_type: "",
    }
}

/// Read any reference as a resource, from `cluster` or the one in use.
pub fn read_resource(
    app: &AppHandle,
    uri: &str,
    cluster: Option<&str>,
) -> Result<ToolAnswer, RpcError> {
    let r = parse(uri)?;
    read(app, &context_for(app, cluster)?, &r)
}

/// Whether a tool leaves the person's work alone, for MCP's `readOnlyHint`.
pub fn read_only(tool: &str) -> Option<bool> {
    match tool {
        "read" | "search_context" | "list_comments" | "get_selection" | "get_canvas_node" => {
            Some(true)
        }
        "resolve_comment" => Some(false),
        // `show` changes nothing on disk, but it puts something in front of
        // the person, which is not what a client means by read-only.
        "show" => Some(false),
        _ => None,
    }
}

fn bad(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message.into())
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, RpcError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| bad(format!("`{key}` is required")))
}

/// An optional string, refused when it is there and is not one.
fn maybe_text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, RpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(bad(format!("`{key}` is a string"))),
    }
}

/// An optional count, refused when it is there and is not one.
fn maybe_count(args: &Map<String, Value>, key: &str) -> Result<Option<usize>, RpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .map(|n| Some(usize::try_from(n).unwrap_or(usize::MAX)))
            .ok_or_else(|| bad(format!("`{key}` is a whole number"))),
    }
}

/// The note `resolve_comment` writes, trimmed and held under [`MAX_NOTE`].
fn note(args: &Map<String, Value>) -> Result<&str, RpcError> {
    let note = text(args, "note")?.trim();
    if note.chars().count() > MAX_NOTE {
        return Err(bad(format!(
            "a note is at most {MAX_NOTE} characters; say what you did in a sentence or two"
        )));
    }
    Ok(note)
}

/// An optional list of strings.
fn strings(args: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, RpcError> {
    let not_a_list = || bad(format!("`{key}` is a list of strings"));
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(list)) => list
            .iter()
            .map(|k| k.as_str().map(String::from))
            .collect::<Option<Vec<_>>>()
            .map(Some)
            .ok_or_else(not_a_list),
        Some(_) => Err(not_a_list()),
    }
}

fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    let args = match params {
        Some(Value::Object(map)) => map,
        None | Some(Value::Null) => Map::new(),
        Some(_) => return Err(bad("arguments must be an object")),
    };
    let ctx = context_for(app, args.get("cluster").and_then(Value::as_str))?;
    match tool {
        "show" => show(app, &ctx, &args),
        "read" => read(app, &ctx, &parse(text(&args, "uri")?)?),
        "search_context" => find(app, &ctx, &args),
        "list_comments" => {
            let wanted = Wanted::parse(maybe_text(&args, "status")?).map_err(bad)?;
            let sources = strings(&args, "sources")?;
            let known = |s: &&String| comments::SOURCES.contains(&s.as_str());
            if let Some(stray) = sources.iter().flatten().find(|s| !known(s)) {
                let all = comments::SOURCES.join(", ");
                return Err(bad(format!("`{stray}` is not a source; use {all}")));
            }
            Ok(comments::list(app, &ctx, wanted, sources.as_deref()).into())
        }
        "resolve_comment" => {
            let (r, note) = (parse(text(&args, "uri")?)?, note(&args)?);
            let done = comments::resolve(app, &ctx, &r, note).map_err(bad)?;
            Ok(done.into())
        }
        "get_selection" => read(app, &ctx, &Ref::Selection),
        "get_canvas_node" => {
            let r = Ref::Canvas {
                id: text(&args, "canvas")?.to_string(),
                part: Some(CanvasPart::Frame(text(&args, "node")?.to_string())),
            };
            // Round-tripped so a canvas id is held to the scheme's rules.
            read(app, &ctx, &parse(&r.to_string())?)
        }
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("the context server has no tool named `{other}`"),
        )),
    }
}

fn parse(raw: &str) -> Result<Ref, RpcError> {
    uri::parse(raw).map_err(bad)
}

/// The cluster a call answers from: the one named, else the one the person
/// is working in.
fn context_for(app: &AppHandle, cluster: Option<&str>) -> Result<CallContext, RpcError> {
    if let Some(cluster) = cluster.filter(|c| !c.is_empty()) {
        return Ok(CallContext::resolve(app, None, Some(cluster)));
    }
    let snapshot = app.state::<ShellState>().snapshot();
    let pages = workspace::page_contexts(app);
    let (_, cluster) = workspace::active_cluster(&snapshot, &pages).ok_or_else(|| {
        RpcError::new(
            INTERNAL_ERROR,
            "there is no cluster to answer from; name one with `cluster`",
        )
    })?;
    Ok(CallContext::resolve(app, None, Some(&cluster)))
}

fn read(app: &AppHandle, ctx: &CallContext, r: &Ref) -> Result<ToolAnswer, RpcError> {
    let resolved = live::resolve(app, ctx, Actor::Agent, r).map_err(bad)?;
    Ok(ToolAnswer::Blocks(blocks(&resolved)))
}

fn find(
    app: &AppHandle,
    ctx: &CallContext,
    args: &Map<String, Value>,
) -> Result<ToolAnswer, RpcError> {
    if ctx.project.is_none() {
        return Err(bad(
            "this cluster has no project open, so there is nothing to find",
        ));
    }
    let words = maybe_text(args, "query")?.unwrap_or("");
    let kinds = strings(args, "kinds")?;
    let limit = maybe_count(args, "limit")?;
    let q = Query::new(words, kinds, limit).map_err(bad)?;
    let hits = search::run(app, ctx, Actor::Agent, &q);
    Ok(json!({ "query": words, "hits": hits }).into())
}

/// Check every reference, then answer with the marker the agent tab draws
/// from (see [`show_answer`]).
fn show(
    app: &AppHandle,
    ctx: &CallContext,
    args: &Map<String, Value>,
) -> Result<ToolAnswer, RpcError> {
    let raw = args
        .get("refs")
        .and_then(Value::as_array)
        .filter(|refs| !refs.is_empty())
        .ok_or_else(|| bad("`refs` needs at least one kaava:// reference"))?;
    if raw.len() > MAX_SHOWN {
        return Err(bad(format!("show at most {MAX_SHOWN} references at once")));
    }
    let caption = args.get("caption").and_then(Value::as_str).map(str::trim);
    if caption.is_some_and(|c| c.chars().count() > MAX_CAPTION) {
        return Err(bad(format!(
            "a caption is at most {MAX_CAPTION} characters"
        )));
    }
    let checked = raw.iter().map(|item| {
        let given = item.as_str().unwrap_or_default();
        let r = uri::parse(given)
            .map_err(|why| (given.to_string(), Fault::new(Reason::BadUri, why)))?;
        live::check(app, ctx, &r).map_err(|why| (r.to_string(), why))?;
        Ok(r)
    });
    show_answer(checked.collect(), caption.filter(|c| !c.is_empty())).map(ToolAnswer::Json)
}

/// The answer to `show`: `{kaavaShow: {component, version, props}}`, which the
/// agent host lifts off this server's tool result for the tab to draw, and the
/// references that could not be shown, each with its reason word and why.
/// Refused when none could be.
fn show_answer(
    checked: Vec<Result<Ref, (String, Fault)>>,
    caption: Option<&str>,
) -> Result<Value, RpcError> {
    let (shown, failed): (Vec<_>, Vec<_>) = checked.into_iter().partition(Result::is_ok);
    let failed: Vec<(String, Fault)> = failed.into_iter().filter_map(Result::err).collect();
    if shown.is_empty() {
        let reasons: Vec<String> = failed
            .iter()
            .map(|(uri, why)| format!("{uri}: {why}"))
            .collect();
        return Err(bad(format!("nothing to show. {}", reasons.join("; "))));
    }
    let failed: Vec<Value> = failed
        .iter()
        .map(|(uri, why)| json!({ "uri": uri, "reason": why.reason, "message": why.message }))
        .collect();
    let refs: Vec<String> = shown.into_iter().flatten().map(|r| r.to_string()).collect();
    let mut props = json!({ "refs": refs });
    if let Some(caption) = caption {
        props["caption"] = json!(caption);
    }
    let mut answer = json!({
        "kaavaShow": { "component": "refs", "version": REFS_VERSION, "props": props },
    });
    if !failed.is_empty() {
        answer["failed"] = json!(failed);
    }
    Ok(answer)
}

/// A resolved reference as content blocks: a header that says what it is,
/// then each part, pictures as pictures.
pub fn blocks(r: &Resolved) -> Vec<Block> {
    let mut head = format!("{} ({}): {}", r.uri, r.kind, r.title);
    for line in [&r.detail, &r.withheld].into_iter().flatten() {
        head.push('\n');
        head.push_str(line);
    }
    if !r.meta.is_empty() {
        head.push('\n');
        head.push_str(&Value::Object(r.meta.clone()).to_string());
    }
    let mut out = vec![Block::Text(head)];
    out.extend(r.parts.iter().map(|part| match part {
        Part::Text {
            text,
            start_line,
            truncated,
            ..
        } => {
            let mut t = String::new();
            if *start_line > 1 {
                t.push_str(&format!("(from line {start_line})\n"));
            }
            t.push_str(text);
            if *truncated {
                t.push_str("\n(cut short; ask for a line range to read further)");
            }
            Block::Text(t)
        }
        Part::Image {
            mime, data_base64, ..
        } => Block::Image {
            mime: mime.clone(),
            data: data_base64.clone(),
        },
        Part::Json { value } => {
            Block::Text(serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()))
        }
        Part::Note { text } => Block::Text(text.clone()),
    }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> Ref {
        uri::parse(&format!("kaava://file/{path}")).unwrap()
    }

    #[test]
    fn show_answers_with_the_marker_the_tab_draws_from() {
        let answer = show_answer(vec![Ok(file("a.gd")), Ok(Ref::Selection)], Some("Here")).unwrap();
        assert_eq!(
            answer,
            json!({ "kaavaShow": {
                "component": "refs",
                "version": 1,
                "props": { "refs": ["kaava://file/a.gd", "kaava://selection"], "caption": "Here" },
            }})
        );
    }

    #[test]
    fn show_draws_what_it_can_and_names_what_it_cannot() {
        let missing = Err((
            "kaava://file/gone.gd".to_string(),
            Fault::new(Reason::Missing, "no such file"),
        ));
        let answer = show_answer(vec![missing.clone(), Ok(file("a.gd"))], None).unwrap();
        assert_eq!(
            answer["kaavaShow"]["props"]["refs"],
            json!(["kaava://file/a.gd"])
        );
        assert!(answer["kaavaShow"]["props"].get("caption").is_none());
        assert_eq!(answer["failed"][0]["reason"], "missing");
        assert_eq!(answer["failed"][0]["message"], "no such file");
        let none = show_answer(vec![missing], None).unwrap_err();
        assert!(
            none.message.contains("gone.gd: no such file"),
            "{}",
            none.message
        );
    }

    fn resolved(uri: &str, title: &str) -> Resolved {
        Resolved {
            uri: uri.into(),
            kind: "text".into(),
            title: title.into(),
            detail: None,
            meta: Map::new(),
            parts: Vec::new(),
            withheld: None,
        }
    }

    #[test]
    fn a_resolved_reference_reads_as_a_header_then_its_parts() {
        let mut r = resolved("kaava://file/a.gd", "a.gd");
        r.detail = Some("a.gd · lines 3–4".into());
        r.meta.insert("lines".into(), json!(40));
        r.parts.push(Part::Text {
            text: "x\ny".into(),
            language: Some("gdscript".into()),
            start_line: 3,
            truncated: true,
        });
        r.parts.push(Part::Image {
            mime: "image/png".into(),
            data_base64: "AA==".into(),
            width: None,
            height: None,
        });
        let out = blocks(&r);
        assert_eq!(
            out[0],
            Block::Text("kaava://file/a.gd (text): a.gd\na.gd · lines 3–4\n{\"lines\":40}".into())
        );
        let Block::Text(body) = &out[1] else {
            panic!("{:?}", out[1])
        };
        assert!(
            body.starts_with("(from line 3)\nx\ny\n(cut short"),
            "{body}"
        );
        assert!(matches!(&out[2], Block::Image { mime, .. } if mime == "image/png"));
    }

    #[test]
    fn a_withheld_reference_says_why_in_its_header() {
        let mut r = resolved("kaava://file/.env", ".env");
        r.withheld = Some("withheld: secrets".into());
        assert_eq!(
            blocks(&r),
            vec![Block::Text(
                "kaava://file/.env (text): .env\nwithheld: secrets".into()
            )]
        );
    }

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn an_argument_of_the_wrong_type_is_refused_not_replaced() {
        let given = args(json!({ "query": 7, "limit": "ten", "status": null, "n": 3 }));
        assert!(maybe_text(&given, "query").is_err());
        assert!(maybe_count(&given, "limit").is_err());
        assert_eq!(maybe_text(&given, "status").unwrap(), None);
        assert_eq!(maybe_text(&given, "absent").unwrap(), None);
        assert_eq!(maybe_count(&given, "n").unwrap(), Some(3));
        assert!(maybe_count(&args(json!({ "n": -1 })), "n").is_err());
    }

    #[test]
    fn a_note_is_trimmed_and_held_under_the_cap() {
        assert_eq!(note(&args(json!({ "note": "  done \n" }))).unwrap(), "done");
        let longest = "é".repeat(MAX_NOTE);
        assert!(
            note(&args(json!({ "note": longest }))).is_ok(),
            "counted in characters"
        );
        let over = "x".repeat(MAX_NOTE + 1);
        let err = note(&args(json!({ "note": over }))).unwrap_err();
        assert_eq!(err.code, kaava_rpc::INVALID_PARAMS);
        assert!(note(&args(json!({ "note": "   " }))).is_err());
    }
}
