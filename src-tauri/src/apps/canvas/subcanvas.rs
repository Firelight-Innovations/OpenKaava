//! Sub-canvases: a heavy frame moved into a child canvas of its own, so the
//! parent draws one picture per frame instead of every element in it.
//!
//! A canvas with thirty frames of a few hundred elements each makes Excalidraw
//! repaint six thousand elements on every pan, which is a slideshow. Splitting
//! moves each frame's members into `canvas/<parent>/<diagram>.json`, together
//! with a copy of the frame itself (same element id, same position, same
//! diagram metadata). The parent keeps the empty frame, linked to the child
//! with the ordinary nesting link (`customData.kaava.child` plus a
//! `kaava://canvas/` link) and marked `customData.kaava.subcanvas: true`. The
//! marker is what tells the editor to draw the child's picture into the frame,
//! and tells the agent methods that the frame's elements now live in the child.
//!
//! Splitting is an explicit action (`canvas/split-frames`), not something done
//! on open. It turns one committed file into many, which is the person's call;
//! a read-only checkout cannot write at all; and it is checkpointed, so it can
//! be undone with `canvas/restore-checkpoint` like any other agent edit.
//! Rejected: pictures drawn from the parent's own elements with no child file;
//! saves, diffs and agent reads would stay as heavy as before.

use super::comments;
use super::diagrams::{self, Diagram};
use super::methods::{actor, open, params_of, save_scene, string};
use super::store;
use super::{bad, file_for, mtime_at, relative, validate_id, SCHEMA};
use base64::Engine;
use kaava_rpc::RpcError;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

/// A frame with fewer members than this stays where it is unless named.
pub const MIN_ELEMENTS: usize = 40;

/// Mirrors `CANVAS_LINK` in `ui/src/nesting.ts`.
const CANVAS_LINK: &str = "kaava://canvas/";

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn is_live(e: &Value) -> bool {
    e.get("isDeleted").and_then(Value::as_bool) != Some(true)
}

fn is_frame(e: &Value) -> bool {
    matches!(str_of(e, "type"), Some("frame" | "magicframe"))
}

/// The child canvas a live frame's elements were moved into, if it is a
/// sub-canvas frame. A frame that is merely linked to a child (drawn by hand
/// next to its link badge) is not one.
pub fn child_of_frame(el: &Value) -> Option<&str> {
    if !is_frame(el) || !is_live(el) {
        return None;
    }
    let kaava = el.pointer("/customData/kaava")?;
    if kaava.get("subcanvas").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    kaava.get("child").and_then(Value::as_str)
}

/// Every sub-canvas frame in `scene`: `(frame element, child id)`.
pub fn subcanvas_frames(scene: &Value) -> Vec<(&Value, String)> {
    diagrams::elements_of(scene)
        .iter()
        .filter_map(|e| child_of_frame(e).map(|c| (e, c.to_string())))
        .collect()
}

/// The frame element `d` describes.
fn frame_el<'a>(scene: &'a Value, d: &Diagram) -> Option<&'a Value> {
    diagrams::elements_of(scene)
        .iter()
        .find(|e| str_of(e, "id") == Some(d.element_id.as_str()))
}

/// The canvas that holds diagram `wanted`'s elements: the sub-canvas its frame
/// was split into, if it was and that file exists, else canvas `id` itself.
/// Returns the canvas id, scene and mtime to work on, and the parent's id when
/// it followed a link.
pub fn follow(
    root: &Path,
    id: String,
    scene: Value,
    mtime: Option<u64>,
    wanted: &str,
) -> Result<(String, Value, Option<u64>, Option<String>), RpcError> {
    let all = diagrams::list(&scene);
    let child = diagrams::find(&all, wanted)
        .and_then(|d| frame_el(&scene, d))
        .and_then(child_of_frame)
        .filter(|c| validate_id(c).is_ok() && file_for(root, c).is_file())
        .map(str::to_owned);
    match child {
        Some(c) => {
            let (cid, cscene, cmtime) = open(root, &json!({ "id": c }))?;
            Ok((cid, cscene, cmtime, Some(id)))
        }
        None => Ok((id, scene, mtime, None)),
    }
}

/// Copy the child's frame (size, name, diagram metadata) onto the parent's
/// sub-canvas frame for `child`, so the parent's frame always fits the picture
/// and lists under the child's current title. Returns whether anything changed.
pub fn sync_parent_frame(parent: &mut Value, child: &str, child_scene: &Value) -> bool {
    let Some(list) = parent.get_mut("elements").and_then(Value::as_array_mut) else {
        return false;
    };
    let Some(target) = list.iter_mut().find(|e| child_of_frame(e) == Some(child)) else {
        return false;
    };
    let frame_id = str_of(target, "id").unwrap_or("").to_string();
    let elements = diagrams::elements_of(child_scene);
    let Some(source) = elements
        .iter()
        .find(|e| is_frame(e) && is_live(e) && str_of(e, "id") == Some(frame_id.as_str()))
        .or_else(|| elements.iter().find(|e| is_frame(e) && is_live(e)))
    else {
        return false;
    };
    let mut changed = false;
    for key in ["width", "height", "name"] {
        if let Some(v) = source.get(key) {
            if target.get(key) != Some(v) {
                target[key] = v.clone();
                changed = true;
            }
        }
    }
    if let Some(diagram) = source.pointer("/customData/kaava/diagram") {
        if target.pointer("/customData/kaava/diagram") != Some(diagram) {
            target["customData"]["kaava"]["diagram"] = diagram.clone();
            changed = true;
        }
    }
    if changed {
        diagrams::bump(target);
    }
    changed
}

/// After an edit to `child`, bring its parent's frame in line with it. A
/// parent that changed meanwhile is left alone: the editor syncs it on open.
pub fn sync_parent(root: &Path, parent: &str, child: &str, who: &str) -> Result<(), RpcError> {
    let (_, child_scene, _) = open(root, &json!({ "id": child }))?;
    let (_, mut scene, base) = open(root, &json!({ "id": parent }))?;
    if sync_parent_frame(&mut scene, child, &child_scene) {
        save_scene(root, parent, scene, base, who)?;
    }
    Ok(())
}

/// After `canvas/set-frame` renames or retypes a sub-canvas frame on the
/// parent, give the child's copy of the frame the same name and object, so
/// the next sync from the child does not undo it. Not a sub-canvas frame: no-op.
pub fn mirror_into_child(root: &Path, parent_frame: &Value, who: &str) -> Result<(), RpcError> {
    let Some(child) = child_of_frame(parent_frame) else {
        return Ok(());
    };
    if validate_id(child).is_err() || !file_for(root, child).is_file() {
        return Ok(());
    }
    let (_, mut scene, base) = open(root, &json!({ "id": child }))?;
    let fid = str_of(parent_frame, "id").unwrap_or("");
    let Some(target) = scene
        .get_mut("elements")
        .and_then(Value::as_array_mut)
        .and_then(|a| a.iter_mut().find(|e| str_of(e, "id") == Some(fid)))
    else {
        return Ok(());
    };
    target["name"] = parent_frame.get("name").cloned().unwrap_or(Value::Null);
    if !target.get("customData").is_some_and(Value::is_object) {
        target["customData"] = json!({});
    }
    if !target["customData"]
        .get("kaava")
        .is_some_and(Value::is_object)
    {
        target["customData"]["kaava"] = json!({});
    }
    match parent_frame.pointer("/customData/kaava/object") {
        Some(o) => target["customData"]["kaava"]["object"] = o.clone(),
        None => {
            if let Some(k) = target["customData"]["kaava"].as_object_mut() {
                k.remove("object");
            }
        }
    }
    diagrams::bump(target);
    // The child's title is what its badge, breadcrumb and picker show.
    let name = parent_frame.get("name").and_then(Value::as_str);
    if let (Some(n), Some(k)) = (name, scene.get_mut("kaava").and_then(Value::as_object_mut)) {
        k.insert("title".into(), json!(n));
    }
    save_scene(root, child, scene, base, who)?;
    Ok(())
}

// --- splitting ------------------------------------------------------------------

/// Why a frame cannot be split, or `None` when it can: something outside it is
/// bound to, contained by, or grouped with something inside it.
fn crossing(elements: &[Value], frame_id: &str, members: &HashSet<String>) -> Option<String> {
    let inside = |id: &str| id == frame_id || members.contains(id);
    for e in elements.iter().filter(|e| is_live(e)) {
        let Some(id) = str_of(e, "id") else { continue };
        let refs = [
            e.pointer("/startBinding/elementId").and_then(Value::as_str),
            e.pointer("/endBinding/elementId").and_then(Value::as_str),
            str_of(e, "containerId"),
        ];
        let is_member = members.contains(id);
        for r in refs.into_iter().flatten() {
            // A member pointing out, or an outsider pointing in. The frame
            // itself counts as outside for members and inside for outsiders,
            // since it stays in the parent and is copied into the child.
            if is_member && !members.contains(r) {
                return Some(format!("`{id}` is bound to `{r}`, outside the frame"));
            }
            if !is_member && id != frame_id && members.contains(r) {
                return Some(format!("`{id}`, outside the frame, is bound to `{r}`"));
            }
        }
        if is_member {
            if let Some(bound) = e.get("boundElements").and_then(Value::as_array) {
                for b in bound.iter().filter_map(|b| str_of(b, "id")) {
                    if !inside(b) {
                        return Some(format!("`{b}`, outside the frame, is bound to `{id}`"));
                    }
                }
            }
        }
    }
    let groups: HashSet<&str> = elements
        .iter()
        .filter(|e| str_of(e, "id").is_some_and(|id| members.contains(id)))
        .filter_map(|e| e.get("groupIds").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    elements
        .iter()
        .filter(|e| is_live(e))
        .filter(|e| str_of(e, "id").is_some_and(|id| !inside(id)))
        .find(|e| {
            e.get("groupIds")
                .and_then(Value::as_array)
                .is_some_and(|g| {
                    g.iter()
                        .filter_map(Value::as_str)
                        .any(|g| groups.contains(g))
                })
        })
        .map(|e| {
            format!(
                "`{}`, outside the frame, is grouped with elements inside it",
                str_of(e, "id").unwrap_or("?")
            )
        })
}

/// A slug for the child's last id segment.
fn slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() || out == "refs" {
        "frame".into()
    } else {
        out
    }
}

/// `<parent>/<slug>`, numbered past any canvas that exists or is planned.
fn child_id(root: &Path, parent: &str, base: &str, taken: &HashSet<String>) -> Option<String> {
    for n in 1..1000 {
        let id = if n == 1 {
            format!("{parent}/{base}")
        } else {
            format!("{parent}/{base}-{n}")
        };
        validate_id(&id).ok()?;
        if !taken.contains(&id) && !file_for(root, &id).exists() {
            return Some(id);
        }
    }
    None
}

/// The frame as the child keeps it: no child link, no marker, and no parent
/// diagram (which is not on the child canvas), bound only to its members.
fn child_frame(frame: &Value, members: &HashSet<String>) -> Value {
    let mut f = frame.clone();
    if let Some(k) = f
        .pointer_mut("/customData/kaava")
        .and_then(Value::as_object_mut)
    {
        k.remove("child");
        k.remove("subcanvas");
        if let Some(d) = k.get_mut("diagram").and_then(Value::as_object_mut) {
            d.remove("parent");
        }
    }
    if str_of(&f, "link").is_some_and(|l| l.starts_with(CANVAS_LINK)) {
        f["link"] = Value::Null;
    }
    keep_bound(&mut f, |id| members.contains(id));
    f
}

fn keep_bound(el: &mut Value, keep: impl Fn(&str) -> bool) {
    if let Some(list) = el.get_mut("boundElements").and_then(Value::as_array_mut) {
        list.retain(|b| str_of(b, "id").is_some_and(&keep));
    }
}

struct Plan {
    frame_id: String,
    key: String,
    title: String,
    child: String,
    members: HashSet<String>,
}

/// `canvas/split-frames` `{id, actor, frames?: [diagram id | frame id | title],
/// minElements?, dryRun?}`: move each named frame (or, with none named, each
/// frame of at least `minElements` members, default [`MIN_ELEMENTS`]) into its
/// own child canvas, leaving a linked sub-canvas frame in its place. Review
/// comments on a moved frame move with it. The parent is checkpointed first.
///
/// Result: `{canvas, split: [{frame, diagram, title, child, elements,
/// comments}], skipped: [{frame, reason}], checkpoint, mtime, dryRun}`.
pub fn split_frames(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let who = actor(p)?;
    let (id, mut scene, base) = open(root, p)?;
    let dry = p.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let min = p
        .get("minElements")
        .and_then(Value::as_u64)
        .map_or(MIN_ELEMENTS, |n| n.max(1) as usize);
    let named: Option<Vec<String>> = match p.get("frames") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(
            a.iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| bad("frames must be a list of diagram ids"))
                })
                .collect::<Result<_, _>>()?,
        ),
        Some(_) => return Err(bad("frames must be a list of diagram ids")),
    };

    let all = diagrams::list(&scene);
    let wanted: Vec<&Diagram> = match &named {
        Some(names) => names
            .iter()
            .map(|n| {
                diagrams::find(&all, n)
                    .ok_or_else(|| bad(format!("no frame `{n}` on canvas `{id}`")))
            })
            .collect::<Result<_, _>>()?,
        None => all.iter().filter(|d| d.members >= min).collect(),
    };

    let elements = diagrams::elements_of(&scene).to_vec();
    let mut taken = HashSet::new();
    let mut plans = Vec::new();
    let mut skipped = Vec::new();
    for d in wanted {
        let key = d.id.clone().unwrap_or_else(|| d.element_id.clone());
        let skip = |reason: String| json!({ "frame": key, "reason": reason });
        let Some(frame) = frame_el(&scene, d) else {
            continue;
        };
        if frame.pointer("/customData/kaava/child").is_some() {
            skipped.push(skip("it already links to a child canvas".into()));
            continue;
        }
        let members: HashSet<String> = diagrams::members_of(&elements, &d.element_id)
            .into_iter()
            .collect();
        if members.is_empty() {
            skipped.push(skip("it is empty".into()));
            continue;
        }
        if let Some(why) = crossing(&elements, &d.element_id, &members) {
            skipped.push(skip(why));
            continue;
        }
        let base_slug = slug(d.id.as_deref().unwrap_or(&d.title));
        let Some(child) = child_id(root, &id, &base_slug, &taken) else {
            skipped.push(skip(format!(
                "`{id}` is nested as deep as canvases go, so it cannot have children"
            )));
            continue;
        };
        taken.insert(child.clone());
        plans.push(Plan {
            frame_id: d.element_id.clone(),
            key,
            title: d.title.clone(),
            child,
            members,
        });
    }

    let (comment_list, _) = comments::load_all(root, &id);
    let comments_for = |plan: &Plan| -> Vec<&comments::Comment> {
        comment_list
            .iter()
            .filter(|c| c.frame_id == plan.key || c.frame_id == plan.frame_id)
            .collect()
    };
    let report: Vec<Value> = plans
        .iter()
        .map(|plan| {
            json!({
                "frame": plan.frame_id,
                "diagram": plan.key,
                "title": plan.title,
                "child": plan.child,
                "elements": plan.members.len(),
                "comments": comments_for(plan).len(),
            })
        })
        .collect();
    if dry || plans.is_empty() {
        return Ok(json!({
            "canvas": id, "split": report, "skipped": skipped,
            "checkpoint": null, "mtime": base, "dryRun": dry,
        }));
    }

    let checkpoint = store::checkpoint(root, &id, store::SPLIT_CHECKPOINT)?;
    store::inflate(root, &id, &mut scene);
    let files = scene.get("files").and_then(Value::as_object).cloned();
    let app_state = {
        let a = scene.get("appState").cloned().unwrap_or(json!({}));
        json!({
            "viewBackgroundColor": a.get("viewBackgroundColor").cloned().unwrap_or(json!("#ffffff")),
            "gridSize": a.get("gridSize").cloned().unwrap_or(Value::Null),
        })
    };
    let values = scene.pointer("/kaava/values").cloned();

    let mut written: Vec<String> = Vec::new();
    let undo = |written: &[String]| {
        for c in written {
            let _ = std::fs::remove_file(file_for(root, c));
        }
    };
    for plan in &plans {
        let mut child_elements = Vec::new();
        let mut used_files = Map::new();
        for e in &elements {
            let Some(eid) = str_of(e, "id") else { continue };
            if eid == plan.frame_id {
                child_elements.push(child_frame(e, &plan.members));
            } else if plan.members.contains(eid) {
                if let (Some(fid), Some(all_files)) = (str_of(e, "fileId"), files.as_ref()) {
                    if let Some(f) = all_files.get(fid) {
                        used_files.insert(fid.to_string(), f.clone());
                    }
                }
                child_elements.push(e.clone());
            }
        }
        // The frame is drawn after its children, the order Excalidraw keeps.
        if let Some(pos) = child_elements
            .iter()
            .position(|e| str_of(e, "id") == Some(plan.frame_id.as_str()))
        {
            let f = child_elements.remove(pos);
            child_elements.push(f);
        }
        let mut kaava = json!({ "schema": SCHEMA, "title": plan.title, "parent": id });
        if let Some(v) = &values {
            kaava["values"] = v.clone();
        }
        let child_scene = json!({
            "type": "excalidraw",
            "version": 2,
            "source": "openkaava",
            "elements": child_elements,
            "appState": app_state,
            "files": used_files,
            "kaava": kaava,
        });
        if let Err(e) = save_scene(root, &plan.child, child_scene, None, who) {
            undo(&written);
            return Err(e);
        }
        written.push(plan.child.clone());
    }

    let moved: HashSet<&str> = plans
        .iter()
        .flat_map(|p| p.members.iter().map(String::as_str))
        .collect();
    if let Some(list) = scene.get_mut("elements").and_then(Value::as_array_mut) {
        list.retain(|e| str_of(e, "id").is_none_or(|eid| !moved.contains(eid)));
        for plan in &plans {
            if let Some(f) = list
                .iter_mut()
                .find(|e| str_of(e, "id") == Some(plan.frame_id.as_str()))
            {
                if !f.get("customData").is_some_and(Value::is_object) {
                    f["customData"] = json!({});
                }
                if !f["customData"].get("kaava").is_some_and(Value::is_object) {
                    f["customData"]["kaava"] = json!({});
                }
                f["customData"]["kaava"]["child"] = json!(plan.child);
                f["customData"]["kaava"]["subcanvas"] = json!(true);
                f["link"] = json!(format!("{CANVAS_LINK}{}", plan.child));
                keep_bound(f, |b| !plan.members.contains(b));
                diagrams::bump(f);
            }
        }
    }
    // Files only the moved elements used now live with the children.
    let still_used: HashSet<String> = diagrams::elements_of(&scene)
        .iter()
        .filter_map(|e| str_of(e, "fileId").map(str::to_owned))
        .collect();
    if let Some(f) = scene.get_mut("files").and_then(Value::as_object_mut) {
        f.retain(|k, _| still_used.contains(k));
    }
    let mtime = match save_scene(root, &id, scene, base, who) {
        Ok(m) => m,
        Err(e) => {
            undo(&written);
            return Err(e);
        }
    };
    for plan in &plans {
        for c in comments_for(plan) {
            comments::move_to(root, c, &plan.child)?;
        }
    }
    Ok(json!({
        "canvas": id, "split": report, "skipped": skipped,
        "checkpoint": checkpoint, "mtime": mtime, "dryRun": false,
        "hint": "each split frame now shows a picture of its child canvas; double-click it, \
                 or pass the diagram id to any canvas method and it is followed into the child. \
                 restore-checkpoint on the parent undoes the split and brings the comments home.",
    }))
}

/// Before an undone split is saved: for every child that `before` linked as a
/// sub-canvas and `after` no longer does, put the child's current elements
/// back into `after` in place of the frame's members there. Without this,
/// restoring the split checkpoint would bring back the members as they were at
/// the split and drop every edit made in the child since.
/// A child whose frame is not on `after` is left out, so a checkpoint older
/// than the frame stays as it was. Returns the children merged.
pub fn merge_children(
    root: &Path,
    parent: &str,
    before: &Value,
    after: &mut Value,
) -> Result<Vec<String>, RpcError> {
    let still: HashSet<String> = subcanvas_frames(after)
        .into_iter()
        .map(|(_, c)| c)
        .collect();
    let gone: Vec<(String, String)> = subcanvas_frames(before)
        .into_iter()
        .filter(|(_, c)| !still.contains(c))
        .filter_map(|(f, c)| str_of(f, "id").map(|id| (id.to_string(), c)))
        .collect();
    let mut merged = Vec::new();
    for (frame_id, child) in gone {
        let Ok(mut cscene) = super::load(&file_for(root, &child)) else {
            continue;
        };
        if cscene.pointer("/kaava/parent").and_then(Value::as_str) != Some(parent) {
            continue;
        }
        store::inflate(root, &child, &mut cscene);
        let Some(list) = after.get_mut("elements").and_then(Value::as_array_mut) else {
            break;
        };
        if !list
            .iter()
            .any(|e| str_of(e, "id") == Some(frame_id.as_str()))
        {
            continue;
        }
        let stale: HashSet<String> = diagrams::members_of(list, &frame_id).into_iter().collect();
        list.retain(|e| str_of(e, "id").is_none_or(|id| !stale.contains(id)));
        let taken: HashSet<String> = list
            .iter()
            .filter_map(|e| str_of(e, "id").map(str::to_owned))
            .collect();
        let celements = diagrams::elements_of(&cscene);
        let incoming: Vec<Value> = celements
            .iter()
            .filter(|e| is_live(e))
            .filter(|e| str_of(e, "id").is_some_and(|id| !taken.contains(id)))
            .cloned()
            .collect();
        let at = list
            .iter()
            .position(|e| str_of(e, "id") == Some(frame_id.as_str()))
            .unwrap_or(list.len());
        // The child's frame: its size and name carry over to the parent's.
        if let Some(cframe) = celements
            .iter()
            .find(|e| str_of(e, "id") == Some(frame_id.as_str()))
        {
            let target = &mut list[at];
            for key in ["width", "height", "name"] {
                if let Some(v) = cframe.get(key) {
                    target[key] = v.clone();
                }
            }
            diagrams::bump(target);
        }
        let used: Vec<String> = incoming
            .iter()
            .filter_map(|e| str_of(e, "fileId").map(str::to_owned))
            .collect();
        list.splice(at..at, incoming);
        if let Some(cfiles) = cscene.get("files").and_then(Value::as_object) {
            if !after.get("files").is_some_and(Value::is_object) {
                after["files"] = json!({});
            }
            if let Some(files) = after["files"].as_object_mut() {
                for fid in used {
                    if let Some(f) = cfiles.get(&fid) {
                        files.entry(fid).or_insert_with(|| f.clone());
                    }
                }
            }
        }
        merged.push(child);
    }
    Ok(merged)
}

/// Undo a split's files for every child that `before` linked as a sub-canvas
/// and `after` no longer does: its comments move back to `parent`, and the
/// child, once copied into its own checkpoint ring, is removed with its cached
/// picture, so a later split does not stack `-2`, `-3` copies beside it.
/// Returns how many comments moved and the children removed.
pub fn unsplit(
    root: &Path,
    parent: &str,
    before: &Value,
    after: &Value,
) -> Result<(usize, Vec<String>), RpcError> {
    let still: HashSet<String> = subcanvas_frames(after)
        .into_iter()
        .map(|(_, c)| c)
        .collect();
    let mut moved = 0;
    let mut removed = Vec::new();
    for (_, child) in subcanvas_frames(before) {
        if still.contains(&child) {
            continue;
        }
        for c in comments::load_all(root, &child).0 {
            comments::move_to(root, &c, parent)?;
            moved += 1;
        }
        let path = file_for(root, &child);
        let ours = super::load(&path)
            .ok()
            .is_some_and(|s| s.pointer("/kaava/parent").and_then(Value::as_str) == Some(parent));
        if ours && store::checkpoint(root, &child, "unsplit")?.is_some() {
            std::fs::remove_file(&path)
                .map_err(|e| bad(format!("could not remove {child}: {e}")))?;
            let (png, meta) = store::snapshot_paths(root, &child)?;
            let _ = std::fs::remove_file(png);
            let _ = std::fs::remove_file(meta);
            // Its comments folder, now empty; remove_dir leaves a full one.
            let _ = std::fs::remove_dir(path.with_extension("comments"));
            removed.push(child);
        }
    }
    Ok((moved, removed))
}

// --- pictures ---------------------------------------------------------------------

/// `canvas/snapshots` `{id, known?: {child: mtime}}` -> `{frames: [{frame,
/// child, mtime, missing, unchanged?, childFrame?, png?, width?, height?}]}`:
/// each sub-canvas frame on canvas `id` and its child's current mtime. A child
/// whose mtime matches `known` is reported `unchanged` and nothing more, so the
/// editor's poll is cheap. Otherwise the row carries the child's frame
/// (`{id, width, height, name}`) and the cached picture (base64) when one was
/// drawn from that mtime. A row with no `png` needs drawing; the editor draws
/// it and hands it back with `canvas/put-snapshot`.
pub fn snapshots(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let (_, scene, _) = open(root, p)?;
    let mut rows = Vec::new();
    for (frame, child) in subcanvas_frames(&scene) {
        if validate_id(&child).is_err() {
            continue;
        }
        let path = file_for(root, &child);
        let mtime = mtime_at(&path);
        let mut row = json!({
            "frame": str_of(frame, "id"),
            "child": child,
            "mtime": mtime,
            "missing": mtime.is_none(),
        });
        let known = p.pointer(&format!(
            "/known/{}",
            child.replace('~', "~0").replace('/', "~1")
        ));
        if mtime.is_some() && known.and_then(Value::as_u64) == mtime {
            // The editor already has this one; a poll stays a handful of stats.
            row["unchanged"] = json!(true);
            rows.push(row);
            continue;
        }
        if let Some(m) = mtime {
            if let Ok((_, cscene, _)) = open(root, &json!({ "id": child })) {
                let fid = str_of(frame, "id").unwrap_or("");
                let elements = diagrams::elements_of(&cscene);
                let f = elements
                    .iter()
                    .find(|e| is_frame(e) && is_live(e) && str_of(e, "id") == Some(fid))
                    .or_else(|| elements.iter().find(|e| is_frame(e) && is_live(e)));
                if let Some(f) = f {
                    row["childFrame"] = json!({
                        "id": str_of(f, "id"),
                        "width": f.get("width"),
                        "height": f.get("height"),
                        "name": f.get("name"),
                    });
                }
            }
            if let Ok((png, meta)) = store::snapshot_paths(root, &child) {
                let fresh = std::fs::read_to_string(&meta)
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .filter(|v| v.get("mtime").and_then(Value::as_u64) == Some(m));
                if let (Some(meta), Ok(bytes)) = (fresh, std::fs::read(&png)) {
                    row["png"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
                    row["width"] = meta.get("width").cloned().unwrap_or(Value::Null);
                    row["height"] = meta.get("height").cloned().unwrap_or(Value::Null);
                }
            }
        }
        rows.push(row);
    }
    Ok(json!({ "frames": rows }))
}

/// `canvas/put-snapshot` `{child, mtime, png, width, height}`: cache the
/// picture the editor drew of `child` as it was at `mtime`. A cache write under
/// `.kaava/`, not a design change, so it works on a read-only checkout too.
pub fn put_snapshot(root: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let p = params_of(params);
    let child = string(p, "child")?;
    validate_id(&child)?;
    let mtime = p
        .get("mtime")
        .and_then(Value::as_u64)
        .ok_or_else(|| bad("mtime is required: the child's mtime the picture was drawn from"))?;
    let png = string(p, "png")?;
    let (png_path, meta_path) = store::snapshot_paths(root, &child)?;
    let bytes = store::write_png(&png_path, &png)?;
    let meta = json!({
        "mtime": mtime,
        "width": p.get("width").cloned().unwrap_or(Value::Null),
        "height": p.get("height").cloned().unwrap_or(Value::Null),
    });
    store::atomic_write(&meta_path, meta.to_string().as_bytes())?;
    Ok(json!({ "child": child, "bytes": bytes, "path": relative(root, &png_path) }))
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

    fn frame(id: &str, diagram: &str, x: f64) -> Value {
        json!({ "id": id, "type": "frame", "name": format!("Frame {diagram}"),
                "x": x, "y": 0, "width": 400, "height": 300, "version": 1,
                "customData": { "kaava": { "diagram": { "id": diagram, "title": diagram,
                                                        "parent": "overview" } } } })
    }

    fn rect(id: &str, frame: &str) -> Value {
        json!({ "id": id, "type": "rectangle", "frameId": frame, "x": 10, "y": 10,
                "width": 10, "height": 10, "version": 1 })
    }

    /// A canvas `game` with a heavy frame `big` (50 members, one of them a
    /// labelled box), a light frame `small`, and a frame `tied` whose member is
    /// bound to an arrow outside it.
    fn setup() -> TempDir {
        let dir = TempDir::new().unwrap();
        let mut elements = Vec::new();
        for n in 0..49 {
            elements.push(rect(&format!("b{n}"), "fb"));
        }
        let mut boxed = rect("box", "fb");
        boxed["boundElements"] = json!([{ "id": "label", "type": "text" }]);
        elements.push(boxed);
        elements.push(json!({ "id": "label", "type": "text", "containerId": "box",
                              "text": "{{gravity}}", "x": 12, "y": 12, "version": 1,
                              "customData": { "kaava": { "value": "gravity", "template": "{{gravity}}" } } }));
        elements.push(frame("fb", "big", 0.0));
        elements.push(rect("s1", "fs"));
        elements.push(frame("fs", "small", 500.0));
        let mut tied = rect("t1", "ft");
        tied["boundElements"] = json!([{ "id": "arrow", "type": "arrow" }]);
        elements.push(tied);
        elements.push(frame("ft", "tied", 1000.0));
        elements.push(json!({ "id": "arrow", "type": "arrow", "x": 0, "y": 400,
                              "endBinding": { "elementId": "t1" } }));
        let scene = json!({
            "type": "excalidraw",
            "elements": elements,
            "appState": { "viewBackgroundColor": "#fafafa", "gridSize": 20 },
            "files": {},
            "kaava": { "title": "Game", "values": { "gravity": { "value": 30 } } },
        });
        let path = dir.path().join("canvas/game.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, scene.to_string()).unwrap();
        dir
    }

    fn read(root: &Path, id: &str) -> Value {
        let (_, scene, _) = open(root, &json!({ "id": id })).unwrap();
        scene
    }

    #[test]
    fn a_dry_run_plans_the_heavy_frames_and_writes_nothing() {
        let dir = setup();
        let before = std::fs::read(dir.path().join("canvas/game.json")).unwrap();
        let out = run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent", "dryRun": true }),
        )
        .unwrap();
        assert_eq!(out["split"].as_array().unwrap().len(), 1);
        assert_eq!(out["split"][0]["child"], "game/big");
        assert_eq!(out["split"][0]["elements"], 51);
        assert_eq!(
            std::fs::read(dir.path().join("canvas/game.json")).unwrap(),
            before
        );
        assert!(!dir.path().join("canvas/game/big.json").exists());
        assert!(!dir.path().join("canvas/game/big.comments").exists());
    }

    #[test]
    fn splitting_moves_every_member_and_links_the_frame() {
        let dir = setup();
        let out = run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "human", "frames": ["big", "small", "tied"] }),
        )
        .unwrap();
        let split: Vec<&str> = out["split"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["diagram"].as_str().unwrap())
            .collect();
        assert_eq!(split, ["big", "small"]);
        assert_eq!(out["skipped"][0]["frame"], "tied");
        assert!(out["checkpoint"].is_string());

        let parent = read(dir.path(), "game");
        let ids: Vec<&str> = diagrams::elements_of(&parent)
            .iter()
            .filter_map(|e| str_of(e, "id"))
            .collect();
        assert_eq!(ids, ["fb", "fs", "t1", "ft", "arrow"]);
        let fb = &diagrams::elements_of(&parent)[0];
        assert_eq!(child_of_frame(fb), Some("game/big"));
        assert_eq!(fb["link"], "kaava://canvas/game/big");
        assert_eq!(fb["version"], 2);

        let child = read(dir.path(), "game/big");
        let celements = diagrams::elements_of(&child);
        assert_eq!(celements.len(), 52);
        let last = celements.last().unwrap();
        assert_eq!(last["id"], "fb");
        assert!(last.pointer("/customData/kaava/child").is_none());
        assert!(last.pointer("/customData/kaava/diagram/parent").is_none());
        assert_eq!(last["x"], 0.0);
        assert_eq!(child["kaava"]["parent"], "game");
        assert_eq!(child["kaava"]["values"]["gravity"]["value"], 30);
        assert_eq!(child["appState"]["viewBackgroundColor"], "#fafafa");
        let label = celements.iter().find(|e| e["id"] == "label").unwrap();
        assert_eq!(label["containerId"], "box");
    }

    #[test]
    fn a_child_id_that_exists_is_numbered_past() {
        let dir = setup();
        let taken = dir.path().join("canvas/game/big.json");
        std::fs::create_dir_all(taken.parent().unwrap()).unwrap();
        std::fs::write(&taken, r#"{"type":"excalidraw","elements":[]}"#).unwrap();
        let out = run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert_eq!(out["split"][0]["child"], "game/big-2");
    }

    #[test]
    fn comments_on_a_split_frame_move_into_the_child() {
        let dir = setup();
        let c = run(
            dir.path(),
            "canvas/create-comment",
            json!({ "id": "game", "actor": "human", "diagram": "big",
                    "elementIds": ["b3"], "text": "too big" }),
        )
        .unwrap();
        run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let cid = c["id"].as_str().unwrap();
        assert!(comments::load_one(dir.path(), "game", cid).is_err());
        let moved = comments::load_one(dir.path(), "game/big", cid).unwrap();
        assert_eq!(moved.canvas, "game/big");
        assert_eq!(moved.frame_id, "big");

        // Still reachable through the parent, as before the split.
        let listed = run(
            dir.path(),
            "canvas/list-comments",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        assert_eq!(listed["comments"][0]["id"], cid);
        let resolved = run(
            dir.path(),
            "canvas/resolve-comment",
            json!({ "id": "game", "actor": "agent", "commentId": cid, "note": "smaller" }),
        )
        .unwrap();
        assert_eq!(resolved["status"], "resolved");

        // Undoing the split, even after more edits, brings the comment home.
        for n in 0..6 {
            run(
                dir.path(),
                "canvas/set-values",
                json!({ "id": "game", "actor": "agent", "values": { "gravity": n } }),
            )
            .unwrap();
        }
        let names = store::checkpoint_names(dir.path(), "game").unwrap();
        let split = names
            .iter()
            .find(|n| n.ends_with(store::SPLIT_CHECKPOINT))
            .expect("the split checkpoint survives later edits")
            .clone();
        let restored = run(
            dir.path(),
            "canvas/restore-checkpoint",
            json!({ "id": "game", "actor": "agent", "checkpoint": split }),
        )
        .unwrap();
        assert_eq!(restored["commentsReturned"], 1);
        assert_eq!(restored["childrenRemoved"], json!(["game/big"]));
        assert!(!dir.path().join("canvas/game/big.json").exists());
        // The removed child can still be recovered from its own ring.
        let kept = store::checkpoint_names(dir.path(), "game/big").unwrap();
        assert!(kept.last().is_some_and(|n| n.ends_with("unsplit")));
        // So the next split takes the same id instead of `big-2`.
        let again = run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent", "dryRun": true }),
        )
        .unwrap();
        assert_eq!(again["split"][0]["child"], "game/big");
        assert_eq!(
            comments::load_one(dir.path(), "game", cid).unwrap().canvas,
            "game"
        );
        assert!(comments::load_one(dir.path(), "game/big", cid).is_err());
    }

    #[test]
    fn undoing_a_split_keeps_the_edits_made_in_the_child() {
        let dir = setup();
        let out = run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let split = out["checkpoint"].as_str().unwrap().to_string();

        // Edit the child: move one member, delete another, add one, widen the frame.
        let (_, mut child, base) = open(dir.path(), &json!({ "id": "game/big" })).unwrap();
        for e in child["elements"].as_array_mut().unwrap() {
            match e["id"].as_str() {
                Some("b3") => e["x"] = json!(77),
                Some("b4") => e["isDeleted"] = json!(true),
                Some("fb") => e["width"] = json!(900),
                _ => {}
            }
        }
        let list = child["elements"].as_array_mut().unwrap();
        list.insert(0, rect("new", "fb"));
        save_scene(dir.path(), "game/big", child, base, "human").unwrap();

        let restored = run(
            dir.path(),
            "canvas/restore-checkpoint",
            json!({ "id": "game", "actor": "agent", "checkpoint": split }),
        )
        .unwrap();
        assert_eq!(restored["childrenMerged"], json!(["game/big"]));
        assert!(!dir.path().join("canvas/game/big.json").exists());

        let parent = read(dir.path(), "game");
        let elements = diagrams::elements_of(&parent);
        let ids: Vec<&str> = elements.iter().filter_map(|e| str_of(e, "id")).collect();
        let unique: HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "no element twice: {ids:?}");
        let by = |id: &str| elements.iter().find(|e| e["id"] == id);
        assert_eq!(by("b3").unwrap()["x"], 77);
        assert!(by("b4").is_none());
        assert!(by("new").is_some());
        assert_eq!(by("fb").unwrap()["width"], 900);
        assert!(child_of_frame(by("fb").unwrap()).is_none());
        // 51 members, less one deleted, plus one added; the frame after them.
        let at = |id: &str| ids.iter().position(|x| *x == id).unwrap();
        assert_eq!(diagrams::members_of(elements, "fb").len(), 51);
        assert!(at("new") < at("fb") && at("label") < at("fb"));
        assert!(by("s1").is_some() && by("arrow").is_some());
    }

    #[test]
    fn agent_reads_follow_a_split_frame_into_its_child() {
        let dir = setup();
        run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let d = run(
            dir.path(),
            "canvas/describe-diagram",
            json!({ "id": "game", "actor": "agent", "diagram": "big" }),
        )
        .unwrap();
        assert_eq!(d["canvas"], "game/big");
        assert_eq!(d["counts"]["shapes"], 50);

        let listed = run(
            dir.path(),
            "canvas/list-diagrams",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let big = listed["diagrams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == "big")
            .unwrap();
        assert_eq!(big["childCanvas"], "game/big");
        assert_eq!(big["elements"], 51);

        // The frame methods count the members where they now live.
        let frames = run(
            dir.path(),
            "canvas/frames",
            json!({ "canvas": "game", "actor": "agent" }),
        )
        .unwrap();
        let fb = frames["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == "fb")
            .unwrap();
        assert_eq!(fb["elements"], 51);

        let c = run(
            dir.path(),
            "canvas/create-comment",
            json!({ "id": "game", "actor": "agent", "diagram": "big",
                    "elementIds": ["b7"], "text": "here" }),
        )
        .unwrap();
        assert_eq!(c["canvas"], "game/big");
    }

    #[test]
    fn set_values_reaches_the_children() {
        let dir = setup();
        run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let set = run(
            dir.path(),
            "canvas/set-values",
            json!({ "id": "game", "actor": "agent", "values": { "gravity": 12 } }),
        )
        .unwrap();
        let child = read(dir.path(), "game/big");
        assert_eq!(child["kaava"]["values"]["gravity"]["value"], 12);
        // Its report lists the uses inside the child, as canvas/values does.
        assert!(set["uses"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["canvas"] == "game/big"));
    }

    #[test]
    fn renaming_a_split_frame_retitles_its_child() {
        let dir = setup();
        run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        run(
            dir.path(),
            "canvas/set-frame",
            json!({ "canvas": "game", "actor": "agent", "frame": "fb", "name": "Renamed" }),
        )
        .unwrap();
        let child = read(dir.path(), "game/big");
        assert_eq!(child["kaava"]["title"], "Renamed");
    }

    #[test]
    fn the_parent_frame_follows_the_childs_size_and_title() {
        let dir = setup();
        run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let path = dir.path().join("canvas/game/big.json");
        let mut child: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let frame = child["elements"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|e| e["id"] == "fb")
            .unwrap();
        frame["width"] = json!(900);
        frame["name"] = json!("Bigger");
        std::fs::write(&path, child.to_string()).unwrap();
        sync_parent(dir.path(), "game", "game/big", "agent").unwrap();
        let parent = read(dir.path(), "game");
        let fb = &diagrams::elements_of(&parent)[0];
        assert_eq!(fb["width"], 900);
        assert_eq!(fb["name"], "Bigger");
        assert_eq!(child_of_frame(fb), Some("game/big"));
    }

    #[test]
    fn snapshots_are_fresh_only_for_the_mtime_they_were_drawn_from() {
        let dir = setup();
        run(
            dir.path(),
            "canvas/split-frames",
            json!({ "id": "game", "actor": "agent" }),
        )
        .unwrap();
        let listed = run(dir.path(), "canvas/snapshots", json!({ "id": "game" })).unwrap();
        let row = &listed["frames"][0];
        assert_eq!(row["child"], "game/big");
        assert!(row.get("png").is_none());
        let mtime = row["mtime"].as_u64().unwrap();
        const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        run(
            dir.path(),
            "canvas/put-snapshot",
            json!({ "child": "game/big", "mtime": mtime, "png": PNG_1X1, "width": 1, "height": 1 }),
        )
        .unwrap();
        let listed = run(dir.path(), "canvas/snapshots", json!({ "id": "game" })).unwrap();
        assert_eq!(listed["frames"][0]["png"], PNG_1X1);
        assert_eq!(listed["frames"][0]["childFrame"]["width"], 400);
        let polled = run(
            dir.path(),
            "canvas/snapshots",
            json!({ "id": "game", "known": { "game/big": mtime } }),
        )
        .unwrap();
        assert_eq!(polled["frames"][0]["unchanged"], true);
        assert!(polled["frames"][0].get("png").is_none());
        run(
            dir.path(),
            "canvas/put-snapshot",
            json!({ "child": "game/big", "mtime": mtime + 1, "png": PNG_1X1 }),
        )
        .unwrap();
        let listed = run(dir.path(), "canvas/snapshots", json!({ "id": "game" })).unwrap();
        assert!(listed["frames"][0].get("png").is_none());
    }
}
