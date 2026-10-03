//! What a canvas keeps on disk besides its JSON: reference images, undo
//! checkpoints and rendered views.
//!
//! **Reference images** live beside the design as `canvas/<id>/refs/<file>`.
//! Excalidraw keeps an image as a base64 `dataURL` in the scene's `files` map;
//! a write here swaps each one for a `kaavaRef` path and writes the bytes out,
//! and a read puts the `dataURL` back, so the editor never knows. A photo is
//! then a binary file git can store once, not a megabyte line in every diff.
//! Rejected: a content-addressed store under `.kaava/`. It would be invisible
//! in the checkout and ignored by git, so a clone would open with holes.
//!
//! **Checkpoints** and **views** are Kaava's own working state, not the
//! design's, so they go under `.kaava/` with a `.gitignore` of `*`, the same
//! arrangement as `.kaava/context/`. Checkpoints are a ring of
//! [`CHECKPOINTS`] per canvas; a view is overwritten in place per diagram, so
//! an agent looking a hundred times leaves one file, not a hundred.

use super::{bad, file_for, relative, DIR};
use base64::Engine;
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// How many checkpoints each canvas keeps.
pub const CHECKPOINTS: usize = 5;

/// The reason `canvas/split-frames` checkpoints under, kept out of the ring.
pub const SPLIT_CHECKPOINT: &str = "split-frames";

/// The largest reference image accepted, decoded.
const MAX_REF_BYTES: usize = 25 * 1024 * 1024;

fn io(what: &str, path: &Path, e: std::io::Error) -> RpcError {
    RpcError::new(
        INTERNAL_ERROR,
        format!("could not {what} {}: {e}", path.display()),
    )
}

/// Write `bytes` to `path` through a sibling temp file and a rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), RpcError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io("create", parent, e))?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".kaava-tmp");
    let temp = path.with_file_name(name);
    std::fs::write(&temp, bytes).map_err(|e| io("write", &temp, e))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io("replace", path, e)
    })
}

/// Make `.kaava/<name>/` with a `.gitignore` of `*`, and return it.
fn kaava_dir(root: &Path, name: &str) -> Result<PathBuf, RpcError> {
    let dir = root.join(".kaava").join(name);
    std::fs::create_dir_all(&dir).map_err(|e| io("create", &dir, e))?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").map_err(|e| io("write", &ignore, e))?;
    }
    Ok(dir)
}

fn nest(mut dir: PathBuf, id: &str) -> PathBuf {
    for segment in id.split('/') {
        dir.push(segment);
    }
    dir
}

// --- reference images -------------------------------------------------------

/// `canvas/<id>/refs/`.
pub fn refs_dir(root: &Path, canvas: &str) -> PathBuf {
    nest(root.join(DIR), canvas).join("refs")
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "bin",
    }
}

fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// A file id safe to use as a file name: Excalidraw's own ids are hex or
/// nanoid, and anything else is refused rather than escaped.
fn safe_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Move every inline image in `scene.files` out to `refs/`. Returns the
/// relative paths written.
pub fn externalize(root: &Path, canvas: &str, scene: &mut Value) -> Result<Vec<String>, RpcError> {
    let mut written = Vec::new();
    let Some(files) = scene.get_mut("files").and_then(Value::as_object_mut) else {
        return Ok(written);
    };
    for (key, entry) in files.iter_mut() {
        let Some(url) = entry
            .get("dataURL")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let Some((head, data)) = url.strip_prefix("data:").and_then(|u| u.split_once(',')) else {
            continue;
        };
        if !head.ends_with(";base64") || !safe_name(key) {
            continue;
        }
        let mime = head.trim_end_matches(";base64").to_string();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| bad(format!("image `{key}` is not valid base64: {e}")))?;
        if bytes.len() > MAX_REF_BYTES {
            return Err(bad(format!(
                "image `{key}` is {} MB; the limit is {} MB",
                bytes.len() / 1_048_576,
                MAX_REF_BYTES / 1_048_576
            )));
        }
        let name = format!("{key}.{}", extension_for(&mime));
        let path = refs_dir(root, canvas).join(&name);
        let same = std::fs::read(&path).is_ok_and(|old| old == bytes);
        if !same {
            atomic_write(&path, &bytes)?;
        }
        written.push(relative(root, &path));
        if let Some(obj) = entry.as_object_mut() {
            obj.remove("dataURL");
            obj.insert("mimeType".into(), json!(mime));
            obj.insert("kaavaRef".into(), json!(format!("refs/{name}")));
        }
    }
    Ok(written)
}

/// Put each `kaavaRef` image back as a `dataURL`. Returns the refs that are
/// missing from disk, which the editor then shows as a broken image.
pub fn inflate(root: &Path, canvas: &str, scene: &mut Value) -> Vec<String> {
    let mut missing = Vec::new();
    let base = nest(root.join(DIR), canvas);
    let Some(files) = scene.get_mut("files").and_then(Value::as_object_mut) else {
        return missing;
    };
    for entry in files.values_mut() {
        if entry.get("dataURL").is_some() {
            continue;
        }
        let Some(rel) = entry.get("kaavaRef").and_then(Value::as_str) else {
            continue;
        };
        let name = rel.strip_prefix("refs/").unwrap_or("");
        if !name.contains('.') || !safe_name(name.split('.').next().unwrap_or("")) {
            missing.push(rel.to_string());
            continue;
        }
        let path = base.join("refs").join(name);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let mime = entry
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| mime_for(name))
                    .to_string();
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                entry["dataURL"] = json!(format!("data:{mime};base64,{data}"));
            }
            Err(_) => missing.push(rel.to_string()),
        }
    }
    missing
}

/// `canvas/refs`: the images stored beside a canvas, whether placed or not.
pub fn list_refs(root: &Path, canvas: &str, scene: &Value) -> Value {
    let placed: Map<String, Value> = scene
        .get("files")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut rows = Vec::new();
    if let Ok(reader) = std::fs::read_dir(refs_dir(root, canvas)) {
        let mut names: Vec<String> = reader
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with(".kaava-tmp"))
            .collect();
        names.sort();
        for name in names {
            let rel = format!("refs/{name}");
            let file_id = placed
                .iter()
                .find(|(_, v)| v.get("kaavaRef").and_then(Value::as_str) == Some(rel.as_str()))
                .map(|(k, _)| k.clone());
            rows.push(json!({
                "name": name,
                "ref": rel,
                "path": relative(root, &refs_dir(root, canvas).join(&name)),
                "mimeType": mime_for(&name),
                "fileId": file_id,
            }));
        }
    }
    json!({ "refs": rows })
}

// --- checkpoints ------------------------------------------------------------

fn checkpoint_dir(root: &Path, canvas: &str) -> Result<PathBuf, RpcError> {
    Ok(nest(kaava_dir(root, "canvas-checkpoints")?, canvas))
}

/// Copy the canvas file as it is now into the ring, dropping the oldest.
/// Returns the checkpoint's name, or `None` when there is no file yet.
pub fn checkpoint(root: &Path, canvas: &str, reason: &str) -> Result<Option<String>, RpcError> {
    let source = file_for(root, canvas);
    let Ok(bytes) = std::fs::read(&source) else {
        return Ok(None);
    };
    let dir = checkpoint_dir(root, canvas)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let slug: String = reason
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    let mut name = format!("{millis:013}-{slug}");
    let mut n = 1;
    while dir.join(format!("{name}.json")).exists() {
        name = format!("{millis:013}-{slug}-{n}");
        n += 1;
    }
    atomic_write(&dir.join(format!("{name}.json")), &bytes)?;
    let mut names = checkpoint_names(root, canvas)?;
    // The newest split stays outside the ring: it is the only way back to the
    // unsplit canvas, and ordinary edits would otherwise push it out in five.
    if let Some(i) = names.iter().rposition(|n| n.ends_with(SPLIT_CHECKPOINT)) {
        names.remove(i);
    }
    if names.len() > CHECKPOINTS {
        for old in &names[..names.len() - CHECKPOINTS] {
            let _ = std::fs::remove_file(dir.join(format!("{old}.json")));
        }
    }
    Ok(Some(name))
}

/// The ring's names, oldest first.
pub fn checkpoint_names(root: &Path, canvas: &str) -> Result<Vec<String>, RpcError> {
    let dir = checkpoint_dir(root, canvas)?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|r| {
            r.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.strip_suffix(".json").map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

/// A checkpoint's scene: the named one, else the newest.
pub fn checkpoint_scene(
    root: &Path,
    canvas: &str,
    name: Option<&str>,
) -> Result<(String, Value), RpcError> {
    let names = checkpoint_names(root, canvas)?;
    let chosen = match name {
        Some(n) => names.iter().find(|x| x.as_str() == n).cloned(),
        None => names.last().cloned(),
    }
    .ok_or_else(|| {
        RpcError::with_data(
            INVALID_PARAMS,
            format!(
                "canvas `{canvas}` has no checkpoint {}",
                name.unwrap_or("yet")
            ),
            json!({ "kind": "missing", "checkpoints": names }),
        )
    })?;
    let path = checkpoint_dir(root, canvas)?.join(format!("{chosen}.json"));
    let text = std::fs::read_to_string(&path).map_err(|e| io("read", &path, e))?;
    let scene = serde_json::from_str(&text)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("checkpoint is not JSON: {e}")))?;
    Ok((chosen, scene))
}

// --- views ------------------------------------------------------------------

/// The file a view of `diagram` renders to. Overwritten on every render.
pub fn view_path(
    root: &Path,
    canvas: &str,
    diagram: &str,
    region: bool,
) -> Result<PathBuf, RpcError> {
    let safe: String = diagram
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let suffix = if region { ".region.png" } else { ".png" };
    Ok(nest(kaava_dir(root, "canvas-views")?, canvas).join(format!("{safe}{suffix}")))
}

/// The file a frame's picture renders to: `.kaava/preview/canvas/<canvas>/<frame>.png`.
/// Overwritten on every render, so an agent that looks a hundred times leaves one file.
pub fn frame_image_path(root: &Path, canvas: &str, frame_id: &str) -> Result<PathBuf, RpcError> {
    let safe: String = frame_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    Ok(nest(kaava_dir(root, "preview/canvas")?, canvas).join(format!("{safe}.png")))
}

/// Where a sub-canvas's picture is cached: `.kaava/canvas-snapshots/<child>.png`,
/// with a `.json` beside it naming the child's mtime the picture was drawn from.
/// A cache, so it is under `.kaava/` and ignored by git: a clone redraws it.
pub fn snapshot_paths(root: &Path, child: &str) -> Result<(PathBuf, PathBuf), RpcError> {
    let base = nest(kaava_dir(root, "canvas-snapshots")?, child);
    Ok((base.with_extension("png"), base.with_extension("json")))
}

/// Decode the frontend's base64 PNG and write it to `path`.
pub fn write_png(path: &Path, base64_png: &str) -> Result<usize, RpcError> {
    let data = base64_png
        .split_once(',')
        .map(|(_, d)| d)
        .unwrap_or(base64_png);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("the render was not base64: {e}")))?;
    if !bytes.starts_with(b"\x89PNG") {
        return Err(RpcError::new(INTERNAL_ERROR, "the render was not a PNG"));
    }
    atomic_write(path, &bytes)?;
    Ok(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    fn scene_with_image() -> Value {
        json!({
            "type": "excalidraw",
            "elements": [],
            "files": { "abc123": {
                "id": "abc123", "mimeType": "image/png", "created": 1,
                "dataURL": format!("data:image/png;base64,{PNG_1X1}"),
            } },
        })
    }

    #[test]
    fn images_move_out_to_refs_and_come_back_identically() {
        let dir = TempDir::new().unwrap();
        let original = scene_with_image();
        let mut scene = original.clone();
        let written = externalize(dir.path(), "game", &mut scene).unwrap();
        assert_eq!(written, vec!["canvas/game/refs/abc123.png"]);
        assert!(scene["files"]["abc123"].get("dataURL").is_none());
        assert_eq!(scene["files"]["abc123"]["kaavaRef"], "refs/abc123.png");
        assert!(dir.path().join("canvas/game/refs/abc123.png").is_file());
        let missing = inflate(dir.path(), "game", &mut scene);
        assert!(missing.is_empty());
        assert_eq!(
            scene["files"]["abc123"]["dataURL"],
            original["files"]["abc123"]["dataURL"]
        );
    }

    #[test]
    fn a_missing_ref_is_reported_not_invented() {
        let dir = TempDir::new().unwrap();
        let mut scene = json!({ "files": { "x": { "kaavaRef": "refs/x.png" } } });
        assert_eq!(inflate(dir.path(), "game", &mut scene), vec!["refs/x.png"]);
        let mut escape = json!({ "files": { "x": { "kaavaRef": "refs/../../secret.png" } } });
        assert_eq!(inflate(dir.path(), "game", &mut escape).len(), 1);
    }

    #[test]
    fn refs_list_names_the_placed_file_id() {
        let dir = TempDir::new().unwrap();
        let mut scene = scene_with_image();
        externalize(dir.path(), "game", &mut scene).unwrap();
        std::fs::write(dir.path().join("canvas/game/refs/loose.jpg"), b"x").unwrap();
        let out = list_refs(dir.path(), "game", &scene);
        assert_eq!(out["refs"][0]["fileId"], "abc123");
        assert_eq!(out["refs"][1]["name"], "loose.jpg");
        assert_eq!(out["refs"][1]["fileId"], Value::Null);
    }

    #[test]
    fn the_checkpoint_ring_keeps_the_newest_five_and_is_git_ignored() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("canvas/game.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for n in 0..7 {
            std::fs::write(&file, format!("{{\"n\":{n}}}")).unwrap();
            checkpoint(dir.path(), "game", "bulk edit").unwrap();
        }
        let names = checkpoint_names(dir.path(), "game").unwrap();
        assert_eq!(names.len(), CHECKPOINTS);
        let (_, newest) = checkpoint_scene(dir.path(), "game", None).unwrap();
        assert_eq!(newest["n"], 6);
        let ignore = dir.path().join(".kaava/canvas-checkpoints/.gitignore");
        assert_eq!(std::fs::read_to_string(ignore).unwrap(), "*\n");
        assert!(checkpoint(dir.path(), "none", "x").unwrap().is_none());
    }

    #[test]
    fn the_newest_split_checkpoint_outlives_the_ring() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("canvas/game.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{\"n\":\"unsplit\"}").unwrap();
        let split = checkpoint(dir.path(), "game", SPLIT_CHECKPOINT)
            .unwrap()
            .unwrap();
        for n in 0..8 {
            std::fs::write(&file, format!("{{\"n\":{n}}}")).unwrap();
            checkpoint(dir.path(), "game", "set-values").unwrap();
        }
        let names = checkpoint_names(dir.path(), "game").unwrap();
        assert_eq!(names.len(), CHECKPOINTS + 1);
        let (_, kept) = checkpoint_scene(dir.path(), "game", Some(&split)).unwrap();
        assert_eq!(kept["n"], "unsplit");
    }

    #[test]
    fn a_view_overwrites_one_file_per_diagram() {
        let dir = TempDir::new().unwrap();
        let path = view_path(dir.path(), "game", "playfield", false).unwrap();
        write_png(&path, PNG_1X1).unwrap();
        write_png(&path, &format!("data:image/png;base64,{PNG_1X1}")).unwrap();
        let folder = path.parent().unwrap();
        assert_eq!(std::fs::read_dir(folder).unwrap().count(), 1);
        assert!(write_png(&path, "aGVsbG8=").is_err(), "not a PNG");
        let region = view_path(dir.path(), "game", "a/b", true).unwrap();
        assert!(region.ends_with("a_b.region.png"));
    }
}
