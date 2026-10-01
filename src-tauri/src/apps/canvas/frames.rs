//! Frames as labelled objects: what an agent reads a canvas as when it asks
//! "what is on this canvas" rather than "what shapes are there".
//!
//! A frame's metadata is `customData.kaava.object = { type, props }` on the
//! Excalidraw frame element itself. It stays inside the scene, travels with the
//! element when it is copied, and needs no second file to keep in step. The
//! frame's id is the element id, its name is Excalidraw's own `name`, and its
//! child canvas is `customData.kaava.child` (see `apps/canvas/ui/src/nesting.ts`).
//!
//! Older canvases carry the asset spec card (`customData.kaava.spec`). [`migrate`]
//! turns one on a frame into a `model` object, in memory, and reports the cards
//! on plain shapes instead of guessing a frame for them.
//!
//! Everything is a pure function of scene JSON and the type table.

use super::diagrams::{bounds_of, elements_of, kaava_of, members_of, Bounds};
use super::types::{self, TypeDef, REVIEW_STATES};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn is_live(el: &Value) -> bool {
    el.get("isDeleted").and_then(Value::as_bool) != Some(true)
}

fn is_frame(el: &Value) -> bool {
    matches!(str_of(el, "type"), Some("frame" | "magicframe"))
}

/// The name Excalidraw gives a frame nobody has named.
fn is_default_name(name: &str) -> bool {
    let name = name.trim();
    name.is_empty()
        || name == "Frame"
        || name
            .strip_prefix("Frame ")
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// A frame as the methods report it, before it is turned into JSON.
#[derive(Debug, Clone)]
pub struct Frame {
    pub id: String,
    pub name: String,
    pub type_id: Option<String>,
    pub props: Map<String, Value>,
    pub bounds: Bounds,
    pub child: Option<String>,
    pub elements: usize,
}

/// A spec card on a shape that is not a frame, left where it is.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyCard {
    pub element_id: String,
    pub name: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Migration {
    /// Frames whose spec card became a `model` object.
    pub converted: Vec<String>,
    pub legacy: Vec<LegacyCard>,
}

fn spec_to_props(spec: &Map<String, Value>, frame_name: &str) -> Map<String, Value> {
    let mut props = Map::new();
    for key in ["size_m", "triangle_budget"] {
        if let Some(n) = spec.get(key).filter(|v| v.is_number()) {
            props.insert(key.into(), n.clone());
        }
    }
    if let Some(s) = spec.get("style_notes").and_then(Value::as_str) {
        props.insert("style_notes".into(), json!(s));
    }
    if let Some(r) = spec.get("reference_images").and_then(Value::as_array) {
        let paths: Vec<&str> = r.iter().filter_map(Value::as_str).collect();
        props.insert("reference_images".into(), json!(paths));
    }
    let status = spec
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| REVIEW_STATES.contains(s))
        .unwrap_or("draft");
    props.insert("review_state".into(), json!(status));
    if let Some(name) = spec.get("name").and_then(Value::as_str) {
        if !name.trim().is_empty() && name.trim() != frame_name {
            props.insert("asset_name".into(), json!(name.trim()));
        }
    }
    props
}

/// Convert, in place, each frame carrying a spec card and no object into a
/// `model` frame. The card's name becomes the frame's when the frame has none of
/// its own (otherwise it is kept as `asset_name`), so nothing the card said is
/// lost. Cards on non-frames are reported and not touched.
pub fn migrate(scene: &mut Value) -> Migration {
    let mut out = Migration::default();
    let Some(elements) = scene.get_mut("elements").and_then(Value::as_array_mut) else {
        return out;
    };
    for el in elements.iter_mut() {
        if !is_live(el) {
            continue;
        }
        let Some(spec) = kaava_of(el, "spec").and_then(Value::as_object).cloned() else {
            continue;
        };
        let id = str_of(el, "id").unwrap_or("").to_string();
        if !is_frame(el) {
            out.legacy.push(LegacyCard {
                element_id: id,
                name: spec
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
            continue;
        }
        if kaava_of(el, "object").is_some() {
            continue;
        }
        let current = str_of(el, "name").unwrap_or("").to_string();
        let spec_name = spec
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let name = if is_default_name(&current) && !spec_name.is_empty() {
            spec_name.to_string()
        } else {
            current
        };
        let props = spec_to_props(&spec, &name);
        if let Some(kaava) = el
            .get_mut("customData")
            .and_then(|c| c.get_mut("kaava"))
            .and_then(Value::as_object_mut)
        {
            kaava.remove("spec");
            kaava.insert("object".into(), json!({ "type": "model", "props": props }));
        }
        el["name"] = json!(name);
        out.converted.push(id);
    }
    out
}

/// Every live frame in drawing order, with its object read out.
pub fn list(scene: &Value) -> Vec<Frame> {
    let elements = elements_of(scene);
    elements
        .iter()
        .filter(|e| is_live(e) && is_frame(e))
        .map(|frame| {
            let id = str_of(frame, "id").unwrap_or("").to_string();
            let object = kaava_of(frame, "object");
            Frame {
                name: str_of(frame, "name").unwrap_or("").to_string(),
                type_id: object
                    .and_then(|o| str_of(o, "type"))
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned),
                props: object
                    .and_then(|o| o.get("props"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default(),
                bounds: bounds_of(frame),
                child: kaava_of(frame, "child")
                    .and_then(Value::as_str)
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned),
                elements: members_of(elements, &id).len(),
                id,
            }
        })
        .collect()
}

fn type_of<'a>(table: &'a [TypeDef], frame: &Frame) -> Option<&'a TypeDef> {
    let wanted = frame.type_id.as_deref()?;
    table.iter().find(|t| t.id == wanted)
}

/// One frame as JSON: values resolved against its type, with defaults filled in.
pub fn frame_json(canvas: &str, frame: &Frame, table: &[TypeDef]) -> Value {
    let def = type_of(table, frame);
    let (props, extra) = types::resolve(def, &frame.props);
    json!({
        "canvas": canvas,
        "id": frame.id,
        "name": frame.name,
        "type": frame.type_id,
        "typeName": def.map(|t| t.name.clone()),
        "typeKnown": frame.type_id.is_none() || def.is_some(),
        "props": props,
        "extraProps": extra,
        "bbox": frame.bounds.to_json(),
        "childCanvas": frame.child,
        "elements": frame.elements,
    })
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text_of).collect::<Vec<_>>().join(" "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// How well `frame` answers `query`, and where it matched; `None` when some word
/// of the query is nowhere in it. Words are case-insensitive substrings; a
/// match in the name counts most, then the type, then a property.
pub fn score(frame: &Frame, table: &[TypeDef], query: &str) -> Option<(u32, Vec<String>)> {
    let def = type_of(table, frame);
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let name = frame.name.to_lowercase();
    let kind = format!(
        "{} {}",
        frame.type_id.as_deref().unwrap_or(""),
        def.map(|t| t.name.as_str()).unwrap_or("")
    )
    .to_lowercase();
    let (known, extra) = types::resolve(def, &frame.props);
    let mut total = 0;
    let mut where_ = Vec::<String>::new();
    for word in &words {
        let mut best = 0;
        if name.contains(word.as_str()) {
            best = 3;
            where_.push("name".into());
        } else if kind.contains(word.as_str()) {
            best = 2;
            where_.push("type".into());
        } else {
            for (k, v) in known.iter().chain(extra.iter()) {
                if text_of(v).to_lowercase().contains(word.as_str()) {
                    best = 1;
                    where_.push(format!("props.{k}"));
                    break;
                }
            }
        }
        if best == 0 {
            return None;
        }
        total += best;
    }
    where_.sort();
    where_.dedup();
    Some((total, where_))
}

/// A frame by element id, else by exact name ignoring case. `Err` lists the
/// choices, or the clashing ids when a name is shared.
pub fn find<'a>(frames: &'a [Frame], wanted: &str) -> Result<&'a Frame, String> {
    if let Some(f) = frames.iter().find(|f| f.id == wanted) {
        return Ok(f);
    }
    let same: Vec<&Frame> = frames
        .iter()
        .filter(|f| f.name.eq_ignore_ascii_case(wanted))
        .collect();
    match same.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "no frame `{wanted}` on this canvas; there are: {}",
            if frames.is_empty() {
                "none".to_string()
            } else {
                frames
                    .iter()
                    .map(|f| format!("{} ({})", f.name, f.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        )),
        many => Err(format!(
            "{} frames are named `{wanted}`; use one of their ids: {}",
            many.len(),
            many.iter()
                .map(|f| f.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// The elements inside a frame, with the text each one shows: a shape's bound
/// label, or a text element's own text.
pub fn contents(scene: &Value, frame_id: &str) -> Vec<Value> {
    let elements = elements_of(scene);
    let members: HashSet<String> = members_of(elements, frame_id).into_iter().collect();
    elements
        .iter()
        .filter(|e| is_live(e) && str_of(e, "id").is_some_and(|i| members.contains(i)))
        .filter(|e| str_of(e, "containerId").is_none_or(|c| !members.contains(c)))
        .map(|e| {
            let id = str_of(e, "id").unwrap_or("");
            let own = str_of(e, "text");
            let label = own.map(str::to_owned).or_else(|| {
                elements
                    .iter()
                    .filter(|t| is_live(t) && str_of(t, "containerId") == Some(id))
                    .find_map(|t| str_of(t, "text").map(str::to_owned))
            });
            json!({
                "id": id,
                "type": str_of(e, "type"),
                "text": label,
                "bbox": bounds_of(e).to_json(),
            })
        })
        .collect()
}

/// The asset-list card a `model` frame stands for, in the shape the spec card
/// had: `{name, reference_images, size_m, triangle_budget, style_notes, status}`.
/// `None` for any other element.
pub fn model_card(el: &Value) -> Option<Value> {
    if !is_frame(el) {
        return None;
    }
    let object = kaava_of(el, "object")?;
    if str_of(object, "type") != Some("model") {
        return None;
    }
    let empty = Map::new();
    let props = object
        .get("props")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let name = props
        .get("asset_name")
        .and_then(Value::as_str)
        .filter(|n| !n.trim().is_empty())
        .or_else(|| str_of(el, "name"))
        .unwrap_or("");
    let mut card = Map::new();
    card.insert("name".into(), json!(name));
    for key in [
        "reference_images",
        "size_m",
        "triangle_budget",
        "style_notes",
    ] {
        if let Some(v) = props.get(key).filter(|v| !v.is_null()) {
            card.insert(key.into(), v.clone());
        }
    }
    let status = props
        .get("review_state")
        .and_then(Value::as_str)
        .filter(|s| REVIEW_STATES.contains(s))
        .unwrap_or("draft");
    card.insert("status".into(), json!(status));
    Some(Value::Object(card))
}

/// The canvas ids named by frame links in a scene.
pub fn child_links(scene: &Value) -> Vec<String> {
    list(scene).into_iter().filter_map(|f| f.child).collect()
}

/// Whether making `parent` the parent of `id` would loop: `parent` is `id`, or
/// `id` is somewhere up `parent`'s own chain. `parent_of` reads one canvas's
/// parent; a chain that never ends is a loop too.
pub fn would_cycle(id: &str, parent: &str, parent_of: impl Fn(&str) -> Option<String>) -> bool {
    let mut at = Some(parent.to_string());
    let mut steps = 0;
    while let Some(here) = at {
        if here == id || steps > 64 {
            return true;
        }
        steps += 1;
        at = parent_of(&here);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: &str, name: &str, custom: Value) -> Value {
        json!({ "id": id, "type": "frame", "name": name, "x": 0, "y": 0,
                "width": 100, "height": 80, "customData": custom })
    }

    fn shape(id: &str, parent: Option<&str>, custom: Value) -> Value {
        json!({ "id": id, "type": "rectangle", "frameId": parent, "x": 5, "y": 5,
                "width": 10, "height": 10, "customData": custom })
    }

    fn scene(elements: Vec<Value>) -> Value {
        json!({ "type": "excalidraw", "elements": elements })
    }

    #[test]
    fn a_spec_card_on_a_frame_becomes_a_model_frame_and_keeps_every_field() {
        let mut s = scene(vec![frame(
            "f1",
            "Frame",
            json!({ "kaava": { "child": "c/x", "spec": {
                "name": "Playfield", "size_m": 16, "triangle_budget": 5000,
                "style_notes": "chunky", "reference_images": ["a.png"], "status": "review" } } }),
        )]);
        let m = migrate(&mut s);
        assert_eq!(m.converted, ["f1"]);
        let el = &s["elements"][0];
        assert_eq!(el["name"], "Playfield");
        assert!(el["customData"]["kaava"].get("spec").is_none());
        assert_eq!(
            el["customData"]["kaava"]["child"], "c/x",
            "the child link survives"
        );
        assert_eq!(
            el["customData"]["kaava"]["object"],
            json!({ "type": "model", "props": {
                "size_m": 16, "triangle_budget": 5000, "style_notes": "chunky",
                "reference_images": ["a.png"], "review_state": "review" } })
        );
        assert_eq!(
            migrate(&mut s),
            Migration::default(),
            "migrating twice changes nothing"
        );
    }

    #[test]
    fn a_frame_with_its_own_name_keeps_it_and_the_cards_name_is_not_lost() {
        let mut s = scene(vec![frame(
            "f1",
            "Hospital bed",
            json!({ "kaava": { "spec": { "name": "Gurney", "status": "bogus" } } }),
        )]);
        migrate(&mut s);
        assert_eq!(s["elements"][0]["name"], "Hospital bed");
        let props = &s["elements"][0]["customData"]["kaava"]["object"]["props"];
        assert_eq!(props["asset_name"], "Gurney");
        assert_eq!(props["review_state"], "draft");
    }

    #[test]
    fn a_card_on_a_plain_shape_is_reported_and_left_alone() {
        let card = json!({ "kaava": { "spec": { "name": "Chair" } } });
        let mut s = scene(vec![shape("a", None, card.clone())]);
        let m = migrate(&mut s);
        assert!(m.converted.is_empty());
        assert_eq!(
            m.legacy,
            [LegacyCard {
                element_id: "a".into(),
                name: "Chair".into()
            }]
        );
        assert_eq!(s["elements"][0]["customData"], card);
    }

    #[test]
    fn a_frame_that_already_has_an_object_is_not_overwritten() {
        let mut s = scene(vec![frame(
            "f1",
            "Jump",
            json!({ "kaava": { "object": { "type": "feature", "props": {} },
                               "spec": { "name": "Old" } } }),
        )]);
        assert!(migrate(&mut s).converted.is_empty());
        assert_eq!(
            s["elements"][0]["customData"]["kaava"]["object"]["type"],
            "feature"
        );
    }

    fn table() -> Vec<TypeDef> {
        types::builtins()
    }

    fn two_frames() -> Value {
        scene(vec![
            frame(
                "f1",
                "Flap",
                json!({ "kaava": { "object": { "type": "feature",
                    "props": { "summary": "Tap to rise", "priority": "high" } } } }),
            ),
            shape("s1", Some("f1"), json!(null)),
            json!({ "id": "t1", "type": "text", "frameId": "f1", "text": "tap", "x": 1, "y": 1,
                    "width": 5, "height": 5 }),
            frame(
                "f2",
                "Pillar",
                json!({ "kaava": { "child": "world/pillar",
                "object": { "type": "model", "props": { "style_notes": "green and chunky" } } } }),
            ),
            frame("f3", "Loose", json!(null)),
        ])
    }

    #[test]
    fn listing_reads_type_values_bbox_child_and_element_count() {
        let s = two_frames();
        let frames = list(&s);
        assert_eq!(frames.len(), 3);
        let row = frame_json("balls", &frames[0], &table());
        assert_eq!(row["type"], "feature");
        assert_eq!(row["typeName"], "Feature");
        assert_eq!(row["props"]["priority"], "high");
        assert_eq!(row["props"]["status"], "idea", "defaults are filled in");
        assert_eq!(row["elements"], 2);
        assert_eq!(row["bbox"]["width"], 100.0);
        let pillar = frame_json("balls", &frames[1], &table());
        assert_eq!(pillar["childCanvas"], "world/pillar");
        let loose = frame_json("balls", &frames[2], &table());
        assert!(loose["type"].is_null() && loose["typeKnown"] == true);
    }

    #[test]
    fn a_deleted_type_is_flagged_not_dropped() {
        let s = scene(vec![frame(
            "f1",
            "X",
            json!({ "kaava": { "object": { "type": "gone", "props": { "a": 1 } } } }),
        )]);
        let row = frame_json("c", &list(&s)[0], &table());
        assert_eq!(row["typeKnown"], false);
        assert_eq!(row["extraProps"]["a"], 1);
    }

    #[test]
    fn search_ranks_name_over_type_over_property_and_needs_every_word() {
        let s = two_frames();
        let frames = list(&s);
        let t = table();
        let by = |q: &str| {
            let mut hits: Vec<(u32, &str)> = frames
                .iter()
                .filter_map(|f| score(f, &t, q).map(|(n, _)| (n, f.id.as_str())))
                .collect();
            hits.sort_by_key(|b| std::cmp::Reverse(b.0));
            hits.into_iter().map(|h| h.1).collect::<Vec<_>>()
        };
        assert_eq!(by("flap"), ["f1"]);
        assert_eq!(by("chunky"), ["f2"]);
        assert_eq!(by("model"), ["f2"]);
        assert_eq!(by("tap rise"), ["f1"]);
        assert!(by("tap pillar").is_empty(), "every word must match");
        let (_, where_) = score(&frames[1], &t, "chunky").unwrap();
        assert_eq!(where_, ["props.style_notes"]);
    }

    #[test]
    fn find_takes_an_id_or_a_unique_name_and_explains_a_miss() {
        let s = two_frames();
        let frames = list(&s);
        assert_eq!(find(&frames, "f2").unwrap().name, "Pillar");
        assert_eq!(find(&frames, "pillar").unwrap().id, "f2");
        assert!(find(&frames, "nope").unwrap_err().contains("Flap (f1)"));
        let dup = scene(vec![
            frame("a", "Same", json!(null)),
            frame("b", "Same", json!(null)),
        ]);
        assert!(find(&list(&dup), "same").unwrap_err().contains("a, b"));
    }

    #[test]
    fn contents_lists_members_with_their_text_and_folds_labels_into_shapes() {
        let mut s = two_frames();
        s["elements"].as_array_mut().unwrap().push(json!({
            "id": "lbl", "type": "text", "containerId": "s1", "frameId": "f1",
            "text": "Ball", "x": 6, "y": 6, "width": 4, "height": 4 }));
        let got = contents(&s, "f1");
        let ids: Vec<&str> = got.iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["s1", "t1"]);
        assert_eq!(got[0]["text"], "Ball");
        assert_eq!(got[1]["text"], "tap");
    }

    #[test]
    fn a_model_frame_is_an_asset_card_in_the_old_shape() {
        let mut s = scene(vec![frame(
            "f1",
            "Frame",
            json!({ "kaava": { "spec": { "name": "Gurney", "size_m": 2, "triangle_budget": 8000,
                                          "status": "review" } } }),
        )]);
        migrate(&mut s);
        let card = model_card(&s["elements"][0]).unwrap();
        assert_eq!(
            card,
            json!({ "name": "Gurney", "size_m": 2, "triangle_budget": 8000, "status": "review" })
        );
        assert!(model_card(&frame(
            "g",
            "Jump",
            json!({ "kaava": { "object": { "type": "feature" } } })
        ))
        .is_none());
    }

    #[test]
    fn nesting_a_canvas_under_itself_or_its_own_descendant_is_a_cycle() {
        let parents = |id: &str| match id {
            "b" => Some("a".to_string()),
            "c" => Some("b".to_string()),
            _ => None,
        };
        assert!(would_cycle("a", "a", parents));
        assert!(would_cycle("a", "c", parents), "a is c's grandparent");
        assert!(would_cycle("b", "c", parents));
        assert!(!would_cycle("c", "a", parents));
        assert!(!would_cycle("x", "a", parents));
        let looped = |id: &str| Some(if id == "p" { "q" } else { "p" }.to_string());
        assert!(
            would_cycle("z", "p", looped),
            "a chain that never ends is a loop"
        );
    }
}
