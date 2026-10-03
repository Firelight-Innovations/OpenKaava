//! How much an agent draws on a design canvas, and what it looks like.
//!
//! Two knobs, both chosen in Settings (Canvas section) and both overridable per
//! canvas (`kaava.design` in the canvas file):
//!
//! * a **detail level**, which says how many panels a frame carries and whether
//!   scales, tables and worked examples are required, and
//! * a **style**, which says how it is drawn: a palette mapping, stroke
//!   roughness, fill style, font family, and prose for the agent.
//!
//! Both end up in two places. The agent reads them as prose from `drawing_guide`
//! and `canvas/design-brief` ([`brief`]), and the renderable half of the style
//! ([`render_params`]) is handed to the canvas frontend on every `add_shapes`, so
//! a sketch style is *drawn* sketchily and not merely described as such.
//!
//! The detail levels are calibrated on the minecraft-clone canvas
//! (`demo-game/canvas/minecraft-clone.json`): what that file does per frame is
//! `standard`. `sparse` is a sketch of the idea and `dense` is a build spec.

use serde_json::{json, Map, Value};

/// The setting keys, so the Settings schema and the resolver cannot drift.
pub const KEY_DETAIL: &str = "canvas.detailLevel";
pub const KEY_STYLE: &str = "canvas.style";

pub const DEFAULT_DETAIL: &str = "standard";
pub const DEFAULT_STYLE: &str = "blueprint";

/// One level of detail. The numbers are what the prose says, kept as data so a
/// test can hold the two together.
pub struct DetailLevel {
    pub id: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    /// Inclusive range of titled panels per frame.
    pub panels: (u8, u8),
    /// Rough shape count per frame, for the agent's sense of scale.
    pub shapes: (u16, u16),
    pub requires_scale: bool,
    pub requires_table: bool,
    pub requires_worked_example: bool,
    /// Longest label, in words.
    pub label_words: u8,
    pub guidance: &'static str,
}

pub static DETAIL_LEVELS: &[DetailLevel] = &[
    DetailLevel {
        id: "sparse",
        name: "Sparse",
        summary: "One idea per frame: a few labelled shapes, no tables.",
        panels: (1, 2),
        shapes: (6, 15),
        requires_scale: false,
        requires_table: false,
        requires_worked_example: false,
        label_words: 4,
        guidance: "\
- One idea per frame. Draw 1 or 2 panels, each with a short title, and 6 to 15 shapes in all.
- Labels are 4 words or fewer. A frame carries one summary line and no paragraphs of prose.
- Numbers appear only where they decide something (a speed, a count, a size). Give the unit.
- No tables, no worked examples, no scales. Draw proportions roughly right and say nothing about them.
- Name the parts and show how they connect: boxes and arrows, one arrow label each at most.
- Leave detail to a later pass. If a frame needs a table to make sense, split it into two frames.",
    },
    DetailLevel {
        id: "standard",
        name: "Standard",
        summary: "Dense and specific: real numbers and units, tables, labelled diagrams with scales.",
        panels: (2, 4),
        shapes: (15, 45),
        requires_scale: true,
        requires_table: true,
        requires_worked_example: true,
        label_words: 8,
        guidance: "\
- Be specific. Every frame is 2 to 4 panels, each with a capitalised panel title, and 15 to 45 shapes in all.
- Use real numbers with units everywhere a quantity exists: 80 px = 1 m, a 12-byte position, fog from 96 m to 128 m. Never write \"large\", \"fast\" or \"some\" where a figure belongs.
- Any panel that shows geometry is drawn to a stated scale, with the scale written on it (\"80 px = 1 m\") and dimension lines on the parts that matter.
- Each frame has at least one table (3 rows or more, with a header row) or one worked example that carries real values through the rule, step by step: inputs, the arithmetic, the result.
- Diagrams are labelled: every shape named, every arrow says what flows or what triggers it, every axis has a unit.
- Prose is for what no picture can carry: at most two short lines under a panel, 14 px.
- Reference point: the minecraft-clone canvas. Its chunk meshing frame has face culling drawn at 80 px = 1 m, a vertex format byte table and fog radii in metres; its atlas frame has the atlas grid and a UV worked example.",
    },
    DetailLevel {
        id: "dense",
        name: "Dense",
        summary: "A build spec: many panels, tables and worked examples with arithmetic, edge cases, ranges.",
        panels: (4, 6),
        shapes: (45, 100),
        requires_scale: true,
        requires_table: true,
        requires_worked_example: true,
        label_words: 12,
        guidance: "\
- Draw it so someone could implement it without asking. Every frame is 4 to 6 panels with capitalised titles and 45 to 100 shapes in all; split a frame in two rather than going past 6 panels.
- Everything in `standard` applies, and more: every panel has a scale or a legend, and every quantity has a unit and, where it is tunable, a range (\"fog start 64 to 160 m, default 96 m\").
- Each frame has two or more tables (5 rows or more) and at least one worked example with the arithmetic written out line by line, ending in the value the engine would store.
- Show the edge cases as their own panel: boundaries, off-by-one cases, empty and maximum inputs, and what the system does when each fails.
- Show a rejected alternative where a design choice was made: draw it small, mark it with a cross and say why in one line.
- Cross-link: a label that depends on another frame links to it (`kaava://diagram/<id>`), and a value that appears twice lives in the value table (`{{name}}`) so it cannot drift.
- Order panels so the frame reads left to right, top to bottom: overview, mechanism, numbers, worked example, edge cases.
- Text may be denser, but never below 14 px, and every paragraph is 3 lines or fewer.",
    },
];

/// One visual style.
pub struct Style {
    pub id: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    /// Excalidraw roughness: 0 clean, 1 slightly drawn, 2 sketched.
    pub roughness: u8,
    /// Excalidraw fill style: `solid`, `hachure`, `cross-hatch`.
    pub fill_style: &'static str,
    /// Stroke width in px for shapes that do not set their own.
    pub stroke_width: u8,
    /// Excalidraw's font family id.
    pub font_family: u8,
    /// The face's CSS name, for measuring text before it is drawn.
    pub font_name: &'static str,
    /// Whether rectangles are rounded unless the shape says otherwise.
    pub rounded: bool,
    /// Which palette names play which part, since a colour outside the palette is
    /// drawn in ink. `(role, palette names)`.
    pub palette: &'static [(&'static str, &'static str)],
    pub guidance: &'static str,
}

pub static STYLES: &[Style] = &[
    Style {
        id: "blueprint",
        name: "Technical blueprint",
        summary: "Thin outlines, muted fills, colour-coded categories, panel titles in caps.",
        roughness: 0,
        fill_style: "solid",
        stroke_width: 2,
        font_family: 6,
        font_name: "Nunito",
        rounded: true,
        palette: &[
            ("outlines and labels", "ink"),
            ("notes, dimensions, secondary", "muted"),
            ("player, input, links", "blue"),
            ("success, safe, scoring", "green"),
            ("danger, failure, collisions", "red"),
            ("forces, motion, flow", "orange"),
            ("state and timing", "violet"),
            ("spawning, generation", "teal"),
        ],
        guidance: "\
- Look: a dark technical drawing. Thin outlines, light muted fills, nothing decorative. Draw boxes that stand for hard edges (memory blocks, grids, table cells) square with `\"rounded\": false`.
- Colour codes the category, never the mood: use each palette name for the role it has above, and keep the same colour for the same kind of thing across every frame. Fill with the matching light shade only to mark membership of a category.
- Panel titles are in CAPITALS (\"FACE CULLING\"), numbered when the frame has an order (\"7. CHUNK MESHING\"). Labels are short and technical, in the units of the thing drawn.
- Draw precisely: align to the 10 px grid, use dimension lines with end ticks, and write the scale on every panel.
- Tables are rectangles in a grid with `ink` outlines and a header row filled `muted`.",
    },
    Style {
        id: "whiteboard",
        name: "Whiteboard sketch",
        summary: "Hand-drawn strokes and hatching, marker colours, loose and quick to read.",
        roughness: 2,
        fill_style: "hachure",
        stroke_width: 2,
        font_family: 5,
        font_name: "Excalifont",
        rounded: true,
        palette: &[
            ("outlines and labels", "ink"),
            ("the thing being explained, links", "blue"),
            ("problems, what not to do", "red"),
            ("the good path, results", "green"),
            ("side notes and asides", "muted"),
        ],
        guidance: "\
- Look: a diagram sketched on a whiteboard in marker. Rough strokes, hatched fills and a handwritten face; it is drawn that way for you, so do not fight it.
- Stay with the four marker colours above. Use `ink` for most of it, `blue` to point at the thing being explained, `red` for what goes wrong and `green` for the result. Leave `orange`, `violet` and `teal` out.
- Fill with hatching sparingly, to highlight one or two shapes per panel. Most shapes stay empty (`\"fill\": \"none\"`).
- Prefer curved arrows (`\"curved\": true`) and loose layouts over tidy grids. Circle or underline the key thing with an `ellipse` or a `line` rather than boxing it.
- Labels read like something said out loud: sentence case, plain words, no panel-title capitals. Write a number as it would be spoken or scribbled (\"~16 m\").
- Keep it quick to read: favour fewer, bigger shapes, and let a scribbled arrow stand for a paragraph of detail. Handwriting is wide, so keep labels short or wrap them with `maxWidth`.",
    },
    Style {
        id: "minimal",
        name: "Clean presentation",
        summary: "Slide-like: white space, one accent colour, thin neutral lines, no fills.",
        roughness: 0,
        fill_style: "solid",
        stroke_width: 1,
        font_family: 9,
        font_name: "Liberation Sans",
        rounded: true,
        palette: &[
            ("outlines and body text", "ink"),
            ("secondary text and guides", "muted"),
            ("the single accent: what to look at", "blue"),
        ],
        guidance: "\
- Look: a slide from a well-designed deck. A lot of white space, thin neutral lines, one sans-serif face and a single accent colour.
- Use `ink` and `muted` for nearly everything and `blue` for the one thing in each panel the eye should land on. No other colours. Do not fill shapes (`\"fill\": \"none\"`), except one light `blue` fill on the focal shape.
- Leave generous space: 60 px or more between groups, and nothing crowded into a corner. If it does not fit, drop the least important element rather than shrinking spacing.
- One message per panel, stated as a title in sentence case (\"Faces between two solid blocks are never drawn\"), with the figure beneath it. Rounded boxes, straight arrows, `small` text for notes.
- Tables are drawn as aligned text with thin `muted` rules between rows, not boxed cells.",
    },
    Style {
        id: "explainer",
        name: "Colourful explainer",
        summary: "Bold strokes, a colour per concept, every box filled, numbered steps; friendly.",
        roughness: 1,
        fill_style: "solid",
        stroke_width: 3,
        font_family: 8,
        font_name: "Comic Shanns",
        rounded: true,
        palette: &[
            ("outlines and labels", "ink"),
            ("concept one (the main thing)", "blue"),
            ("concept two", "orange"),
            ("concept three", "green"),
            ("concept four", "violet"),
            ("concept five", "teal"),
            ("warnings and mistakes", "red"),
        ],
        guidance: "\
- Look: a friendly explainer for someone meeting the idea for the first time. Bold strokes, a slightly wobbly line, a rounded casual face and plenty of colour.
- Give each concept its own colour from the list above and keep it for that concept in every frame. Fill every box with its colour's light shade (`\"fill\": \"<name>\"`), and keep text in `ink`.
- Number the steps: draw a small `ellipse` with 1, 2, 3 along the path and read left to right. A frame is a story with a beginning and an end.
- Name things the way a person would (\"The chunk\", \"What the GPU sees\") and add a one-line takeaway in a filled `orange` or `green` box at the bottom of each frame.
- Use `red` only for the warning or the common mistake, drawn with a cross.
- Keep shapes big and few so it reads at a glance, and use a small worked example in place of a table where you can.",
    },
];

pub fn detail(id: &str) -> Option<&'static DetailLevel> {
    DETAIL_LEVELS.iter().find(|d| d.id == id)
}

pub fn style(id: &str) -> Option<&'static Style> {
    STYLES.iter().find(|s| s.id == id)
}

/// Where an effective value came from, so a brief never hides a default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Canvas,
    Setting,
    Default,
}

impl Source {
    fn label(self) -> &'static str {
        match self {
            Self::Canvas => "this canvas",
            Self::Setting => "settings",
            Self::Default => "default",
        }
    }
}

/// The levels and styles in force.
pub struct Effective {
    pub detail: &'static DetailLevel,
    pub detail_from: Source,
    pub style: &'static Style,
    pub style_from: Source,
}

/// One pick: the canvas's own override, else the setting, else the default.
/// A value that names nothing known falls through to the next, so an old file or
/// a hand-edited settings file never leaves an agent with no guidance.
fn pick<T>(
    find: fn(&str) -> Option<&'static T>,
    canvas: Option<&str>,
    setting: Option<&str>,
    default: &'static T,
) -> (&'static T, Source) {
    if let Some(found) = canvas.and_then(find) {
        return (found, Source::Canvas);
    }
    if let Some(found) = setting.and_then(find) {
        return (found, Source::Setting);
    }
    (default, Source::Default)
}

/// The defaults, as the entries `DEFAULT_DETAIL` and `DEFAULT_STYLE` name; a test
/// holds the two together.
fn default_detail() -> &'static DetailLevel {
    &DETAIL_LEVELS[1]
}

fn default_style() -> &'static Style {
    &STYLES[0]
}

/// Resolve the effective level and style. Pure, so it is tested without an app.
pub fn resolve(
    canvas_detail: Option<&str>,
    canvas_style: Option<&str>,
    setting_detail: Option<&str>,
    setting_style: Option<&str>,
) -> Effective {
    let (detail, detail_from) = pick(detail, canvas_detail, setting_detail, default_detail());
    let (style, style_from) = pick(style, canvas_style, setting_style, default_style());
    Effective {
        detail,
        detail_from,
        style,
        style_from,
    }
}

/// The `kaava.design` override a canvas file carries: `(detail, style)`.
pub fn override_of(scene: &Value) -> (Option<String>, Option<String>) {
    let design = scene.get("kaava").and_then(|k| k.get("design"));
    let get = |key: &str| {
        design
            .and_then(|d| d.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    (get("detail"), get("style"))
}

/// The half of a style the canvas frontend draws with. `fontName` is what text is
/// measured in before it is placed.
pub fn render_params(style: &Style) -> Value {
    json!({
        "style": style.id,
        "roughness": style.roughness,
        "fillStyle": style.fill_style,
        "strokeWidth": style.stroke_width,
        "fontFamily": style.font_family,
        "fontName": style.font_name,
        "rounded": style.rounded,
    })
}

/// The prose an agent reads.
pub fn guidance_text(e: &Effective) -> String {
    let mut text = String::new();
    text.push_str("## Detail level and style for this canvas\n\n");
    text.push_str(&format!(
        "Detail: **{}** ({}). Style: **{}** ({}).\n\n",
        e.detail.name,
        e.detail_from.label(),
        e.style.name,
        e.style_from.label()
    ));
    text.push_str(&format!(
        "### Detail: {}\n\n{}\n\n{}\n\n",
        e.detail.name, e.detail.summary, e.detail.guidance
    ));
    text.push_str(&format!(
        "### Style: {}\n\n{}\n\nPalette roles (palette names only; any other colour is drawn in ink):\n",
        e.style.name, e.style.summary
    ));
    for (role, name) in e.style.palette {
        text.push_str(&format!("- `{name}`: {role}\n"));
    }
    text.push_str(&format!(
        "\nThe canvas draws this style for you: roughness {}, {} fills, {} px strokes, {} text. You do not set these per shape.\n\n{}\n\n",
        e.style.roughness,
        e.style.fill_style,
        e.style.stroke_width,
        e.style.font_name,
        e.style.guidance
    ));
    text.push_str(
        "The person chose these in Settings, Canvas. Follow them over your own taste, and do not \
         change them yourself. `canvas/set-design` is for when the person asks.\n",
    );
    text
}

/// Every level and style, for `drawing_guide {topic: "style"}`.
pub fn catalog_text() -> String {
    let mut text = String::from("# Detail levels and styles\n\n## Detail levels\n\n");
    for d in DETAIL_LEVELS {
        text.push_str(&format!(
            "### {} (`{}`)\n\n{}\n\n{}\n\n",
            d.name, d.id, d.summary, d.guidance
        ));
    }
    text.push_str("## Styles\n\n");
    for s in STYLES {
        text.push_str(&format!(
            "### {} (`{}`)\n\n{}\n\n{}\n\n",
            s.name, s.id, s.summary, s.guidance
        ));
    }
    text
}

/// The structured brief: what is in force, where each came from, the render
/// parameters and the prose.
pub fn brief(e: &Effective) -> Value {
    json!({
        "detail": {
            "id": e.detail.id, "name": e.detail.name, "from": e.detail_from.label(),
            "panels": [e.detail.panels.0, e.detail.panels.1],
            "shapes": [e.detail.shapes.0, e.detail.shapes.1],
            "requiresScale": e.detail.requires_scale,
            "requiresTable": e.detail.requires_table,
            "requiresWorkedExample": e.detail.requires_worked_example,
            "labelWords": e.detail.label_words,
        },
        "style": {
            "id": e.style.id, "name": e.style.name, "from": e.style_from.label(),
            "render": render_params(e.style),
            "palette": e.style.palette.iter().map(|(role, name)| json!({ "role": role, "color": name })).collect::<Vec<_>>(),
        },
        "options": {
            "detail": DETAIL_LEVELS.iter().map(|d| d.id).collect::<Vec<_>>(),
            "style": STYLES.iter().map(|s| s.id).collect::<Vec<_>>(),
            "names": DETAIL_LEVELS
                .iter()
                .map(|d| (d.id, d.name))
                .chain(STYLES.iter().map(|s| (s.id, s.name)))
                .map(|(id, name)| (id.to_string(), json!(name)))
                .collect::<Map<String, Value>>(),
        },
        "text": guidance_text(e),
    })
}

/// A per-canvas override from `canvas/set-design` params: `Some(Some(id))` sets,
/// `Some(None)` clears (`null` or `"default"`), `None` leaves alone.
pub fn parse_choice(
    params: &Value,
    key: &str,
    known: fn(&str) -> bool,
) -> Result<Option<Option<String>>, String> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if s == "default" => Ok(Some(None)),
        Some(Value::String(s)) if known(s) => Ok(Some(Some(s.clone()))),
        Some(Value::String(s)) => Err(format!("`{s}` is not a {key}")),
        Some(_) => Err(format!("{key} must be a string or null")),
    }
}

/// Apply a choice to `kaava.design` in a scene.
pub fn store_choice(scene: &mut Value, key: &str, choice: Option<Option<String>>) {
    let Some(choice) = choice else { return };
    if !scene.get("kaava").is_some_and(Value::is_object) {
        scene["kaava"] = json!({});
    }
    let kaava = &mut scene["kaava"];
    if !kaava.get("design").is_some_and(Value::is_object) {
        kaava["design"] = Value::Object(Map::new());
    }
    if let Some(design) = kaava["design"].as_object_mut() {
        match choice {
            Some(id) => {
                design.insert(key.into(), json!(id));
            }
            None => {
                design.remove(key);
            }
        }
    }
    let emptied = kaava["design"].as_object().is_some_and(Map::is_empty);
    if let (true, Some(kaava)) = (emptied, kaava.as_object_mut()) {
        kaava.remove("design");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_current_look_and_the_minecraft_level() {
        assert_eq!(DEFAULT_DETAIL, "standard");
        assert_eq!(DEFAULT_STYLE, "blueprint");
        assert_eq!(default_detail().id, DEFAULT_DETAIL);
        assert_eq!(default_style().id, DEFAULT_STYLE);
        let e = resolve(None, None, None, None);
        assert_eq!((e.detail.id, e.detail_from), ("standard", Source::Default));
        assert_eq!((e.style.id, e.style_from), ("blueprint", Source::Default));
        // Today's renderer draws roughness 0, solid fill, Nunito.
        assert_eq!(e.style.roughness, 0);
        assert_eq!(e.style.fill_style, "solid");
        assert_eq!(e.style.font_family, 6);
    }

    #[test]
    fn a_canvas_override_beats_the_setting_which_beats_the_default() {
        let e = resolve(Some("dense"), None, Some("sparse"), Some("whiteboard"));
        assert_eq!((e.detail.id, e.detail_from), ("dense", Source::Canvas));
        assert_eq!((e.style.id, e.style_from), ("whiteboard", Source::Setting));
    }

    #[test]
    fn an_unknown_value_falls_through_instead_of_leaving_no_guidance() {
        let e = resolve(Some("huge"), Some("neon"), Some("sparse"), Some("also-bad"));
        assert_eq!((e.detail.id, e.detail_from), ("sparse", Source::Setting));
        assert_eq!((e.style.id, e.style_from), ("blueprint", Source::Default));
    }

    #[test]
    fn the_levels_are_ordered_and_their_numbers_are_in_their_prose() {
        let ids: Vec<&str> = DETAIL_LEVELS.iter().map(|d| d.id).collect();
        assert_eq!(ids, ["sparse", "standard", "dense"]);
        for pair in DETAIL_LEVELS.windows(2) {
            assert!(pair[0].panels.1 <= pair[1].panels.1);
            assert!(pair[0].shapes.1 < pair[1].shapes.1);
        }
        for d in DETAIL_LEVELS {
            assert!(
                d.guidance.contains(&d.panels.0.to_string())
                    && d.guidance.contains(&d.panels.1.to_string()),
                "{}: panel range missing from the prose",
                d.id
            );
            assert!(d.guidance.contains(&d.shapes.1.to_string()), "{}", d.id);
        }
        assert!(!DETAIL_LEVELS[0].requires_table && !DETAIL_LEVELS[0].requires_worked_example);
        for d in &DETAIL_LEVELS[1..] {
            assert!(d.requires_scale && d.requires_table && d.requires_worked_example);
        }
    }

    #[test]
    fn standard_asks_for_what_the_minecraft_canvas_has() {
        let g = detail("standard").unwrap().guidance;
        for needle in ["scale", "table", "worked example", "units", "80 px = 1 m"] {
            assert!(g.contains(needle), "standard lacks {needle}");
        }
    }

    #[test]
    fn styles_are_distinct_and_use_only_palette_names() {
        assert_eq!(STYLES.len(), 4);
        for s in STYLES {
            assert!(["solid", "hachure", "cross-hatch"].contains(&s.fill_style));
            assert!(s.roughness <= 2);
            assert!(!s.guidance.is_empty() && !s.summary.is_empty());
        }
        for (i, a) in STYLES.iter().enumerate() {
            for b in &STYLES[i + 1..] {
                let same = (a.roughness, a.fill_style, a.stroke_width, a.font_family)
                    == (b.roughness, b.fill_style, b.stroke_width, b.font_family);
                assert!(!same, "{} and {} draw identically", a.id, b.id);
                assert_ne!(a.id, b.id);
            }
        }
    }

    #[test]
    fn the_brief_carries_the_effective_guidance_and_render_params() {
        let b = brief(&resolve(None, Some("whiteboard"), Some("dense"), None));
        assert_eq!(b["detail"]["id"], "dense");
        assert_eq!(b["detail"]["from"], "settings");
        assert_eq!(b["style"]["id"], "whiteboard");
        assert_eq!(b["style"]["from"], "this canvas");
        assert_eq!(b["style"]["render"]["roughness"], 2);
        assert_eq!(b["style"]["render"]["fillStyle"], "hachure");
        let text = b["text"].as_str().unwrap();
        assert!(text.contains(DETAIL_LEVELS[2].guidance));
        assert!(text.contains(STYLES[1].guidance));
        assert!(!text.contains(DETAIL_LEVELS[0].guidance));
        assert!(!text.contains(STYLES[0].guidance));
    }

    #[test]
    fn the_catalog_lists_everything() {
        let text = catalog_text();
        for d in DETAIL_LEVELS {
            assert!(text.contains(d.guidance));
        }
        for s in STYLES {
            assert!(text.contains(s.guidance));
        }
    }

    #[test]
    fn a_choice_is_parsed_stored_and_cleared() {
        let known = |s: &str| detail(s).is_some();
        let p = json!({ "detail": "dense" });
        let set = parse_choice(&p, "detail", known).unwrap();
        assert_eq!(set, Some(Some("dense".to_string())));
        assert_eq!(parse_choice(&json!({}), "detail", known).unwrap(), None);
        assert_eq!(
            parse_choice(&json!({ "detail": "default" }), "detail", known).unwrap(),
            Some(None)
        );
        assert!(parse_choice(&json!({ "detail": "huge" }), "detail", known).is_err());
        assert!(parse_choice(&json!({ "detail": 3 }), "detail", known).is_err());

        let mut scene = json!({ "elements": [] });
        store_choice(&mut scene, "detail", set);
        assert_eq!(override_of(&scene).0.as_deref(), Some("dense"));
        store_choice(&mut scene, "detail", Some(None));
        assert_eq!(override_of(&scene), (None, None));
        assert!(
            scene["kaava"].get("design").is_none(),
            "an empty override is removed"
        );
    }

    /// The canvas's picker labels its choices from the brief, so every option the
    /// brief offers has a name there.
    #[test]
    fn the_brief_names_every_option_for_the_picker() {
        let brief = brief(&resolve(None, None, None, None));
        for kind in ["detail", "style"] {
            for id in brief["options"][kind].as_array().unwrap() {
                let id = id.as_str().unwrap();
                assert!(
                    brief["options"]["names"][id]
                        .as_str()
                        .is_some_and(|n| !n.is_empty()),
                    "{kind} `{id}` has no name"
                );
            }
        }
    }
}
