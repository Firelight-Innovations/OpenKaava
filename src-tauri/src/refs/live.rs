//! The references only a running Veistra can answer: canvases (read and drawn
//! through the Canvas app), Design Mode comments (kept in app state) and the
//! selection (reported by the panes on screen). Files, context items and
//! viewer comments are plain disk reads and go straight to [`super::resolve`].

use super::fault::{Fault, Reason};
use super::resolve::{self, Part, Resolved};
use super::uri::{CanvasPart, Ref};
use crate::apps::CallContext;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;
use veistra_rpc::RpcError;

/// Most frames a canvas reference lists, and most text items a frame lists.
const MAX_LISTED: usize = 100;

/// Who is asking. The canvas records it on every call it answers: the person
/// through `refs/resolve`, the agent through the context server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    Human,
    Agent,
}

impl Actor {
    pub fn name(self) -> &'static str {
        match self {
            Actor::Human => "human",
            Actor::Agent => "agent",
        }
    }
}

/// Resolve any reference for the cluster in `ctx`.
pub fn resolve(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    r: &Ref,
) -> Result<Resolved, Fault> {
    let root = root_of(ctx)?;
    match r {
        Ref::File { .. } => resolve::file(root, r),
        Ref::Context { .. } => resolve::context_item(root, r),
        Ref::Comment { .. } => resolve::viewer_comment(root, r),
        Ref::Canvas { id, part } => {
            canvas_inside(root, id, part.as_ref())?;
            match part {
                None => canvas(app, ctx, actor, r, id),
                Some(CanvasPart::Frame(frame)) => frame_of(app, ctx, actor, root, r, id, frame),
                Some(CanvasPart::Comment(c)) => canvas_comment(app, ctx, actor, root, r, id, c),
            }
        }
        Ref::DesignComment { id } => design_comment(app, r, id),
        Ref::Selection => selection(app, ctx, root, r),
    }
}

pub(super) fn root_of(ctx: &CallContext) -> Result<&Path, Fault> {
    ctx.project.as_deref().ok_or_else(|| {
        Fault::new(
            Reason::NoProject,
            "this cluster has no project open, so there is nothing to reference",
        )
    })
}

/// Whether a reference names something that is there and may be shown,
/// reading no more than a file's first bytes: what `show` asks before the tab
/// is told to draw it. A secret is refused with the rule it falls under. A
/// gitignored file passes, because the tab draws it as withheld.
pub fn check(app: &AppHandle, ctx: &CallContext, r: &Ref) -> Result<(), Fault> {
    let root = root_of(ctx)?;
    let refuse = |rule: Option<&str>| {
        rule.map_or(Ok(()), |rule| {
            Err(Fault::new(Reason::Secret, resolve::secret_withheld(rule)))
        })
    };
    match r {
        Ref::File { path, .. } => {
            let found = super::policy::contain(root, path)?;
            refuse(resolve::secret_file(path, &found))
        }
        Ref::Context { id } => {
            let item = resolve::stored_item(root, id)?;
            refuse(resolve::item_secret(root, &item))
        }
        Ref::Comment { id } => resolve::viewer_record_at(root, id).map(drop),
        Ref::Canvas { id, part } => {
            canvas_inside(root, id, part.as_ref())?;
            match part {
                Some(CanvasPart::Frame(frame)) => {
                    let asked = json!({ "canvas": id, "frame": frame });
                    canvas_call(app, ctx, Actor::Agent, "canvas/frame", asked).map(drop)
                }
                _ => Ok(()),
            }
        }
        Ref::DesignComment { id } => design_comment_exists(app, id),
        Ref::Selection => Ok(()),
    }
}

#[cfg(feature = "design-mode")]
fn design_comment_exists(app: &AppHandle, id: &str) -> Result<(), Fault> {
    use tauri::Manager;
    let comments = app.state::<crate::design_comments::Comments>();
    comments
        .get(id)
        .map(drop)
        .ok_or_else(|| no_design_comment(id))
}

#[cfg(feature = "design-mode")]
fn no_design_comment(id: &str) -> Fault {
    Fault::new(
        Reason::Missing,
        format!("there is no Design Mode comment `{id}`"),
    )
}

#[cfg(not(feature = "design-mode"))]
fn design_comment_exists(app: &AppHandle, id: &str) -> Result<(), Fault> {
    design_comment(app, &Ref::DesignComment { id: id.into() }, id).map(drop)
}

/// Refuse a canvas, or a comment on one, when a file the Canvas app reads for
/// it is not inside the project once links are followed. The app reads files
/// where it finds them, so the test a file reference passes runs here, before
/// it is asked. That covers the canvas, each child its split frames name, and
/// the comment, which may have moved into a child with its frame.
pub(super) fn canvas_inside(root: &Path, id: &str, part: Option<&CanvasPart>) -> Result<(), Fault> {
    let children = canvas_files_inside(root, id)?;
    match part {
        Some(CanvasPart::Comment(c)) => comment_inside(root, id, &children, c),
        _ => Ok(()),
    }
}

/// The first half of [`canvas_inside`]: the canvas file and its children's.
/// Answers the children, so a caller checking many comments on one canvas
/// reads the canvas once.
pub(super) fn canvas_files_inside(root: &Path, id: &str) -> Result<Vec<String>, Fault> {
    use crate::apps::canvas;
    file_inside(root, id, &canvas::file_for(root, id))?;
    let children = canvas::split_children(root, id);
    // A child that is not there is not opened, so it is not checked.
    for child in &children {
        let file = canvas::file_for(root, child);
        if file.exists() {
            file_inside(root, id, &file)?;
        }
    }
    Ok(children)
}

/// The second half of [`canvas_inside`]: comment `c`'s file, on canvas `id`
/// or on one of its `children`.
pub(super) fn comment_inside(
    root: &Path,
    id: &str,
    children: &[String],
    c: &str,
) -> Result<(), Fault> {
    use crate::apps::canvas;
    let homes = std::iter::once(id).chain(children.iter().map(String::as_str));
    let files: Vec<_> = homes
        .map(|home| canvas::comments::dir_for(root, home).join(format!("{c}.json")))
        .filter(|f| f.exists())
        .collect();
    if files.is_empty() {
        let missing = format!("canvas `{id}` has no comment `{c}`");
        return Err(Fault::new(Reason::Missing, missing));
    }
    files.iter().try_for_each(|f| file_inside(root, id, f))
}

/// Whether `file`, read for canvas `id`, is inside the root once links are
/// followed.
fn file_inside(root: &Path, id: &str, file: &Path) -> Result<(), Fault> {
    let rel = crate::context::relative_to(root, file).ok_or_else(|| {
        Fault::new(
            Reason::Outside,
            format!("canvas `{id}` is not in this project"),
        )
    })?;
    super::policy::contain(root, &rel).map(drop)
}

fn canvas_rpc(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    method: &str,
    mut params: Value,
) -> Result<Value, RpcError> {
    params["actor"] = json!(actor.name());
    crate::apps::call(app, ctx, "canvas", method, Some(params))
}

/// Ask the Canvas app.
pub(super) fn canvas_call(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    method: &str,
    params: Value,
) -> Result<Value, Fault> {
    canvas_rpc(app, ctx, actor, method, params).map_err(canvas_fault)
}

/// The parameters are built here, so the one thing the Canvas app can call
/// invalid in them is a canvas or frame it does not have. A canvas file it
/// cannot parse is unreadable; any other failure is the app's.
fn canvas_fault(e: RpcError) -> Fault {
    let kind = e.data.as_ref().and_then(|d| d.get("kind"));
    let reason = match e.code {
        veistra_rpc::INVALID_PARAMS => Reason::Missing,
        _ if kind.and_then(Value::as_str) == Some("corrupt") => Reason::Unreadable,
        _ => Reason::Unavailable,
    };
    Fault::new(reason, e.message)
}

/// Whether the Canvas app failed only because no Canvas pane is open to draw.
fn no_pane(e: &RpcError) -> bool {
    e.data
        .as_ref()
        .is_some_and(|d| d["kind"] == "canvas-not-open")
}

fn canvas(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    r: &Ref,
    id: &str,
) -> Result<Resolved, Fault> {
    let listed = canvas_call(app, ctx, actor, "canvas/frames", json!({ "canvas": id }))?;
    canvas_from(&listed, r, id)
}

/// A canvas from its `canvas/frames` answer: its frames, each with a reference.
/// The app answers for a damaged canvas with no canvases and the reason in
/// `problems`. That is an error here, so it never reads as an empty canvas.
fn canvas_from(listed: &Value, r: &Ref, id: &str) -> Result<Resolved, Fault> {
    if listed["canvases"].as_array().is_none_or(Vec::is_empty) {
        let why = match listed.pointer("/problems/0").and_then(Value::as_str) {
            Some(why) => format!("canvas `{id}` cannot be read: {why}"),
            None => format!("canvas `{id}` cannot be read"),
        };
        return Err(Fault::new(Reason::Unreadable, why));
    }
    let title = listed
        .pointer("/canvases/0/title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .unwrap_or(id);
    let frames = listed["frames"].as_array().cloned().unwrap_or_default();
    let mut out = resolve::Resolved::empty(r, "canvas", title);
    out.detail = Some(format!("canvas {id}"));
    out.meta.insert("frames".into(), json!(frames.len()));
    let rows: Vec<Value> = frames
        .iter()
        .take(MAX_LISTED)
        .map(|f| {
            let fid = f["id"].as_str().unwrap_or_default();
            let link = Ref::Canvas {
                id: f["canvas"].as_str().unwrap_or(id).to_string(),
                part: Some(CanvasPart::Frame(fid.to_string())),
            };
            json!({ "name": f["name"], "type": f["typeName"], "ref": link.to_string() })
        })
        .collect();
    out.parts
        .push(resolve::json_part(json!({ "frames": rows })));
    Ok(out)
}

fn frame_of(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    root: &Path,
    r: &Ref,
    id: &str,
    frame: &str,
) -> Result<Resolved, Fault> {
    let detail = canvas_call(
        app,
        ctx,
        actor,
        "canvas/frame",
        json!({ "canvas": id, "frame": frame }),
    )
    .map_err(|f| match f.reason {
        Reason::Missing if shared_name(app, ctx, actor, id, frame) => {
            Fault::new(Reason::Ambiguous, f.message)
        }
        _ => f,
    })?;
    let mut out = frame_from(&detail, r, id, frame);
    let fid = detail["id"].as_str().unwrap_or(frame);
    let picture = canvas_call(
        app,
        ctx,
        actor,
        "canvas/frame-image",
        json!({ "canvas": id, "frame": fid }),
    );
    out.parts.push(rendered(root, picture));
    Ok(out)
}

/// Whether two or more frames on the canvas are called `name`. The Canvas app
/// refuses a shared name as it refuses one no frame has, so its listing is
/// asked, and only once a lookup has already failed.
fn shared_name(app: &AppHandle, ctx: &CallContext, actor: Actor, id: &str, name: &str) -> bool {
    let listed = canvas_call(app, ctx, actor, "canvas/frames", json!({ "canvas": id }));
    listed.is_ok_and(|l| frames_named(&l, name) > 1)
}

/// How many frames in a `canvas/frames` answer have this name, ignoring case
/// as the Canvas app does.
fn frames_named(listed: &Value, name: &str) -> usize {
    let frames = listed["frames"].as_array().map_or(&[][..], Vec::as_slice);
    frames
        .iter()
        .filter(|f| {
            f["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .count()
}

/// A frame from its `canvas/frame` answer: its type, properties and text.
fn frame_from(detail: &Value, r: &Ref, id: &str, frame: &str) -> Resolved {
    let name = detail["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or(frame);
    let mut out = resolve::Resolved::empty(r, "frame", name);
    out.detail = Some(match detail["typeName"].as_str() {
        Some(t) => format!("{t} on canvas {id}"),
        None => format!("frame on canvas {id}"),
    });
    out.meta.insert("canvas".into(), json!(id));
    out.meta.insert("frameId".into(), detail["id"].clone());
    let texts: Vec<Value> = detail["contents"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c["text"].as_str())
                .filter(|t| !t.trim().is_empty())
                .take(MAX_LISTED)
                .map(|t| json!(t))
                .collect()
        })
        .unwrap_or_default();
    out.parts.push(resolve::json_part(json!({
        "type": detail["typeName"],
        "props": detail["props"],
        "text": texts,
    })));
    out
}

fn canvas_comment(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    root: &Path,
    r: &Ref,
    id: &str,
    comment: &str,
) -> Result<Resolved, Fault> {
    let viewed = canvas_rpc(
        app,
        ctx,
        actor,
        "canvas/view-comment",
        json!({ "id": id, "commentId": comment }),
    );
    let list = || {
        canvas_call(
            app,
            ctx,
            actor,
            "canvas/list-comments",
            json!({ "id": id, "status": "all" }),
        )
    };
    comment_from(root, r, id, comment, viewed, list)
}

/// A canvas comment from its `canvas/view-comment` answer. Only when no pane is
/// open to draw it does the record come from `list` instead, without a
/// picture; any other failure is the comment's own, and is passed on.
fn comment_from(
    root: &Path,
    r: &Ref,
    id: &str,
    comment: &str,
    viewed: Result<Value, RpcError>,
    list: impl FnOnce() -> Result<Value, Fault>,
) -> Result<Resolved, Fault> {
    let (record, picture) = match viewed {
        Ok(v) => (v["comment"].clone(), rendered(root, Ok(v))),
        Err(e) if no_pane(&e) => {
            let found = list()?["comments"]
                .as_array()
                .and_then(|cs| cs.iter().find(|c| c["id"] == json!(comment)).cloned())
                .ok_or_else(|| {
                    let missing = format!("canvas `{id}` has no comment `{comment}`");
                    Fault::new(Reason::Missing, missing)
                })?;
            (found, rendered(root, Err(canvas_fault(e))))
        }
        Err(e) => return Err(canvas_fault(e)),
    };
    let text = record["text"].as_str().unwrap_or_default();
    let mut out = resolve::Resolved::empty(r, "comment", resolve::first_line(text));
    out.detail = Some(format!("comment on canvas {id}"));
    out.meta.insert("status".into(), record["status"].clone());
    out.meta.insert("author".into(), record["author"].clone());
    out.parts.push(resolve::prose_part(text, Some("markdown")));
    out.parts.push(resolve::json_part(record));
    out.parts.push(picture);
    Ok(out)
}

/// A PNG the canvas rendered, as an image part, or a note saying why not.
/// The path comes from the canvas, and is read only when it is inside the root
/// once links are followed, the same test a file reference passes.
fn rendered(root: &Path, answer: Result<Value, Fault>) -> Part {
    let note = |text: String| Part::Note { text };
    let path = match answer {
        Ok(v) => v["path"].as_str().map(str::to_owned),
        // The app's own message says what would draw one, when anything would.
        Err(why) => return note(format!("No picture: {why}")),
    };
    let found = path
        .and_then(|p| crate::context::relative_to(root, Path::new(&p)))
        .and_then(|rel| super::policy::contain(root, &rel).ok());
    let Some(found) = found else {
        return note("No picture: the canvas did not draw it inside this project.".into());
    };
    match resolve::png_part(&found.abs) {
        Ok(part) => part,
        Err(why) => note(format!("No picture: {why}")),
    }
}

#[cfg(feature = "design-mode")]
fn design_comment(app: &AppHandle, r: &Ref, id: &str) -> Result<Resolved, Fault> {
    use tauri::Manager;
    let c = app
        .state::<crate::design_comments::Comments>()
        .get(id)
        .ok_or_else(|| no_design_comment(id))?;
    let mut out = resolve::Resolved::empty(r, "design-comment", resolve::first_line(&c.request));
    out.detail = Some(format!("{} on {}", c.element.tag, c.page.title));
    out.meta.insert("status".into(), json!(c.status));
    out.parts
        .push(resolve::prose_part(&c.request, Some("markdown")));
    out.parts.push(resolve::json_part(
        json!({ "page": c.page, "selector": c.element.selector, "thread": c.thread }),
    ));
    // Read as a viewer comment's is: capped, sniffed, and a note when it fails.
    let shot = crate::design_comments::shot_file(app, id).filter(|f| f.is_file());
    if let Some(shot) = shot {
        out.parts
            .push(resolve::png_part(&shot).unwrap_or_else(|why| Part::Note {
                text: format!("No screenshot: {why}"),
            }));
    }
    Ok(out)
}

#[cfg(not(feature = "design-mode"))]
fn design_comment(_app: &AppHandle, _r: &Ref, _id: &str) -> Result<Resolved, Fault> {
    Err(Fault::new(
        Reason::Unavailable,
        "Design Mode is not part of this build, so it has no comments",
    ))
}

/// What the person has selected, read from the panes in this cluster.
fn selection(app: &AppHandle, ctx: &CallContext, root: &Path, r: &Ref) -> Result<Resolved, Fault> {
    let cluster = ctx.cluster_id.as_deref().ok_or_else(|| {
        Fault::new(
            Reason::NoProject,
            "this surface is not in a cluster, so it has no selection",
        )
    })?;
    Ok(selection_from(
        crate::mcp::selection_in(app, cluster),
        root,
        r,
    ))
}

/// [`selection`] from what the panes reported. The selected text is sent once,
/// as text; the panes' reports follow it as JSON.
fn selection_from(mut seen: Value, root: &Path, r: &Ref) -> Resolved {
    let mut out = resolve::Resolved::empty(r, "selection", "Selection");
    let mut related = Vec::new();
    let mut secret = None;
    for surface in seen["surfaces"].as_array().into_iter().flatten() {
        let report = &surface["report"];
        if let (Some(canvas), Some(diagram)) =
            (report["canvas"].as_str(), report["diagram"].as_str())
        {
            let link = Ref::Canvas {
                id: canvas.into(),
                part: Some(CanvasPart::Frame(diagram.into())),
            };
            related.push(link.to_string());
        }
        let file = report["file"].as_str().or(report["path"].as_str());
        if let Some(rel) = file.and_then(|f| crate::context::relative_to(root, Path::new(f))) {
            secret = secret.or_else(|| super::policy::secret_rule(&rel));
            if super::policy::check_relative(&rel).is_ok() {
                let link = Ref::File {
                    path: rel,
                    lines: None,
                };
                related.push(link.to_string());
            }
        }
    }
    out.detail = seen["focused"]["title"].as_str().map(str::to_owned);
    out.meta.insert("refs".into(), json!(related));
    // What is selected is screened as a file is: nothing from a secret, and
    // nothing that holds a key.
    let selected = seen["selectedText"].as_str().unwrap_or_default();
    if let Some(rule) = secret.or_else(|| super::policy::secret_content(selected.as_bytes())) {
        return out.withhold(resolve::secret_withheld(rule));
    }
    if let Some(text) = seen["selectedText"].as_str().filter(|t| !t.is_empty()) {
        // The page counts in UTF-16 units, as JavaScript does, not in bytes.
        let units = text.encode_utf16().count() as u64;
        let mut part = resolve::prose_part(text, None);
        if let Part::Text { truncated, .. } = &mut part {
            *truncated |= seen["selectedTextLength"].as_u64() > Some(units);
        }
        out.parts.push(part);
    }
    if let Some(fields) = seen.as_object_mut() {
        fields.remove("selectedText");
    }
    out.parts.push(resolve::json_part(seen));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_png(path: &Path) {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn a_canvas_failure_says_whether_it_is_missing_broken_or_the_apps() {
        use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
        let reason = |e| canvas_fault(e).reason;
        let corrupt = json!({ "kind": "corrupt" });
        assert_eq!(reason(RpcError::new(INVALID_PARAMS, "no")), Reason::Missing);
        let broken = RpcError::with_data(INTERNAL_ERROR, "not JSON", corrupt);
        assert_eq!(reason(broken), Reason::Unreadable);
        let down = RpcError::new(INTERNAL_ERROR, "timed out");
        assert_eq!(reason(down), Reason::Unavailable);
    }

    #[test]
    fn a_frame_name_is_counted_ignoring_case() {
        let listed = json!({ "frames": [
            { "id": "a", "name": "Intro" },
            { "id": "b", "name": "intro" },
            { "id": "c", "name": "Outro" },
        ] });
        assert_eq!(frames_named(&listed, "INTRO"), 2);
        assert_eq!(frames_named(&listed, "Outro"), 1);
        assert_eq!(frames_named(&json!({}), "Intro"), 0);
    }

    #[test]
    fn a_rendered_picture_is_read_only_from_inside_the_project() {
        let (dir, away) = (
            tempfile::TempDir::new().unwrap(),
            tempfile::TempDir::new().unwrap(),
        );
        let here = dir.path().join(".veistra/preview/canvas/world/f1.png");
        let there = away.path().join("f1.png");
        write_png(&here);
        write_png(&there);
        let at = |p: &Path| Ok(json!({ "path": p }));
        assert!(matches!(
            rendered(dir.path(), at(&here)),
            Part::Image { .. }
        ));
        assert!(matches!(
            rendered(dir.path(), at(&there)),
            Part::Note { .. }
        ));
        let missing = rendered(dir.path(), Err("no Canvas pane is open".into()));
        assert!(matches!(missing, Part::Note { text } if text.contains("no Canvas pane")));
    }

    #[test]
    fn a_selection_links_what_the_panes_name_and_counts_text_as_the_page_does() {
        let (dir, away) = (
            tempfile::TempDir::new().unwrap(),
            tempfile::TempDir::new().unwrap(),
        );
        write(&dir.path().join("src/main.gd"), "x");
        let seen = |text: &str, length: usize| {
            json!({
                "focused": { "title": "World" },
                "surfaces": [
                    { "report": { "canvas": "world", "diagram": "f1" } },
                    { "report": { "file": dir.path().join("src/main.gd") } },
                    { "report": { "path": away.path().join("x.gd") } },
                ],
                "selectedText": text,
                "selectedTextLength": length,
            })
        };
        let out = selection_from(seen("h\u{e9}llo \u{1F44B}", 8), dir.path(), &Ref::Selection);
        let frame = Ref::Canvas {
            id: "world".into(),
            part: Some(CanvasPart::Frame("f1".into())),
        };
        assert_eq!(
            out.meta["refs"],
            json!([frame.to_string(), "veistra://file/src/main.gd"])
        );
        assert_eq!(out.detail.as_deref(), Some("World"));
        let cut = |o: &Resolved| matches!(o.parts[0], Part::Text { truncated, .. } if truncated);
        assert!(!cut(&out), "eight UTF-16 units, all of them sent");
        assert!(
            matches!(&out.parts[1], Part::Json { value } if value.get("selectedText").is_none()),
            "the text is sent once, not again inside the reports"
        );
        let longer = selection_from(seen("\u{e9}\u{e9}\u{e9}", 5), dir.path(), &Ref::Selection);
        assert!(cut(&longer), "five units selected, three sent");
    }

    #[test]
    fn a_selection_holding_a_key_or_beside_a_secret_is_withheld() {
        let dir = tempfile::TempDir::new().unwrap();
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl";
        let seen = json!({ "surfaces": [], "selectedText": key, "selectedTextLength": 40 });
        let out = selection_from(seen, dir.path(), &Ref::Selection);
        assert!(out.parts.is_empty(), "{:?}", out.parts);
        assert!(out.withheld.unwrap().contains("private keys"));
        let env = dir.path().join(".env");
        let seen = json!({
            "surfaces": [{ "report": { "file": env } }],
            "selectedText": "API_KEY=hunter2",
            "selectedTextLength": 15,
        });
        let out = selection_from(seen, dir.path(), &Ref::Selection);
        assert!(out.parts.is_empty(), "{:?}", out.parts);
        assert!(out.withheld.unwrap().contains(".env"));
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A canvas whose one frame was split, its elements moved to canvas `child`.
    fn split_into(child: &str) -> String {
        json!({ "type": "excalidraw", "elements": [{
            "id": "f1",
            "type": "frame",
            "customData": { "veistra": { "subcanvas": true, "child": child } },
        }] })
        .to_string()
    }

    #[test]
    fn a_canvas_its_children_and_its_comments_are_read_only_from_inside_the_project() {
        use crate::refs::links;
        let (dir, away) = (
            tempfile::TempDir::new().unwrap(),
            tempfile::TempDir::new().unwrap(),
        );
        let (root, secret) = (dir.path(), away.path().join("secret.json"));
        write(&root.join("canvas/world.json"), &split_into("world-f1"));
        write(&root.join("canvas/world-f1.json"), "{}");
        write(&root.join("canvas/world.comments/c-1.json"), "{}");
        write(&root.join("canvas/world-f1.comments/c-3.json"), "{}");
        write(&secret, "{}");
        let comment = |c: &str| Some(CanvasPart::Comment(c.into()));
        assert!(canvas_inside(root, "world", None).is_ok());
        assert!(canvas_inside(root, "world", comment("c-1").as_ref()).is_ok());
        assert!(
            canvas_inside(root, "world", comment("c-3").as_ref()).is_ok(),
            "a comment that moved into the child with its frame"
        );
        let err = canvas_inside(root, "world", comment("c-9").as_ref()).unwrap_err();
        assert_eq!(err.reason, Reason::Missing);
        assert!(err.message.contains("has no comment `c-9`"), "{err}");
        let children = canvas_files_inside(root, "world").unwrap();
        assert_eq!(children, ["world-f1"]);
        assert!(comment_inside(root, "world", &children, "c-3").is_ok());
        assert!(
            comment_inside(root, "world", &[], "c-3").is_err(),
            "a moved comment is found only through the children it moved to"
        );
        let err = canvas_inside(root, "nope", None).unwrap_err();
        assert_eq!(err.reason, Reason::Missing);

        write(&away.path().join("levels/inner.json"), "{}");
        links::folder(&away.path().join("levels"), &root.join("canvas/levels"));
        write(&root.join("canvas/hub.json"), &split_into("levels/inner"));
        let err = canvas_inside(root, "hub", None).unwrap_err();
        assert_eq!(err.reason, Reason::Outside, "a linked child: {err}");
        let err = canvas_inside(root, "levels/inner", None).unwrap_err();
        assert_eq!(err.reason, Reason::Outside, "a linked folder: {err}");

        if !links::file(&secret, &root.join("canvas/leak.canvas.json")) {
            return;
        }
        let err = canvas_inside(root, "leak", None).unwrap_err();
        assert_eq!(err.reason, Reason::Outside);
        assert!(err.message.contains("outside the project"), "{err}");
        assert!(links::file(
            &secret,
            &root.join("canvas/world.comments/c-2.json")
        ));
        let err = canvas_inside(root, "world", comment("c-2").as_ref()).unwrap_err();
        assert_eq!(err.reason, Reason::Outside);
        assert!(err.message.contains("outside the project"), "{err}");
    }

    fn json_part(r: &Resolved) -> &Value {
        match r.parts.first() {
            Some(Part::Json { value }) => value,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_canvas_lists_its_frames_each_with_a_reference_up_to_the_cap() {
        let frame = |n: usize| json!({ "canvas": "levels/one", "id": format!("f{n}"), "name": format!("Room {n}"), "typeName": "Room" });
        let listed = json!({
            "canvases": [{ "id": "levels/one", "title": "Level one" }],
            "frames": (0..MAX_LISTED + 5).map(frame).collect::<Vec<_>>(),
        });
        let r = Ref::Canvas {
            id: "levels/one".into(),
            part: None,
        };
        let out = canvas_from(&listed, &r, "levels/one").unwrap();
        assert_eq!(
            (out.kind.as_str(), out.title.as_str()),
            ("canvas", "Level one")
        );
        assert_eq!(
            out.meta["frames"],
            MAX_LISTED + 5,
            "the count is the whole canvas"
        );
        let rows = json_part(&out)["frames"].as_array().unwrap();
        assert_eq!(rows.len(), MAX_LISTED);
        assert_eq!(
            rows[0],
            json!({ "name": "Room 0", "type": "Room", "ref": "veistra://canvas/levels/one#frame=f0" })
        );
        let untitled =
            canvas_from(&json!({ "canvases": [{ "title": "" }] }), &r, "levels/one").unwrap();
        assert_eq!(
            untitled.title, "levels/one",
            "an empty title falls back to the id"
        );
        assert!(json_part(&untitled)["frames"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_comment_falls_back_to_its_record_only_when_no_pane_can_draw_it() {
        use veistra_rpc::INTERNAL_ERROR;
        let dir = tempfile::TempDir::new().unwrap();
        let shot = dir.path().join(".veistra/preview/canvas/world/c-1.png");
        write_png(&shot);
        let r = Ref::Canvas {
            id: "world".into(),
            part: Some(CanvasPart::Comment("c-1".into())),
        };
        let record = json!({ "id": "c-1", "text": "Move the door\nleft", "status": "open" });
        let resolve = |viewed, list: &dyn Fn() -> Result<Value, Fault>| {
            comment_from(dir.path(), &r, "world", "c-1", viewed, list)
        };
        let unused = || -> Result<Value, Fault> { panic!("drawn, so not listed") };

        let drawn = resolve(Ok(json!({ "comment": record, "path": shot })), &unused).unwrap();
        assert_eq!(drawn.title, "Move the door");
        assert!(matches!(drawn.parts.last(), Some(Part::Image { .. })));

        let closed = || {
            Err(RpcError::with_data(
                INTERNAL_ERROR,
                "no Canvas app is open",
                json!({ "kind": "canvas-not-open" }),
            ))
        };
        let listed = || Ok(json!({ "comments": [record.clone()] }));
        let undrawn = resolve(closed(), &listed).unwrap();
        assert_eq!(undrawn.meta["status"], "open");
        assert!(
            matches!(undrawn.parts.last(), Some(Part::Note { text }) if text == "No picture: no Canvas app is open")
        );
        let empty = || Ok(json!({ "comments": [] }));
        let err = resolve(closed(), &empty).unwrap_err();
        assert_eq!(err.reason, Reason::Missing);
        assert_eq!(err.message, "canvas `world` has no comment `c-1`");

        let gone = Err(RpcError::new(INTERNAL_ERROR, "the comment's frame is gone"));
        let err = resolve(gone, &unused).unwrap_err();
        assert_eq!(err.reason, Reason::Unavailable);
        assert_eq!(
            err.message, "the comment's frame is gone",
            "not a missing pane, so not listed"
        );
    }

    #[test]
    fn a_damaged_canvas_is_an_error_not_an_empty_canvas() {
        let r = Ref::Canvas {
            id: "broken".into(),
            part: None,
        };
        let listed = json!({
            "canvases": [],
            "frames": [],
            "unreadable": ["broken"],
            "problems": ["canvas/broken.json is not valid JSON: EOF"],
        });
        let err = canvas_from(&listed, &r, "broken").unwrap_err();
        assert_eq!(err.reason, Reason::Unreadable);
        assert_eq!(
            err.message,
            "canvas `broken` cannot be read: canvas/broken.json is not valid JSON: EOF"
        );
        let silent = canvas_from(&json!({ "canvases": [] }), &r, "broken").unwrap_err();
        assert_eq!(silent.message, "canvas `broken` cannot be read");
    }

    #[test]
    fn a_frame_brings_its_type_props_and_nonblank_text() {
        let detail = json!({
            "id": "f1",
            "name": "",
            "typeName": "Room",
            "props": { "light": "dim" },
            "contents": [{ "text": "Ball" }, { "text": "  " }, { "id": "no-text" }, { "text": "Door" }],
        });
        let r = Ref::Canvas {
            id: "world".into(),
            part: Some(CanvasPart::Frame("Lobby".into())),
        };
        let out = frame_from(&detail, &r, "world", "Lobby");
        assert_eq!(
            out.title, "Lobby",
            "an unnamed frame is called what it was asked as"
        );
        assert_eq!(out.detail.as_deref(), Some("Room on canvas world"));
        assert_eq!(out.meta["frameId"], "f1");
        assert_eq!(
            json_part(&out),
            &json!({ "type": "Room", "props": { "light": "dim" }, "text": ["Ball", "Door"] })
        );
        let untyped = frame_from(&json!({ "id": "f2", "name": "Hall" }), &r, "world", "f2");
        assert_eq!(untyped.detail.as_deref(), Some("frame on canvas world"));
        assert_eq!(json_part(&untyped)["text"], json!([]));
    }
}
