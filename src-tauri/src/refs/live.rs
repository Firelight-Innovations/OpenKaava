//! The references only a running Kaava can answer: canvases (read and drawn
//! through the Canvas app), Design Mode comments (kept in app state) and the
//! selection (reported by the panes on screen). Files, context items and
//! viewer comments are plain disk reads and go straight to [`super::resolve`].

use super::resolve::{self, Part, Resolved};
use super::uri::{CanvasPart, Ref};
use crate::apps::CallContext;
use kaava_rpc::RpcError;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;

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
) -> Result<Resolved, String> {
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

pub(super) fn root_of(ctx: &CallContext) -> Result<&Path, String> {
    ctx.project
        .as_deref()
        .ok_or_else(|| "this cluster has no project open, so there is nothing to reference".into())
}

/// Whether a reference names something that is there and may be shown,
/// reading no more than a file's first bytes: what `show` asks before the tab
/// is told to draw it. A secret is refused with the rule it falls under. A
/// gitignored file passes, because the tab draws it as withheld.
pub fn check(app: &AppHandle, ctx: &CallContext, r: &Ref) -> Result<(), String> {
    let root = root_of(ctx)?;
    let refuse =
        |rule: Option<&str>| rule.map_or(Ok(()), |rule| Err(resolve::secret_withheld(rule)));
    match r {
        Ref::File { path, .. } => {
            let found = super::policy::contain(root, path)?;
            refuse(resolve::secret_file(path, &found))
        }
        Ref::Context { id } => {
            let item = crate::context::get(root, id).map_err(|e| e.message)?;
            refuse(resolve::item_secret(root, &item))
        }
        Ref::Comment { id } => super::policy::contain(root, &format!(".kaava/comments/{id}.json"))
            .map(drop)
            .map_err(|_| format!("there is no comment `{id}` in this project")),
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
fn design_comment_exists(app: &AppHandle, id: &str) -> Result<(), String> {
    use tauri::Manager;
    let comments = app.state::<crate::design_comments::Comments>();
    comments
        .get(id)
        .map(drop)
        .ok_or_else(|| format!("there is no Design Mode comment `{id}`"))
}

#[cfg(not(feature = "design-mode"))]
fn design_comment_exists(app: &AppHandle, id: &str) -> Result<(), String> {
    design_comment(app, &Ref::DesignComment { id: id.into() }, id).map(drop)
}

/// Refuse a canvas, or a comment on one, when a file the Canvas app reads for
/// it is not inside the project once links are followed. The app reads files
/// where it finds them, so the test a file reference passes runs here, before
/// it is asked. That covers the canvas, each child its split frames name, and
/// the comment, which may have moved into a child with its frame.
pub(super) fn canvas_inside(
    root: &Path,
    id: &str,
    part: Option<&CanvasPart>,
) -> Result<(), String> {
    let children = canvas_files_inside(root, id)?;
    match part {
        Some(CanvasPart::Comment(c)) => comment_inside(root, id, &children, c),
        _ => Ok(()),
    }
}

/// The first half of [`canvas_inside`]: the canvas file and its children's.
/// Answers the children, so a caller checking many comments on one canvas
/// reads the canvas once.
pub(super) fn canvas_files_inside(root: &Path, id: &str) -> Result<Vec<String>, String> {
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
) -> Result<(), String> {
    use crate::apps::canvas;
    let homes = std::iter::once(id).chain(children.iter().map(String::as_str));
    let files: Vec<_> = homes
        .map(|home| canvas::comments::dir_for(root, home).join(format!("{c}.json")))
        .filter(|f| f.exists())
        .collect();
    if files.is_empty() {
        return Err(format!("canvas `{id}` has no comment `{c}`"));
    }
    files.iter().try_for_each(|f| file_inside(root, id, f))
}

/// Whether `file`, read for canvas `id`, is inside the root once links are
/// followed.
fn file_inside(root: &Path, id: &str, file: &Path) -> Result<(), String> {
    let rel = crate::context::relative_to(root, file)
        .ok_or_else(|| format!("canvas `{id}` is not in this project"))?;
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

pub(super) fn canvas_call(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    canvas_rpc(app, ctx, actor, method, params).map_err(|e| e.message)
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
) -> Result<Resolved, String> {
    let listed = canvas_call(app, ctx, actor, "canvas/frames", json!({ "canvas": id }))?;
    canvas_from(&listed, r, id)
}

/// A canvas from its `canvas/frames` answer: its frames, each with a reference.
/// The app answers for a damaged canvas with no canvases and the reason in
/// `problems`. That is an error here, so it never reads as an empty canvas.
fn canvas_from(listed: &Value, r: &Ref, id: &str) -> Result<Resolved, String> {
    if listed["canvases"].as_array().is_none_or(Vec::is_empty) {
        return Err(
            match listed.pointer("/problems/0").and_then(Value::as_str) {
                Some(why) => format!("canvas `{id}` cannot be read: {why}"),
                None => format!("canvas `{id}` cannot be read"),
            },
        );
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
) -> Result<Resolved, String> {
    let detail = canvas_call(
        app,
        ctx,
        actor,
        "canvas/frame",
        json!({ "canvas": id, "frame": frame }),
    )?;
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
) -> Result<Resolved, String> {
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
    list: impl FnOnce() -> Result<Value, String>,
) -> Result<Resolved, String> {
    let (record, picture) = match viewed {
        Ok(v) => (v["comment"].clone(), rendered(root, Ok(v))),
        Err(e) if no_pane(&e) => {
            let found = list()?["comments"]
                .as_array()
                .and_then(|cs| cs.iter().find(|c| c["id"] == json!(comment)).cloned())
                .ok_or_else(|| format!("canvas `{id}` has no comment `{comment}`"))?;
            (found, rendered(root, Err(e.message)))
        }
        Err(e) => return Err(e.message),
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
fn rendered(root: &Path, answer: Result<Value, String>) -> Part {
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
fn design_comment(app: &AppHandle, r: &Ref, id: &str) -> Result<Resolved, String> {
    use tauri::Manager;
    let c = app
        .state::<crate::design_comments::Comments>()
        .get(id)
        .ok_or_else(|| format!("there is no Design Mode comment `{id}`"))?;
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
fn design_comment(_app: &AppHandle, _r: &Ref, _id: &str) -> Result<Resolved, String> {
    Err("Design Mode is not part of this build, so it has no comments".into())
}

/// What the person has selected, read from the panes in this cluster.
fn selection(app: &AppHandle, ctx: &CallContext, root: &Path, r: &Ref) -> Result<Resolved, String> {
    let cluster = ctx
        .cluster_id
        .as_deref()
        .ok_or("this surface is not in a cluster, so it has no selection")?;
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
    fn a_rendered_picture_is_read_only_from_inside_the_project() {
        let (dir, away) = (
            tempfile::TempDir::new().unwrap(),
            tempfile::TempDir::new().unwrap(),
        );
        let here = dir.path().join(".kaava/preview/canvas/world/f1.png");
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
            json!([frame.to_string(), "kaava://file/src/main.gd"])
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

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A canvas whose one frame was split, its elements moved to canvas `child`.
    fn split_into(child: &str) -> String {
        json!({ "type": "excalidraw", "elements": [{
            "id": "f1",
            "type": "frame",
            "customData": { "kaava": { "subcanvas": true, "child": child } },
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
        assert!(err.contains("has no comment `c-9`"), "{err}");
        let children = canvas_files_inside(root, "world").unwrap();
        assert_eq!(children, ["world-f1"]);
        assert!(comment_inside(root, "world", &children, "c-3").is_ok());
        assert!(
            comment_inside(root, "world", &[], "c-3").is_err(),
            "a moved comment is found only through the children it moved to"
        );
        assert!(canvas_inside(root, "nope", None).is_err());

        write(&away.path().join("levels/inner.json"), "{}");
        links::folder(&away.path().join("levels"), &root.join("canvas/levels"));
        write(&root.join("canvas/hub.json"), &split_into("levels/inner"));
        let err = canvas_inside(root, "hub", None).unwrap_err();
        assert!(err.contains("outside the project"), "a linked child: {err}");
        let err = canvas_inside(root, "levels/inner", None).unwrap_err();
        assert!(
            err.contains("outside the project"),
            "a linked folder: {err}"
        );

        if !links::file(&secret, &root.join("canvas/leak.canvas.json")) {
            return;
        }
        let err = canvas_inside(root, "leak", None).unwrap_err();
        assert!(err.contains("outside the project"), "{err}");
        assert!(links::file(
            &secret,
            &root.join("canvas/world.comments/c-2.json")
        ));
        let err = canvas_inside(root, "world", comment("c-2").as_ref()).unwrap_err();
        assert!(err.contains("outside the project"), "{err}");
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
            json!({ "name": "Room 0", "type": "Room", "ref": "kaava://canvas/levels/one#frame=f0" })
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
        use kaava_rpc::INTERNAL_ERROR;
        let dir = tempfile::TempDir::new().unwrap();
        let shot = dir.path().join(".kaava/preview/canvas/world/c-1.png");
        write_png(&shot);
        let r = Ref::Canvas {
            id: "world".into(),
            part: Some(CanvasPart::Comment("c-1".into())),
        };
        let record = json!({ "id": "c-1", "text": "Move the door\nleft", "status": "open" });
        let resolve = |viewed, list: &dyn Fn() -> Result<Value, String>| {
            comment_from(dir.path(), &r, "world", "c-1", viewed, list)
        };
        let unused = || -> Result<Value, String> { panic!("drawn, so not listed") };

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
        assert_eq!(err, "canvas `world` has no comment `c-1`");

        let gone = Err(RpcError::new(INTERNAL_ERROR, "the comment's frame is gone"));
        let err = resolve(gone, &unused).unwrap_err();
        assert_eq!(
            err, "the comment's frame is gone",
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
        assert_eq!(
            err,
            "canvas `broken` cannot be read: canvas/broken.json is not valid JSON: EOF"
        );
        let silent = canvas_from(&json!({ "canvases": [] }), &r, "broken").unwrap_err();
        assert_eq!(silent, "canvas `broken` cannot be read");
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
