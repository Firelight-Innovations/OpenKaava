//! The methods that make frames the unit of detail: types, frame listing and
//! search, one frame's detail and picture, and the nested-canvas tree.
//!
//! Params and results are plain JSON, documented on each handler, so a tool
//! server can expose them as they stand. Every method takes the `actor` rule of
//! the rest of the app (`"human"` or `"agent"`).

use super::frames::{self, Frame};
use super::methods::{actor, open, params_of, render, save_scene, string, ViewParams};
use super::store;
use super::types::{self, TypeDef};
use super::webview::Webview;
use super::{bad, file_for, files, load, relative, validate_id, DIR};
use kaava_rpc::RpcError;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The most canvases a `recursive` walk visits, and how deep it goes.
const WALK_MAX: usize = 200;
const WALK_DEPTH: usize = 8;

/// A canvas id from what a caller typed: `balls`, `levels/ward-b`, or the path
/// `canvas/levels/ward-b.json`.
pub fn canvas_id(raw: &str) -> Result<String, RpcError> {
    let raw = raw.trim().replace('\\', "/");
    let raw = raw.strip_prefix(&format!("{DIR}/")).unwrap_or(&raw);
    let raw = raw
        .strip_suffix(".canvas.json")
        .or_else(|| raw.strip_suffix(".json"))
        .unwrap_or(raw);
    validate_id(raw)?;
    Ok(raw.to_string())
}

fn optional_canvas(p: &Value, key: &str) -> Result<Option<String>, RpcError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => canvas_id(s).map(Some),
        Some(_) => Err(bad(format!("{key} must be a canvas id or path"))),
    }
}

fn flag(p: &Value, key: &str) -> bool {
    p.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// The parent a canvas file names, if it can be read.
pub fn parent_of(root: &Path, id: &str) -> Option<String> {
    let path = file_for(root, id);
    let scene = load(&path).ok()?;
    scene
        .get("kaava")?
        .get("parent")?
        .as_str()
        .map(str::to_owned)
}

/// Refuse a scene that would put a canvas under itself: a `kaava.parent` that
/// is the canvas or one of its descendants, or a frame linking to the canvas
/// itself or to one of its ancestors.
pub fn check_links(root: &Path, id: &str, scene: &Value) -> Result<(), RpcError> {
    let up = |c: &str| parent_of(root, c);
    if let Some(parent) = scene
        .get("kaava")
        .and_then(|k| k.get("parent"))
        .and_then(Value::as_str)
    {
        if frames::would_cycle(id, parent, up) {
            return Err(bad(format!(
                "canvas `{id}` cannot have parent `{parent}`: that would put it inside itself"
            )));
        }
    }
    for child in frames::child_links(scene) {
        if frames::would_cycle(&child, id, up) {
            return Err(bad(format!(
                "a frame in `{id}` links to `{child}`, which is `{id}` or one of its ancestors; \
                 nested canvases may not loop"
            )));
        }
    }
    Ok(())
}

// --- types --------------------------------------------------------------------

/// `canvas/types` `{actor}` -> `{builtin: [TypeDef], custom: [TypeDef], path, problem}`.
/// A TypeDef is `{id, name, color, icon, description, builtin, fields: [{key, label,
/// kind, default?, options?, help?}]}`; `kind` is text, multiline, number, enum,
/// path-list or bool.
pub fn types(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (all, problem) = types::all(root);
    let (builtin, custom): (Vec<&TypeDef>, Vec<&TypeDef>) = all.iter().partition(|t| t.builtin);
    Ok(json!({
        "builtin": builtin.iter().map(|t| t.to_json()).collect::<Vec<_>>(),
        "custom": custom.iter().map(|t| t.to_json()).collect::<Vec<_>>(),
        "path": relative(root, &types::types_path(root)),
        "problem": problem,
    }))
}

/// `canvas/save-type` `{actor, type: {id?, name, color, icon, description?, fields}}`
/// adds or replaces a custom type. `id` defaults to a slug of `name`.
pub fn save_type(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let mut raw = p
        .get("type")
        .cloned()
        .filter(Value::is_object)
        .ok_or_else(|| bad("type is required: { id?, name, color, icon, fields }"))?;
    if raw
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        let name = raw.get("name").and_then(Value::as_str).unwrap_or("");
        raw["id"] = json!(types::id_from_name(name));
    }
    let def: TypeDef = serde_json::from_value(raw).map_err(|e| bad(format!("bad type: {e}")))?;
    let saved = types::save(root, def)?;
    Ok(json!({ "type": saved.to_json() }))
}

/// `canvas/delete-type` `{actor, id}`. Frames that used the type keep their values.
pub fn delete_type(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let id = string(p, "id")?;
    Ok(json!({ "id": id, "deleted": types::delete(root, &id)? }))
}

// --- reading frames -----------------------------------------------------------

struct Read {
    id: String,
    title: String,
    scene: Value,
    frames: Vec<Frame>,
    legacy: Vec<frames::LegacyCard>,
}

fn read_canvas(root: &Path, id: &str) -> Result<Read, RpcError> {
    let path = file_for(root, id);
    if !path.is_file() {
        return Err(RpcError::with_data(
            kaava_rpc::INVALID_PARAMS,
            format!("there is no canvas `{id}` ({})", relative(root, &path)),
            json!({ "kind": "missing" }),
        ));
    }
    let mut scene = load(&path)?;
    let migration = frames::migrate(&mut scene);
    let title = scene
        .pointer("/kaava/title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| id.rsplit('/').next().unwrap_or(id))
        .to_string();
    Ok(Read {
        id: id.to_string(),
        title,
        frames: frames::list(&scene),
        legacy: migration.legacy,
        scene,
    })
}

/// The canvases a listing covers, in order: the one asked for, plus its
/// descendants by frame link when `recursive`; or every canvas in the project.
fn scope(
    root: &Path,
    only: Option<&str>,
    recursive: bool,
) -> (Vec<Read>, Vec<String>, Vec<String>) {
    let mut out = Vec::new();
    let mut unreadable = Vec::new();
    let mut problems = Vec::new();
    let Some(start) = only else {
        for (id, _) in files(root) {
            match read_canvas(root, &id) {
                Ok(r) => out.push(r),
                Err(_) => unreadable.push(id),
            }
        }
        return (out, unreadable, problems);
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue = vec![(start.to_string(), 0usize)];
    while let Some((id, depth)) = queue.first().cloned() {
        queue.remove(0);
        if !seen.insert(id.clone()) || out.len() >= WALK_MAX {
            continue;
        }
        match read_canvas(root, &id) {
            Ok(r) => {
                if recursive && depth < WALK_DEPTH {
                    for f in &r.frames {
                        if let Some(child) = &f.child {
                            if file_for(root, child).is_file() {
                                queue.push((child.clone(), depth + 1));
                            } else {
                                problems.push(format!(
                                    "frame `{}` in `{}` links to `{child}`, which does not exist",
                                    f.name, r.id
                                ));
                            }
                        }
                    }
                }
                out.push(r);
            }
            Err(e) if depth == 0 => {
                unreadable.push(id);
                problems.push(e.message);
            }
            Err(_) => unreadable.push(id),
        }
    }
    (out, unreadable, problems)
}

fn legacy_json(reads: &[Read]) -> Vec<Value> {
    reads
        .iter()
        .flat_map(|r| {
            r.legacy.iter().map(|c| {
                json!({ "canvas": r.id, "elementId": c.element_id, "name": c.name,
                        "note": "A spec card on a shape, not a frame. Wrap the shape in a frame \
                                 and it becomes a Model frame." })
            })
        })
        .collect()
}

/// `canvas/frames` `{actor, canvas?, recursive?}`: the labelled frames of one
/// canvas (id or `canvas/x.json` path), or of every canvas when `canvas` is
/// omitted. With `canvas` and `recursive: true` the canvases its frames link to
/// are walked too, to a depth of 8.
///
/// Result: `{scope, canvases: [{id, title}], frames: [Frame], legacyCards,
/// unreadable, problems}`. A Frame is `{canvas, id, name, type, typeName,
/// typeKnown, props, extraProps, bbox{x,y,width,height}, childCanvas, elements}`;
/// `props` holds every field of the type, defaults filled in; `extraProps` holds
/// stored values the type does not define.
pub fn frames_list(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let only = optional_canvas(p, "canvas")?;
    let (reads, unreadable, problems) = scope(root, only.as_deref(), flag(p, "recursive"));
    let (table, _) = types::all(root);
    let rows: Vec<Value> = reads
        .iter()
        .flat_map(|r| {
            r.frames
                .iter()
                .map(|f| frames::frame_json(&r.id, f, &table))
        })
        .collect();
    Ok(json!({
        "scope": if only.is_some() { "canvas" } else { "project" },
        "canvases": reads.iter().map(|r| json!({ "id": r.id, "title": r.title })).collect::<Vec<_>>(),
        "frames": rows,
        "legacyCards": legacy_json(&reads),
        "unreadable": unreadable,
        "problems": problems,
    }))
}

/// `canvas/search-frames` `{actor, query?, type?, canvas?, limit?}`: frames whose
/// name, type or property values contain every word of `query` (case-insensitive),
/// best first; `type` keeps one type id. At least one of `query` and `type` is
/// required. Searches every canvas unless `canvas` is given.
///
/// Result: `{query, type, total, matches: [Frame + {score, matchedIn: ["name" |
/// "type" | "props.<key>"]}]}`.
pub fn search_frames(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let query = p.get("query").and_then(Value::as_str).unwrap_or("").trim();
    let kind = p
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    if query.is_empty() && kind.is_none() {
        return Err(bad("give a query, a type, or both"));
    }
    let limit = p
        .get("limit")
        .and_then(Value::as_u64)
        .map_or(25, |n| n.clamp(1, 100) as usize);
    let only = optional_canvas(p, "canvas")?;
    let (reads, _, _) = scope(root, only.as_deref(), false);
    let (table, _) = types::all(root);
    let mut hits: Vec<(u32, Value)> = Vec::new();
    for r in &reads {
        for f in &r.frames {
            if kind.is_some_and(|k| f.type_id.as_deref() != Some(k)) {
                continue;
            }
            let (points, matched) = if query.is_empty() {
                (1, Vec::new())
            } else {
                let Some(hit) = frames::score(f, &table, query) else {
                    continue;
                };
                hit
            };
            let mut row = frames::frame_json(&r.id, f, &table);
            row["score"] = json!(points);
            row["matchedIn"] = json!(matched);
            hits.push((points, row));
        }
    }
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1["name"].as_str().cmp(&b.1["name"].as_str()))
    });
    let total = hits.len();
    Ok(json!({
        "query": query,
        "type": kind,
        "total": total,
        "matches": hits.into_iter().take(limit).map(|h| h.1).collect::<Vec<_>>(),
    }))
}

/// `canvas/frame` `{actor, canvas, frame}`: one frame in full. `frame` is an
/// element id or an exact (case-insensitive) name.
///
/// Result: a Frame (see `canvas/frames`) plus `typeDef` (its type's schema, so
/// field labels and kinds are at hand), `contents: [{id, type, text, bbox}]`
/// (every element inside it, labels folded into their shapes) and `image`, the
/// call that renders it.
pub fn frame_detail(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let id = canvas_id(&string(p, "canvas")?)?;
    let r = read_canvas(root, &id)?;
    let wanted = string(p, "frame")?;
    let f = frames::find(&r.frames, &wanted).map_err(bad)?;
    let (table, _) = types::all(root);
    let mut out = frames::frame_json(&r.id, f, &table);
    out["typeDef"] = f
        .type_id
        .as_deref()
        .and_then(|t| table.iter().find(|d| d.id == t))
        .map_or(Value::Null, TypeDef::to_json);
    out["contents"] = json!(frames::contents(&r.scene, &f.id));
    out["canvasPath"] = json!(relative(root, &file_for(root, &r.id)));
    out["image"] =
        json!({ "method": "canvas/frame-image", "params": { "canvas": r.id, "frame": f.id } });
    Ok(out)
}

/// `canvas/frame-image` `{actor, canvas, frame, scale?, maxDimension?, theme?}`:
/// render just that frame to a PNG, drawn by the open Canvas app so it matches
/// what a person sees. The file is `.kaava/preview/canvas/<canvas>/<frame id>.png`
/// and is overwritten by the next render of the same frame.
///
/// Result: `{path, relative, width, height, scale, bytes, frame: Frame, hint}`;
/// read the PNG at `path`.
pub fn frame_image(
    root: &Path,
    web: &dyn Webview,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    let (id, scene, _) = open(root, &json!({ "id": canvas_id(&string(p, "canvas")?)? }))?;
    let mut scene = scene;
    frames::migrate(&mut scene);
    let all = frames::list(&scene);
    let f = frames::find(&all, &string(p, "frame")?)
        .map_err(bad)?
        .clone();
    let mut view: ViewParams =
        serde_json::from_value(p.clone()).map_err(|e| bad(format!("bad params: {e}")))?;
    view.region = None;
    let file = store::frame_image_path(root, &id, &f.id)?;
    let mut out = render(root, web, &id, scene, &f.id, &view, &file)?;
    let (table, _) = types::all(root);
    out["frame"] = frames::frame_json(&id, &f, &table);
    Ok(out)
}

// --- nesting ------------------------------------------------------------------

/// `canvas/tree` `{actor}`: the nested-canvas hierarchy. A canvas sits under the
/// canvas its `kaava.parent` names; one with no parent, or whose parent is not
/// in the checkout, is a root.
///
/// Result: `{roots: [Node], cycles: [id], problems: [string]}` where a Node is
/// `{id, title, path, parent, frames, error, children: [Node]}`. `cycles` lists
/// canvases that point at each other and so reach no root.
pub fn tree(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    actor(p)?;
    struct Row {
        title: String,
        parent: Option<String>,
        frames: usize,
        error: Option<String>,
        links: Vec<String>,
    }
    let all = files(root);
    let mut rows: HashMap<String, Row> = HashMap::new();
    for (id, _) in &all {
        let row = match read_canvas(root, id) {
            Ok(r) => Row {
                parent: r
                    .scene
                    .pointer("/kaava/parent")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                frames: r.frames.len(),
                links: frames::child_links(&r.scene),
                title: r.title,
                error: None,
            },
            Err(e) => Row {
                title: id.rsplit('/').next().unwrap_or(id).to_string(),
                parent: None,
                frames: 0,
                error: Some(e.message),
                links: Vec::new(),
            },
        };
        rows.insert(id.clone(), row);
    }
    let mut problems = Vec::new();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut roots: Vec<&str> = Vec::new();
    for (id, _) in &all {
        let row = &rows[id];
        match row.parent.as_deref().filter(|par| rows.contains_key(*par)) {
            Some(par) => children.entry(par).or_default().push(id),
            None => {
                if let Some(par) = &row.parent {
                    problems.push(format!("`{id}` names parent `{par}`, which does not exist"));
                }
                roots.push(id);
            }
        }
        for link in &row.links {
            if !rows.contains_key(link.as_str()) {
                problems.push(format!(
                    "a frame in `{id}` links to `{link}`, which does not exist"
                ));
            }
        }
    }
    let mut reached: HashSet<&str> = HashSet::new();
    fn node<'a>(
        id: &'a str,
        rows: &HashMap<String, Row>,
        children: &HashMap<&'a str, Vec<&'a str>>,
        reached: &mut HashSet<&'a str>,
    ) -> Value {
        reached.insert(id);
        let row = &rows[id];
        let kids: Vec<Value> = children
            .get(id)
            .map(|ids| {
                ids.iter()
                    .map(|c| node(c, rows, children, reached))
                    .collect()
            })
            .unwrap_or_default();
        json!({
            "id": id,
            "title": row.title,
            "path": format!("{DIR}/{id}.json"),
            "parent": row.parent,
            "frames": row.frames,
            "error": row.error,
            "children": kids,
        })
    }
    let nodes: Vec<Value> = roots
        .iter()
        .map(|id| node(id, &rows, &children, &mut reached))
        .collect();
    let cycles: Vec<&str> = all
        .iter()
        .map(|(id, _)| id.as_str())
        .filter(|id| !reached.contains(id))
        .collect();
    Ok(json!({ "roots": nodes, "cycles": cycles, "problems": problems }))
}

/// `canvas/set-parent` `{actor, id, parent: string | null}`: nest canvas `id`
/// under `parent`, or make it a root with `null`. Refused when `parent` does not
/// exist or the move would put a canvas inside itself.
///
/// Result: `{id, parent, mtime}`.
pub fn set_parent(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let (id, mut scene, base) = open(root, p)?;
    let parent = match p.get("parent") {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) => Some(canvas_id(s)?),
        Some(_) => return Err(bad("parent must be a canvas id or null")),
    };
    if let Some(par) = &parent {
        if !file_for(root, par).is_file() {
            return Err(bad(format!("the parent canvas `{par}` does not exist")));
        }
        if frames::would_cycle(&id, par, |c| parent_of(root, c)) {
            return Err(bad(format!(
                "cannot nest `{id}` under `{par}`: `{par}` is `{id}` or already inside it"
            )));
        }
    }
    if !scene.get("kaava").is_some_and(Value::is_object) {
        scene["kaava"] = Value::Object(Map::new());
    }
    match &parent {
        Some(par) => scene["kaava"]["parent"] = json!(par),
        None => {
            if let Some(k) = scene["kaava"].as_object_mut() {
                k.remove("parent");
            }
        }
    }
    let mtime = save_scene(root, &id, scene, base, who)?;
    Ok(json!({ "id": id, "parent": parent, "mtime": mtime }))
}

// --- writing frames ---------------------------------------------------------------

fn bump(el: &mut Value) {
    let version = el.get("version").and_then(Value::as_u64).unwrap_or(0) + 1;
    el["version"] = json!(version);
    el["versionNonce"] = json!(rand::random::<u32>() >> 1);
    el["updated"] = json!(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64));
}

fn element_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    (0..21)
        .map(|_| ALPHABET[rand::random_range(0..ALPHABET.len())] as char)
        .collect()
}

fn opt_str<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>, RpcError> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(bad(format!("{key} must be a string"))),
    }
}

fn opt_values(p: &Value) -> Result<Option<&Map<String, Value>>, RpcError> {
    match p.get("values") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(m)) => Ok(Some(m)),
        Some(_) => Err(bad("values must be an object of field key to value")),
    }
}

/// Set the object on frame element `el`: switch to `type_id` (keeping every
/// stored value, adding the new type's defaults) and merge `values`, each
/// checked against its field. A `null` value unsets a field.
fn apply_object(
    table: &[TypeDef],
    el: &mut Value,
    type_id: Option<&str>,
    values: Option<&Map<String, Value>>,
) -> Result<(), RpcError> {
    let current = el
        .pointer("/customData/kaava/object")
        .and_then(Value::as_object);
    let have_type = current
        .and_then(|o| o.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut props: Map<String, Value> = current
        .and_then(|o| o.get("props"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let Some(type_id) = type_id.map(str::to_string).or(have_type) else {
        if values.is_some_and(|v| !v.is_empty()) {
            return Err(bad(
                "this frame has no type yet; pass `type` along with `values`",
            ));
        }
        return Ok(());
    };
    let def = table.iter().find(|d| d.id == type_id).ok_or_else(|| {
        bad(format!(
            "unknown type `{type_id}`; the types are: {}",
            table
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;
    for f in &def.fields {
        if let Some(d) = &f.default {
            props.entry(f.key.clone()).or_insert_with(|| d.clone());
        }
    }
    for (key, value) in values.into_iter().flatten() {
        let field = def.field(key).ok_or_else(|| {
            bad(format!(
                "type `{}` has no field `{key}`; its fields are: {}",
                def.id,
                def.fields
                    .iter()
                    .map(|f| f.key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?;
        types::check_value(field, value).map_err(bad)?;
        if value.is_null() {
            props.remove(key);
        } else {
            props.insert(key.clone(), value.clone());
        }
    }
    if !el.get("customData").is_some_and(Value::is_object) {
        el["customData"] = json!({});
    }
    if !el["customData"].get("kaava").is_some_and(Value::is_object) {
        el["customData"]["kaava"] = json!({});
    }
    el["customData"]["kaava"]["object"] = json!({ "type": type_id, "props": props });
    Ok(())
}

/// `canvas/set-frame` `{actor, canvas, frame, name?, type?, values?}`: label
/// and describe an existing frame. `frame` is an element id or an exact name;
/// `name` renames it; `type` is a type id from `canvas/types` (values already
/// stored are kept, the new type's defaults fill the gaps); `values` is an
/// object of field key to value, each checked against the type's field, with
/// `null` to unset one. Refused when the name is taken by another frame.
///
/// Result: `{frame: Frame, mtime}`.
pub fn set_frame(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let id = canvas_id(&string(p, "canvas")?)?;
    let (_, mut scene, base) = open(root, &json!({ "id": id }))?;
    frames::migrate(&mut scene);
    let (table, _) = types::all(root);
    let all = frames::list(&scene);
    let frame_id = frames::find(&all, &string(p, "frame")?)
        .map_err(bad)?
        .id
        .clone();
    let new_name = opt_str(p, "name")?.map(str::trim);
    if let Some(name) = new_name {
        if name.is_empty() {
            return Err(bad("name cannot be empty"));
        }
        if all
            .iter()
            .any(|f| f.id != frame_id && f.name.eq_ignore_ascii_case(name))
        {
            return Err(bad(format!("another frame is already named `{name}`")));
        }
    }
    let el = scene["elements"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|e| e["id"] == json!(frame_id)))
        .ok_or_else(|| bad("frame vanished"))?;
    apply_object(&table, el, opt_str(p, "type")?, opt_values(p)?)?;
    if let Some(name) = new_name {
        el["name"] = json!(name);
    }
    bump(el);
    let mtime = save_scene(root, &id, scene, base, who)?;
    let after = read_canvas(root, &id)?;
    let f = frames::find(&after.frames, &frame_id).map_err(bad)?;
    Ok(json!({ "frame": frames::frame_json(&id, f, &table), "mtime": mtime }))
}

fn number(v: &Value, key: &str) -> Result<f64, RpcError> {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(|| bad(format!("bbox.{key} must be a number")))
}

const FRAME_PADDING: f64 = 24.0;

fn is_frame_el(e: &Value) -> bool {
    matches!(e["type"].as_str(), Some("frame" | "magicframe"))
}

fn is_live_el(e: &Value) -> bool {
    e.get("isDeleted").and_then(Value::as_bool) != Some(true)
}

/// The shapes a frame would wrap: `ids` plus any text bound to them. Fails on
/// an unknown id or a frame.
fn members_for(elements: &[Value], ids: &[String]) -> Result<Vec<String>, RpcError> {
    let mut members: Vec<String> = Vec::new();
    for want in ids {
        let el = elements
            .iter()
            .filter(|e| is_live_el(e))
            .find(|e| e["id"] == json!(want))
            .ok_or_else(|| bad(format!("no element `{want}` on this canvas")))?;
        if is_frame_el(el) {
            return Err(bad(format!("`{want}` is a frame; frames cannot be nested")));
        }
        if !members.contains(want) {
            members.push(want.clone());
        }
    }
    for e in elements.iter().filter(|e| is_live_el(e)) {
        let bound = e["containerId"]
            .as_str()
            .is_some_and(|c| members.iter().any(|m| m == c));
        if let (true, Some(i)) = (bound, e["id"].as_str()) {
            if !members.iter().any(|m| m == i) {
                members.push(i.to_string());
            }
        }
    }
    Ok(members)
}

/// `(x, y, width, height)` around `members`, with padding.
fn box_around(elements: &[Value], members: &[String]) -> (f64, f64, f64, f64) {
    let boxes: Vec<_> = elements
        .iter()
        .filter(|e| is_live_el(e) && members.iter().any(|m| e["id"] == json!(m)))
        .map(super::diagrams::bounds_of)
        .collect();
    let left = boxes.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
    let top = boxes.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
    let right = boxes
        .iter()
        .map(|b| b.x + b.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = boxes
        .iter()
        .map(|b| b.y + b.height)
        .fold(f64::NEG_INFINITY, f64::max);
    (
        left - FRAME_PADDING,
        top - FRAME_PADDING,
        right - left + 2.0 * FRAME_PADDING,
        bottom - top + 2.0 * FRAME_PADDING,
    )
}

/// `canvas/create-frame` `{actor, canvas, name, type?, elementIds?, bbox?, values?}`:
/// make a labelled frame. Pass exactly one of `elementIds` (existing shapes to
/// wrap: the frame is sized to them plus padding, and they and their bound
/// labels become its contents; frames cannot be wrapped) or `bbox`
/// `{x, y, width, height}` (an empty frame at that scene position, to draw into
/// afterwards). `type` and `values` are as in `canvas/set-frame`; `values`
/// needs a `type`. The name must be unique on the canvas.
///
/// Result: `{frame: Frame, adopted: [element ids], mtime}`.
pub fn create_frame(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let id = canvas_id(&string(p, "canvas")?)?;
    let name = string(p, "name")?.trim().to_string();
    if name.is_empty() {
        return Err(bad("name cannot be empty"));
    }
    let (_, mut scene, base) = open(root, &json!({ "id": id }))?;
    frames::migrate(&mut scene);
    if frames::list(&scene)
        .iter()
        .any(|f| f.name.eq_ignore_ascii_case(&name))
    {
        return Err(bad(format!("a frame is already named `{name}`")));
    }
    let (table, _) = types::all(root);
    let ids: Option<Vec<String>> = match p.get("elementIds") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(
            a.iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| bad("elementIds must be strings"))
                })
                .collect::<Result<_, _>>()?,
        ),
        Some(_) => return Err(bad("elementIds must be an array of element ids")),
    };
    let bbox = p.get("bbox").filter(|v| !v.is_null());
    let ((x, y, w, h), members) = match (&ids, bbox) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(bad("pass exactly one of `elementIds` or `bbox`"));
        }
        (None, Some(b)) => {
            let (w, h) = (number(b, "width")?, number(b, "height")?);
            if w <= 0.0 || h <= 0.0 {
                return Err(bad("bbox width and height must be positive"));
            }
            ((number(b, "x")?, number(b, "y")?, w, h), Vec::new())
        }
        (Some(ids), None) => {
            if ids.is_empty() {
                return Err(bad("elementIds is empty"));
            }
            let elements = scene["elements"].as_array().cloned().unwrap_or_default();
            let members = members_for(&elements, ids)?;
            (box_around(&elements, &members), members)
        }
    };
    let frame_id = element_id();
    let mut frame = json!({
        "id": frame_id, "type": "frame", "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": "#bbb", "backgroundColor": "transparent",
        "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 0,
        "opacity": 100, "groupIds": [], "frameId": null, "index": null, "roundness": null,
        "seed": rand::random::<u32>() >> 1, "version": 1,
        "versionNonce": rand::random::<u32>() >> 1, "isDeleted": false,
        "boundElements": null, "updated": 0, "link": null, "locked": false, "name": name
    });
    apply_object(&table, &mut frame, opt_str(p, "type")?, opt_values(p)?)?;
    bump(&mut frame);
    if let Some(list) = scene["elements"].as_array_mut() {
        for el in list.iter_mut() {
            if members.iter().any(|m| el["id"] == json!(m)) {
                el["frameId"] = json!(frame_id);
                bump(el);
            }
        }
        list.push(frame);
    } else {
        scene["elements"] = json!([frame]);
    }
    let mtime = save_scene(root, &id, scene, base, who)?;
    let after = read_canvas(root, &id)?;
    let f = frames::find(&after.frames, &frame_id).map_err(bad)?;
    Ok(json!({ "frame": frames::frame_json(&id, f, &table), "adopted": members, "mtime": mtime }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::canvas::call;
    use crate::apps::CallContext;
    use tempfile::TempDir;

    fn ctx(root: &Path) -> CallContext {
        CallContext {
            cluster_id: Some("c1".into()),
            project: Some(root.to_path_buf()),
        }
    }

    fn run(root: &Path, method: &str, params: Value) -> Result<Value, RpcError> {
        call(&ctx(root), false, method, Some(params))
    }

    fn agent(mut v: Value) -> Value {
        v["actor"] = json!("agent");
        v
    }

    fn frame(id: &str, name: &str, kaava: Value) -> Value {
        json!({ "id": id, "type": "frame", "name": name, "x": 10, "y": 20, "width": 300,
                "height": 200, "customData": { "kaava": kaava } })
    }

    fn put(root: &Path, id: &str, parent: Option<&str>, elements: Vec<Value>) {
        run(root, "canvas/create", json!({ "id": id, "parent": parent })).unwrap();
        let path = file_for(root, id);
        let mut scene: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        scene["elements"] = Value::Array(elements);
        std::fs::write(&path, serde_json::to_string_pretty(&scene).unwrap()).unwrap();
    }

    fn project() -> TempDir {
        let dir = TempDir::new().unwrap();
        put(
            dir.path(),
            "world",
            None,
            vec![
                frame(
                    "f1",
                    "Flap",
                    json!({ "object": { "type": "feature", "props": { "summary": "tap to rise" } },
                            "child": "world/pillar" }),
                ),
                json!({ "id": "s1", "type": "rectangle", "frameId": "f1", "x": 20, "y": 30,
                        "width": 10, "height": 10 }),
                json!({ "id": "l1", "type": "text", "containerId": "s1", "frameId": "f1",
                        "text": "Ball", "x": 21, "y": 31, "width": 4, "height": 4 }),
                frame(
                    "f2",
                    "Frame",
                    json!({ "spec": { "name": "Pillar", "size_m": 4, "triangle_budget": 900 } }),
                ),
                json!({ "id": "legacy", "type": "rectangle", "x": 0, "y": 0, "width": 5,
                        "height": 5, "customData": { "kaava": { "spec": { "name": "Chair" } } } }),
            ],
        );
        put(
            dir.path(),
            "world/pillar",
            Some("world"),
            vec![frame(
                "p1",
                "Pillar gap",
                json!({ "object": { "type": "system", "props": { "tunables": "gap 3.6" } } }),
            )],
        );
        dir
    }

    #[test]
    fn frames_lists_typed_frames_with_migration_and_legacy_cards() {
        let dir = project();
        let out = run(
            dir.path(),
            "canvas/frames",
            agent(json!({ "canvas": "world" })),
        )
        .unwrap();
        let frames = out["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["name"], "Flap");
        assert_eq!(frames[0]["type"], "feature");
        assert_eq!(frames[0]["childCanvas"], "world/pillar");
        assert_eq!(frames[0]["elements"], 2);
        assert_eq!(
            frames[1]["type"], "model",
            "the spec card on a frame is a Model frame"
        );
        assert_eq!(frames[1]["name"], "Pillar");
        assert_eq!(frames[1]["props"]["triangle_budget"], 900);
        assert_eq!(out["legacyCards"][0]["elementId"], "legacy");
        assert_eq!(out["scope"], "canvas");
    }

    #[test]
    fn frames_without_a_canvas_covers_the_project_and_recursive_walks_children() {
        let dir = project();
        let all = run(dir.path(), "canvas/frames", agent(json!({}))).unwrap();
        assert_eq!(all["scope"], "project");
        assert_eq!(all["frames"].as_array().unwrap().len(), 3);

        let flat = run(
            dir.path(),
            "canvas/frames",
            agent(json!({ "canvas": "canvas/world.json" })),
        )
        .unwrap();
        assert_eq!(flat["frames"].as_array().unwrap().len(), 2);
        let deep = run(
            dir.path(),
            "canvas/frames",
            agent(json!({ "canvas": "world", "recursive": true })),
        )
        .unwrap();
        let names: Vec<&str> = deep["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Flap", "Pillar", "Pillar gap"]);
    }

    #[test]
    fn a_recursive_walk_survives_a_frame_link_loop() {
        let dir = TempDir::new().unwrap();
        put(
            dir.path(),
            "a",
            None,
            vec![frame("fa", "To b", json!({ "child": "b" }))],
        );
        put(
            dir.path(),
            "b",
            None,
            vec![frame("fb", "To a", json!({ "child": "a" }))],
        );
        let out = run(
            dir.path(),
            "canvas/frames",
            agent(json!({ "canvas": "a", "recursive": true })),
        )
        .unwrap();
        assert_eq!(out["frames"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn search_matches_name_type_and_properties_and_filters_by_type() {
        let dir = project();
        let by = |q: Value| {
            let out = run(dir.path(), "canvas/search-frames", agent(q)).unwrap();
            out["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(by(json!({ "query": "pillar" })), ["f2", "p1"]);
        assert_eq!(by(json!({ "query": "gap 3.6" })), ["p1"]);
        assert_eq!(by(json!({ "type": "feature" })), ["f1"]);
        assert_eq!(by(json!({ "query": "pillar", "type": "model" })), ["f2"]);
        assert_eq!(by(json!({ "query": "pillar", "canvas": "world" })), ["f2"]);
        assert!(by(json!({ "query": "nothing like this" })).is_empty());
        assert!(run(dir.path(), "canvas/search-frames", agent(json!({}))).is_err());
    }

    #[test]
    fn frame_detail_has_the_schema_and_the_labelled_contents() {
        let dir = project();
        let out = run(
            dir.path(),
            "canvas/frame",
            agent(json!({ "canvas": "world", "frame": "flap" })),
        )
        .unwrap();
        assert_eq!(out["id"], "f1");
        assert_eq!(out["typeDef"]["id"], "feature");
        assert_eq!(out["contents"][0]["text"], "Ball");
        assert_eq!(out["contents"].as_array().unwrap().len(), 1);
        assert_eq!(out["image"]["params"]["frame"], "f1");
        assert!(run(
            dir.path(),
            "canvas/frame",
            agent(json!({ "canvas": "world", "frame": "zz" }))
        )
        .is_err());
    }

    #[test]
    fn every_method_requires_an_actor() {
        let dir = project();
        for m in ["canvas/types", "canvas/frames", "canvas/tree"] {
            assert!(run(dir.path(), m, json!({})).is_err(), "{m}");
        }
    }

    #[test]
    fn frame_image_renders_through_the_frontend_and_overwrites_one_file() {
        use std::cell::RefCell;
        struct Fake(RefCell<Vec<Value>>);
        impl Webview for Fake {
            fn run(&self, _: &str, payload: &Value, _: Option<&str>) -> Result<Value, RpcError> {
                self.0.borrow_mut().push(payload.clone());
                Ok(
                    json!({ "png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
                           "width": 1, "height": 1, "scale": 1 }),
                )
            }
        }
        let dir = project();
        let web = Fake(RefCell::new(Vec::new()));
        let p = agent(json!({ "canvas": "world", "frame": "f1" }));
        let first = frame_image(dir.path(), &web, Some(&p)).unwrap();
        let second = frame_image(dir.path(), &web, Some(&p)).unwrap();
        assert_eq!(first["path"], second["path"]);
        assert!(first["relative"]
            .as_str()
            .unwrap()
            .starts_with(".kaava/preview/canvas/world/"));
        assert!(Path::new(first["path"].as_str().unwrap()).is_file());
        assert_eq!(web.0.borrow()[0]["frameId"], "f1");
        let dir_files: Vec<_> =
            std::fs::read_dir(Path::new(first["path"].as_str().unwrap()).parent().unwrap())
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".png"))
                .collect();
        assert_eq!(dir_files.len(), 1, "never timestamped copies");
    }

    #[test]
    fn types_methods_list_save_and_delete() {
        let dir = project();
        let out = run(dir.path(), "canvas/types", agent(json!({}))).unwrap();
        assert_eq!(out["builtin"].as_array().unwrap().len(), 5);
        assert!(out["custom"].as_array().unwrap().is_empty());

        let made = run(
            dir.path(),
            "canvas/save-type",
            agent(json!({ "type": { "name": "Vehicle", "color": "#112233", "icon": "box",
                "fields": [{ "key": "speed", "label": "Speed", "kind": "number", "default": 5 }] } })),
        )
        .unwrap();
        assert_eq!(made["type"]["id"], "vehicle");
        assert!(types::types_path(dir.path()).is_file());
        assert!(run(
            dir.path(),
            "canvas/save-type",
            agent(json!({ "type": { "id": "model", "name": "X", "color": "#112233", "icon": "box", "fields": [] } })),
        )
        .is_err());
        let del = run(
            dir.path(),
            "canvas/delete-type",
            agent(json!({ "id": "vehicle" })),
        )
        .unwrap();
        assert_eq!(del["deleted"], true);
        assert!(run(
            dir.path(),
            "canvas/delete-type",
            agent(json!({ "id": "note" }))
        )
        .is_err());
    }

    #[test]
    fn tree_nests_by_parent_and_reports_cycles_and_dangling_links() {
        let dir = project();
        let out = run(dir.path(), "canvas/tree", agent(json!({}))).unwrap();
        assert_eq!(out["roots"].as_array().unwrap().len(), 1);
        assert_eq!(out["roots"][0]["id"], "world");
        assert_eq!(out["roots"][0]["children"][0]["id"], "world/pillar");
        assert_eq!(out["roots"][0]["frames"], 2);
        assert!(out["cycles"].as_array().unwrap().is_empty());

        // Hand-edit two canvases into a loop; the tree must not hang or lose them.
        for (id, parent) in [("x", "y"), ("y", "x")] {
            put(dir.path(), id, None, vec![]);
            let path = file_for(dir.path(), id);
            let mut s: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            s["kaava"]["parent"] = json!(parent);
            std::fs::write(&path, s.to_string()).unwrap();
        }
        let out = run(dir.path(), "canvas/tree", agent(json!({}))).unwrap();
        assert_eq!(out["cycles"], json!(["x", "y"]));
    }

    #[test]
    fn set_parent_refuses_cycles_and_unknown_parents() {
        let dir = project();
        put(dir.path(), "extra", None, vec![]);
        let ok = run(
            dir.path(),
            "canvas/set-parent",
            agent(json!({ "id": "extra", "parent": "world/pillar" })),
        )
        .unwrap();
        assert_eq!(ok["parent"], "world/pillar");
        assert_eq!(
            parent_of(dir.path(), "extra").as_deref(),
            Some("world/pillar")
        );

        let err = |id: &str, parent: &str| {
            run(
                dir.path(),
                "canvas/set-parent",
                agent(json!({ "id": id, "parent": parent })),
            )
            .unwrap_err()
            .message
        };
        assert!(err("world", "world").contains("cannot nest"));
        assert!(
            err("world", "extra").contains("cannot nest"),
            "a grandchild cannot be a parent"
        );
        assert!(err("extra", "ghost").contains("does not exist"));

        run(
            dir.path(),
            "canvas/set-parent",
            agent(json!({ "id": "extra", "parent": null })),
        )
        .unwrap();
        assert_eq!(parent_of(dir.path(), "extra"), None);
    }

    #[test]
    fn writing_a_scene_that_loops_is_refused() {
        let dir = project();
        let read = |id: &str| run(dir.path(), "canvas/read", json!({ "id": id })).unwrap();
        let mut world = read("world");
        world["scene"]["kaava"]["parent"] = json!("world/pillar");
        let err = run(
            dir.path(),
            "canvas/write",
            json!({ "id": "world", "scene": world["scene"], "baseMtime": world["mtime"] }),
        )
        .unwrap_err();
        assert!(err.message.contains("inside itself"), "{}", err.message);

        let mut pillar = read("world/pillar");
        pillar["scene"]["elements"] = json!([frame("p1", "Up", json!({ "child": "world" }))]);
        let err = run(
            dir.path(),
            "canvas/write",
            json!({ "id": "world/pillar", "scene": pillar["scene"], "baseMtime": pillar["mtime"] }),
        )
        .unwrap_err();
        assert!(err.message.contains("may not loop"), "{}", err.message);
    }

    #[test]
    fn canvas_ids_accept_paths() {
        assert_eq!(
            canvas_id("canvas/levels/ward-b.json").unwrap(),
            "levels/ward-b"
        );
        assert_eq!(canvas_id("canvas/a.canvas.json").unwrap(), "a");
        assert_eq!(canvas_id("balls").unwrap(), "balls");
        assert!(canvas_id("../x").is_err());
    }

    #[test]
    fn set_frame_types_names_and_validates_values() {
        let dir = project();
        let out = run(
            dir.path(),
            "canvas/set-frame",
            agent(
                json!({ "canvas": "world", "frame": "Flap", "name": "Flap input",
                          "type": "feature", "values": { "summary": "hold to rise" } }),
            ),
        )
        .unwrap();
        assert_eq!(out["frame"]["name"], "Flap input");
        assert_eq!(out["frame"]["props"]["summary"], "hold to rise");
        let found = run(
            dir.path(),
            "canvas/search-frames",
            agent(json!({ "query": "hold to rise" })),
        )
        .unwrap();
        assert_eq!(found["matches"][0]["id"], "f1");

        for (values, want) in [
            (json!({ "nope": 1 }), "has no field"),
            (json!({ "summary": 3 }), "not a valid"),
        ] {
            let err = run(
                dir.path(),
                "canvas/set-frame",
                agent(json!({ "canvas": "world", "frame": "f1", "values": values })),
            )
            .unwrap_err();
            assert!(err.message.contains(want), "{}", err.message);
        }
        let err = run(
            dir.path(),
            "canvas/set-frame",
            agent(json!({ "canvas": "world", "frame": "f1", "type": "zzz" })),
        )
        .unwrap_err();
        assert!(err.message.contains("unknown type"), "{}", err.message);
    }

    #[test]
    fn set_frame_keeps_values_across_a_type_change_and_unsets_with_null() {
        let dir = project();
        run(
            dir.path(),
            "canvas/set-frame",
            agent(json!({ "canvas": "world", "frame": "f1", "type": "model",
                          "values": { "size_m": 2, "triangle_budget": 800 } })),
        )
        .unwrap();
        let out = run(
            dir.path(),
            "canvas/set-frame",
            agent(json!({ "canvas": "world", "frame": "f1", "type": "feature",
                          "values": { "summary": null } })),
        )
        .unwrap();
        assert_eq!(out["frame"]["type"], "feature");
        assert_eq!(out["frame"]["extraProps"]["size_m"], 2);
        assert!(out["frame"]["props"].get("summary").is_none());
    }

    #[test]
    fn set_frame_refuses_a_name_another_frame_has_and_a_missing_canvas() {
        let dir = project();
        let err = run(
            dir.path(),
            "canvas/set-frame",
            agent(json!({ "canvas": "world", "frame": "f1", "name": "pillar" })),
        )
        .unwrap_err();
        assert!(err.message.contains("already named"), "{}", err.message);
        assert!(run(
            dir.path(),
            "canvas/set-frame",
            agent(json!({ "canvas": "world", "frame": "f1", "name": "Brand new" })),
        )
        .is_ok());
        assert!(run(
            dir.path(),
            "canvas/set-frame",
            agent(json!({ "canvas": "ghost", "frame": "f1" })),
        )
        .is_err());
    }

    #[test]
    fn create_frame_wraps_elements_and_their_labels() {
        let dir = project();
        let out = run(
            dir.path(),
            "canvas/create-frame",
            agent(json!({ "canvas": "world", "name": "Ball", "type": "model",
                          "elementIds": ["legacy"], "values": { "size_m": 1 } })),
        )
        .unwrap();
        assert_eq!(out["adopted"], json!(["legacy"]));
        assert_eq!(out["frame"]["name"], "Ball");
        assert_eq!(out["frame"]["props"]["size_m"], 1);
        assert_eq!(out["frame"]["elements"], 1);
        let b = &out["frame"]["bbox"];
        assert_eq!(b["x"], -24.0);
        assert_eq!(b["width"], 53.0);
        let read = run(dir.path(), "canvas/read", json!({ "id": "world" })).unwrap();
        let els = read["scene"]["elements"].as_array().unwrap();
        let fid = out["frame"]["id"].as_str().unwrap();
        assert_eq!(els.last().unwrap()["id"], fid);
        assert!(els
            .iter()
            .any(|e| e["id"] == "legacy" && e["frameId"] == fid));
    }

    #[test]
    fn create_frame_at_a_bbox_is_empty_and_takes_labels_of_bound_text() {
        let dir = project();
        let out = run(
            dir.path(),
            "canvas/create-frame",
            agent(
                json!({ "canvas": "world", "name": "Level 1", "type": "ui-screen",
                          "bbox": { "x": 500, "y": 0, "width": 400, "height": 300 } }),
            ),
        )
        .unwrap();
        assert_eq!(out["adopted"], json!([]));
        assert_eq!(out["frame"]["bbox"]["width"], 400.0);
        let wrapped = run(
            dir.path(),
            "canvas/create-frame",
            agent(json!({ "canvas": "world", "name": "Ball again", "elementIds": ["s1"] })),
        )
        .unwrap();
        let adopted = wrapped["adopted"].as_array().unwrap();
        assert!(adopted.contains(&json!("s1")) && adopted.contains(&json!("l1")));
    }

    #[test]
    fn create_frame_refuses_bad_input() {
        let dir = project();
        let go = |extra: Value| {
            let mut v = json!({ "canvas": "world", "name": "New" });
            for (k, val) in extra.as_object().unwrap() {
                v[k] = val.clone();
            }
            run(dir.path(), "canvas/create-frame", agent(v))
                .unwrap_err()
                .message
        };
        assert!(go(json!({})).contains("exactly one"));
        assert!(go(
            json!({ "elementIds": ["legacy"], "bbox": { "x": 0, "y": 0, "width": 1, "height": 1 } })
        )
        .contains("exactly one"));
        assert!(go(json!({ "elementIds": ["f1"] })).contains("cannot be nested"));
        assert!(go(json!({ "elementIds": ["nope"] })).contains("no element"));
        assert!(
            go(json!({ "bbox": { "x": 0, "y": 0, "width": 0, "height": 5 } })).contains("positive")
        );
        assert!(
            go(json!({ "name": "Flap", "bbox": { "x": 0, "y": 0, "width": 1, "height": 1 } }))
                .contains("already named")
        );
        assert!(
            go(json!({ "bbox": { "x": 0, "y": 0, "width": 1, "height": 1 },
                           "values": { "summary": "x" } }))
            .contains("no type")
        );
    }

    #[test]
    fn frame_writes_are_listed_as_writes_and_refused_on_main() {
        use crate::apps::is_write_method;
        assert!(is_write_method("canvas/set-frame"));
        assert!(is_write_method("canvas/create-frame"));
    }
}
