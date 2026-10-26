//! Whether a canvas is agent-ready: every element in a named frame, and every
//! multi-part object a group or a bound container, so one click or one
//! selection hands an agent the whole object.
//!
//! A port of the `agent-ready-canvas` skill's `canvas_lint.py`, check for check,
//! so a canvas passes here exactly when it passes there, with no Python needed.
//! `canvas/lint` answers with every rule and whether it held, for the agent tab's
//! validation card and badge.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// How many examples each failed rule lists; the count says how many there were.
const MAX_EXAMPLES: usize = 15;

/// Every rule, in the order the card lists them: id, what it asks for, and
/// whether breaking it fails the canvas (the rest are warnings).
const RULES: &[(&str, &str, bool)] = &[
    ("no_frames", "Content is organised into frames", true),
    ("frame_unnamed", "Every frame has a specific name", true),
    ("frame_duplicate_name", "Frame names are unique", true),
    ("frame_nested", "No frame sits inside another", true),
    ("frame_overlap", "Frames do not overlap", false),
    ("outside_frame", "Every element is inside a frame", true),
    (
        "dangling_frame_ref",
        "No element points at a missing frame",
        true,
    ),
    ("clipped_by_frame", "Nothing pokes outside its frame", true),
    ("group_spans_frames", "No group spans two frames", true),
    ("loose_label", "Labels are bound to their shapes", true),
    ("loose_fragments", "Touching parts are grouped", true),
];

type Box2 = (f64, f64, f64, f64);

fn num(e: &Value, key: &str) -> f64 {
    e.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn s<'a>(e: &'a Value, key: &str) -> Option<&'a str> {
    e.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
}

fn kind(e: &Value) -> &str {
    s(e, "type").unwrap_or("")
}

fn id(e: &Value) -> &str {
    s(e, "id").unwrap_or("")
}

fn group_ids(e: &Value) -> Vec<&str> {
    e.get("groupIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// Axis-aligned bounds. Lines, arrows and freedraw keep `x, y` as the first point.
fn bbox(e: &Value) -> Box2 {
    let (x, y) = (num(e, "x"), num(e, "y"));
    let points: Vec<(f64, f64)> = e
        .get("points")
        .and_then(Value::as_array)
        .map(|ps| {
            ps.iter()
                .filter_map(|p| Some((p.get(0)?.as_f64()?, p.get(1)?.as_f64()?)))
                .collect()
        })
        .unwrap_or_default();
    if points.is_empty() {
        return (x, y, x + num(e, "width"), y + num(e, "height"));
    }
    let xs = points.iter().map(|p| x + p.0);
    let ys = points.iter().map(|p| y + p.1);
    (
        xs.clone().fold(f64::INFINITY, f64::min),
        ys.clone().fold(f64::INFINITY, f64::min),
        xs.fold(f64::NEG_INFINITY, f64::max),
        ys.fold(f64::NEG_INFINITY, f64::max),
    )
}

fn area(b: Box2) -> f64 {
    (b.2 - b.0).max(0.0) * (b.3 - b.1).max(0.0)
}

fn inside(inner: Box2, outer: Box2, tol: f64) -> bool {
    inner.0 >= outer.0 - tol
        && inner.1 >= outer.1 - tol
        && inner.2 <= outer.2 + tol
        && inner.3 <= outer.3 + tol
}

fn touches(a: Box2, b: Box2, gap: f64) -> bool {
    !(a.2 + gap < b.0 || b.2 + gap < a.0 || a.3 + gap < b.1 || b.3 + gap < a.1)
}

fn overlap_area(a: Box2, b: Box2) -> f64 {
    area((a.0.max(b.0), a.1.max(b.1), a.2.min(b.2), a.3.min(b.3)))
}

/// Up to 60 characters of an element's text or name, on one line.
fn label(e: &Value) -> String {
    let t = s(e, "text").or_else(|| s(e, "name")).unwrap_or("");
    t.replace('\n', " ").trim().chars().take(60).collect()
}

/// `frame`, `Section 3`, `untitled` and the like say nothing a person would use.
fn generic_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    let word = lower.trim_end_matches(|c: char| c.is_ascii_digit()).trim();
    matches!(
        word,
        "" | "frame" | "section" | "group" | "untitled" | "new frame"
    )
}

fn is_frame(e: &Value) -> bool {
    matches!(kind(e), "frame" | "magicframe")
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Lint one scene (`{ elements: [...] }`). Deleted elements are ignored.
pub fn lint(scene: &Value) -> Value {
    let els: Vec<&Value> = scene
        .get("elements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| !e.get("isDeleted").and_then(Value::as_bool).unwrap_or(false))
        .collect();
    let by_id: HashMap<&str, &Value> = els.iter().map(|e| (id(e), *e)).collect();
    let frames: Vec<&Value> = els.iter().copied().filter(|e| is_frame(e)).collect();
    let content: Vec<&Value> = els.iter().copied().filter(|e| !is_frame(e)).collect();
    let mut issues: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut add = |rule: &'static str, line: String| issues.entry(rule).or_default().push(line);

    // Frames.
    let name_of = |f: &Value| s(f, "name").unwrap_or("").trim().to_string();
    let mut names: HashMap<String, usize> = HashMap::new();
    for f in &frames {
        *names.entry(name_of(f)).or_default() += 1;
    }
    for f in &frames {
        let n = name_of(f);
        if generic_name(&n) {
            add("frame_unnamed", format!("{} has generic name {n:?}", id(f)));
        } else if names[&n] > 1 {
            add("frame_duplicate_name", format!("{} {n:?}", id(f)));
        }
        if let Some(parent) = s(f, "frameId") {
            add(
                "frame_nested",
                format!("{} {n:?} sits inside frame {parent}", id(f)),
            );
        }
    }
    for (i, a) in frames.iter().enumerate() {
        for b in &frames[i + 1..] {
            let (ba, bb) = (bbox(a), bbox(b));
            if overlap_area(ba, bb) > 0.02 * area(ba).min(area(bb)) {
                add(
                    "frame_overlap",
                    format!("{:?} overlaps {:?}", name_of(a), name_of(b)),
                );
            }
        }
    }

    // Frame membership; bound text follows its container.
    let framed = content
        .iter()
        .filter(|e| s(e, "frameId").is_some_and(|f| by_id.contains_key(f)))
        .count();
    for e in &content {
        if s(e, "containerId").is_some() {
            continue;
        }
        match s(e, "frameId") {
            None => add(
                "outside_frame",
                format!("{} {} {:?}", id(e), kind(e), label(e)),
            ),
            Some(fid) => match by_id.get(fid) {
                None => add(
                    "dangling_frame_ref",
                    format!("{} -> missing frame {fid}", id(e)),
                ),
                Some(frame) if !inside(bbox(e), bbox(frame), 2.0) => add(
                    "clipped_by_frame",
                    format!("{} {} pokes outside {:?}", id(e), kind(e), name_of(frame)),
                ),
                Some(_) => {}
            },
        }
    }

    // Groups.
    let mut group_frames: BTreeMap<&str, HashSet<Option<&str>>> = BTreeMap::new();
    for e in &content {
        for g in group_ids(e) {
            group_frames.entry(g).or_default().insert(s(e, "frameId"));
        }
    }
    for (g, fs) in &group_frames {
        if fs.len() > 1 {
            add(
                "group_spans_frames",
                format!("group {g} spans {} frames", fs.len()),
            );
        }
    }

    let linked = |a: &Value, b: &Value| {
        s(a, "containerId") == Some(id(b))
            || s(b, "containerId") == Some(id(a))
            || group_ids(a).iter().any(|g| group_ids(b).contains(g))
    };

    // Fragments: two small parts that touch but share no group are a multi-part
    // object that will be selected one stray piece at a time. Large backgrounds
    // (panels) may stand alone.
    let mut by_frame: BTreeMap<Option<&str>, Vec<&Value>> = BTreeMap::new();
    for e in &content {
        by_frame.entry(s(e, "frameId")).or_default().push(e);
    }
    let mut frag_ids: HashSet<&str> = HashSet::new();
    let mut unbound = Vec::new();
    for (fid, items) in &by_frame {
        let fb = fid.and_then(|f| by_id.get(f)).map(|f| bbox(f));
        let mut small: Vec<(&Value, Box2)> = items
            .iter()
            .map(|e| (*e, bbox(e)))
            .filter(|(_, b)| fb.is_none_or(|fb| area(*b) < 0.25 * area(fb)))
            .collect();
        small.sort_by(|a, b| a.1 .0.total_cmp(&b.1 .0));
        for (i, (a, ba)) in small.iter().enumerate() {
            for (b, bb) in &small[i + 1..] {
                if bb.0 > ba.2 + 1.0 {
                    break;
                }
                if kind(a) == "text" && kind(b) == "text" {
                    continue;
                }
                if !touches(*ba, *bb, 1.0) || linked(a, b) {
                    continue;
                }
                let contain = inside(*ba, *bb, 1.0) || inside(*bb, *ba, 1.0);
                let (big, little) = if area(*bb) >= area(*ba) {
                    (b, a)
                } else {
                    (a, b)
                };
                if contain
                    && kind(little) == "text"
                    && matches!(kind(big), "rectangle" | "ellipse" | "diamond")
                {
                    unbound.push(format!(
                        "{} {:?} sits in {} but is not bound/grouped",
                        id(little),
                        label(little),
                        id(big)
                    ));
                } else {
                    frag_ids.insert(id(a));
                    frag_ids.insert(id(b));
                }
            }
        }
    }
    issues.remove("loose_label");
    if !unbound.is_empty() {
        issues.insert("loose_label", unbound);
    }
    if !frag_ids.is_empty() {
        let mut sample: Vec<&str> = frag_ids.iter().copied().collect();
        sample.sort_unstable();
        sample.truncate(8);
        issues.insert(
            "loose_fragments",
            vec![format!(
                "{} touching parts share no group, e.g. {}",
                frag_ids.len(),
                sample.join(", ")
            )],
        );
    }

    let bound_to: HashSet<&str> = content.iter().filter_map(|e| s(e, "containerId")).collect();
    let grouped = content
        .iter()
        .filter(|e| {
            !group_ids(e).is_empty() || s(e, "containerId").is_some() || bound_to.contains(id(e))
        })
        .count();
    let total = content.len().max(1) as f64;
    let frag_pct = round1(100.0 * frag_ids.len() as f64 / total);
    let stats = json!({
        "elements": content.len(),
        "frames": frames.len(),
        "framedPct": round1(100.0 * framed as f64 / total),
        "groups": group_frames.len(),
        "groupedPct": round1(100.0 * grouped as f64 / total),
        "looseFragmentElements": frag_ids.len(),
        "looseFragmentPct": frag_pct,
        "frameNames": frames.iter().map(|f| f.get("name").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
    });

    // Hard failures break agent selection outright; warnings are worth fixing.
    let failed = |rule: &str| match rule {
        "no_frames" => content.len() >= 10 && frames.is_empty(),
        "loose_fragments" => frag_pct > 2.0,
        "frame_overlap" => false,
        other => issues.get(other).is_some_and(|v| !v.is_empty()),
    };
    let checks: Vec<Value> = RULES
        .iter()
        .map(|(rule, text, hard)| {
            let found = issues.get(rule).map(Vec::as_slice).unwrap_or(&[]);
            let broke = failed(rule);
            json!({
                "id": rule,
                "label": text,
                "hard": hard,
                "pass": !broke,
                "warn": !broke && !found.is_empty(),
                "count": found.len(),
                "issues": found.iter().take(MAX_EXAMPLES).collect::<Vec<_>>(),
            })
        })
        .collect();
    let failed_checks: Vec<&str> = RULES.iter().map(|r| r.0).filter(|r| failed(r)).collect();
    let mut all = Map::new();
    for (rule, lines) in &issues {
        all.insert((*rule).to_string(), json!(lines.len()));
    }
    json!({
        "kind": "canvasLint",
        "pass": failed_checks.is_empty(),
        "failedChecks": failed_checks,
        "checks": checks,
        "stats": stats,
        "issueCounts": all,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, frame: Option<&str>) -> Value {
        json!({ "id": id, "type": "rectangle", "x": x, "y": y, "width": w, "height": h, "frameId": frame })
    }

    fn frame(id: &str, name: &str, x: f64, y: f64, w: f64, h: f64) -> Value {
        json!({ "id": id, "type": "frame", "name": name, "x": x, "y": y, "width": w, "height": h })
    }

    fn check<'a>(out: &'a Value, rule: &str) -> &'a Value {
        out["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == rule)
            .unwrap()
    }

    #[test]
    fn a_framed_grouped_canvas_passes_every_rule() {
        let mut a = rect("a", 10.0, 10.0, 20.0, 20.0, Some("f"));
        let mut b = rect("b", 30.0, 10.0, 20.0, 20.0, Some("f"));
        a["groupIds"] = json!(["g"]);
        b["groupIds"] = json!(["g"]);
        let scene = json!({ "elements": [frame("f", "1. Hammer", 0.0, 0.0, 400.0, 400.0), a, b] });
        let out = lint(&scene);
        assert_eq!(out["pass"], true, "{out:#}");
        assert_eq!(out["checks"].as_array().unwrap().len(), RULES.len());
        assert_eq!(out["stats"]["groupedPct"], 100.0);
    }

    #[test]
    fn loose_touching_parts_and_unframed_elements_fail() {
        let scene = json!({ "elements": [
            frame("f", "Frame 2", 0.0, 0.0, 400.0, 400.0),
            rect("a", 10.0, 10.0, 20.0, 20.0, Some("f")),
            rect("b", 30.0, 10.0, 20.0, 20.0, Some("f")),
            rect("c", 900.0, 900.0, 5.0, 5.0, None),
        ]});
        let out = lint(&scene);
        assert_eq!(out["pass"], false);
        assert_eq!(check(&out, "frame_unnamed")["pass"], false);
        assert_eq!(check(&out, "outside_frame")["count"], 1);
        assert_eq!(check(&out, "loose_fragments")["pass"], false);
        assert_eq!(check(&out, "frame_nested")["pass"], true);
    }

    #[test]
    fn text_sitting_in_a_box_unbound_is_a_loose_label() {
        let text = json!({ "id": "t", "type": "text", "text": "Coins", "x": 12.0, "y": 12.0, "width": 10.0, "height": 8.0, "frameId": "f" });
        let scene = json!({ "elements": [
            frame("f", "Economy", 0.0, 0.0, 400.0, 400.0),
            rect("box", 10.0, 10.0, 40.0, 20.0, Some("f")),
            text,
        ]});
        let out = lint(&scene);
        assert_eq!(check(&out, "loose_label")["pass"], false);
        assert!(check(&out, "loose_label")["issues"][0]
            .as_str()
            .unwrap()
            .contains("sits in box"));
    }

    #[test]
    fn overlapping_frames_only_warn_and_generic_names_are_caught() {
        let scene = json!({ "elements": [
            frame("f1", "Movement", 0.0, 0.0, 100.0, 100.0),
            frame("f2", "Combat", 50.0, 50.0, 100.0, 100.0),
        ]});
        let out = lint(&scene);
        assert_eq!(out["pass"], true);
        assert_eq!(check(&out, "frame_overlap")["warn"], true);
        assert!(generic_name("Section 3") && generic_name("frame") && generic_name(""));
        assert!(!generic_name("3. Movement"));
    }

    #[test]
    fn many_elements_without_any_frame_fail_no_frames() {
        let elements: Vec<Value> = (0..10)
            .map(|i| rect(&format!("r{i}"), i as f64 * 100.0, 0.0, 10.0, 10.0, None))
            .collect();
        let out = lint(&json!({ "elements": elements }));
        assert_eq!(out["failedChecks"][0], "no_frames");
    }
}
