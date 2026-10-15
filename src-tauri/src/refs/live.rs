//! The references only a running Kaava can answer: canvases (read and drawn
//! through the Canvas app), Design Mode comments (kept in app state) and the
//! selection (reported by the panes on screen). Files, context items and
//! viewer comments are plain disk reads and go straight to [`super::resolve`].

use super::resolve::{self, Part, Resolved};
use super::uri::{CanvasPart, Ref};
use crate::apps::CallContext;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;

/// Most frames a canvas reference lists, and most text items a frame lists.
const MAX_LISTED: usize = 100;

/// Who is asking. The canvas records it on every call it answers. Only the
/// person resolves references so far; the context server adds the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    Human,
}

impl Actor {
    fn name(self) -> &'static str {
        match self {
            Actor::Human => "human",
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
    let root = ctx
        .project
        .as_deref()
        .ok_or("this cluster has no project open, so there is nothing to reference")?;
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

/// Refuse a canvas, or a comment on one, whose file is not inside the project
/// once links are followed. The Canvas app reads the files where it finds
/// them, so the test a file reference passes runs here, before it is asked.
fn canvas_inside(root: &Path, id: &str, part: Option<&CanvasPart>) -> Result<(), String> {
    use crate::apps::canvas;
    let mut files = vec![canvas::file_for(root, id)];
    if let Some(CanvasPart::Comment(c)) = part {
        files.push(canvas::comments::dir_for(root, id).join(format!("{c}.json")));
    }
    for file in files {
        let rel = crate::context::relative_to(root, &file)
            .ok_or_else(|| format!("canvas `{id}` is not in this project"))?;
        super::policy::contain(root, &rel)?;
    }
    Ok(())
}

fn canvas_call(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    method: &str,
    mut params: Value,
) -> Result<Value, String> {
    params["actor"] = json!(actor.name());
    crate::apps::call(app, ctx, "canvas", method, Some(params)).map_err(|e| e.message)
}

fn canvas(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    r: &Ref,
    id: &str,
) -> Result<Resolved, String> {
    let listed = canvas_call(app, ctx, actor, "canvas/frames", json!({ "canvas": id }))?;
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
    out.parts.push(Part::Json {
        value: json!({ "frames": rows }),
    });
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
    out.parts.push(Part::Json {
        value: json!({
            "type": detail["typeName"],
            "props": detail["props"],
            "text": texts,
        }),
    });
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

fn canvas_comment(
    app: &AppHandle,
    ctx: &CallContext,
    actor: Actor,
    root: &Path,
    r: &Ref,
    id: &str,
    comment: &str,
) -> Result<Resolved, String> {
    let viewed = canvas_call(
        app,
        ctx,
        actor,
        "canvas/view-comment",
        json!({ "id": id, "commentId": comment }),
    );
    let (record, picture) = match viewed {
        Ok(v) => (v["comment"].clone(), rendered(root, Ok(v))),
        // No Canvas pane to draw it: the comment itself still reads from disk.
        Err(why) => {
            let all = canvas_call(
                app,
                ctx,
                actor,
                "canvas/list-comments",
                json!({ "id": id, "status": "all" }),
            )?;
            let found = all["comments"]
                .as_array()
                .and_then(|cs| cs.iter().find(|c| c["id"] == json!(comment)).cloned())
                .ok_or_else(|| format!("canvas `{id}` has no comment `{comment}`"))?;
            (found, rendered(root, Err(why)))
        }
    };
    let text = record["text"].as_str().unwrap_or_default();
    let mut out = resolve::Resolved::empty(r, "comment", resolve::first_line(text));
    out.detail = Some(format!("comment on canvas {id}"));
    out.meta.insert("status".into(), record["status"].clone());
    out.meta.insert("author".into(), record["author"].clone());
    out.parts.push(Part::Text {
        text: text.to_string(),
        language: Some("markdown".into()),
        start_line: 1,
        truncated: false,
    });
    out.parts.push(Part::Json { value: record });
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
        Err(why) => {
            return note(format!(
                "No picture: {why}. Open the canvas in a Canvas pane to render one."
            ))
        }
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
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use tauri::Manager;
    let c = app
        .state::<crate::design_comments::Comments>()
        .get(id)
        .ok_or_else(|| format!("there is no Design Mode comment `{id}`"))?;
    let mut out = resolve::Resolved::empty(r, "design-comment", resolve::first_line(&c.request));
    out.detail = Some(format!("{} on {}", c.element.tag, c.page.title));
    out.meta.insert("status".into(), json!(c.status));
    out.parts.push(Part::Text {
        text: c.request.clone(),
        language: Some("markdown".into()),
        start_line: 1,
        truncated: false,
    });
    out.parts.push(Part::Json {
        value: json!({ "page": c.page, "selector": c.element.selector, "thread": c.thread }),
    });
    if let Some(bytes) = crate::design_comments::read_shot(app, id) {
        if bytes.len() as u64 <= resolve::MAX_IMAGE_BYTES {
            out.parts.push(Part::Image {
                mime: "image/png".into(),
                data_base64: BASE64.encode(bytes),
                width: None,
                height: None,
            });
        }
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

/// [`selection`] from what the panes reported.
fn selection_from(seen: Value, root: &Path, r: &Ref) -> Resolved {
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
        out.parts.push(Part::Text {
            text: text.to_string(),
            language: None,
            start_line: 1,
            truncated: seen["selectedTextLength"].as_u64() > Some(units),
        });
    }
    out.parts.push(Part::Json { value: seen });
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
        let longer = selection_from(seen("\u{e9}\u{e9}\u{e9}", 5), dir.path(), &Ref::Selection);
        assert!(cut(&longer), "five units selected, three sent");
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn link(target: &Path, at: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, at);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, at);
        made.is_ok()
    }

    #[test]
    fn a_canvas_or_its_comment_is_read_only_from_inside_the_project() {
        let (dir, away) = (
            tempfile::TempDir::new().unwrap(),
            tempfile::TempDir::new().unwrap(),
        );
        let (root, secret) = (dir.path(), away.path().join("secret.json"));
        write(&root.join("canvas/world.json"), "{}");
        write(&root.join("canvas/world.comments/c-1.json"), "{}");
        write(&secret, "{}");
        let comment = |c: &str| Some(CanvasPart::Comment(c.into()));
        assert!(canvas_inside(root, "world", None).is_ok());
        assert!(canvas_inside(root, "world", comment("c-1").as_ref()).is_ok());
        assert!(canvas_inside(root, "nope", None).is_err());
        if !link(&secret, &root.join("canvas/leak.canvas.json")) {
            eprintln!("skipped: cannot create symlinks here");
            return;
        }
        let err = canvas_inside(root, "leak", None).unwrap_err();
        assert!(err.contains("outside the project"), "{err}");
        assert!(link(&secret, &root.join("canvas/world.comments/c-2.json")));
        let err = canvas_inside(root, "world", comment("c-2").as_ref()).unwrap_err();
        assert!(err.contains("outside the project"), "{err}");
    }
}
