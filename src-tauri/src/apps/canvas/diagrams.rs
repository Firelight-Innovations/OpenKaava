//! Named diagrams: what an agent reads a canvas *as*, rather than as 100 loose
//! shapes.
//!
//! A diagram is an Excalidraw frame whose `customData.kaava.diagram` names it:
//! a stable `id`, a `title`, a one-line `summary`, an optional `parent` diagram
//! and a `level` (`index`, `overview`, `subsystem` or `detail`). The frame's own
//! `name` is what Excalidraw draws above it and is kept equal to the title by
//! the frontend; this side reads the metadata first and falls back to `name`.
//!
//! Everything here is a pure function of the scene JSON, so listing, describing
//! and the coverage report run without a webview. Rendering is the one thing
//! that cannot, and lives in [`super::webview`].

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The levels a diagram may declare, top to bottom.
pub const LEVELS: &[&str] = &["index", "overview", "subsystem", "detail"];

/// The concerns a game design is expected to cover when a canvas names no
/// checklist of its own. The brief's list, in its order.
pub const GAME_CHECKLIST: &[&str] = &[
    "input", "physics", "spawning", "scoring", "states", "ui", "audio", "tuning",
];

/// One frame, as `canvas/list-diagrams` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Diagram {
    /// The metadata id, or `None` for a frame nobody has named yet.
    pub id: Option<String>,
    pub element_id: String,
    pub title: String,
    pub summary: String,
    pub parent: Option<String>,
    pub level: Option<String>,
    pub covers: Vec<String>,
    pub bounds: Bounds,
    /// Live elements drawn inside the frame, bound labels included.
    pub members: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    pub fn to_json(self) -> Value {
        json!({
            "x": round(self.x),
            "y": round(self.y),
            "width": round(self.width),
            "height": round(self.height),
        })
    }

    /// The smallest box holding both.
    pub fn union(self, other: Bounds) -> Bounds {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = (self.x + self.width).max(other.x + other.width);
        let bottom = (self.y + self.height).max(other.y + other.height);
        Bounds {
            x,
            y,
            width: right - x,
            height: bottom - y,
        }
    }
}

/// Two decimals is plenty for a coordinate an agent reads, and keeps a
/// description from carrying `12.000000000001`.
fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn num_of(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn live(elements: &[Value]) -> impl Iterator<Item = &Value> {
    elements
        .iter()
        .filter(|e| e.get("isDeleted").and_then(Value::as_bool) != Some(true))
}

/// The scene's elements, or none for a scene without the array.
pub fn elements_of(scene: &Value) -> &[Value] {
    scene
        .get("elements")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// An element's `customData.kaava.<key>`.
pub fn kaava_of<'a>(el: &'a Value, key: &str) -> Option<&'a Value> {
    el.get("customData")?.get("kaava")?.get(key)
}

/// The box an element occupies. Lines and arrows are measured by their points,
/// since their `width`/`height` is the points' extent but `x`/`y` is the first
/// point, which need not be the top-left one.
pub fn bounds_of(el: &Value) -> Bounds {
    let x = num_of(el, "x");
    let y = num_of(el, "y");
    if let Some(points) = el.get("points").and_then(Value::as_array) {
        let coords: Vec<(f64, f64)> = points
            .iter()
            .filter_map(|p| {
                let pair = p.as_array()?;
                Some((pair.first()?.as_f64()?, pair.get(1)?.as_f64()?))
            })
            .collect();
        if !coords.is_empty() {
            let min_x = coords.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
            let min_y = coords.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
            let max_x = coords.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
            let max_y = coords.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
            return Bounds {
                x: x + min_x,
                y: y + min_y,
                width: max_x - min_x,
                height: max_y - min_y,
            };
        }
    }
    Bounds {
        x,
        y,
        width: num_of(el, "width"),
        height: num_of(el, "height"),
    }
}

fn is_frame(el: &Value) -> bool {
    matches!(str_of(el, "type"), Some("frame" | "magicframe"))
}

/// The ids of the live elements that belong to `frame_id`: those whose
/// `frameId` names it, and the labels bound inside any of them.
pub fn members_of(elements: &[Value], frame_id: &str) -> Vec<String> {
    let direct: HashSet<&str> = live(elements)
        .filter(|e| str_of(e, "frameId") == Some(frame_id))
        .filter_map(|e| str_of(e, "id"))
        .collect();
    live(elements)
        .filter(|e| {
            str_of(e, "id").is_some_and(|id| direct.contains(id))
                || str_of(e, "containerId").is_some_and(|c| direct.contains(c))
        })
        .filter_map(|e| str_of(e, "id").map(str::to_owned))
        .collect()
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Every frame in the scene, in drawing order.
pub fn list(scene: &Value) -> Vec<Diagram> {
    let elements = elements_of(scene);
    live(elements)
        .filter(|e| is_frame(e))
        .map(|frame| {
            let meta = kaava_of(frame, "diagram");
            let element_id = str_of(frame, "id").unwrap_or("").to_string();
            let name = str_of(frame, "name").unwrap_or("").to_string();
            let get = |key: &str| {
                meta.and_then(|m| str_of(m, key))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            };
            Diagram {
                id: get("id"),
                title: get("title").unwrap_or(name),
                summary: get("summary").unwrap_or_default(),
                parent: get("parent"),
                level: get("level"),
                covers: string_list(meta.and_then(|m| m.get("covers"))),
                bounds: bounds_of(frame),
                members: members_of(elements, &element_id).len(),
                element_id,
            }
        })
        .collect()
}

/// The frame `wanted` names: a diagram id, else a frame element id, else an
/// exact title. In that order so a title that happens to equal another
/// diagram's id cannot shadow it.
pub fn find<'a>(diagrams: &'a [Diagram], wanted: &str) -> Option<&'a Diagram> {
    diagrams
        .iter()
        .find(|d| d.id.as_deref() == Some(wanted))
        .or_else(|| diagrams.iter().find(|d| d.element_id == wanted))
        .or_else(|| diagrams.iter().find(|d| d.title == wanted))
}

/// The `/`-joined chain of ids from the top diagram down to this one, e.g.
/// `overview/physics/flap-timing`. A parent that does not exist, or a loop,
/// ends the chain where it breaks rather than failing the whole listing.
pub fn path_of(diagrams: &[Diagram], d: &Diagram) -> Option<String> {
    let mut chain = vec![d.id.clone()?];
    let mut seen: HashSet<String> = chain.iter().cloned().collect();
    let mut next = d.parent.clone();
    while let Some(parent) = next {
        if !seen.insert(parent.clone()) {
            break;
        }
        chain.push(parent.clone());
        next = diagrams
            .iter()
            .find(|x| x.id.as_deref() == Some(parent.as_str()))
            .and_then(|x| x.parent.clone());
    }
    chain.reverse();
    Some(chain.join("/"))
}

/// Problems worth telling an agent about before it relies on the structure.
pub fn problems(diagrams: &[Diagram], scene: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for d in diagrams {
        match d.id.as_deref() {
            None => out.push(format!(
                "frame `{}` (\"{}\") has no diagram id; give it one with canvas/add-shapes or the \
                 Diagrams panel",
                d.element_id, d.title
            )),
            Some(id) => *seen.entry(id).or_default() += 1,
        }
        if let Some(parent) = &d.parent {
            if !diagrams.iter().any(|x| x.id.as_deref() == Some(parent)) {
                out.push(format!(
                    "diagram `{}` names parent `{parent}`, which is not a diagram here",
                    d.id.as_deref().unwrap_or(&d.element_id)
                ));
            }
        }
        if let Some(level) = &d.level {
            if !LEVELS.contains(&level.as_str()) {
                out.push(format!(
                    "diagram `{}` has level `{level}`; use one of {}",
                    d.id.as_deref().unwrap_or(&d.element_id),
                    LEVELS.join(", ")
                ));
            }
        }
    }
    for (id, n) in seen {
        if n > 1 {
            out.push(format!("diagram id `{id}` is used by {n} frames"));
        }
    }
    let loose = live(elements_of(scene))
        .filter(|e| !is_frame(e))
        .filter(|e| e.get("frameId").is_none_or(Value::is_null))
        .filter(|e| e.get("containerId").is_none_or(Value::is_null))
        .count();
    if loose > 0 {
        out.push(format!(
            "{loose} element(s) are outside every frame, so no diagram shows them"
        ));
    }
    if !diagrams.is_empty() && !diagrams.iter().any(|d| d.level.as_deref() == Some("index")) {
        out.push(
            "there is no index diagram (level `index`); canvas/add-shapes with \
             {\"index\": true} builds one"
                .to_string(),
        );
    }
    out.sort();
    out
}

/// `canvas/list-diagrams`, as JSON.
pub fn list_json(scene: &Value) -> Value {
    let diagrams = list(scene);
    let rows: Vec<Value> = diagrams
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "title": d.title,
                "summary": d.summary,
                "parent": d.parent,
                "path": path_of(&diagrams, d),
                "level": d.level,
                "covers": d.covers,
                "frameElementId": d.element_id,
                "bounds": d.bounds.to_json(),
                "elements": d.members,
            })
        })
        .collect();
    let index = diagrams
        .iter()
        .find(|d| d.level.as_deref() == Some("index"))
        .and_then(|d| d.id.clone());
    json!({
        "diagrams": rows,
        "index": index,
        "problems": problems(&diagrams, scene),
    })
}

/// The text a shape shows: its bound label's, if it has one.
fn label_of(elements: &[Value], el: &Value) -> Option<String> {
    let id = str_of(el, "id")?;
    live(elements)
        .find(|t| str_of(t, "containerId") == Some(id))
        .and_then(|t| str_of(t, "text").or_else(|| str_of(t, "originalText")))
        .map(str::to_owned)
}

fn relative(b: Bounds, origin: Bounds) -> Value {
    Bounds {
        x: b.x - origin.x,
        y: b.y - origin.y,
        ..b
    }
    .to_json()
}

/// What an arrow end is bound to, named the way an agent would refer to it.
fn end_of(elements: &[Value], binding: Option<&Value>) -> Value {
    let Some(target) = binding.and_then(|b| str_of(b, "elementId")) else {
        return Value::Null;
    };
    let el = live(elements).find(|e| str_of(e, "id") == Some(target));
    json!({
        "id": target,
        "node": el.and_then(|e| kaava_of(e, "node")).cloned(),
        "label": el.and_then(|e| label_of(elements, e)),
    })
}

/// `canvas/describe-diagram`: the frame's contents as structure, coordinates
/// relative to the frame's top-left corner.
pub fn describe(scene: &Value, d: &Diagram) -> Value {
    let elements = elements_of(scene);
    let members: HashSet<String> = members_of(elements, &d.element_id).into_iter().collect();
    let mut shapes = Vec::new();
    let mut texts = Vec::new();
    let mut arrows = Vec::new();
    let mut images = Vec::new();
    for el in live(elements).filter(|e| str_of(e, "id").is_some_and(|id| members.contains(id))) {
        let id = str_of(el, "id").unwrap_or("");
        let kind = str_of(el, "type").unwrap_or("");
        let at = relative(bounds_of(el), d.bounds);
        let node = kaava_of(el, "node").cloned();
        match kind {
            "text" => {
                // A bound label is reported on its shape, not twice.
                if el.get("containerId").is_some_and(|c| !c.is_null()) {
                    continue;
                }
                texts.push(json!({
                    "id": id,
                    "node": node,
                    "text": str_of(el, "text").unwrap_or(""),
                    "fontSize": el.get("fontSize"),
                    "bounds": at,
                    "linkedTo": kaava_of(el, "linksTo"),
                    "template": kaava_of(el, "template"),
                }));
            }
            "arrow" | "line" => arrows.push(json!({
                "id": id,
                "node": node,
                "type": kind,
                "from": end_of(elements, el.get("startBinding")),
                "to": end_of(elements, el.get("endBinding")),
                "label": label_of(elements, el),
                "dashed": str_of(el, "strokeStyle").is_some_and(|s| s != "solid"),
                "color": el.get("strokeColor"),
                "bounds": at,
            })),
            "image" => images.push(json!({
                "id": id,
                "node": node,
                "fileId": el.get("fileId"),
                "bounds": at,
            })),
            _ => shapes.push(json!({
                "id": id,
                "node": node,
                "type": kind,
                "label": label_of(elements, el),
                "stroke": el.get("strokeColor"),
                "fill": el.get("backgroundColor"),
                "bounds": at,
            })),
        }
    }
    json!({
        "diagram": {
            "id": d.id,
            "title": d.title,
            "summary": d.summary,
            "parent": d.parent,
            "level": d.level,
            "frameElementId": d.element_id,
            "bounds": d.bounds.to_json(),
        },
        "shapes": shapes,
        "arrows": arrows,
        "texts": texts,
        "images": images,
        "counts": {
            "shapes": shapes.len(),
            "arrows": arrows.len(),
            "texts": texts.len(),
            "images": images.len(),
        },
    })
}

/// The canvas's own checklist (`kaava.checklist.concerns`), else the game one.
pub fn checklist_of(scene: &Value, given: Option<&Value>) -> Vec<String> {
    let from = |v: Option<&Value>| {
        let list = string_list(v);
        (!list.is_empty()).then_some(list)
    };
    from(given)
        .or_else(|| {
            from(
                scene
                    .get("kaava")
                    .and_then(|k| k.get("checklist"))
                    .and_then(|c| c.get("concerns")),
            )
        })
        .unwrap_or_else(|| GAME_CHECKLIST.iter().map(|s| (*s).to_string()).collect())
}

/// `canvas/coverage`: which diagrams cover each concern, which concerns no
/// diagram covers, and which diagrams declare nothing.
pub fn coverage(scene: &Value, checklist: &[String]) -> Value {
    let diagrams = list(scene);
    let mut by: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for concern in checklist {
        by.insert(concern.as_str(), Vec::new());
    }
    let mut unknown: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for d in &diagrams {
        let name = d.id.clone().unwrap_or_else(|| d.element_id.clone());
        for c in &d.covers {
            match by.get_mut(c.as_str()) {
                Some(list) => list.push(name.clone()),
                None => unknown.entry(c.clone()).or_default().push(name.clone()),
            }
        }
    }
    let rows: Vec<Value> = checklist
        .iter()
        .map(|c| {
            let frames = by.get(c.as_str()).cloned().unwrap_or_default();
            json!({ "concern": c, "covered": !frames.is_empty(), "diagrams": frames })
        })
        .collect();
    let missing: Vec<&String> = checklist
        .iter()
        .filter(|c| by.get(c.as_str()).is_none_or(Vec::is_empty))
        .collect();
    let silent: Vec<String> = diagrams
        .iter()
        .filter(|d| d.covers.is_empty() && d.level.as_deref() != Some("index"))
        .map(|d| d.id.clone().unwrap_or_else(|| d.element_id.clone()))
        .collect();
    json!({
        "checklist": checklist,
        "concerns": rows,
        "missing": missing,
        "outsideChecklist": unknown,
        "diagramsCoveringNothing": silent,
        "complete": missing.is_empty(),
    })
}

// --- linked values ----------------------------------------------------------

/// The canvas's value table, `kaava.values`: name to `{ value, unit?, spec? }`.
pub fn values_of(scene: &Value) -> Map<String, Value> {
    scene
        .get("kaava")
        .and_then(|k| k.get("values"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// A value as it is written into text: a whole number without `.0`.
pub fn value_text(entry: &Value) -> String {
    let v = entry.get("value").unwrap_or(entry);
    match v {
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", f as i64)
            } else {
                format!("{f}")
            }
        }
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Fill `{{name}}` placeholders from `values`. Unknown names are left in place
/// and returned, so a typo shows on the drawing and in the report.
pub fn render_template(template: &str, values: &Map<String, Value>) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut unknown = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let name = after[..end].trim();
        match values.get(name) {
            Some(entry) => out.push_str(&value_text(entry)),
            None => {
                unknown.push(name.to_string());
                out.push_str(&rest[start..start + 2 + end + 2]);
            }
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    (out, unknown)
}

/// `canvas/values`: every templated text and linked spec field, and every
/// place the drawing disagrees with the table.
pub fn values_report(scene: &Value) -> Value {
    let values = values_of(scene);
    let elements = elements_of(scene);
    let mut uses = Vec::new();
    let mut mismatches = Vec::new();
    for el in live(elements) {
        let Some(template) = kaava_of(el, "template").and_then(Value::as_str) else {
            continue;
        };
        let (expected, unknown) = render_template(template, &values);
        let actual = str_of(el, "text").unwrap_or("");
        let ok = unknown.is_empty() && actual == expected;
        let row = json!({
            "elementId": str_of(el, "id"),
            "template": template,
            "text": actual,
            "expected": expected,
            "unknown": unknown,
            "ok": ok,
        });
        if !ok {
            mismatches.push(row.clone());
        }
        uses.push(row);
    }
    for (name, entry) in &values {
        let Some(link) = entry.get("spec") else {
            continue;
        };
        let element = link.get("element").and_then(Value::as_str).unwrap_or("");
        let field = link.get("field").and_then(Value::as_str).unwrap_or("");
        let card = live(elements)
            .find(|e| str_of(e, "id") == Some(element))
            .and_then(|e| kaava_of(e, "spec"));
        let actual = card.and_then(|c| c.get(field));
        let ok = actual.is_some_and(|a| value_text(a) == value_text(entry));
        let row = json!({
            "value": name,
            "spec": { "element": element, "field": field },
            "specHas": actual,
            "expected": entry.get("value"),
            "ok": ok,
        });
        if !ok {
            mismatches.push(row.clone());
        }
        uses.push(row);
    }
    json!({
        "values": values,
        "uses": uses,
        "mismatches": mismatches,
        "consistent": mismatches.is_empty(),
    })
}

/// Re-render every templated text from `values`, and write linked spec
/// fields. Returns how many elements changed.
///
/// Width is scaled by the change in character count rather than measured:
/// measuring needs the font, which only the webview has, and the editor
/// re-measures every text once its fonts load (Excalidraw's `onLoaded`), so a
/// rough width here is corrected the first time a person opens the canvas.
pub fn apply_values(scene: &mut Value) -> usize {
    let values = values_of(scene);
    let Some(elements) = scene.get_mut("elements").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut changed = 0;
    let spec_links: Vec<(String, String, Value)> = values
        .values()
        .filter_map(|entry| {
            let link = entry.get("spec")?;
            Some((
                link.get("element")?.as_str()?.to_string(),
                link.get("field")?.as_str()?.to_string(),
                entry.get("value")?.clone(),
            ))
        })
        .collect();
    for el in elements.iter_mut() {
        let id = str_of(el, "id").unwrap_or("").to_string();
        if let Some(template) = kaava_of(el, "template").and_then(Value::as_str) {
            let (text, _) = render_template(template, &values);
            let old = str_of(el, "text").unwrap_or("").to_string();
            if text != old {
                let old_len = old.lines().map(str::len).max().unwrap_or(0).max(1) as f64;
                let new_len = text.lines().map(str::len).max().unwrap_or(0).max(1) as f64;
                let width = num_of(el, "width") * new_len / old_len;
                el["text"] = json!(text);
                el["originalText"] = json!(text);
                el["width"] = json!(round(width));
                bump(el);
                changed += 1;
            }
        }
        for (element, field, value) in &spec_links {
            if *element != id {
                continue;
            }
            let Some(spec) = el
                .get_mut("customData")
                .and_then(|c| c.get_mut("kaava"))
                .and_then(|k| k.get_mut("spec"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            if spec.get(field) != Some(value) {
                spec.insert(field.clone(), value.clone());
                bump(el);
                changed += 1;
            }
        }
    }
    changed
}

/// Raise an element's version so the editor treats the change as an edit.
pub fn bump(el: &mut Value) {
    let version = el.get("version").and_then(Value::as_u64).unwrap_or(0);
    el["version"] = json!(version + 1);
    el["versionNonce"] = json!(nonce(version));
}

/// A new nonce without a random source: good enough to differ from the last,
/// which is all Excalidraw asks of it.
fn nonce(seed: u64) -> u64 {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (t ^ seed.wrapping_mul(0x9E37_79B9_7F4A_7C15)) % (1u64 << 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: &str, meta: Value) -> Value {
        json!({
            "id": id, "type": "frame", "name": "Frame name",
            "x": 100, "y": 50, "width": 400, "height": 300,
            "customData": { "kaava": { "diagram": meta } },
        })
    }

    fn scene(elements: Vec<Value>) -> Value {
        json!({ "type": "excalidraw", "elements": elements })
    }

    fn sample() -> Value {
        scene(vec![
            frame(
                "f1",
                json!({ "id": "playfield", "title": "Playfield", "summary": "to scale",
                        "level": "subsystem", "parent": "index", "covers": ["physics", "spawning"] }),
            ),
            frame(
                "f0",
                json!({ "id": "index", "title": "Index", "level": "index" }),
            ),
            json!({ "id": "ball", "type": "ellipse", "frameId": "f1", "x": 130, "y": 90,
                    "width": 20, "height": 20, "customData": { "kaava": { "node": "ball" } } }),
            json!({ "id": "ball-label", "type": "text", "containerId": "ball", "text": "ball",
                    "x": 131, "y": 91, "width": 18, "height": 18 }),
            json!({ "id": "pillar", "type": "rectangle", "frameId": "f1", "x": 300, "y": 50,
                    "width": 40, "height": 120 }),
            json!({ "id": "a1", "type": "arrow", "frameId": "f1", "x": 150, "y": 100,
                    "points": [[0, 0], [150, -20]],
                    "startBinding": { "elementId": "ball" }, "endBinding": { "elementId": "pillar" } }),
            json!({ "id": "note", "type": "text", "frameId": "f1", "text": "gravity 30",
                    "x": 110, "y": 300, "width": 80, "height": 20,
                    "customData": { "kaava": { "template": "gravity {{gravity}}" } } }),
            json!({ "id": "gone", "type": "rectangle", "frameId": "f1", "isDeleted": true }),
        ])
    }

    #[test]
    fn frames_are_listed_with_their_metadata_and_path() {
        let out = list_json(&sample());
        let rows = out["diagrams"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "playfield");
        assert_eq!(rows[0]["title"], "Playfield");
        assert_eq!(rows[0]["path"], "index/playfield");
        assert_eq!(rows[0]["elements"], 5, "ball, its label, pillar, arrow, note");
        assert_eq!(rows[0]["bounds"]["width"], 400.0);
        assert_eq!(out["index"], "index");
    }

    #[test]
    fn an_unnamed_frame_is_listed_and_reported() {
        let s = scene(vec![json!({ "id": "f", "type": "frame", "name": "Sketch",
                                    "x": 0, "y": 0, "width": 10, "height": 10 })]);
        let out = list_json(&s);
        assert_eq!(out["diagrams"][0]["id"], Value::Null);
        assert_eq!(out["diagrams"][0]["title"], "Sketch");
        let problems = out["problems"].as_array().unwrap();
        assert!(problems
            .iter()
            .any(|p| p.as_str().unwrap().contains("no diagram id")));
        assert!(problems
            .iter()
            .any(|p| p.as_str().unwrap().contains("no index")));
    }

    #[test]
    fn loose_elements_and_bad_parents_are_problems() {
        let s = scene(vec![
            frame("f", json!({ "id": "a", "parent": "ghost", "level": "index" })),
            json!({ "id": "stray", "type": "rectangle", "x": 0, "y": 0 }),
        ]);
        let problems = list_json(&s)["problems"].clone();
        let text = problems.to_string();
        assert!(text.contains("ghost"), "{text}");
        assert!(text.contains("outside every frame"), "{text}");
    }

    #[test]
    fn find_prefers_id_then_element_then_title() {
        let diagrams = list(&sample());
        assert_eq!(find(&diagrams, "playfield").unwrap().element_id, "f1");
        assert_eq!(find(&diagrams, "f0").unwrap().id.as_deref(), Some("index"));
        assert_eq!(find(&diagrams, "Index").unwrap().element_id, "f0");
        assert!(find(&diagrams, "nope").is_none());
    }

    #[test]
    fn describe_reports_shapes_labels_arrows_and_text_relative_to_the_frame() {
        let s = sample();
        let diagrams = list(&s);
        let d = find(&diagrams, "playfield").unwrap();
        let out = describe(&s, d);
        assert_eq!(out["counts"]["shapes"], 2);
        assert_eq!(out["counts"]["texts"], 1, "the bound label is not repeated");
        let ball = &out["shapes"][0];
        assert_eq!(ball["label"], "ball");
        assert_eq!(ball["node"], "ball");
        assert_eq!(ball["bounds"]["x"], 30.0);
        assert_eq!(ball["bounds"]["y"], 40.0);
        let arrow = &out["arrows"][0];
        assert_eq!(arrow["from"]["label"], "ball");
        assert_eq!(arrow["to"]["id"], "pillar");
        assert_eq!(arrow["bounds"]["y"], 30.0, "the arrow's box starts at its highest point");
        assert_eq!(out["texts"][0]["template"], "gravity {{gravity}}");
    }

    #[test]
    fn coverage_names_the_frames_per_concern_and_the_gaps() {
        let s = sample();
        let out = coverage(&s, &checklist_of(&s, None));
        assert_eq!(out["concerns"][1]["concern"], "physics");
        assert_eq!(out["concerns"][1]["diagrams"], json!(["playfield"]));
        let missing = out["missing"].as_array().unwrap();
        assert!(missing.contains(&json!("audio")));
        assert!(!missing.contains(&json!("physics")));
        assert_eq!(out["complete"], false);
    }

    #[test]
    fn a_canvas_checklist_replaces_the_default() {
        let mut s = sample();
        s["kaava"] = json!({ "checklist": { "concerns": ["physics", "rendering"] } });
        let list = checklist_of(&s, None);
        assert_eq!(list, vec!["physics", "rendering"]);
        let given = json!(["spawning"]);
        assert_eq!(checklist_of(&s, Some(&given)), vec!["spawning"]);
    }

    #[test]
    fn templates_render_and_report_unknown_names() {
        let mut values = Map::new();
        values.insert("g".into(), json!({ "value": 30 }));
        values.insert("r".into(), json!({ "value": 0.3 }));
        let (text, unknown) = render_template("g={{g}} r={{ r }} x={{x}}", &values);
        assert_eq!(text, "g=30 r=0.3 x={{x}}");
        assert_eq!(unknown, vec!["x"]);
        let (open, _) = render_template("broken {{g", &values);
        assert_eq!(open, "broken {{g");
    }

    #[test]
    fn a_hand_edited_number_is_a_mismatch_and_apply_fixes_it() {
        let mut s = sample();
        s["kaava"] = json!({ "values": { "gravity": { "value": 24 } } });
        let report = values_report(&s);
        assert_eq!(report["consistent"], false);
        assert_eq!(report["mismatches"][0]["expected"], "gravity 24");
        assert_eq!(apply_values(&mut s), 1);
        assert_eq!(values_report(&s)["consistent"], true);
        let note = elements_of(&s).iter().find(|e| e["id"] == "note").unwrap();
        assert_eq!(note["text"], "gravity 24");
        assert!(note["version"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn a_value_linked_to_a_spec_field_flags_and_fixes_drift() {
        let mut s = scene(vec![json!({
            "id": "card", "type": "rectangle",
            "customData": { "kaava": { "spec": { "name": "Ball", "size_m": 0.5 } } },
        })]);
        s["kaava"] = json!({ "values": { "ball-size": {
            "value": 0.6, "spec": { "element": "card", "field": "size_m" } } } });
        assert_eq!(values_report(&s)["consistent"], false);
        assert_eq!(apply_values(&mut s), 1);
        assert_eq!(values_report(&s)["consistent"], true);
        assert_eq!(
            elements_of(&s)[0]["customData"]["kaava"]["spec"]["size_m"],
            0.6
        );
    }

    #[test]
    fn value_text_drops_a_trailing_zero_fraction() {
        assert_eq!(value_text(&json!({ "value": 30.0 })), "30");
        assert_eq!(value_text(&json!({ "value": 1.35 })), "1.35");
        assert_eq!(value_text(&json!({ "value": "5-12" })), "5-12");
    }
}
