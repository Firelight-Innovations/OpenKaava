//! The 3D preview: a scene exported to one glTF binary the viewer can orbit.
//!
//! `godot --headless -s export_glb.gd` loads a scene without running it and
//! writes it with `GLTFDocument`. The viewer draws that file with three.js, so
//! the picture is an approximation of what Godot renders (see the badge in the
//! viewer), but it is the scene's real geometry, and every node in it can be
//! named.
//!
//! **One file per scene, overwritten in place.** `<slug>.glb` and its sidecar
//! `<slug>.json` are replaced atomically (write a temp file beside them, then
//! rename), never written under a new name, so the folder cannot grow with use.
//! The sidecar holds the cache key and the node map; the glb is served again
//! untouched until the key changes.
//!
//! **The node map** turns a click in the 3D view back into a scene path.
//! Godot writes every node into the glTF under its own name, except that names
//! are made unique across the whole file (`Crate` twice becomes `Crate` and
//! `Crate2`), and three.js then rewrites spaces and a few punctuation marks.
//! [`build_node_map`] undoes both by walking the glTF and the scene tree
//! together, and keys the map by the path three.js will report.

use super::detect::Found;
use super::scene::{
    attr, ensure_imported, finish, push_output, res_to_path, run_capture, set_phase, tail, Job,
    Limits,
};
use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

pub const EXPORT_SCRIPT: &str = include_str!("export_glb.gd");

/// Bump when the export script or the node map changes shape, so a cached
/// preview from the old code is not served as if it were current.
const KEY_VERSION: u32 = 1;

/// Files hashed into a cache key. A scene that pulls in more than this is
/// hashed on its first 512 and the rest are trusted not to change alone.
const MAX_DEPENDENCIES: usize = 512;

/// Instanced scenes and resources are followed this deep.
const MAX_DEPTH: usize = 6;

/// The most a glb may weigh for the viewer to receive it whole over the bridge.
pub const MAX_GLB_BYTES: u64 = 48 * 1024 * 1024;

/// The sidecar beside a glb: what the file was made from and how to read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub key: String,
    pub scene: String,
    pub exported_at: u64,
    pub godot: String,
    pub glb_bytes: u64,
    /// The path three.js reports for a glTF node, to the scene path of the node
    /// that made it. See [`build_node_map`].
    pub node_map: BTreeMap<String, String>,
}

/// The file stem for a scene: `res://scenes/main.tscn` in the project at
/// `game/` is `game__scenes__main_tscn`. Stable, readable, and the same
/// scene always names the same file.
pub fn slug(project_rel: &str, scene: &str) -> String {
    let flat = |text: &str| -> String {
        text.trim_start_matches("res://")
            .trim_matches('/')
            .chars()
            .map(|c| match c {
                '/' | '\\' => "__".to_string(),
                c if c.is_ascii_alphanumeric() || c == '-' => c.to_string(),
                _ => "_".to_string(),
            })
            .collect()
    };
    let scene = flat(scene);
    match project_rel {
        "." | "" => scene,
        rel => format!("{}__{scene}", flat(rel)),
    }
}

pub fn glb_path(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("{slug}.glb"))
}

fn sidecar_path(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("{slug}.json"))
}

// --- the cache key -----------------------------------------------------------

fn is_text_resource(res: &str) -> bool {
    res.ends_with(".tscn") || res.ends_with(".tres")
}

/// What decides whether the glb on disk is still right: the scene, everything
/// it references, the engine that wrote it, and the code that asked.
///
/// A scene or resource written as text is hashed by content, so a checkout
/// that touches a file without changing it does not force a re-export. A
/// binary asset (a model, a texture) is identified by length and modification
/// time, because hashing a 40 MB model on every poll would cost more than it
/// saves. The scene itself must exist; a missing dependency is skipped, since
/// Godot does the same and the export then says what it could not load.
pub fn cache_key(project: &Path, scene: &str, godot: &str) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(KEY_VERSION.to_le_bytes());
    hasher.update(godot.as_bytes());
    hasher.update([0]);
    hasher.update(scene.as_bytes());

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<(String, usize)> = vec![(scene.to_string(), 0)];
    while let Some((res, depth)) = queue.pop() {
        if seen.len() >= MAX_DEPENDENCIES || !seen.insert(res.clone()) {
            continue;
        }
        let path = res_to_path(project, &res);
        if is_text_resource(&res) {
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) if res == scene => {
                    return Err(format!("could not read {}: {e}", path.display()))
                }
                Err(_) => continue,
            };
            hasher.update(res.as_bytes());
            hasher.update([0]);
            hasher.update(text.as_bytes());
            if depth < MAX_DEPTH {
                for dependency in dependencies(&text) {
                    queue.push((dependency, depth + 1));
                }
            }
        } else if let Ok(meta) = std::fs::metadata(&path) {
            let modified = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            hasher.update(res.as_bytes());
            hasher.update([0]);
            hasher.update(meta.len().to_le_bytes());
            hasher.update(modified.to_le_bytes());
        }
    }
    Ok(hasher
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The `res://` paths a text scene or resource lists as `[ext_resource ...]`.
fn dependencies(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.starts_with("[ext_resource"))
        .filter_map(|l| attr(l, "path"))
        .filter(|p| p.starts_with("res://"))
        .collect()
}

/// The sidecar, when it matches `key` and its glb is still there.
pub fn read_fresh(dir: &Path, slug: &str, key: &str) -> Option<Preview> {
    let text = std::fs::read_to_string(sidecar_path(dir, slug)).ok()?;
    let preview: Preview = serde_json::from_str(&text).ok()?;
    (preview.key == key && glb_path(dir, slug).is_file()).then_some(preview)
}

// --- reading a glb ------------------------------------------------------------

/// The JSON chunk of a glb, read without loading the binary chunk after it.
pub fn read_glb_json(mut glb: impl Read) -> Result<Value, String> {
    let mut header = [0u8; 20];
    glb.read_exact(&mut header)
        .map_err(|e| format!("the glTF is too short to read: {e}"))?;
    if &header[0..4] != b"glTF" {
        return Err("the file is not a glTF binary".to_string());
    }
    if &header[16..20] != b"JSON" {
        return Err("the glTF's first chunk is not JSON".to_string());
    }
    let length = u32::from_le_bytes([header[12], header[13], header[14], header[15]]) as usize;
    if length > 64 * 1024 * 1024 {
        return Err("the glTF's JSON chunk is implausibly large".to_string());
    }
    let mut json = vec![0u8; length];
    glb.read_exact(&mut json)
        .map_err(|e| format!("the glTF's JSON chunk is truncated: {e}"))?;
    serde_json::from_slice(&json).map_err(|e| format!("the glTF's JSON is unreadable: {e}"))
}

// --- the node map -------------------------------------------------------------

/// One node of the scene as `export_glb.gd` wrote it.
#[derive(Debug, Clone, Deserialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub children: Vec<TreeNode>,
}

/// A name as three.js's `GLTFLoader` will report it: whitespace becomes `_`,
/// and `[ ] . : /` are dropped.
pub fn three_name(name: &str) -> String {
    name.chars()
        .filter_map(|c| match c {
            c if c.is_whitespace() => Some('_'),
            '[' | ']' | '.' | ':' | '/' => None,
            c => Some(c),
        })
        .collect()
}

/// Whether `gltf` is what Godot wrote for a node called `godot`: the same name,
/// or that name with the digits (and an optional underscore) it appends to keep
/// glTF names unique.
fn names_match(godot: &str, gltf: &str) -> bool {
    match gltf.strip_prefix(godot) {
        Some("") => true,
        Some(rest) => rest
            .trim_start_matches('_')
            .bytes()
            .all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Map every scene node that has a glTF counterpart, keyed by the path the 3D
/// view reports for it. Both trees are walked in order, so a node the exporter
/// left out is skipped and its children are matched against the parent's.
pub fn build_node_map(gltf: &Value, roots: &[TreeNode]) -> BTreeMap<String, String> {
    let nodes = gltf["nodes"].as_array().map_or(&[][..], Vec::as_slice);
    let scene_index = gltf["scene"].as_u64().unwrap_or(0) as usize;
    let top: Vec<usize> = gltf["scenes"][scene_index]["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64().map(|n| n as usize))
                .collect()
        })
        .unwrap_or_default();

    let mut map = BTreeMap::new();
    let godot: Vec<&TreeNode> = roots.iter().collect();
    match_level(nodes, &top, &godot, "", &mut map);
    map
}

fn children_of(node: &Value) -> Vec<usize> {
    node["children"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64().map(|n| n as usize))
                .collect()
        })
        .unwrap_or_default()
}

fn match_level(
    nodes: &[Value],
    gltf_kids: &[usize],
    godot_kids: &[&TreeNode],
    prefix: &str,
    map: &mut BTreeMap<String, String>,
) {
    let mut next = 0;
    for godot in godot_kids {
        let found = (next..gltf_kids.len()).find(|&k| {
            nodes
                .get(gltf_kids[k])
                .and_then(|n| n["name"].as_str())
                .is_some_and(|name| names_match(&godot.name, name))
        });
        match found {
            Some(k) => {
                next = k + 1;
                let index = gltf_kids[k];
                let name = nodes[index]["name"].as_str().unwrap_or_default();
                let path = if prefix.is_empty() {
                    three_name(name)
                } else {
                    format!("{prefix}/{}", three_name(name))
                };
                map.insert(path.clone(), godot.path.clone());
                let below: Vec<&TreeNode> = godot.children.iter().collect();
                match_level(nodes, &children_of(&nodes[index]), &below, &path, map);
            }
            None => {
                // Not exported: whatever hangs off it was attached one level up.
                let below: Vec<&TreeNode> = godot.children.iter().collect();
                match_level(nodes, &gltf_kids[next..], &below, prefix, map);
            }
        }
    }
}

// --- exporting -----------------------------------------------------------------

/// What one export should produce.
#[derive(Debug, Clone)]
pub struct Export {
    pub project: PathBuf,
    pub scene: String,
    /// Where `<slug>.glb` and `<slug>.json` go.
    pub dir: PathBuf,
    pub slug: String,
    pub key: String,
    pub godot: Found,
    pub scratch: PathBuf,
    pub limits: Limits,
}

/// Run an export to completion, recording the outcome on `job`. Blocking: the
/// caller runs it on its own thread and polls the job.
pub fn run(job: &Arc<Mutex<Job>>, opts: &Export) {
    let outcome = export(job, opts);
    finish(job, outcome.err());
}

fn export(job: &Arc<Mutex<Job>>, opts: &Export) -> Result<Preview, String> {
    ensure_imported(job, &opts.project, &opts.godot, opts.limits.import)?;

    set_phase(job, "exporting the scene to glTF");
    std::fs::create_dir_all(&opts.dir)
        .map_err(|e| format!("could not create {}: {e}", opts.dir.display()))?;
    std::fs::create_dir_all(&opts.scratch).map_err(|e| e.to_string())?;
    let script = opts.scratch.join("export_glb.gd");
    std::fs::write(&script, EXPORT_SCRIPT)
        .map_err(|e| format!("could not write the export script: {e}"))?;
    let tree_file = opts.scratch.join("export-tree.json");
    let _ = std::fs::remove_file(&tree_file);
    let temp = opts.dir.join(format!("{}.tmp.glb", opts.slug));
    let _ = std::fs::remove_file(&temp);

    let args = [
        "--headless",
        "--path",
        opts.project.to_str().unwrap_or("."),
        "-s",
        script.to_str().unwrap_or(""),
        "--",
        "--scene",
        &opts.scene,
        "--glb",
        temp.to_str().unwrap_or(""),
        "--out",
        tree_file.to_str().unwrap_or(""),
    ];
    let out = run_capture(
        opts.godot.for_logging(),
        &args,
        &opts.project,
        opts.limits.export,
    )?;
    push_output(job, &out.text);

    let outcome = (|| {
        let text = std::fs::read_to_string(&tree_file).map_err(|_| {
            format!(
                "Godot exited ({}) without exporting the scene{}",
                out.code_label(),
                tail(&out.text)
            )
        })?;
        install(opts, &temp, &text)
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    outcome
}

/// Turn what the script wrote into the finished preview: check it, build the
/// node map, and swap the new glb and sidecar into place.
fn install(opts: &Export, temp: &Path, tree_json: &str) -> Result<Preview, String> {
    let tree: Value = serde_json::from_str(tree_json)
        .map_err(|e| format!("the scene tree was unreadable: {e}"))?;
    if tree["ok"].as_bool() != Some(true) {
        return Err(tree["error"]
            .as_str()
            .unwrap_or("Godot could not export the scene")
            .to_string());
    }
    let roots: Vec<TreeNode> = serde_json::from_value(tree["nodes"].clone())
        .map_err(|e| format!("the scene tree had an unexpected shape: {e}"))?;
    let file = std::fs::File::open(temp)
        .map_err(|e| format!("Godot reported success but wrote no glTF: {e}"))?;
    let gltf = read_glb_json(file)?;
    let glb_bytes = std::fs::metadata(temp).map_err(|e| e.to_string())?.len();

    let preview = Preview {
        key: opts.key.clone(),
        scene: opts.scene.clone(),
        exported_at: super::runner::now_ms(),
        godot: opts.godot.version.clone(),
        glb_bytes,
        node_map: build_node_map(&gltf, &roots),
    };

    replace(temp, &glb_path(&opts.dir, &opts.slug))?;
    let sidecar = sidecar_path(&opts.dir, &opts.slug);
    let text = serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())?;
    let sidecar_temp = opts.dir.join(format!("{}.json.tmp", opts.slug));
    std::fs::write(&sidecar_temp, text).map_err(|e| e.to_string())?;
    replace(&sidecar_temp, &sidecar)?;
    Ok(preview)
}

/// Rename over `to`. A reader with the destination open makes a Windows rename
/// fail for a moment, so it is retried briefly before giving up.
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    let mut last = None;
    for _ in 0..12 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    let _ = std::fs::remove_file(from);
    Err(format!(
        "could not replace {}: {}",
        to.display(),
        last.map_or_else(String::new, |e| e.to_string())
    ))
}

/// The glb's bytes for the viewer, or why it cannot be sent.
pub fn read_glb(dir: &Path, slug: &str) -> Result<Vec<u8>, String> {
    let path = glb_path(dir, slug);
    let size = std::fs::metadata(&path)
        .map_err(|_| "this scene has not been exported yet".to_string())?
        .len();
    if size > MAX_GLB_BYTES {
        return Err(format!(
            "the exported scene is {} MB; the viewer takes up to {} MB",
            size / 1024 / 1024,
            MAX_GLB_BYTES / 1024 / 1024
        ));
    }
    std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// The last export of this kind that failed on `job`, for the pane to explain.
pub fn failure(job: &Job, scene: &str) -> Option<String> {
    (!job.running && job.scene == scene)
        .then(|| job.error.clone())
        .flatten()
}

/// The job for `key`, without holding its lock.
pub fn snapshot(job: &Arc<Mutex<Job>>) -> Job {
    job.lock_or_panic().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn tree(name: &str, path: &str, children: Vec<TreeNode>) -> TreeNode {
        TreeNode {
            name: name.to_string(),
            path: path.to_string(),
            children,
        }
    }

    #[test]
    fn a_scene_names_one_stable_file() {
        assert_eq!(slug(".", "res://scenes/main.tscn"), "scenes__main_tscn");
        assert_eq!(slug("", "res://main.tscn"), "main_tscn");
        assert_eq!(
            slug("game", "res://scenes/main.tscn"),
            "game__scenes__main_tscn"
        );
        assert_eq!(
            slug("tools/viewer", "res://a b/c.tscn"),
            "tools__viewer__a_b__c_tscn"
        );
        assert_eq!(
            slug(".", "res://scenes/main.tscn"),
            slug(".", "res://scenes/main.tscn"),
            "the same scene is always the same file"
        );
        assert!(!slug(".", "res://../../etc/x.tscn").contains('/'));
    }

    fn project() -> TempDir {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("props")).unwrap();
        std::fs::write(
            dir.path().join("main.tscn"),
            "[gd_scene format=3]\n\n[ext_resource type=\"PackedScene\" path=\"res://props/bed.tscn\" id=\"1\"]\n\n[node name=\"World\" type=\"Node3D\"]\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("props/bed.tscn"),
            "[gd_scene format=3]\n\n[ext_resource type=\"PackedScene\" path=\"res://props/bed.glb\" id=\"1\"]\n\n[node name=\"Bed\" type=\"Node3D\"]\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("props/bed.glb"), b"glb-v1").unwrap();
        dir
    }

    #[test]
    fn the_key_holds_until_the_scene_or_something_it_uses_changes() {
        let dir = project();
        let key = |g: &str| cache_key(dir.path(), "res://main.tscn", g).unwrap();
        let first = key("4.3");
        assert_eq!(first, key("4.3"), "nothing changed, nothing to redo");
        assert_ne!(
            first,
            key("4.4"),
            "a different engine writes a different file"
        );

        // Touching the scene without editing it does not count: it is hashed by content.
        let scene = dir.path().join("main.tscn");
        let text = std::fs::read_to_string(&scene).unwrap();
        std::fs::write(&scene, &text).unwrap();
        assert_eq!(first, key("4.3"));

        std::fs::write(
            &scene,
            format!("{text}\n[node name=\"X\" type=\"Node3D\" parent=\".\"]\n"),
        )
        .unwrap();
        let edited = key("4.3");
        assert_ne!(first, edited, "the scene changed");

        // A sub-scene two levels down is a dependency too.
        std::fs::write(
            dir.path().join("props/bed.tscn"),
            "[gd_scene format=3]\n\n[node name=\"Bed2\" type=\"Node3D\"]\n",
        )
        .unwrap();
        assert_ne!(edited, key("4.3"), "an instanced scene changed");
    }

    #[test]
    fn a_changed_model_changes_the_key() {
        let dir = project();
        let before = cache_key(dir.path(), "res://main.tscn", "4.3").unwrap();
        std::fs::write(dir.path().join("props/bed.glb"), b"glb-v2-longer").unwrap();
        assert_ne!(
            before,
            cache_key(dir.path(), "res://main.tscn", "4.3").unwrap()
        );
    }

    #[test]
    fn a_missing_scene_is_an_error_and_a_missing_dependency_is_not() {
        let dir = project();
        assert!(cache_key(dir.path(), "res://nope.tscn", "4.3")
            .unwrap_err()
            .contains("could not read"));
        std::fs::remove_file(dir.path().join("props/bed.glb")).unwrap();
        assert!(cache_key(dir.path(), "res://main.tscn", "4.3").is_ok());
    }

    #[test]
    fn a_scene_that_includes_itself_terminates() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("loop.tscn"),
            "[gd_scene format=3]\n[ext_resource type=\"PackedScene\" path=\"res://loop.tscn\" id=\"1\"]\n[node name=\"L\" type=\"Node3D\"]\n",
        )
        .unwrap();
        assert!(cache_key(dir.path(), "res://loop.tscn", "4.3").is_ok());
    }

    #[test]
    fn a_sidecar_is_fresh_only_for_its_key_and_while_the_glb_exists() {
        let dir = TempDir::new().unwrap();
        let preview = Preview {
            key: "k1".into(),
            scene: "res://main.tscn".into(),
            exported_at: 5,
            godot: "4.3".into(),
            glb_bytes: 3,
            node_map: BTreeMap::from([("World".into(), "World".into())]),
        };
        std::fs::write(
            sidecar_path(dir.path(), "main_tscn"),
            serde_json::to_string(&preview).unwrap(),
        )
        .unwrap();
        assert!(
            read_fresh(dir.path(), "main_tscn", "k1").is_none(),
            "no glb yet"
        );
        std::fs::write(glb_path(dir.path(), "main_tscn"), b"x").unwrap();
        assert_eq!(read_fresh(dir.path(), "main_tscn", "k1"), Some(preview));
        assert!(read_fresh(dir.path(), "main_tscn", "k2").is_none());
        assert!(read_fresh(dir.path(), "other", "k1").is_none());
    }

    fn glb(json: &Value) -> Vec<u8> {
        let mut text = serde_json::to_vec(json).unwrap();
        while !text.len().is_multiple_of(4) {
            text.push(b' ');
        }
        let mut out = b"glTF".to_vec();
        out.extend(2u32.to_le_bytes());
        out.extend((20 + text.len() as u32).to_le_bytes());
        out.extend((text.len() as u32).to_le_bytes());
        out.extend(b"JSON");
        out.extend(text);
        out
    }

    #[test]
    fn the_json_chunk_is_read_and_bad_files_are_named() {
        let bytes = glb(&json!({"asset": {"version": "2.0"}}));
        let value = read_glb_json(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(value["asset"]["version"], "2.0");
        assert!(
            read_glb_json(std::io::Cursor::new(b"not a glb at all, no".to_vec()))
                .unwrap_err()
                .contains("not a glTF")
        );
        assert!(read_glb_json(std::io::Cursor::new(b"glTF".to_vec()))
            .unwrap_err()
            .contains("too short"));
        let mut cut = glb(&json!({"a": 1}));
        cut.truncate(cut.len() - 4);
        assert!(read_glb_json(std::io::Cursor::new(cut))
            .unwrap_err()
            .contains("truncated"));
    }

    #[test]
    fn three_renames_what_it_renames() {
        assert_eq!(three_name("Front Door"), "Front_Door");
        assert_eq!(three_name("Wall.001"), "Wall001");
        assert_eq!(three_name("A[1]:b"), "A1b");
        assert_eq!(three_name("Leg3"), "Leg3");
    }

    #[test]
    fn unique_suffixes_still_match_their_node() {
        assert!(names_match("Crate", "Crate"));
        assert!(names_match("Crate", "Crate2"));
        assert!(names_match("Crate", "Crate_2"));
        assert!(!names_match("Crate", "CrateBig"));
        assert!(!names_match("Crate", "Cra"));
    }

    /// The scene `demo-game/scenes/main.tscn` exports as, cut down: a renamed
    /// duplicate, a node with a space, and a branch of non-3D nodes.
    fn demo_gltf() -> Value {
        json!({
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {"name": "Main", "children": [1, 3, 4]},
                {"name": "Crate", "children": [2]},
                {"name": "Crate2"},
                {"name": "Front Door"},
                {"name": "Hud"},
            ]
        })
    }

    #[test]
    fn a_pick_maps_back_to_its_scene_path_through_renames() {
        let roots = vec![tree(
            "Main",
            "Main",
            vec![
                tree(
                    "Crate",
                    "Main/Crate",
                    vec![tree("Crate", "Main/Crate/Crate", vec![])],
                ),
                tree("Front Door", "Main/Front Door", vec![]),
                tree("Hud", "Main/Hud", vec![]),
            ],
        )];
        let map = build_node_map(&demo_gltf(), &roots);
        assert_eq!(map["Main"], "Main");
        assert_eq!(map["Main/Crate"], "Main/Crate");
        assert_eq!(
            map["Main/Crate/Crate2"], "Main/Crate/Crate",
            "the exporter's unique name maps to the scene's"
        );
        assert_eq!(
            map["Main/Front_Door"], "Main/Front Door",
            "three.js's sanitised path maps to the scene's"
        );
        assert_eq!(map["Main/Hud"], "Main/Hud");
        assert_eq!(map.len(), 5);
    }

    #[test]
    fn a_node_the_exporter_skipped_does_not_derail_its_siblings() {
        // `Marker` has no glTF node; `Lamp`, its child, was attached to `Main`.
        let gltf = json!({
            "scenes": [{"nodes": [0]}],
            "nodes": [
                {"name": "Main", "children": [1, 2]},
                {"name": "Floor"},
                {"name": "Lamp"},
            ]
        });
        let roots = vec![tree(
            "Main",
            "Main",
            vec![
                tree("Floor", "Main/Floor", vec![]),
                tree(
                    "Marker",
                    "Main/Marker",
                    vec![tree("Lamp", "Main/Marker/Lamp", vec![])],
                ),
            ],
        )];
        let map = build_node_map(&gltf, &roots);
        assert_eq!(map["Main/Floor"], "Main/Floor");
        assert_eq!(map["Main/Lamp"], "Main/Marker/Lamp");
        assert!(!map.values().any(|v| v == "Main/Marker"));
    }

    #[test]
    fn a_scene_root_that_is_not_exported_leaves_its_children_at_the_top() {
        let gltf = json!({
            "scenes": [{"nodes": [0, 1]}],
            "nodes": [{"name": "Player"}, {"name": "Floor"}]
        });
        let roots = vec![tree(
            "Level",
            "Level",
            vec![
                tree("Player", "Level/Player", vec![]),
                tree("Floor", "Level/Floor", vec![]),
            ],
        )];
        let map = build_node_map(&gltf, &roots);
        assert_eq!(map["Player"], "Level/Player");
        assert_eq!(map["Floor"], "Level/Floor");
    }

    #[test]
    fn an_empty_gltf_maps_nothing() {
        assert!(build_node_map(&json!({}), &[tree("A", "A", vec![])]).is_empty());
    }

    fn export_opts(dir: &TempDir, godot_exe: &Path) -> Export {
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".godot/imported")).unwrap();
        std::fs::write(project.join("main.tscn"), "[gd_scene]\n").unwrap();
        Export {
            project,
            scene: "res://main.tscn".into(),
            dir: dir.path().join("preview"),
            slug: "main_tscn".into(),
            key: "key-1".into(),
            godot: Found {
                path: godot_exe.to_path_buf(),
                console: None,
                source: super::super::detect::Source::Setting,
                version: "4.3.stable.fake".into(),
                major: 4,
                minor: 3,
            },
            scratch: dir.path().join("scratch"),
            limits: Limits::default(),
        }
    }

    #[test]
    fn an_export_installs_the_glb_and_sidecar_in_place_and_leaves_no_temp_files() {
        let dir = TempDir::new().unwrap();
        let exe = super::super::testing::fake_godot(dir.path(), false);
        let opts = export_opts(&dir, &exe);
        std::fs::create_dir_all(&opts.dir).unwrap();
        let temp = opts.dir.join("main_tscn.tmp.glb");
        let tree_json = json!({
            "ok": true,
            "nodes": [{"name": "Main", "path": "Main", "children": []}]
        })
        .to_string();

        for round in 0..3 {
            std::fs::write(&temp, glb(&json!({"scenes": [{"nodes": [0]}], "nodes": [{"name": "Main"}], "round": round}))).unwrap();
            let preview = install(&opts, &temp, &tree_json).unwrap();
            assert_eq!(preview.node_map["Main"], "Main");
        }

        let mut names: Vec<String> = std::fs::read_dir(&opts.dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["main_tscn.glb", "main_tscn.json"],
            "three exports, still one file and its sidecar"
        );
        assert!(read_fresh(&opts.dir, "main_tscn", "key-1").is_some());
    }

    #[test]
    fn a_failed_conversion_reports_godots_reason_and_keeps_the_last_good_file() {
        let dir = TempDir::new().unwrap();
        let exe = super::super::testing::fake_godot(dir.path(), false);
        let opts = export_opts(&dir, &exe);
        std::fs::create_dir_all(&opts.dir).unwrap();
        std::fs::write(glb_path(&opts.dir, "main_tscn"), b"previous").unwrap();
        let temp = opts.dir.join("main_tscn.tmp.glb");
        let failed = json!({"ok": false, "error": "could not load res://main.tscn"}).to_string();
        assert_eq!(
            install(&opts, &temp, &failed).unwrap_err(),
            "could not load res://main.tscn"
        );
        assert_eq!(
            std::fs::read(glb_path(&opts.dir, "main_tscn")).unwrap(),
            b"previous"
        );
        assert!(install(&opts, &temp, "not json").is_err());
    }

    #[test]
    fn an_engine_that_exits_without_writing_says_so_and_leaves_nothing_behind() {
        let dir = TempDir::new().unwrap();
        let exe = super::super::testing::fake_godot(dir.path(), false);
        let opts = export_opts(&dir, &exe);
        let job = Arc::new(Mutex::new(Job {
            running: true,
            scene: opts.scene.clone(),
            ..Job::default()
        }));
        run(&job, &opts);
        let job = snapshot(&job);
        assert!(!job.running);
        let why = failure(&job, "res://main.tscn").expect("failed");
        assert!(why.contains("without exporting"), "{why}");
        assert!(failure(&job, "res://other.tscn").is_none());
        assert!(
            std::fs::read_dir(&opts.dir).unwrap().next().is_none(),
            "no glb, no temp file"
        );
    }

    #[test]
    fn a_glb_over_the_limit_is_refused_by_name() {
        let dir = TempDir::new().unwrap();
        assert!(read_glb(dir.path(), "main_tscn")
            .unwrap_err()
            .contains("not been exported"));
        std::fs::write(glb_path(dir.path(), "main_tscn"), b"12345").unwrap();
        assert_eq!(read_glb(dir.path(), "main_tscn").unwrap(), b"12345");
    }
}
