//! The Canvas app's Rust half: design canvases kept as one JSON file each,
//! inside the environment's checkout, so they are committed with the game.
//!
//! `docs/KAAVA-UX-REWORK.md` §6 puts canvases in `canvas/` on the environment's
//! branch, and `docs/design/KAAVA-UX-SPEC.md` board 12 shows the path
//! `canvas/levels/hospital-wing.json`. `docs/cloud-services.md` §4 proposes
//! moving them to the artifact bucket instead but marks that "decision needed",
//! so this follows the two documents that are decided: a canvas is
//! `<environment>/canvas/<id>.json`, and `<id>` may nest one folder per segment.
//!
//! The file is an Excalidraw scene plus one top-level `kaava` object, the shape
//! `cloud-services.md` §4 gives (`schema`, `id`, `title`, `parent`, `updated`,
//! `updated_by`). The scene is opaque here: Rust validates its outline and never
//! interprets an element. The one exception is the spec-card scan behind
//! `canvas/assets`, which reads `customData.kaava.spec`.
//!
//! Writes are atomic (a sibling temp file, then rename) and conflict-checked
//! against the `mtime` the caller last read, the same contract as `files/write`.
//! The methods that write are in `apps::WRITE_METHODS`, so a read-only main
//! checkout is refused centrally before any handler here runs.

use crate::apps::CallContext;
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The folder canvases live in, relative to the environment root.
pub const DIR: &str = "canvas";

/// How many `/`-separated segments an id may have.
const MAX_DEPTH: usize = 4;

/// The `kaava.schema` value this build writes.
const SCHEMA: u64 = 1;

/// The registry's entry point: works out whether the cluster's environment is
/// the read-only main checkout, then hands off to [`call`].
pub fn call_live(
    app: &tauri::AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    use tauri::Manager;
    let read_only = context.cluster_id.as_deref().is_some_and(|cluster| {
        app.state::<crate::shell_state::ShellState>()
            .cluster_environment(cluster)
            .is_some_and(|env| env.is_main())
    });
    call(context, read_only, method, params)
}

pub fn call(
    context: &CallContext,
    read_only: bool,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "canvas/state" => Ok(json!({
            "hasEnvironment": context.project.is_some(),
            "readOnly": read_only,
            "dir": DIR,
        })),
        "canvas/list" => list(&root(context)?),
        "canvas/read" => read(&root(context)?, &id_param(params.as_ref())?),
        "canvas/stat" => stat(&root(context)?, &id_param(params.as_ref())?),
        "canvas/create" => create(&root(context)?, params.as_ref()),
        "canvas/write" => write(&root(context)?, params.as_ref()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

fn root(context: &CallContext) -> Result<PathBuf, RpcError> {
    context.project.clone().ok_or_else(|| {
        RpcError::new(
            INTERNAL_ERROR,
            "this cluster has no environment to keep canvases in - open a project first",
        )
    })
}

fn bad(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message)
}

fn id_param(params: Option<&Value>) -> Result<String, RpcError> {
    match params.and_then(|p| p.get("id")) {
        Some(Value::String(id)) => {
            validate_id(id)?;
            Ok(id.clone())
        }
        _ => Err(bad("id is required and must be a string")),
    }
}

/// A canvas id is one to [`MAX_DEPTH`] segments joined by `/`, each a lowercase
/// slug. It becomes a path under `canvas/`, so nothing that could leave that
/// folder (`..`, a drive, a backslash, an empty segment) is accepted.
pub fn validate_id(id: &str) -> Result<(), RpcError> {
    let segments: Vec<&str> = id.split('/').collect();
    if segments.len() > MAX_DEPTH {
        return Err(bad(format!(
            "canvas id `{id}` nests more than {MAX_DEPTH} folders deep"
        )));
    }
    for segment in segments {
        let ok = !segment.is_empty()
            && segment.len() <= 64
            && segment
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            && !segment.starts_with('-');
        if !ok {
            return Err(bad(format!(
                "canvas id `{id}` is not a slug: use lowercase letters, digits, - and _, \
                 with / between folders"
            )));
        }
    }
    Ok(())
}

fn file_for(root: &Path, id: &str) -> PathBuf {
    let mut path = root.join(DIR);
    for segment in id.split('/') {
        path.push(segment);
    }
    path.set_extension("json");
    path
}

fn mtime_at(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    crate::cloud::rfc3339(secs)
}

/// The outline a scene must have to be a canvas: an object with
/// `type == "excalidraw"` and an `elements` array. Anything deeper is
/// Excalidraw's own business, and a file that passes here but that the editor
/// cannot draw is reported by the editor, not guessed at here.
pub fn validate_scene(scene: &Value) -> Result<(), String> {
    let obj = scene.as_object().ok_or("the scene is not a JSON object")?;
    if obj.get("type").and_then(Value::as_str) != Some("excalidraw") {
        return Err("the scene's `type` is not \"excalidraw\"".into());
    }
    if !obj.get("elements").is_some_and(Value::is_array) {
        return Err("the scene has no `elements` array".into());
    }
    if let Some(files) = obj.get("files") {
        if !files.is_object() {
            return Err("the scene's `files` is not an object".into());
        }
    }
    if let Some(kaava) = obj.get("kaava") {
        if !kaava.is_object() {
            return Err("the scene's `kaava` is not an object".into());
        }
    }
    Ok(())
}

fn empty_scene(id: &str, title: &str, parent: Option<&str>) -> Value {
    let mut kaava = Map::new();
    kaava.insert("schema".into(), json!(SCHEMA));
    kaava.insert("id".into(), json!(id));
    kaava.insert("title".into(), json!(title));
    if let Some(parent) = parent {
        kaava.insert("parent".into(), json!(parent));
    }
    kaava.insert("updated".into(), json!(now_rfc3339()));
    kaava.insert("updated_by".into(), json!("human"));
    json!({
        "type": "excalidraw",
        "version": 2,
        "elements": [],
        "appState": {},
        "files": {},
        "kaava": Value::Object(kaava),
    })
}

/// Read and parse one canvas file. A file that is not valid JSON or not a
/// scene is an error naming the file: the caller must not fall back to an empty
/// canvas, because the next autosave would then overwrite what is there.
fn load(path: &Path) -> Result<Value, RpcError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not read {}: {e}", path.display()),
        )
    })?;
    let scene: Value = serde_json::from_str(&raw).map_err(|e| {
        RpcError::with_data(
            INTERNAL_ERROR,
            format!("{} is not valid JSON: {e}", path.display()),
            json!({ "kind": "corrupt" }),
        )
    })?;
    validate_scene(&scene).map_err(|why| {
        RpcError::with_data(
            INTERNAL_ERROR,
            format!("{} is not a canvas: {why}", path.display()),
            json!({ "kind": "corrupt" }),
        )
    })?;
    Ok(scene)
}

/// One row of `canvas/list`.
fn summary(root: &Path, id: &str, path: &Path) -> Value {
    let mtime = mtime_at(path);
    match load(path) {
        Ok(scene) => {
            let kaava = scene.get("kaava");
            let title = kaava
                .and_then(|k| k.get("title"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| id.rsplit('/').next().unwrap_or(id));
            let parent = kaava.and_then(|k| k.get("parent")).and_then(Value::as_str);
            json!({
                "id": id,
                "title": title,
                "parent": parent,
                "mtime": mtime,
                "path": relative(root, path),
                "error": Value::Null,
            })
        }
        Err(e) => json!({
            "id": id,
            "title": id.rsplit('/').next().unwrap_or(id),
            "parent": Value::Null,
            "mtime": mtime,
            "path": relative(root, path),
            "error": e.message,
        }),
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Every `*.json` under `canvas/`, as `(id, path)` pairs sorted by id. Files
/// whose names are not valid slugs are skipped, not reported: they were not made
/// by this app and are not canvases it can address.
pub fn files(root: &Path) -> Vec<(String, PathBuf)> {
    fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<(String, PathBuf)>) {
        let Ok(reader) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in reader.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    walk(&path, &format!("{prefix}{name}/"), depth + 1, out);
                }
            } else if let Some(stem) = name.strip_suffix(".json") {
                let id = format!("{prefix}{stem}");
                if validate_id(&id).is_ok() {
                    out.push((id, path));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.join(DIR), "", 0, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn list(root: &Path) -> Result<Value, RpcError> {
    let rows: Vec<Value> = files(root)
        .iter()
        .map(|(id, path)| summary(root, id, path))
        .collect();
    Ok(Value::Array(rows))
}

fn read(root: &Path, id: &str) -> Result<Value, RpcError> {
    let path = file_for(root, id);
    if !path.is_file() {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!("there is no canvas `{id}` ({})", relative(root, &path)),
            json!({ "kind": "missing" }),
        ));
    }
    let scene = load(&path)?;
    Ok(json!({
        "id": id,
        "path": relative(root, &path),
        "scene": scene,
        "mtime": mtime_at(&path),
    }))
}

/// Just the mtime, for the poll that notices a `git pull` or another writer.
fn stat(root: &Path, id: &str) -> Result<Value, RpcError> {
    Ok(json!({ "mtime": mtime_at(&file_for(root, id)) }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    parent: Option<String>,
}

fn create(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p: CreateParams = serde_json::from_value(params.cloned().unwrap_or(Value::Null))
        .map_err(|e| bad(format!("bad params: {e}")))?;
    validate_id(&p.id)?;
    if let Some(parent) = &p.parent {
        validate_id(parent)?;
        if !file_for(root, parent).is_file() {
            return Err(bad(format!("the parent canvas `{parent}` does not exist")));
        }
    }
    let path = file_for(root, &p.id);
    if path.exists() {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!("canvas `{}` already exists", p.id),
            json!({ "kind": "exists" }),
        ));
    }
    let title = p
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| p.id.rsplit('/').next().unwrap_or(&p.id).to_string());
    let scene = empty_scene(&p.id, title.trim(), p.parent.as_deref());
    write_file(&path, &scene)?;
    Ok(json!({
        "id": p.id,
        "path": relative(root, &path),
        "scene": scene,
        "mtime": mtime_at(&path),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteParams {
    id: String,
    scene: Value,
    #[serde(default)]
    base_mtime: Option<u64>,
    /// `"human"` (the default) or `"agent"`; `"system"` is never accepted.
    #[serde(default)]
    actor: Option<String>,
}

fn write(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p: WriteParams = serde_json::from_value(params.cloned().unwrap_or(Value::Null))
        .map_err(|e| bad(format!("bad params: {e}")))?;
    validate_id(&p.id)?;
    let actor = match p.actor.as_deref() {
        None | Some("human") => "human",
        Some("agent") => "agent",
        Some(other) => return Err(bad(format!("actor must be human or agent, got `{other}`"))),
    };
    let mut scene = p.scene;
    validate_scene(&scene).map_err(|why| bad(format!("refusing to write: {why}")))?;

    let path = file_for(root, &p.id);
    let current = mtime_at(&path);
    // A file deleted since the read counts as changed, the same rule as
    // `files/write`: the caller asked to replace a version that is gone.
    if let Some(base) = p.base_mtime {
        if current != Some(base) {
            return Err(RpcError::with_data(
                INVALID_PARAMS,
                format!(
                    "{} changed on disk since it was read",
                    relative(root, &path)
                ),
                json!({ "kind": "stale", "mtime": current }),
            ));
        }
    } else if current.is_some() {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!(
                "{} already exists and no baseMtime was given",
                relative(root, &path)
            ),
            json!({ "kind": "stale", "mtime": current }),
        ));
    }

    stamp(&mut scene, &p.id, actor);
    write_file(&path, &scene)?;
    Ok(json!({ "id": p.id, "mtime": mtime_at(&path) }))
}

/// Set the bookkeeping fields the host owns: `schema`, `id` (always the file's
/// own id, so a copied file cannot claim to be another canvas), `updated` and
/// `updated_by`. `title` and `parent` are the caller's and are kept.
fn stamp(scene: &mut Value, id: &str, actor: &str) {
    let Some(obj) = scene.as_object_mut() else {
        return;
    };
    let kaava = obj
        .entry("kaava")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(k) = kaava.as_object_mut() {
        k.insert("schema".into(), json!(SCHEMA));
        k.insert("id".into(), json!(id));
        k.insert("updated".into(), json!(now_rfc3339()));
        k.insert("updated_by".into(), json!(actor));
    }
}

/// Pretty-printed, with a trailing newline, so a git diff is line-oriented and
/// two machines writing the same scene write the same bytes.
fn write_file(path: &Path, scene: &Value) -> Result<(), RpcError> {
    let mut text = serde_json::to_string_pretty(scene)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not serialize: {e}")))?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("could not create {}: {e}", parent.display()),
            )
        })?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".kaava-tmp");
    let temp = path.with_file_name(name);
    std::fs::write(&temp, text).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not write {}: {e}", temp.display()),
        )
    })?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not replace {}: {e}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn rect_scene() -> Value {
        json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [{ "id": "a", "type": "rectangle", "x": 1, "y": 2 }],
            "appState": { "viewBackgroundColor": "#ffffff" },
            "files": {},
        })
    }

    #[test]
    fn write_then_read_round_trips_elements() {
        let dir = TempDir::new().unwrap();
        let created = run(dir.path(), "canvas/create", json!({ "id": "world" })).unwrap();
        let mtime = created["mtime"].as_u64();
        let mut scene = rect_scene();
        scene["kaava"] = json!({ "title": "World map" });
        let saved = run(
            dir.path(),
            "canvas/write",
            json!({ "id": "world", "scene": scene, "baseMtime": mtime }),
        )
        .unwrap();
        assert!(saved["mtime"].is_u64());

        let read = run(dir.path(), "canvas/read", json!({ "id": "world" })).unwrap();
        assert_eq!(read["scene"]["elements"], rect_scene()["elements"]);
        assert_eq!(read["scene"]["kaava"]["title"], "World map");
        assert_eq!(read["scene"]["kaava"]["id"], "world");
        assert_eq!(read["scene"]["kaava"]["schema"], 1);
        assert_eq!(read["scene"]["kaava"]["updated_by"], "human");
        assert_eq!(read["path"], "canvas/world.json");
    }

    /// The acceptance test for "survives a clone": the file is plain JSON on
    /// disk at a predictable path, and a second checkout of the same bytes
    /// reads the same scene without any state from the first.
    #[test]
    fn a_copy_of_the_file_in_a_second_checkout_reads_identically() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        run(
            first.path(),
            "canvas/create",
            json!({ "id": "levels/ward-b" }),
        )
        .unwrap();
        let read = run(
            first.path(),
            "canvas/read",
            json!({ "id": "levels/ward-b" }),
        )
        .unwrap();
        let rel = read["path"].as_str().unwrap();
        assert_eq!(rel, "canvas/levels/ward-b.json");

        let target = second.path().join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(first.path().join(rel), &target).unwrap();

        let again = run(
            second.path(),
            "canvas/read",
            json!({ "id": "levels/ward-b" }),
        )
        .unwrap();
        assert_eq!(again["scene"], read["scene"]);
        let listed = run(second.path(), "canvas/list", json!({})).unwrap();
        assert_eq!(listed[0]["id"], "levels/ward-b");
    }

    #[test]
    fn the_file_is_pretty_json_with_a_trailing_newline_and_no_temp_left() {
        let dir = TempDir::new().unwrap();
        run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap();
        let text = std::fs::read_to_string(dir.path().join("canvas/a.json")).unwrap();
        assert!(text.ends_with("}\n"));
        assert!(text.contains("\n  \"elements\""));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("canvas"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".kaava-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn a_write_against_a_moved_file_is_refused_as_stale() {
        let dir = TempDir::new().unwrap();
        let created = run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap();
        let stale = created["mtime"].as_u64().unwrap() - 1000;
        let err = run(
            dir.path(),
            "canvas/write",
            json!({ "id": "a", "scene": rect_scene(), "baseMtime": stale }),
        )
        .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert_eq!(err.data.as_ref().unwrap()["kind"], "stale");
    }

    #[test]
    fn writing_over_an_existing_file_without_a_base_is_refused() {
        let dir = TempDir::new().unwrap();
        run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap();
        let err = run(
            dir.path(),
            "canvas/write",
            json!({ "id": "a", "scene": rect_scene() }),
        )
        .unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "stale");
    }

    #[test]
    fn a_corrupt_file_is_an_error_and_is_left_alone() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("canvas/broken.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();

        let err = run(dir.path(), "canvas/read", json!({ "id": "broken" })).unwrap_err();
        assert!(err.message.contains("not valid JSON"), "{}", err.message);
        assert_eq!(err.data.as_ref().unwrap()["kind"], "corrupt");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");

        // The list still shows it, flagged, rather than hiding the file.
        let listed = run(dir.path(), "canvas/list", json!({})).unwrap();
        assert_eq!(listed[0]["id"], "broken");
        assert!(listed[0]["error"].is_string());
    }

    #[test]
    fn valid_json_that_is_not_a_scene_is_corrupt_too() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("canvas/other.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"hello": 1}"#).unwrap();
        let err = run(dir.path(), "canvas/read", json!({ "id": "other" })).unwrap_err();
        assert!(err.message.contains("not a canvas"), "{}", err.message);
    }

    #[test]
    fn a_missing_canvas_says_so() {
        let dir = TempDir::new().unwrap();
        let err = run(dir.path(), "canvas/read", json!({ "id": "nope" })).unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "missing");
        assert_eq!(
            run(dir.path(), "canvas/list", json!({})).unwrap(),
            json!([])
        );
    }

    #[test]
    fn ids_cannot_leave_the_canvas_folder() {
        for id in [
            "..",
            "../x",
            "a/../b",
            "/abs",
            "a//b",
            "A",
            "a b",
            "a\\b",
            "C:/x",
            "",
            "-a",
            "a/b/c/d/e",
        ] {
            assert!(validate_id(id).is_err(), "{id:?} should be refused");
        }
        for id in ["a", "levels/ward-b", "a_b/c1", "a/b/c/d"] {
            assert!(validate_id(id).is_ok(), "{id:?} should be accepted");
        }
        let dir = TempDir::new().unwrap();
        assert!(run(dir.path(), "canvas/read", json!({ "id": "../x" })).is_err());
        assert!(run(dir.path(), "canvas/create", json!({ "id": "../x" })).is_err());
    }

    #[test]
    fn create_refuses_an_existing_canvas_and_a_missing_parent() {
        let dir = TempDir::new().unwrap();
        run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap();
        let err = run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "exists");
        let err = run(
            dir.path(),
            "canvas/create",
            json!({ "id": "b", "parent": "ghost" }),
        )
        .unwrap_err();
        assert!(err.message.contains("does not exist"));
    }

    #[test]
    fn a_write_of_a_non_scene_is_refused_before_touching_disk() {
        let dir = TempDir::new().unwrap();
        run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap();
        let before = std::fs::read_to_string(dir.path().join("canvas/a.json")).unwrap();
        let base = mtime_at(&dir.path().join("canvas/a.json"));
        let err = run(
            dir.path(),
            "canvas/write",
            json!({ "id": "a", "scene": { "elements": [] }, "baseMtime": base }),
        )
        .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("canvas/a.json")).unwrap(),
            before
        );
    }

    #[test]
    fn the_id_in_the_file_is_always_the_files_own() {
        let dir = TempDir::new().unwrap();
        let created = run(dir.path(), "canvas/create", json!({ "id": "a" })).unwrap();
        let mut scene = rect_scene();
        scene["kaava"] = json!({ "id": "impostor", "title": "T" });
        run(
            dir.path(),
            "canvas/write",
            json!({ "id": "a", "scene": scene, "baseMtime": created["mtime"] }),
        )
        .unwrap();
        let read = run(dir.path(), "canvas/read", json!({ "id": "a" })).unwrap();
        assert_eq!(read["scene"]["kaava"]["id"], "a");
    }

    #[test]
    fn no_environment_is_an_error_and_state_reports_read_only() {
        let none = CallContext::default();
        assert!(call(&none, false, "canvas/list", None).is_err());
        let state = call(&none, true, "canvas/state", None).unwrap();
        assert_eq!(state["readOnly"], true);
        assert_eq!(state["hasEnvironment"], false);
    }

    #[test]
    fn list_walks_nested_folders_and_ignores_strays() {
        let dir = TempDir::new().unwrap();
        run(dir.path(), "canvas/create", json!({ "id": "world" })).unwrap();
        run(
            dir.path(),
            "canvas/create",
            json!({ "id": "levels/ward-b", "parent": "world", "title": "Ward B" }),
        )
        .unwrap();
        std::fs::write(dir.path().join("canvas/Notes.json"), "{}").unwrap();
        std::fs::write(dir.path().join("canvas/readme.md"), "x").unwrap();
        let listed = run(dir.path(), "canvas/list", json!({})).unwrap();
        let ids: Vec<&str> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["levels/ward-b", "world"]);
        assert_eq!(listed[0]["parent"], "world");
        assert_eq!(listed[0]["title"], "Ward B");
    }
}
