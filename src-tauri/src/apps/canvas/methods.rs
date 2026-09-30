//! The canvas methods an agent works through: diagrams, views, comments,
//! drawing, values and checkpoints.
//!
//! Split from `mod.rs`, which keeps the file format (read, write, validate) and
//! the dispatch table; this is what is built on top of it. Every method here
//! takes an `actor` of `"human"` or `"agent"`, the same rule Schematify's
//! methods follow, so a log of who changed a design never has to guess.
//!
//! Rejected: one `canvas/agent` method with a sub-command. Separate names are
//! what `app_call` lists, what `WRITE_METHODS` can gate one by one, and what an
//! agent can discover without reading a manual first.

use super::comments::{self, Region};
use super::diagrams::{self, Bounds, Diagram};
use super::store;
use super::webview::Webview;
use super::{bad, file_for, load, mtime_at, relative, stamp, validate_id, write_file};
use kaava_rpc::{RpcError, INVALID_PARAMS};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::Path;

/// The widest or tallest a view is drawn, in pixels, unless asked otherwise.
/// Big enough to read a 14 px label at scale 1, small enough to look at.
const MAX_VIEW_PX: u64 = 2400;

/// The margin kept around a comment's elements when rendering it.
const COMMENT_MARGIN: f64 = 32.0;

fn params_of(params: Option<&Value>) -> &Value {
    static NULL: Value = Value::Null;
    params.unwrap_or(&NULL)
}

fn string(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| bad(format!("{key} is required and must be a string")))
}

/// The `actor` every method here requires.
pub fn actor(params: &Value) -> Result<&'static str, RpcError> {
    match params.get("actor").and_then(Value::as_str) {
        Some("human") => Ok("human"),
        Some("agent") => Ok("agent"),
        Some(other) => Err(bad(format!(
            "actor must be \"human\" or \"agent\", got `{other}`"
        ))),
        None => Err(bad("actor is required: \"human\" or \"agent\"")),
    }
}

/// The canvas id param, validated, and the scene with its mtime.
fn open(root: &Path, params: &Value) -> Result<(String, Value, Option<u64>), RpcError> {
    let id = string(params, "id")?;
    validate_id(&id)?;
    let path = file_for(root, &id);
    if !path.is_file() {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!("there is no canvas `{id}` ({})", relative(root, &path)),
            json!({ "kind": "missing" }),
        ));
    }
    let mtime = mtime_at(&path);
    Ok((id, load(&path)?, mtime))
}

/// The diagram `wanted` names, or an error listing the ones there are.
fn diagram<'a>(all: &'a [Diagram], wanted: &str) -> Result<&'a Diagram, RpcError> {
    diagrams::find(all, wanted).ok_or_else(|| {
        let known: Vec<String> = all
            .iter()
            .map(|d| d.id.clone().unwrap_or_else(|| d.element_id.clone()))
            .collect();
        RpcError::with_data(
            INVALID_PARAMS,
            format!(
                "no diagram `{wanted}` on this canvas; there are: {}",
                if known.is_empty() { "none".to_string() } else { known.join(", ") }
            ),
            json!({ "kind": "missing", "diagrams": known }),
        )
    })
}

fn key_of(d: &Diagram) -> String {
    d.id.clone().unwrap_or_else(|| d.element_id.clone())
}

/// Save `scene` over the canvas, refusing if the file moved since `base`.
fn save_scene(
    root: &Path,
    id: &str,
    mut scene: Value,
    base: Option<u64>,
    who: &str,
) -> Result<Option<u64>, RpcError> {
    let path = file_for(root, id);
    let now = mtime_at(&path);
    if now != base {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!(
                "{} changed while this edit was being made; read it again and retry",
                relative(root, &path)
            ),
            json!({ "kind": "stale", "mtime": now }),
        ));
    }
    store::externalize(root, id, &mut scene)?;
    stamp(&mut scene, id, who);
    write_file(&path, &scene)?;
    Ok(mtime_at(&path))
}

fn live_count(scene: &Value) -> usize {
    diagrams::elements_of(scene)
        .iter()
        .filter(|e| e.get("isDeleted").and_then(Value::as_bool) != Some(true))
        .count()
}

// --- reading ----------------------------------------------------------------

pub fn list_diagrams(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (id, scene, _) = open(root, p)?;
    let mut out = diagrams::list_json(&scene);
    out["canvas"] = json!(id);
    out["path"] = json!(relative(root, &file_for(root, &id)));
    Ok(out)
}

pub fn describe_diagram(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (_, scene, _) = open(root, p)?;
    let all = diagrams::list(&scene);
    let d = diagram(&all, &string(p, "diagram")?)?;
    let mut out = diagrams::describe(&scene, d);
    out["diagram"]["path"] = json!(diagrams::path_of(&all, d));
    Ok(out)
}

pub fn coverage(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (_, scene, _) = open(root, p)?;
    let checklist = diagrams::checklist_of(&scene, p.get("checklist"));
    Ok(diagrams::coverage(&scene, &checklist))
}

pub fn values(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (_, scene, _) = open(root, p)?;
    Ok(diagrams::values_report(&scene))
}

pub fn refs(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (id, scene, _) = open(root, p)?;
    let mut out = store::list_refs(root, &id, &scene);
    out["dir"] = json!(relative(root, &store::refs_dir(root, &id)));
    Ok(out)
}

pub fn checkpoints(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (id, _, _) = open(root, p)?;
    Ok(json!({ "checkpoints": store::checkpoint_names(root, &id)? }))
}

// --- views ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewParams {
    #[serde(default)]
    region: Option<Region>,
    #[serde(default)]
    scale: Option<f64>,
    #[serde(default)]
    max_dimension: Option<u64>,
    #[serde(default)]
    theme: Option<String>,
}

/// Draw `region` (frame-relative) of `d`, or all of it, into `file`.
fn render(
    root: &Path,
    web: &dyn Webview,
    id: &str,
    mut scene: Value,
    d: &Diagram,
    view: &ViewParams,
    file: &Path,
) -> Result<Value, RpcError> {
    let missing = store::inflate(root, id, &mut scene);
    let theme = match view.theme.as_deref() {
        None | Some("light") => "light",
        Some("dark") => "dark",
        Some(other) => return Err(bad(format!("theme must be light or dark, got `{other}`"))),
    };
    let payload = json!({
        "scene": scene,
        "frameId": d.element_id,
        "region": view.region,
        "scale": view.scale,
        "maxDimension": view.max_dimension.unwrap_or(MAX_VIEW_PX),
        "theme": theme,
    });
    let out = web.run("render", &payload, None)?;
    let png = out
        .get("png")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("the canvas frontend returned no image"))?;
    let bytes = store::write_png(file, png)?;
    Ok(json!({
        "path": file.display().to_string(),
        "relative": relative(root, file),
        "width": out.get("width"),
        "height": out.get("height"),
        "scale": out.get("scale"),
        "region": view.region,
        "bytes": bytes,
        "missingRefs": missing,
        "hint": "Read the PNG at `path` to see the diagram. It is overwritten by the next view \
                 of the same diagram.",
    }))
}

pub fn view_diagram(root: &Path, web: &dyn Webview, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (id, scene, _) = open(root, p)?;
    let view: ViewParams =
        serde_json::from_value(p.clone()).map_err(|e| bad(format!("bad params: {e}")))?;
    let all = diagrams::list(&scene);
    let d = diagram(&all, &string(p, "diagram")?)?.clone();
    let file = store::view_path(root, &id, &key_of(&d), view.region.is_some())?;
    let mut out = render(root, web, &id, scene, &d, &view, &file)?;
    out["diagram"] = json!({ "id": d.id, "title": d.title, "summary": d.summary,
                             "frameElementId": d.element_id, "bounds": d.bounds.to_json() });
    Ok(out)
}

/// `canvas/save`: flush the open editor's pending edits, if it has this
/// canvas, then report what is on disk, which is what an agent should trust.
pub fn save(root: &Path, web: &dyn Webview, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let id = string(p, "id")?;
    validate_id(&id)?;
    let flushed = match web.run("flush", &json!({ "canvas": id }), Some(&id)) {
        Ok(v) => json!({ "editorOpen": true, "result": v }),
        Err(e) if e.data.as_ref().is_some_and(|d| d["kind"] == "canvas-not-open") => {
            json!({ "editorOpen": false })
        }
        Err(e) => return Err(e),
    };
    let (_, scene, mtime) = open(root, p)?;
    let path = file_for(root, &id);
    let all = diagrams::list(&scene);
    let (comments, _) = comments::load_all(root, &id);
    Ok(json!({
        "id": id,
        "path": relative(root, &path),
        "absolutePath": path.display().to_string(),
        "mtime": mtime,
        "elementCount": live_count(&scene),
        "diagrams": all.iter().map(key_of).collect::<Vec<_>>(),
        "openComments": comments.iter().filter(|c| c.status == "open").count(),
        "flush": flushed,
    }))
}

// --- drawing ----------------------------------------------------------------

/// `canvas/add-shapes` and `canvas/import-mermaid`: the frontend lays out and
/// measures, Rust checkpoints and writes.
pub fn author(
    root: &Path,
    web: &dyn Webview,
    params: Option<&Value>,
    op: &str,
) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let (id, mut scene, base) = open(root, p)?;
    let mut spec = p.clone();
    if let Some(obj) = spec.as_object_mut() {
        obj.remove("id");
        obj.remove("actor");
    }
    // The layout needs each image's `kaavaRef` to place `{type: image, ref}`,
    // and never its bytes, so an inline `dataURL` stays behind.
    let mut light = scene.clone();
    if let Some(files) = light.get_mut("files").and_then(Value::as_object_mut) {
        for entry in files.values_mut() {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("dataURL");
            }
        }
    }
    let out = web.run(op, &json!({ "scene": light, "spec": spec }), None)?;
    let elements = out
        .get("elements")
        .filter(|e| e.is_array())
        .cloned()
        .ok_or_else(|| bad("the canvas frontend returned no elements"))?;
    let checkpoint = store::checkpoint(root, &id, op)?;
    scene["elements"] = elements;
    if let Some(values) = out.get("values").and_then(Value::as_object) {
        merge_values(&mut scene, values);
        diagrams::apply_values(&mut scene);
    }
    let mtime = save_scene(root, &id, scene.clone(), base, who)?;
    Ok(json!({
        "ids": out.get("ids"),
        "frame": out.get("frame"),
        "warnings": out.get("warnings").cloned().unwrap_or(json!([])),
        "checkpoint": checkpoint,
        "mtime": mtime,
        "elementCount": live_count(&scene),
        "hint": "view-diagram the frame to check the result; restore-checkpoint undoes this edit",
    }))
}

fn merge_values(scene: &mut Value, incoming: &Map<String, Value>) {
    if !scene.get("kaava").is_some_and(Value::is_object) {
        scene["kaava"] = json!({});
    }
    let kaava = &mut scene["kaava"];
    if !kaava.get("values").is_some_and(Value::is_object) {
        kaava["values"] = json!({});
    }
    let Some(table) = kaava["values"].as_object_mut() else {
        return;
    };
    for (name, v) in incoming {
        match v {
            Value::Null => {
                table.remove(name);
            }
            Value::Object(o) if o.contains_key("value") => {
                table.insert(name.clone(), v.clone());
            }
            other => {
                let mut entry = table
                    .get(name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                entry.insert("value".into(), other.clone());
                table.insert(name.clone(), Value::Object(entry));
            }
        }
    }
}

/// `canvas/set-values`: change the value table and every text and spec field
/// linked to it, in one checkpointed write.
pub fn set_values(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let (id, mut scene, base) = open(root, p)?;
    let incoming = p
        .get("values")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("values is required: { name: number | string | { value, unit?, spec? } }"))?;
    for name in incoming.keys() {
        let ok = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if !ok {
            return Err(bad(format!(
                "value name `{name}` must be letters, digits, - _ and ."
            )));
        }
    }
    let checkpoint = store::checkpoint(root, &id, "set-values")?;
    merge_values(&mut scene, incoming);
    let changed = diagrams::apply_values(&mut scene);
    let mtime = save_scene(root, &id, scene.clone(), base, who)?;
    let mut out = diagrams::values_report(&scene);
    out["changedElements"] = json!(changed);
    out["checkpoint"] = json!(checkpoint);
    out["mtime"] = json!(mtime);
    Ok(out)
}

pub fn restore_checkpoint(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let (id, _, base) = open(root, p)?;
    let wanted = p.get("checkpoint").and_then(Value::as_str);
    let (name, scene) = store::checkpoint_scene(root, &id, wanted)?;
    super::validate_scene(&scene).map_err(|why| bad(format!("checkpoint {name}: {why}")))?;
    let saved = store::checkpoint(root, &id, "before-restore")?;
    let mtime = save_scene(root, &id, scene, base, who)?;
    Ok(json!({ "restored": name, "previousSavedAs": saved, "mtime": mtime }))
}

// --- comments ---------------------------------------------------------------

pub fn list_comments(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let id = string(p, "id")?;
    validate_id(&id)?;
    comments::require_canvas(root, &id)?;
    let status = p.get("status").and_then(Value::as_str).unwrap_or("open");
    if !matches!(status, "open" | "resolved" | "all") {
        return Err(bad("status must be open, resolved or all"));
    }
    let wanted_diagram = p.get("diagram").and_then(Value::as_str);
    let (all, unreadable) = comments::load_all(root, &id);
    let open_count = all.iter().filter(|c| c.status == "open").count();
    let rows: Vec<Value> = all
        .iter()
        .filter(|c| status == "all" || c.status == status)
        .filter(|c| wanted_diagram.is_none_or(|d| c.frame_id == d))
        .map(|c| comments::to_json(root, c))
        .collect();
    Ok(json!({
        "comments": rows,
        "open": open_count,
        "total": all.len(),
        "unreadable": unreadable,
    }))
}

pub fn create_comment(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let (id, scene, _) = open(root, p)?;
    let cp: comments::CreateParams =
        serde_json::from_value(p.clone()).map_err(|e| bad(format!("bad params: {e}")))?;
    let all = diagrams::list(&scene);
    let d = diagram(&all, &cp.diagram)?;
    let known: std::collections::HashSet<&str> = diagrams::elements_of(&scene)
        .iter()
        .filter_map(|e| e.get("id").and_then(Value::as_str))
        .collect();
    if let Some(stray) = cp.element_ids.iter().find(|e| !known.contains(e.as_str())) {
        return Err(bad(format!("element `{stray}` is not on this canvas")));
    }
    let c = comments::create(root, &id, &key_of(d), cp, who)?;
    Ok(comments::to_json(root, &c))
}

pub fn resolve_comment(root: &Path, params: Option<&Value>, resolved: bool) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let id = string(p, "id")?;
    validate_id(&id)?;
    let comment_id = string(p, "commentId")?;
    let note = p.get("note").and_then(Value::as_str);
    let c = comments::set_status(root, &id, &comment_id, resolved, note, who)?;
    Ok(comments::to_json(root, &c))
}

/// The frame-relative box a comment points at: its region, else the union of
/// its elements' boxes with a margin, else `None` (the whole frame).
pub fn comment_region(scene: &Value, d: &Diagram, c: &comments::Comment) -> Option<Region> {
    if let Some(r) = c.region {
        return Some(r);
    }
    let boxes: Vec<Bounds> = diagrams::elements_of(scene)
        .iter()
        .filter(|e| {
            e.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| c.element_ids.iter().any(|x| x == id))
        })
        .map(diagrams::bounds_of)
        .collect();
    let first = *boxes.first()?;
    let all = boxes.iter().fold(first, |acc, b| acc.union(*b));
    Some(Region {
        x: all.x - d.bounds.x - COMMENT_MARGIN,
        y: all.y - d.bounds.y - COMMENT_MARGIN,
        width: all.width + 2.0 * COMMENT_MARGIN,
        height: all.height + 2.0 * COMMENT_MARGIN,
    })
}

pub fn view_comment(root: &Path, web: &dyn Webview, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (id, scene, _) = open(root, p)?;
    let c = comments::load_one(root, &id, &string(p, "commentId")?)?;
    let all = diagrams::list(&scene);
    let d = diagram(&all, &c.frame_id)?.clone();
    let region = comment_region(&scene, &d, &c);
    let view = ViewParams {
        region,
        scale: p.get("scale").and_then(Value::as_f64).or(Some(2.0)),
        max_dimension: None,
        theme: p.get("theme").and_then(Value::as_str).map(str::to_owned),
    };
    let file = store::view_path(root, &id, &format!("{}-comment", key_of(&d)), true)?;
    let mut out = render(root, web, &id, scene, &d, &view, &file)?;
    out["comment"] = comments::to_json(root, &c);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::canvas::call_with;
    use crate::apps::CallContext;
    use std::cell::RefCell;
    use tempfile::TempDir;

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    /// A webview that records what it was asked and answers like the frontend.
    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<(String, Value)>>,
    }

    impl Webview for Fake {
        fn run(&self, op: &str, payload: &Value, canvas: Option<&str>) -> Result<Value, RpcError> {
            self.calls.borrow_mut().push((op.to_string(), payload.clone()));
            match op {
                "render" => Ok(json!({ "png": PNG_1X1, "width": 1, "height": 1, "scale": 1 })),
                "flush" if canvas == Some("open") => Ok(json!({ "saved": true })),
                "flush" => Err(super::super::webview::not_open()),
                "addShapes" => {
                    let mut elements = payload["scene"]["elements"].as_array().cloned().unwrap();
                    elements.push(json!({ "id": "new:box", "type": "rectangle", "frameId": "f1",
                                          "x": 120, "y": 70, "width": 10, "height": 10 }));
                    Ok(json!({ "elements": elements, "ids": { "box": "new:box" },
                               "values": { "gravity": 30 } }))
                }
                _ => Err(super::super::webview::not_open()),
            }
        }
    }

    fn scene() -> Value {
        json!({
            "type": "excalidraw",
            "elements": [
                { "id": "f1", "type": "frame", "name": "Playfield", "x": 100, "y": 50,
                  "width": 400, "height": 300,
                  "customData": { "kaava": { "diagram": { "id": "playfield", "title": "Playfield",
                                                          "covers": ["physics"] } } } },
                { "id": "ball", "type": "ellipse", "frameId": "f1", "x": 200, "y": 150,
                  "width": 20, "height": 20 },
            ],
            "files": {},
        })
    }

    fn setup() -> TempDir {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("canvas/game.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, scene().to_string()).unwrap();
        dir
    }

    fn run(dir: &TempDir, web: &Fake, method: &str, params: Value) -> Result<Value, RpcError> {
        let ctx = CallContext {
            cluster_id: Some("c1".into()),
            project: Some(dir.path().to_path_buf()),
        };
        call_with(&ctx, false, web, method, Some(params))
    }

    #[test]
    fn every_agent_method_requires_a_human_or_agent_actor() {
        let dir = setup();
        let web = Fake::default();
        for method in [
            "canvas/list-diagrams",
            "canvas/describe-diagram",
            "canvas/view-diagram",
            "canvas/save",
            "canvas/add-shapes",
            "canvas/list-comments",
            "canvas/create-comment",
            "canvas/coverage",
            "canvas/values",
            "canvas/set-values",
        ] {
            let err = run(&dir, &web, method, json!({ "id": "game" })).unwrap_err();
            assert!(err.message.contains("actor"), "{method}: {}", err.message);
            let sys = run(&dir, &web, method, json!({ "id": "game", "actor": "system" }))
                .unwrap_err();
            assert!(sys.message.contains("actor"), "{method}: {}", sys.message);
        }
    }

    #[test]
    fn view_diagram_renders_the_frame_and_overwrites_one_file() {
        let dir = setup();
        let web = Fake::default();
        let params = json!({ "id": "game", "diagram": "playfield", "actor": "agent" });
        let first = run(&dir, &web, "canvas/view-diagram", params.clone()).unwrap();
        run(&dir, &web, "canvas/view-diagram", params).unwrap();
        assert_eq!(first["relative"], ".kaava/canvas-views/game/playfield.png");
        let folder = dir.path().join(".kaava/canvas-views/game");
        assert_eq!(std::fs::read_dir(folder).unwrap().count(), 1);
        let (op, payload) = web.calls.borrow()[0].clone();
        assert_eq!(op, "render");
        assert_eq!(payload["frameId"], "f1");
        assert_eq!(payload["theme"], "light");
    }

    #[test]
    fn view_diagram_without_a_canvas_open_says_so() {
        let dir = setup();
        let ctx = CallContext {
            cluster_id: None,
            project: Some(dir.path().to_path_buf()),
        };
        let err = crate::apps::canvas::call(
            &ctx,
            false,
            "canvas/view-diagram",
            Some(json!({ "id": "game", "diagram": "playfield", "actor": "agent" })),
        )
        .unwrap_err();
        assert_eq!(err.data.unwrap()["kind"], "canvas-not-open");
    }

    #[test]
    fn a_missing_diagram_lists_the_ones_there_are() {
        let dir = setup();
        let err = run(
            &dir,
            &Fake::default(),
            "canvas/describe-diagram",
            json!({ "id": "game", "diagram": "nope", "actor": "agent" }),
        )
        .unwrap_err();
        assert!(err.message.contains("playfield"), "{}", err.message);
    }

    #[test]
    fn save_reports_the_file_whether_or_not_the_editor_is_open() {
        let dir = setup();
        let out = run(
            &dir,
            &Fake::default(),
            "canvas/save",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert_eq!(out["elementCount"], 2);
        assert_eq!(out["path"], "canvas/game.json");
        assert_eq!(out["flush"]["editorOpen"], false);
        assert_eq!(out["diagrams"], json!(["playfield"]));
    }

    #[test]
    fn add_shapes_checkpoints_then_writes_what_the_frontend_laid_out() {
        let dir = setup();
        let web = Fake::default();
        let out = run(
            &dir,
            &web,
            "canvas/add-shapes",
            json!({ "id": "game", "actor": "agent", "frame": { "id": "playfield" },
                    "shapes": [{ "id": "box", "type": "rectangle" }] }),
        )
        .unwrap();
        assert_eq!(out["ids"]["box"], "new:box");
        assert!(out["checkpoint"].is_string());
        let saved: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("canvas/game.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["elements"].as_array().unwrap().len(), 3);
        assert_eq!(saved["kaava"]["updated_by"], "agent");
        assert_eq!(saved["kaava"]["values"]["gravity"]["value"], 30);
        let (_, payload) = web.calls.borrow()[0].clone();
        assert_eq!(payload["scene"]["files"], json!({}));
        assert!(payload["spec"].get("actor").is_none());
        let back = run(
            &dir,
            &web,
            "canvas/restore-checkpoint",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert!(back["restored"].is_string());
        let restored: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("canvas/game.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(restored["elements"].as_array().unwrap().len(), 2);
    }

    /// The layout places `{type: image, ref: "refs/a.png"}` by finding that
    /// `kaavaRef` in `files`. Dropping `files` to keep the payload small made
    /// every image placement fail with "no reference image"; only the bytes
    /// may stay behind.
    #[test]
    fn add_shapes_sends_image_refs_but_not_their_bytes() {
        let dir = setup();
        let mut with_image = scene();
        with_image["files"] = json!({ "img1": { "id": "img1", "mimeType": "image/png",
            "kaavaRef": "refs/a.png", "dataURL": "data:image/png;base64,AAAA" } });
        std::fs::write(dir.path().join("canvas/game.json"), with_image.to_string()).unwrap();
        let web = Fake::default();
        run(
            &dir,
            &web,
            "canvas/add-shapes",
            json!({ "id": "game", "actor": "agent", "frame": { "id": "playfield" }, "shapes": [] }),
        )
        .unwrap();
        let (_, payload) = web.calls.borrow()[0].clone();
        let sent = &payload["scene"]["files"]["img1"];
        assert_eq!(sent["kaavaRef"], "refs/a.png");
        assert!(sent.get("dataURL").is_none(), "{sent}");
    }

    #[test]
    fn the_comment_loop_creates_lists_views_and_resolves() {
        let dir = setup();
        let web = Fake::default();
        let c = run(
            &dir,
            &web,
            "canvas/create-comment",
            json!({ "id": "game", "actor": "human", "diagram": "playfield",
                    "elementIds": ["ball"], "text": "ball overlaps the pillar" }),
        )
        .unwrap();
        assert_eq!(c["frameId"], "playfield");
        assert_eq!(c["author"], "human");
        let listed = run(
            &dir,
            &web,
            "canvas/list-comments",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert_eq!(listed["open"], 1);
        let cid = c["id"].as_str().unwrap();
        let view = run(
            &dir,
            &web,
            "canvas/view-comment",
            json!({ "id": "game", "actor": "agent", "commentId": cid }),
        )
        .unwrap();
        assert!(view["relative"].as_str().unwrap().ends_with("playfield-comment.region.png"));
        let (_, payload) = web.calls.borrow()[0].clone();
        assert_eq!(payload["region"]["x"], 100.0 - COMMENT_MARGIN);
        assert_eq!(payload["region"]["width"], 20.0 + 2.0 * COMMENT_MARGIN);
        let done = run(
            &dir,
            &web,
            "canvas/resolve-comment",
            json!({ "id": "game", "actor": "agent", "commentId": cid, "note": "moved it" }),
        )
        .unwrap();
        assert_eq!(done["status"], "resolved");
        let open = run(
            &dir,
            &web,
            "canvas/list-comments",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert_eq!(open["comments"], json!([]));
    }

    #[test]
    fn a_comment_on_an_element_that_is_not_there_is_refused() {
        let dir = setup();
        let err = run(
            &dir,
            &Fake::default(),
            "canvas/create-comment",
            json!({ "id": "game", "actor": "human", "diagram": "playfield",
                    "elementIds": ["ghost"], "text": "x" }),
        )
        .unwrap_err();
        assert!(err.message.contains("ghost"));
    }

    #[test]
    fn set_values_updates_the_table_and_reports() {
        let dir = setup();
        let out = run(
            &dir,
            &Fake::default(),
            "canvas/set-values",
            json!({ "id": "game", "actor": "agent", "values": { "gravity": 30, "gap": { "value": 3.6, "unit": "u" } } }),
        )
        .unwrap();
        assert_eq!(out["values"]["gravity"]["value"], 30);
        assert_eq!(out["values"]["gap"]["unit"], "u");
        assert_eq!(out["consistent"], true);
        let bad_name = run(
            &dir,
            &Fake::default(),
            "canvas/set-values",
            json!({ "id": "game", "actor": "agent", "values": { "a b": 1 } }),
        );
        assert!(bad_name.is_err());
    }

    #[test]
    fn coverage_uses_the_game_checklist_by_default() {
        let dir = setup();
        let out = run(
            &dir,
            &Fake::default(),
            "canvas/coverage",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert_eq!(out["checklist"].as_array().unwrap().len(), 8);
        assert!(out["missing"].as_array().unwrap().contains(&json!("audio")));
    }
}
