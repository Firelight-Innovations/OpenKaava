//! The Canvas app as first-class MCP tools, for any agent, in every build.
//!
//! Until now an agent reached these methods only through the developer-only
//! `agent` server's `app_call`, which a release build does not serve. This is the
//! supported route: one named tool per canvas method, each with a schema and a
//! description, and the `actor` rule the methods enforce kept on the server's side
//! (every call goes out as `"agent"`; a client cannot claim to be a person).
//!
//! **Several canvases can be open at once.** Every tool that acts on a canvas takes
//! `canvas` (its id), `instance` (the pane's instance id) and `cluster`, and
//! `list_canvases` says which are open and which has focus. [`resolve_canvas`] is
//! the one place that turns those into a target: an explicit id or instance wins,
//! an omitted one means the focused canvas (or the only one open), and anything
//! else is an error that lists the candidates. The result always carries a
//! `resolved` block saying what was chosen and why, so a default is never silent.
//!
//! **Adding a method is one row** in the `canvas_tools!` table below: the tool name,
//! the app method, which [`Scope`] it resolves, whether it only reads, a
//! description and a schema. The tool list, the dispatch table and the
//! `readOnlyHint` all come from that row.

use super::workspace::{self, Pages, Surface};
use crate::apps::canvas::style;
use crate::apps::{self, CallContext};
use crate::mcp::{McpServer, McpTool, ToolAnswer};
use crate::shell_state::ShellState;
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

pub static SERVER: McpServer = McpServer {
    id: "canvas",
    name: "Canvas",
    description: "Read and draw on design canvases: diagrams, views, comments, linked values and \
                  checkpoints. Works with several canvases open at once.",
    tools: TOOLS,
    call,
    dev_only: false,
};

/// What a tool needs resolved before its method can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    /// Answered from the manuals compiled in; no app, no pane, no project.
    Guide,
    /// Answered from the open panes alone; no app method.
    Open,
    /// Needs a cluster (its project holds the canvas files) but no canvas.
    Cluster,
    /// `canvas` names a canvas that does not exist yet; needs a cluster.
    New,
    /// Works across a whole cluster's project; `canvas`, if given, is an optional
    /// filter handed to the method untouched, never defaulted to the focused one.
    Project,
    /// Acts on one existing canvas: resolves canvas and cluster.
    Canvas,
}

pub(super) struct Route {
    pub tool: &'static str,
    pub method: &'static str,
    pub scope: Scope,
    pub read_only: bool,
}

/// Whether a canvas tool only reads, for the `readOnlyHint` table.
pub(super) fn read_only(tool: &str) -> Option<bool> {
    ROUTES.iter().find(|r| r.tool == tool).map(|r| r.read_only)
}

macro_rules! canvas_tools {
    ($( $name:literal => $method:literal, $scope:expr, $ro:expr, $desc:literal, $schema:expr; )*) => {
        static TOOLS: &[McpTool] = &[
            $( McpTool { name: $name, description: $desc, schema: $schema } ),*
        ];
        static ROUTES: &[Route] = &[
            $( Route { tool: $name, method: $method, scope: $scope, read_only: $ro } ),*
        ];
    };
}

canvas_tools! {
    "drawing_guide" => "", Scope::Guide, true,
    "The manual, as text: how to draw a design (`topic: \"drawing\"`, the default: palette, \
     sizes, spacing, every add_shapes option, viewing and comments) or how frames, types and \
     nested canvases work (`topic: \"frames\"`). The drawing manual ends with the detail level \
     and style the person chose in Settings (or this canvas's override): follow them. \
     `topic: \"style\"` lists every level and style. Read it before your first add_shapes.",
    || obj(
        json!({
            "topic": { "type": "string", "enum": ["drawing", "frames", "style"], "description": "Default drawing." },
            "canvas": { "type": "string", "description": "The canvas whose detail level and style to append, for a per-canvas override. Default: the focused canvas, else the settings alone." },
            "instance": { "type": "string", "description": "A pane instance id; its canvas is used." },
            "cluster": { "type": "string", "description": CLUSTER_HELP },
        }),
        &[],
    );

    "design_brief" => "canvas/design-brief", Scope::Canvas, true,
    "The detail level (sparse, standard, dense) and drawing style (blueprint, whiteboard, minimal, \
     explainer) in force for a canvas: the canvas's own override, else Settings, else the \
     default. Returns where each came from, the render parameters and the guidance to follow.",
    || canvas_schema(json!({}), &[]);

    "set_design" => "canvas/set-design", Scope::Canvas, false,
    "Give this canvas its own detail level and/or style, overriding Settings; `null` or \
     `\"default\"` clears the override. Only when the person asks: Settings, Canvas is where \
     they choose.",
    || canvas_schema(
        json!({
            "detail": { "type": ["string", "null"], "enum": ["sparse", "standard", "dense", "default", null] },
            "style": { "type": ["string", "null"], "enum": ["blueprint", "whiteboard", "minimal", "explainer", "default", null] },
        }),
        &[],
    );

    "list_canvases" => "", Scope::Open, true,
    "Every Canvas open in OpenKaava right now: pane instance id, the canvas it shows, its \
     cluster, whether it is focused or visible. Also says which canvas a tool would act on if \
     you name none. Call this first when more than one may be open.",
    || obj(json!({}), &[]);

    "list_files" => "canvas/list", Scope::Cluster, true,
    "Every canvas file in a cluster's project, open or not: id, title, parent, mtime and any \
     read error.",
    || cluster_schema(json!({}), &[]);

    "assets" => "canvas/assets", Scope::Cluster, true,
    "Every spec card across all of a cluster's canvases, with its review status.",
    || cluster_schema(json!({}), &[]);

    "create_canvas" => "canvas/create", Scope::New, false,
    "Create an empty canvas. `canvas` is the new id: lowercase slug segments joined by `/`, \
     up to four deep. Fails if it already exists.",
    || cluster_schema(
        json!({
            "canvas": { "type": "string", "description": "The new canvas id, e.g. `levels/hospital-wing`." },
            "title": { "type": "string", "description": "Display title. Defaults to the last segment of the id." },
            "parent": { "type": "string", "description": "The id of an existing canvas this one belongs under." },
        }),
        &["canvas"],
    );

    "read_canvas" => "canvas/read", Scope::Canvas, true,
    "The whole Excalidraw scene as stored, with reference images inlined. Large; prefer \
     list_diagrams and describe_diagram unless you need raw elements.",
    || canvas_schema(json!({}), &[]);

    "stat_canvas" => "canvas/stat", Scope::Canvas, true,
    "Just the file's modification time, to notice that someone else changed it.",
    || canvas_schema(json!({}), &[]);

    "write_canvas" => "canvas/write", Scope::Canvas, false,
    "Replace the whole scene. Conflict-checked against `baseMtime`. A blunt tool: prefer \
     add_shapes, import_mermaid or set_values, which checkpoint and report.",
    || canvas_schema(
        json!({
            "scene": { "type": "object", "description": "A complete Excalidraw scene with an `elements` array." },
            "baseMtime": { "type": "integer", "minimum": 0, "description": "The mtime you last read; the write is refused if the file has moved." },
        }),
        &["scene"],
    );

    "save" => "canvas/save", Scope::Canvas, false,
    "Flush the open editor's pending edits to disk, then report what is on disk: path, mtime, \
     element count, diagrams and open comments. Call before reading a canvas a person may be \
     editing.",
    || canvas_schema(json!({}), &[]);

    "list_diagrams" => "canvas/list-diagrams", Scope::Canvas, true,
    "The named diagrams (frames) on a canvas, with titles, summaries, levels and parents.",
    || canvas_schema(json!({}), &[]);

    "describe_diagram" => "canvas/describe-diagram", Scope::Canvas, true,
    "One diagram in words: its elements, labels, connections and bounds.",
    || canvas_schema(
        json!({
            "diagram": { "type": "string", "description": "The diagram id, from list_diagrams. Give this or `frame`." },
            "frame": { "type": "string", "description": "Alias for `diagram`: the same id, or the frame's element id or title." },
        }),
        &[],
    );

    "view_diagram" => "canvas/view-diagram", Scope::Canvas, true,
    "Render a diagram to a PNG in the project and return its path; read the file to see it. \
     Needs a Canvas pane open somewhere, because the drawing happens in the app.",
    || canvas_schema(
        json!({
            "diagram": { "type": "string", "description": "The diagram id. Give this or `frame`." },
            "frame": { "type": "string", "description": "Alias for `diagram`: the same id, or the frame's element id or title." },
            "region": region_schema("Zoom to this frame-relative box."),
            "scale": { "type": "number", "exclusiveMinimum": 0, "description": "Pixel scale; default fits the max dimension." },
            "maxDimension": { "type": "integer", "minimum": 1, "description": "Widest or tallest side in pixels; default 2400." },
            "theme": { "type": "string", "enum": ["light", "dark"], "description": "Render in this theme." },
        }),
        &[],
    );

    "add_shapes" => "canvas/add-shapes", Scope::Canvas, false,
    "Draw a diagram: one frame and the shapes in it. `frame.id` and `frame.title` are \
     required; every shape lands inside that frame (there are no loose shapes). Shapes are \
     laid out and measured in the app, then written with a checkpoint first; the answer maps \
     your shape ids to element ids (`<frame.id>:<shape id>`; the frame itself is \
     `frame:<frame.id>`, and get_frame/set_frame take either) and lists warnings. Calling it \
     again with the same `frame.id` rebuilds that frame: its old contents are replaced \
     (`replace: false` adds instead), while its type, values and child link are kept. Colours \
     are palette names only; anything else is drawn in `ink` and warned about. Needs a Canvas \
     pane open. Call drawing_guide for the full manual.",
    || canvas_schema_open(
        json!({
            "frame": frame_spec_schema(),
            "shapes": {
                "type": "array",
                "description": "Shapes to draw. Coordinates are relative to the frame's drawing \
                                area: the frame keeps 40 px of padding and puts its title (and \
                                summary) on top, so `{x: 0, y: 0}` is just below the header, about \
                                110 px under the frame's top edge. Negative coordinates land on \
                                the header and are warned about. Boxes grow to fit their labels.",
                "items": shape_spec_schema(),
            },
            "index": { "type": "boolean", "description": "Build the index frame listing every diagram instead; no `frame` or `shapes` needed." },
            "replace": { "type": "boolean", "description": "Rebuild the frame from these shapes, dropping what was in it (default true). False adds to it." },
            "nudge": { "type": "boolean", "description": "Move overlapping text clear (default true); false only warns." },
        }),
        &[],
    );

    "import_mermaid" => "canvas/import-mermaid", Scope::Canvas, false,
    "Turn Mermaid source into shapes in a diagram frame, checkpointed. Needs a Canvas pane open.",
    || canvas_schema_open(
        json!({
            "frame": frame_spec_schema(),
            "source": { "type": "string", "description": "Mermaid text, e.g. `stateDiagram-v2 ...`." },
        }),
        &["source"],
    );

    "coverage" => "canvas/coverage", Scope::Canvas, true,
    "Which diagrams cover each concern on a checklist, which concerns no diagram covers, and \
     which diagrams declare nothing.",
    || canvas_schema(
        json!({ "checklist": { "type": "array", "items": { "type": "string" }, "description": "Concerns to check. Defaults to the canvas's own, else the game checklist." } }),
        &[],
    );

    "values" => "canvas/values", Scope::Canvas, true,
    "The linked value table and whether every text and spec field using a value agrees with it.",
    || canvas_schema(json!({}), &[]);

    "set_values" => "canvas/set-values", Scope::Canvas, false,
    "Change named values and every linked text and spec field in one checkpointed write.",
    || canvas_schema(
        json!({ "values": { "type": "object", "description": "name -> number | string | { value, unit?, spec? }. Names use letters, digits, - _ and .", "additionalProperties": true } }),
        &["values"],
    );

    "refs" => "canvas/refs", Scope::Canvas, true,
    "The reference images stored for a canvas, and which are used or missing.",
    || canvas_schema(json!({}), &[]);

    "checkpoints" => "canvas/checkpoints", Scope::Canvas, true,
    "The saved checkpoints (the last few) that restore_checkpoint can return to.",
    || canvas_schema(json!({}), &[]);

    "restore_checkpoint" => "canvas/restore-checkpoint", Scope::Canvas, false,
    "Return the canvas to a checkpoint (the newest by default), saving the current state first.",
    || canvas_schema(
        json!({ "checkpoint": { "type": "string", "description": "A name from checkpoints. Omit for the newest." } }),
        &[],
    );

    "list_comments" => "canvas/list-comments", Scope::Canvas, true,
    "Review comments on a canvas, with the diagram and elements or region each points at.",
    || canvas_schema(
        json!({
            "status": { "type": "string", "enum": ["open", "resolved", "all"], "description": "Default open." },
            "diagram": { "type": "string", "description": "Only comments on this diagram." },
        }),
        &[],
    );

    "create_comment" => "canvas/create-comment", Scope::Canvas, false,
    "Leave a review comment, authored as the agent, on a diagram's elements or a region.",
    || canvas_schema(
        json!({
            "diagram": { "type": "string", "description": "The diagram id." },
            "text": { "type": "string", "description": "The comment, up to 4000 characters." },
            "elementIds": { "type": "array", "items": { "type": "string" }, "description": "Elements on the canvas it points at." },
            "region": region_schema("Or a frame-relative box it points at."),
        }),
        &["diagram", "text"],
    );

    "resolve_comment" => "canvas/resolve-comment", Scope::Canvas, false,
    "Mark a comment resolved, with an optional note saying what was done.",
    || canvas_schema(
        json!({
            "commentId": { "type": "string", "description": "From list_comments." },
            "note": { "type": "string", "description": "What changed." },
        }),
        &["commentId"],
    );

    "reopen_comment" => "canvas/reopen-comment", Scope::Canvas, false,
    "Reopen a resolved comment.",
    || canvas_schema(
        json!({
            "commentId": { "type": "string", "description": "From list_comments." },
            "note": { "type": "string", "description": "Why it is open again." },
        }),
        &["commentId"],
    );

    "view_comment" => "canvas/view-comment", Scope::Canvas, true,
    "Render what a comment points at to a PNG and return its path, with the comment. Needs a \
     Canvas pane open.",
    || canvas_schema(
        json!({
            "commentId": { "type": "string", "description": "From list_comments." },
            "scale": { "type": "number", "exclusiveMinimum": 0, "description": "Default 2." },
            "theme": { "type": "string", "enum": ["light", "dark"] },
        }),
        &["commentId"],
    );

    "list_types" => "canvas/types", Scope::Project, true,
    "The frame types a project defines: the built-in ones plus its own, each with an id, color, \
     icon and the typed fields a frame of that type carries. Look here before create_frame or \
     set_frame so you use a type that exists.",
    || cluster_schema(json!({}), &[]);

    "list_frames" => "canvas/frames", Scope::Project, true,
    "The labelled frames: the unit of meaning on a canvas (a named, typed object such as a room, \
     a system or a character). With no `canvas` it covers the whole project, not just the \
     focused canvas. Start here, then get_frame and frame_image for detail.",
    || cluster_schema(
        json!({
            "canvas": { "type": "string", "description": "Limit to this canvas id. Omit for every canvas in the project." },
            "recursive": { "type": "boolean", "description": "With `canvas`, also include the canvases nested under it." },
        }),
        &[],
    );

    "search_frames" => "canvas/search-frames", Scope::Project, true,
    "Find frames by name or field text, optionally of one type. With no `canvas` it searches \
     the whole project. Prefer this to reading whole canvases when you know what you want.",
    || cluster_schema(
        json!({
            "query": { "type": "string", "description": "Text to match against frame names and field values." },
            "type": { "type": "string", "description": "Only frames of this type id, from list_types." },
            "canvas": { "type": "string", "description": "Limit to this canvas id. Omit to search the whole project." },
            "limit": { "type": "integer", "minimum": 1, "description": "Most results to return." },
        }),
        &[],
    );

    "get_frame" => "canvas/frame", Scope::Canvas, true,
    "One frame in full: its type and values, the type's schema, and every element inside it. \
     Pair it with frame_image to see it. `canvas` defaults to the focused canvas.",
    || canvas_schema(
        json!({ "frame": { "type": "string", "description": FRAME_HELP } }),
        &["frame"],
    );

    "frame_image" => "canvas/frame-image", Scope::Canvas, true,
    "Render just one frame to a PNG, drawn by the open Canvas app so it matches what a person \
     sees, and return the file's path and size; read the file to see it. Needs a Canvas pane \
     open somewhere. The next render of the same frame overwrites the file.",
    || canvas_schema(
        json!({
            "frame": { "type": "string", "description": FRAME_HELP },
            "scale": { "type": "number", "exclusiveMinimum": 0, "description": "Pixel scale; default fits the max dimension." },
            "maxDimension": { "type": "integer", "minimum": 1, "description": "Widest or tallest side in pixels." },
            "theme": { "type": "string", "enum": ["light", "dark"], "description": "Render in this theme." },
        }),
        &["frame"],
    );

    "canvas_tree" => "canvas/tree", Scope::Project, true,
    "The nested-canvas hierarchy of the project: roots, each canvas's children and frame \
     count, and any cycles or problems.",
    || cluster_schema(json!({}), &[]);

    "save_type" => "canvas/save-type", Scope::Project, false,
    "Create or update a custom frame type in the project. Omit `type.id` to create one (the id \
     is derived from the name).",
    || cluster_schema(
        json!({
            "type": {
                "type": "object",
                "description": "The type definition.",
                "properties": {
                    "id": { "type": "string", "description": "An existing type id to update; omit to create." },
                    "name": { "type": "string" },
                    "color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$", "description": "`#rrggbb`, e.g. `#7c5cff`." },
                    "icon": { "type": "string", "enum": crate::apps::canvas::TYPE_ICONS, "description": "One of the icons the Inspector draws." },
                    "description": { "type": "string" },
                    "fields": {
                        "type": "array",
                        "description": "The typed fields a frame of this type carries.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": { "type": "string", "description": "Lowercase slug; the key in set_frame's `values`." },
                                "label": { "type": "string" },
                                "kind": { "type": "string", "enum": crate::apps::canvas::FIELD_KINDS },
                                "options": { "type": "array", "items": { "type": "string" }, "description": "The choices; `enum` fields only, and required for them." },
                                "default": { "description": "A value of the field's kind." },
                                "help": { "type": "string" },
                            },
                            "required": ["key", "label", "kind"],
                        },
                    },
                },
                "required": ["name", "color", "icon", "fields"],
            },
        }),
        &["type"],
    );

    "delete_type" => "canvas/delete-type", Scope::Project, false,
    "Delete a custom frame type by id. Built-in types cannot be deleted.",
    || cluster_schema(
        json!({ "id": { "type": "string", "description": "The type id, from list_types." } }),
        &["id"],
    );

    "set_parent" => "canvas/set-parent", Scope::Canvas, false,
    "Nest a canvas under another, or make it a root. `canvas` is the canvas being moved and is \
     required: it never defaults to the focused one.",
    || canvas_schema(
        json!({ "parent": { "type": ["string", "null"], "description": "The parent canvas id, or null to make this canvas a root." } }),
        &["canvas", "parent"],
    );

    "link_frame" => "canvas/link-frame", Scope::Canvas, false,
    "Make a frame open an EXISTING canvas as its child (double-click, or the ↳ badge on \
     the frame), or unlink it with `child: null`. This is how a frame gets a `childCanvas`: \
     set_frame cannot, and set_parent only nests canvases. Sets the child's parent too, so \
     canvas_tree and the breadcrumb agree. Refused for the canvas itself, an ancestor (a \
     loop), or a canvas already nested elsewhere unless `reparent` is true. `canvas` is the \
     canvas holding the frame and is required.",
    || canvas_schema(
        json!({
            "frame": { "type": "string", "description": FRAME_HELP },
            "child": { "type": ["string", "null"], "description": "The canvas id to open from the frame, or null to unlink." },
            "reparent": { "type": "boolean", "description": "Move the child here if it is nested under another canvas (default false)." },
        }),
        &["canvas", "frame", "child"],
    );

    "set_frame" => "canvas/set-frame", Scope::Canvas, false,
    "Rename a frame, change its type, or set its field values. `canvas` defaults to the \
     focused canvas.",
    || canvas_schema(
        json!({
            "frame": { "type": "string", "description": FRAME_HELP },
            "name": { "type": "string", "description": "A new name." },
            "type": { "type": "string", "description": "A type id from list_types." },
            "values": { "type": "object", "description": "field id -> value, per the type's schema.", "additionalProperties": true },
        }),
        &["frame"],
    );

    "create_frame" => "canvas/create-frame", Scope::Canvas, false,
    "Make a labelled, typed frame (a named object): either around existing elements given by \
     `elementIds` (they and their bound labels move into it), or empty at a `bbox` to draw \
     into. An element belongs to one frame, so elements already inside another frame are \
     refused, naming that frame; pass `move: true` to take them anyway, which leaves a gap \
     in the old frame. To draw a new picture, use add_shapes instead. `canvas` defaults to \
     the focused canvas.",
    || canvas_schema(
        json!({
            "name": { "type": "string", "description": "The frame's name." },
            "type": { "type": "string", "description": "A type id from list_types." },
            "values": { "type": "object", "description": "field id -> value, per the type's schema. A child canvas is not a value: use link_frame.", "additionalProperties": true },
            "elementIds": { "type": "array", "items": { "type": "string" }, "description": "The elements to group." },
            "bbox": region_schema("Or: an empty frame at this scene-coordinate box."),
            "move": { "type": "boolean", "description": "Take elements out of the frame they are in now. The result's `movedFrom` lists them." },
        }),
        &["name"],
    );
}

/// How every frame tool names a frame.
const FRAME_HELP: &str = "The frame: its element id (`frame:board-title`), its diagram id \
    (`board-title`, as add_shapes was given it) or its exact name, case-insensitive.";

/// The manuals `drawing_guide` serves. Compiled in, so an agent that only has these
/// tools can read them; the files stay the single source.
const DRAWING_GUIDE: &str = include_str!("../../../../docs/canvas-drawing-guide.md");
const FRAMES_GUIDE: &str = include_str!("../../../../docs/canvas-objects.md");

/// The `drawing_guide` answer.
///
/// `design` is the brief for the canvas asked about ([`style::brief`]): the drawing
/// manual and the style topic end with its guidance, so an agent that reads only
/// the guide still draws at the level and in the style the person chose.
pub(super) fn guide(args: &Map<String, Value>, design: &Value) -> Result<Value, RpcError> {
    let design_text = design["text"].as_str().unwrap_or_default();
    let (topic, path, text) = match args.get("topic").and_then(Value::as_str) {
        None | Some("drawing") => (
            "drawing",
            "docs/canvas-drawing-guide.md",
            format!("{DRAWING_GUIDE}\n{design_text}"),
        ),
        Some("frames") => ("frames", "docs/canvas-objects.md", FRAMES_GUIDE.to_string()),
        Some("style") => (
            "style",
            "src-tauri/src/apps/canvas/style.rs",
            format!("{}{design_text}", style::catalog_text()),
        ),
        Some(other) => {
            return Err(bad(format!(
                "no guide on `{other}`; the topics are drawing, frames and style"
            )))
        }
    };
    let mut out = json!({ "topic": topic, "source": path, "text": text });
    if topic != "frames" {
        out["design"] = json!({ "detail": design["detail"]["id"], "style": design["style"]["id"] });
    }
    Ok(out)
}

/// The brief a guide ends with: the focused (or named) canvas's, with its override,
/// and the settings alone when no canvas can be resolved. A guide must still answer
/// with no canvas open, so nothing here is an error.
fn guide_design(app: &AppHandle, args: &Map<String, Value>) -> Value {
    let setting = |key| Some(crate::settings::text(app, key)).filter(|s| !s.is_empty());
    let fallback = || {
        style::brief(&style::resolve(
            None,
            None,
            setting(style::KEY_DETAIL).as_deref(),
            setting(style::KEY_STYLE).as_deref(),
        ))
    };
    let Ok(target) = Target::from_args(args) else {
        return fallback();
    };
    let snapshot = app.state::<ShellState>().snapshot();
    let pages = workspace::page_contexts(app);
    let all = workspace::surfaces(&snapshot, &pages);
    let active = workspace::active_cluster(&snapshot, &pages).map(|(_, cluster)| cluster);
    let Ok(resolved) = resolve_canvas(&target, &all, active.as_deref()) else {
        return fallback();
    };
    let context = CallContext::resolve(app, None, Some(&resolved.cluster));
    let params = method_params(args, resolved.canvas.as_deref(), "canvas/design-brief");
    apps::call(app, &context, "canvas", "canvas/design-brief", Some(params))
        .ok()
        .filter(|brief| brief["text"].is_string())
        .unwrap_or_else(fallback)
}

/// The palette names `add_shapes` draws with. Mirrors `PALETTE` in
/// `apps/canvas/ui/src/draw.ts`; a test holds the two together.
pub(crate) const PALETTE: &[&str] = &[
    "ink", "muted", "red", "green", "blue", "orange", "violet", "teal",
];

/// The diagram frame of `add_shapes` and `import_mermaid`.
fn frame_spec_schema() -> Value {
    json!({
        "type": "object",
        "description": "The diagram frame. Created, or rebuilt when a frame with this id exists.",
        "properties": {
            "id": {
                "type": "string",
                "pattern": "^[a-z0-9][a-z0-9-]{0,63}$",
                "description": "Required. Lowercase letters, digits and -, e.g. `flap-timing`. Stable: \
                                comments, links and rebuilds find the frame by it.",
            },
            "title": { "type": "string", "description": "Required. The heading drawn at the top of the frame." },
            "summary": { "type": "string", "description": "One line under the title: what the diagram shows." },
            "level": { "type": "string", "enum": ["overview", "subsystem", "detail"] },
            "parent": { "type": "string", "description": "The id of the diagram this one details." },
            "covers": { "type": "array", "items": { "type": "string" }, "description": "Checklist topics it covers, for coverage." },
            "x": { "type": "number", "description": "Scene position of the frame's top-left. Default: where it already is, else right of the other frames." },
            "y": { "type": "number" },
            "width": { "type": "number", "description": "Fixed size. Default: fit the content. Too small is warned about and clips." },
            "height": { "type": "number" },
        },
        "required": ["id", "title"],
    })
}

/// One shape of `add_shapes`. Left open (`additionalProperties`) so the layout's
/// own checks, which say what is wrong in words, stay the authority.
fn shape_spec_schema() -> Value {
    let mut fills: Vec<&str> = PALETTE.to_vec();
    fills.extend(["solid", "none"]);
    let head = json!({ "type": "string", "enum": ["arrow", "triangle", "dot", "bar", "none"] });
    let point =
        json!({ "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 });
    let end = json!({ "description": "A shape id in this call, or a point [x, y].", "anyOf": [{ "type": "string" }, point] });
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Letters, digits, - and _. Unique in this call." },
            "type": { "type": "string", "enum": ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "image"] },
            "x": { "type": "number" }, "y": { "type": "number" },
            "width": { "type": "number", "description": "Give only when size means something; boxes otherwise fit their label." },
            "height": { "type": "number" },
            "label": { "type": "string", "description": "Text inside a shape, or on an arrow. `{{name}}` fills from set_values." },
            "text": { "type": "string", "description": "A text element's text." },
            "size": { "type": "string", "enum": ["title", "heading", "body", "small"], "description": "28, 20, 16 or 14 px. Default body (small on arrows)." },
            "color": { "description": "Stroke and text colour. Default ink.", "type": "string", "enum": PALETTE },
            "fill": {
                "type": "string",
                "enum": fills,
                "description": "A palette name fills with its light shade, `solid` with the stroke colour, \
                                `none` leaves it empty. Works on rectangle, ellipse, diamond, and on a \
                                `line` with 3 or more `points` (closed into a polygon for you).",
            },
            "dashed": { "type": "boolean" },
            "strokeWidth": { "type": "number" },
            "rounded": { "type": "boolean", "description": "Rectangles are rounded unless false." },
            "align": { "type": "string", "enum": ["left", "center", "right"], "description": "Text: which edge `x` names." },
            "valign": { "type": "string", "enum": ["top", "middle", "bottom"], "description": "Text: which edge `y` names." },
            "maxWidth": { "type": "number", "description": "Text: wrap to this width." },
            "from": end.clone(),
            "to": end,
            "points": { "type": "array", "items": point, "description": "Arrow/line: every point, in drawing-area coordinates." },
            "curved": { "type": "boolean" },
            "head": head.clone(),
            "tail": head,
            "ref": { "type": "string", "description": "Image: `refs/<file>`, a reference image of this canvas (see refs)." },
            "fixed": { "type": "boolean", "description": "Never move this text to clear an overlap." },
            "link": { "type": "string", "description": "Opened on click; `kaava://diagram/<id>` moves to that diagram." },
        },
        "required": ["id", "type"],
    })
}

fn region_schema(about: &str) -> Value {
    json!({
        "type": "object",
        "description": about,
        "properties": {
            "x": { "type": "number" }, "y": { "type": "number" },
            "width": { "type": "number" }, "height": { "type": "number" },
        },
        "required": ["x", "y", "width", "height"],
    })
}

fn obj(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn extend(base: Value, extra: Value) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Value::Object(more) = extra {
        merged.extend(more);
    }
    Value::Object(merged)
}

const CLUSTER_HELP: &str = "A cluster id from the workspace server's `layout`. Defaults to the \
    focused pane's cluster, else the active one.";

fn cluster_schema(properties: Value, required: &[&str]) -> Value {
    obj(
        extend(
            properties,
            json!({
                "cluster": { "type": "string", "description": CLUSTER_HELP },
                "instance": { "type": "string", "description": "A pane instance id (from list_canvases); its cluster is used." },
            }),
        ),
        required,
    )
}

fn canvas_schema(properties: Value, required: &[&str]) -> Value {
    obj(
        extend(
            properties,
            json!({
                "canvas": {
                    "type": "string",
                    "description": "Canvas id: the file under canvas/ without `.json`, e.g. `levels/hospital-wing`. Omit to act on the focused canvas (or the only one open); the result's `resolved` block says which.",
                },
                "instance": {
                    "type": "string",
                    "description": "A Canvas pane's instance id from list_canvases, e.g. `canvas-2`. Selects the canvas it shows and its cluster.",
                },
                "cluster": {
                    "type": "string",
                    "description": "Only needed when the same canvas id exists in two clusters. Defaults to where the canvas is open, else the active cluster.",
                },
            }),
        ),
        required,
    )
}

/// [`canvas_schema`] for tools whose spec carries options the schema does not list.
fn canvas_schema_open(properties: Value, required: &[&str]) -> Value {
    let mut schema = canvas_schema(properties, required);
    schema["additionalProperties"] = json!(true);
    schema
}

/// How the caller named its target. Every field is optional.
#[derive(Debug, Default, Clone, PartialEq)]
pub(super) struct Target {
    pub canvas: Option<String>,
    pub instance: Option<String>,
    pub cluster: Option<String>,
}

impl Target {
    fn from_args(args: &Map<String, Value>) -> Result<Self, RpcError> {
        let text = |key: &str| match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
            Some(_) => Err(bad(format!("`{key}` must be a non-empty string"))),
        };
        Ok(Self {
            canvas: text("canvas")?,
            instance: text("instance")?,
            cluster: text("cluster")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Resolved {
    pub canvas: Option<String>,
    pub instance: Option<String>,
    pub cluster: String,
    /// `instance`, `explicit`, `focused`, `only-open`, `active-cluster`.
    pub how: &'static str,
}

impl Resolved {
    fn to_json(&self) -> Value {
        let note = match self.how {
            "focused" => "No canvas was named, so the focused canvas was used.",
            "only-open" => "No canvas was named and none has focus; it is the only one open.",
            "active-cluster" => "No cluster was named, so the active cluster was used.",
            "focused-cluster" => "No cluster was named, so the focused pane's cluster was used.",
            _ => "As named.",
        };
        json!({
            "canvas": self.canvas,
            "instance": self.instance,
            "cluster": self.cluster,
            "how": self.how,
            "note": note,
        })
    }
}

fn bad(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message)
}

fn open_json(open: &[&Surface]) -> Vec<Value> {
    open.iter()
        .map(|s| {
            json!({
                "instance": s.instance, "canvas": s.file(), "cluster": s.cluster,
                "focused": s.focused, "visible": s.visible,
            })
        })
        .collect()
}

fn listing(open: &[&Surface]) -> String {
    if open.is_empty() {
        return "none is open".to_string();
    }
    open.iter()
        .map(|s| {
            format!(
                "`{}` ({} in {})",
                s.instance,
                s.file().unwrap_or_else(|| "no file".to_string()),
                s.cluster
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn ambiguous(what: &str, open: &[&Surface]) -> RpcError {
    RpcError::with_data(
        INVALID_PARAMS,
        format!(
            "{what}, and more than one canvas is open: {}. Pass `canvas` (and `cluster` if the id \
             repeats) or `instance`. A pane listed as `no file` is in a cluster that is not on \
             screen and does not report its canvas.",
            listing(open)
        ),
        json!({ "kind": "ambiguous-canvas", "open": open_json(open) }),
    )
}

fn canvases(all: &[Surface]) -> Vec<&Surface> {
    all.iter().filter(|s| s.app == "canvas").collect()
}

/// Turn a [`Target`] into one canvas in one cluster, or say why not.
///
/// Pure, over the open surfaces and the active cluster id, so every branch is
/// tested without an app.
pub(super) fn resolve_canvas(
    target: &Target,
    all: &[Surface],
    active: Option<&str>,
) -> Result<Resolved, RpcError> {
    let open = canvases(all);

    if let Some(instance) = &target.instance {
        let surface = open
            .iter()
            .find(|s| &s.instance == instance)
            .ok_or_else(|| {
                RpcError::with_data(
                    INVALID_PARAMS,
                    format!(
                        "`{instance}` is not an open Canvas pane; open canvases: {}",
                        listing(&open)
                    ),
                    json!({ "kind": "no-such-instance", "open": open_json(&open) }),
                )
            })?;
        if target
            .cluster
            .as_deref()
            .is_some_and(|c| c != surface.cluster)
        {
            return Err(bad(format!(
                "`{instance}` is in cluster `{}`, not `{}`",
                surface.cluster,
                target.cluster.as_deref().unwrap_or_default()
            )));
        }
        let canvas = target
            .canvas
            .clone()
            .or_else(|| surface.file())
            .ok_or_else(|| {
                bad(format!(
                    "`{instance}` has no canvas open yet; pass `canvas` to name one"
                ))
            })?;
        return Ok(Resolved {
            canvas: Some(canvas),
            instance: Some(surface.instance.clone()),
            cluster: surface.cluster.clone(),
            how: "instance",
        });
    }

    if let Some(canvas) = &target.canvas {
        let showing: Vec<&&Surface> = open
            .iter()
            .filter(|s| s.file().as_deref() == Some(canvas.as_str()))
            .filter(|s| target.cluster.as_deref().is_none_or(|c| c == s.cluster))
            .collect();
        let mut clusters: Vec<&str> = showing.iter().map(|s| s.cluster.as_str()).collect();
        clusters.sort_unstable();
        clusters.dedup();

        let cluster = match (&target.cluster, clusters.as_slice()) {
            (Some(c), _) => c.clone(),
            (None, [one]) => (*one).to_string(),
            (None, []) => active
                .map(str::to_owned)
                .ok_or_else(|| bad("no cluster is active to look for that canvas in"))?,
            (None, _) => {
                let both: Vec<&Surface> = showing.iter().map(|s| **s).collect();
                return Err(ambiguous(
                    &format!(
                        "canvas `{canvas}` is open in clusters {}",
                        clusters.join(", ")
                    ),
                    &both,
                ));
            }
        };
        let pick = showing
            .iter()
            .find(|s| s.focused && s.cluster == cluster)
            .or_else(|| showing.iter().find(|s| s.cluster == cluster));
        return Ok(Resolved {
            canvas: Some(canvas.clone()),
            instance: pick.map(|s| s.instance.clone()),
            cluster,
            how: "explicit",
        });
    }

    if let Some(s) = open.iter().find(|s| s.focused && s.file().is_some()) {
        return Ok(Resolved {
            canvas: s.file(),
            instance: Some(s.instance.clone()),
            cluster: s.cluster.clone(),
            how: "focused",
        });
    }

    let with_file: Vec<&Surface> = open
        .iter()
        .copied()
        .filter(|s| s.file().is_some())
        .collect();
    // A Canvas pane only says which canvas it shows while its page is mounted, so one in
    // a cluster that is not on screen has no file here. It still counts: it may be the
    // canvas the caller means, and "the only one open" would be a guess.
    let unknown = open.len() - with_file.len();
    match with_file.as_slice() {
        [only] if unknown == 0 => Ok(Resolved {
            canvas: only.file(),
            instance: Some(only.instance.clone()),
            cluster: only.cluster.clone(),
            how: "only-open",
        }),
        [] if unknown == 0 => Err(RpcError::with_data(
            INVALID_PARAMS,
            "no canvas was named and none is open. Pass `canvas` (see list_files), or open one \
             with the agent server's open_app or ask the person to.",
            json!({ "kind": "no-canvas" }),
        )),
        [] => Err(RpcError::with_data(
            INVALID_PARAMS,
            format!(
                "no canvas was named, and the open Canvas pane(s) do not say which canvas they \
                 show ({}): a pane only reports it while its cluster is on screen. Pass `canvas` \
                 (see list_files), or switch to that cluster.",
                listing(&open)
            ),
            json!({ "kind": "canvas-unknown", "open": open_json(&open) }),
        )),
        _ => Err(ambiguous("no canvas was named and none has focus", &open)),
    }
}

/// Turn a [`Target`] into a cluster, for the tools that name no existing canvas.
pub(super) fn resolve_cluster(
    target: &Target,
    all: &[Surface],
    active: Option<&str>,
) -> Result<Resolved, RpcError> {
    let done = |cluster: String, instance: Option<String>, how| {
        Ok(Resolved {
            canvas: target.canvas.clone(),
            instance,
            cluster,
            how,
        })
    };
    if let Some(cluster) = &target.cluster {
        return done(cluster.clone(), None, "explicit");
    }
    if let Some(instance) = &target.instance {
        let surface = all
            .iter()
            .find(|s| &s.instance == instance)
            .ok_or_else(|| {
                bad(format!(
                    "`{instance}` is not an open pane; see list_canvases"
                ))
            })?;
        return done(
            surface.cluster.clone(),
            Some(surface.instance.clone()),
            "instance",
        );
    }
    if let Some(s) = all.iter().find(|s| s.focused) {
        return done(s.cluster.clone(), None, "focused-cluster");
    }
    match active {
        Some(cluster) => done(cluster.to_string(), None, "active-cluster"),
        None => Err(RpcError::new(
            INTERNAL_ERROR,
            "there is no cluster to work in; name one with `cluster`",
        )),
    }
}

/// The `list_canvases` answer.
pub(super) fn list_open(all: &[Surface], active: Option<&str>) -> Value {
    let open = canvases(all);
    let rows: Vec<Value> = open
        .iter()
        .map(|s| {
            json!({
                "instance": s.instance,
                "canvas": s.file(),
                "canvasKnown": s.file().is_some(),
                "title": s.title,
                "cluster": s.cluster,
                "window": s.window,
                "pane": s.pane,
                "focused": s.focused,
                "visible": s.visible,
                "activeTab": s.active_tab,
                "selection": s.report.as_ref().map(|r| json!({
                    "elementIds": r.get("elementIds"),
                    "diagram": r.get("diagram"),
                })),
            })
        })
        .collect();
    let default = match resolve_canvas(&Target::default(), all, active) {
        Ok(r) => {
            json!({ "canvas": r.canvas, "instance": r.instance, "cluster": r.cluster, "how": r.how })
        }
        Err(e) => json!({ "error": e.message }),
    };
    let unknown = open.iter().filter(|s| s.file().is_none()).count();
    json!({
        "count": rows.len(),
        "canvases": rows,
        "ifNoCanvasIsNamed": default,
        "note": (unknown > 0).then(|| format!(
            "{unknown} pane(s) show `canvas: null`: a Canvas pane reports its canvas only while \
             its cluster is on screen, so one in another cluster cannot be identified here. \
             Name `canvas` explicitly, or switch to that cluster."
        )),
    })
}

/// The frame methods read the canvas as `canvas`; every older method as `id`.
fn canvas_key(method: &str) -> &'static str {
    match method {
        "canvas/frame"
        | "canvas/frame-image"
        | "canvas/set-frame"
        | "canvas/create-frame"
        | "canvas/link-frame" => "canvas",
        _ => "id",
    }
}

/// The params an app method gets: the caller's own, minus how it named the target, plus the
/// agent actor and the resolved canvas, which goes in as `canvas` or `id` as the method wants.
///
/// With no canvas resolved (project-wide tools) the
/// caller's own `canvas` and `id` are real parameters of the method and pass
/// through.
fn method_params(args: &Map<String, Value>, id: Option<&str>, method: &str) -> Value {
    let mut params = args.clone();
    for key in ["instance", "cluster", "actor"] {
        params.remove(key);
    }
    if let Some(id) = id {
        params.remove("canvas");
        params.remove("id");
        params.insert(canvas_key(method).into(), json!(id));
    }
    params.insert("actor".into(), json!("agent"));
    Value::Object(params)
}

fn annotate(result: Value, resolved: &Resolved) -> Value {
    match result {
        Value::Object(mut map) => {
            map.insert("resolved".into(), resolved.to_json());
            Value::Object(map)
        }
        other => json!({ "result": other, "resolved": resolved.to_json() }),
    }
}

/// Tools that restructure the project and so must be told which canvas: the schema marks
/// `canvas` required, but a schema is advice a client may ignore, so the server checks.
/// Without this an omitted `canvas` resolved to the focused one and moved *that*.
const NAMED_CANVAS_ONLY: &[&str] = &["set_parent", "link_frame"];

/// Refuse a [`NAMED_CANVAS_ONLY`] tool that was not given `canvas` itself. An `instance`
/// does not stand in for it, and neither does focus.
pub(super) fn require_named_canvas(tool: &str, target: &Target) -> Result<(), RpcError> {
    if NAMED_CANVAS_ONLY.contains(&tool) && target.canvas.is_none() {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!(
                "`{tool}` requires `canvas`: it changes how that canvas is nested and never \
                 defaults to the focused one or to an `instance`'s. Pass the canvas id (see \
                 list_files)."
            ),
            json!({ "kind": "canvas-required", "tool": tool }),
        ));
    }
    Ok(())
}

fn needs_page(route: &Route, target: &Target) -> bool {
    match route.scope {
        Scope::Guide => false,
        Scope::Open => true,
        Scope::Canvas => {
            !(target.canvas.is_some() && (target.instance.is_some() || target.cluster.is_some()))
        }
        Scope::Cluster | Scope::New | Scope::Project => {
            target.cluster.is_none() && target.instance.is_none()
        }
    }
}

fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    let route = ROUTES.iter().find(|r| r.tool == tool).ok_or_else(|| {
        RpcError::new(
            METHOD_NOT_FOUND,
            format!("the canvas server has no tool named `{tool}`"),
        )
    })?;
    let args = match params {
        Some(Value::Object(map)) => map,
        None | Some(Value::Null) => Map::new(),
        Some(_) => return Err(bad("arguments must be an object")),
    };
    if route.scope == Scope::Guide {
        return Ok(guide(&args, &guide_design(app, &args))?.into());
    }
    let target = Target::from_args(&args)?;
    require_named_canvas(tool, &target)?;

    let snapshot = app.state::<ShellState>().snapshot();
    let pages = if needs_page(route, &target) {
        workspace::page_contexts(app)
    } else {
        Pages::default()
    };
    let all = workspace::surfaces(&snapshot, &pages);
    let active = workspace::active_cluster(&snapshot, &pages).map(|(_, cluster)| cluster);

    let (resolved, id) = match route.scope {
        Scope::Guide => unreachable!("answered above"),
        Scope::Open => return Ok(list_open(&all, active.as_deref()).into()),
        Scope::Canvas => {
            let r = resolve_canvas(&target, &all, active.as_deref())?;
            let id = r.canvas.clone();
            (r, id)
        }
        Scope::New => {
            let id = target
                .canvas
                .clone()
                .ok_or_else(|| bad("`canvas` is required: the id of the new canvas"))?;
            (resolve_cluster(&target, &all, active.as_deref())?, Some(id))
        }
        Scope::Cluster | Scope::Project => {
            (resolve_cluster(&target, &all, active.as_deref())?, None)
        }
    };

    let context = CallContext::resolve(app, None, Some(&resolved.cluster));
    let answer = apps::call(
        app,
        &context,
        "canvas",
        route.method,
        Some(method_params(&args, id.as_deref(), route.method)),
    )?;
    Ok(annotate(answer, &resolved).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::servers::workspace::fixtures::*;

    fn open(pages: Pages) -> Vec<Surface> {
        workspace::surfaces(&snapshot(), &pages)
    }

    fn surfaces_with_focus(focus: Option<&str>) -> Vec<Surface> {
        open(pages(page(focus.is_some(), focus, "app")))
    }

    fn target(canvas: Option<&str>, instance: Option<&str>, cluster: Option<&str>) -> Target {
        Target {
            canvas: canvas.map(str::to_owned),
            instance: instance.map(str::to_owned),
            cluster: cluster.map(str::to_owned),
        }
    }

    #[test]
    fn the_server_is_ordinary_and_lists_its_tools() {
        assert!(!SERVER.dev_only, "canvas ships to everyone");
        assert_eq!(TOOLS.len(), ROUTES.len());
        for (tool, route) in TOOLS.iter().zip(ROUTES) {
            assert_eq!(tool.name, route.tool);
        }
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        for expected in [
            "list_canvases",
            "list_files",
            "read_canvas",
            "view_diagram",
            "add_shapes",
            "import_mermaid",
            "set_values",
            "design_brief",
            "set_design",
            "create_comment",
            "restore_checkpoint",
        ] {
            assert!(names.contains(&expected), "missing {expected}");
        }
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "a tool is listed twice");
    }

    #[test]
    fn every_tool_is_hinted_and_every_schema_is_an_object_schema() {
        for tool in TOOLS {
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert!(schema["properties"].is_object(), "{}", tool.name);
            assert!(!tool.description.trim().is_empty(), "{}", tool.name);
            assert!(read_only(tool.name).is_some(), "{}", tool.name);
            assert!(
                schema["properties"].get("actor").is_none(),
                "{} lets a client choose the actor",
                tool.name
            );
            for required in schema["required"].as_array().unwrap() {
                let name = required.as_str().unwrap();
                assert!(
                    schema["properties"].get(name).is_some(),
                    "{}: {name}",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn canvas_tools_take_an_explicit_canvas_instance_and_cluster() {
        for route in ROUTES
            .iter()
            .filter(|r| r.scope == Scope::Canvas && !["set_parent", "link_frame"].contains(&r.tool))
        {
            let tool = TOOLS.iter().find(|t| t.name == route.tool).unwrap();
            let schema = (tool.schema)();
            for key in ["canvas", "instance", "cluster"] {
                assert!(
                    schema["properties"].get(key).is_some(),
                    "{}: {key}",
                    route.tool
                );
            }
            assert!(
                !schema["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("canvas")),
                "{}: canvas must stay optional so the focused one can default",
                route.tool
            );
        }
    }

    /// Every row has to name a method the app really dispatches. The pure
    /// canvas entry point answers `METHOD_NOT_FOUND` for one it does not know,
    /// and anything else (no project, bad params) for one it does.
    #[test]
    fn every_route_names_a_method_the_canvas_app_dispatches() {
        for route in ROUTES
            .iter()
            .filter(|r| r.scope != Scope::Open && r.scope != Scope::Guide)
        {
            let context = CallContext {
                cluster_id: None,
                project: None,
            };
            let err = crate::apps::canvas::call(&context, false, route.method, None)
                .expect_err("no project, so it must fail");
            assert_ne!(
                err.code, METHOD_NOT_FOUND,
                "{} -> {}",
                route.tool, route.method
            );
        }
    }

    #[test]
    fn the_frame_tools_are_listed_with_the_right_read_only_hints() {
        let expected = [
            ("list_types", true),
            ("list_frames", true),
            ("search_frames", true),
            ("get_frame", true),
            ("frame_image", true),
            ("canvas_tree", true),
            ("save_type", false),
            ("delete_type", false),
            ("set_parent", false),
            ("link_frame", false),
            ("set_frame", false),
            ("create_frame", false),
        ];
        for (tool, ro) in expected {
            assert!(TOOLS.iter().any(|t| t.name == tool), "missing {tool}");
            assert_eq!(read_only(tool), Some(ro), "{tool}");
        }
    }

    #[test]
    fn project_wide_tools_never_default_to_the_focused_canvas() {
        for tool in ["list_types", "list_frames", "search_frames", "canvas_tree"] {
            let route = ROUTES.iter().find(|r| r.tool == tool).unwrap();
            assert_eq!(route.scope, Scope::Project, "{tool}");
        }
        for tool in ["get_frame", "frame_image", "set_frame", "create_frame"] {
            let route = ROUTES.iter().find(|r| r.tool == tool).unwrap();
            assert_eq!(route.scope, Scope::Canvas, "{tool}");
        }
        let args: Map<String, Value> = serde_json::from_value(json!({
            "query": "door", "canvas": "world", "cluster": "c", "actor": "human",
        }))
        .unwrap();
        let params = method_params(&args, None, "canvas/search-frames");
        assert_eq!(params["canvas"], "world", "the filter passes through");
        assert_eq!(params["actor"], "agent");
        assert!(params.get("cluster").is_none());
        let none: Map<String, Value> = Map::new();
        assert!(method_params(&none, None, "canvas/frames")
            .get("canvas")
            .is_none());
        let del: Map<String, Value> = serde_json::from_value(json!({ "id": "room" })).unwrap();
        assert_eq!(
            method_params(&del, None, "canvas/delete-type")["id"],
            "room"
        );
    }

    #[test]
    fn per_canvas_frame_tools_resolve_a_canvas_and_send_it_as_canvas() {
        let all = surfaces_with_focus(Some("canvas-2"));
        let r = resolve_canvas(&Target::default(), &all, Some("cluster-1")).unwrap();
        assert_eq!(r.how, "focused");
        let args: Map<String, Value> = serde_json::from_value(json!({ "frame": "Lobby" })).unwrap();
        let params = method_params(&args, r.canvas.as_deref(), "canvas/frame");
        assert_eq!(params["canvas"], "levels/two");
        assert!(params.get("id").is_none());
        let moved = method_params(&args, Some("levels/one"), "canvas/set-parent");
        assert_eq!(moved["id"], "levels/one");
        let ambiguous = resolve_canvas(&Target::default(), &surfaces_with_focus(None), None);
        assert!(ambiguous.is_err());
    }

    #[test]
    fn an_explicit_canvas_is_used_as_named() {
        let all = surfaces_with_focus(Some("canvas-2"));
        let r = resolve_canvas(
            &target(Some("levels/one"), None, None),
            &all,
            Some("cluster-1"),
        )
        .unwrap();
        assert_eq!(r.canvas.as_deref(), Some("levels/one"));
        assert_eq!(r.instance.as_deref(), Some("canvas-1"));
        assert_eq!(r.cluster, "cluster-1");
        assert_eq!(r.how, "explicit");
    }

    /// The drawing tools resolve like every other per-canvas tool: the canvas the agent
    /// named wins over the focused one, and the app method gets that canvas as `id`.
    #[test]
    fn view_diagram_and_add_shapes_target_the_named_canvas_not_the_focused_one() {
        let all = surfaces_with_focus(Some("canvas-2"));
        for tool in [
            "view_diagram",
            "add_shapes",
            "import_mermaid",
            "view_comment",
        ] {
            let route = ROUTES.iter().find(|r| r.tool == tool).unwrap();
            assert_eq!(route.scope, Scope::Canvas, "{tool}");
            let named = resolve_canvas(
                &target(Some("levels/one"), None, None),
                &all,
                Some("cluster-1"),
            )
            .unwrap();
            assert_eq!(named.canvas.as_deref(), Some("levels/one"), "{tool}");
            assert_eq!(named.how, "explicit", "{tool}");
            let args: Map<String, Value> =
                serde_json::from_value(json!({ "canvas": "levels/one", "diagram": "d" })).unwrap();
            let params = method_params(&args, named.canvas.as_deref(), route.method);
            assert_eq!(params["id"], "levels/one", "{tool}");
            assert!(params.get("canvas").is_none(), "{tool}");
        }
        let by_pane = resolve_canvas(&target(None, Some("canvas-1"), None), &all, None).unwrap();
        assert_eq!(by_pane.canvas.as_deref(), Some("levels/one"));
    }

    /// `link_frame` sends the canvas as `canvas`, requires it, and never defaults it.
    #[test]
    fn link_frame_requires_its_canvas_frame_and_child() {
        let tool = TOOLS.iter().find(|t| t.name == "link_frame").unwrap();
        let schema = (tool.schema)();
        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(required, ["canvas", "frame", "child"]);
        let args: Map<String, Value> = serde_json::from_value(
            json!({ "canvas": "levels/one", "frame": "Lobby", "child": null }),
        )
        .unwrap();
        let params = method_params(&args, Some("levels/one"), "canvas/link-frame");
        assert_eq!(params["canvas"], "levels/one");
        assert!(params.get("id").is_none());
        assert_eq!(params["child"], Value::Null);
    }

    #[test]
    fn an_instance_selects_its_canvas_and_cluster() {
        let all = surfaces_with_focus(None);
        let r = resolve_canvas(
            &target(None, Some("canvas-2"), None),
            &all,
            Some("cluster-1"),
        )
        .unwrap();
        assert_eq!(r.canvas.as_deref(), Some("levels/two"));
        assert_eq!(r.how, "instance");
        let err = resolve_canvas(&target(None, Some("canvas-9"), None), &all, None).unwrap_err();
        assert!(err.message.contains("canvas-1"), "{}", err.message);
    }

    #[test]
    fn an_omitted_canvas_defaults_to_the_focused_one_and_says_so() {
        let all = surfaces_with_focus(Some("canvas-2"));
        let r = resolve_canvas(&Target::default(), &all, Some("cluster-1")).unwrap();
        assert_eq!(r.canvas.as_deref(), Some("levels/two"));
        assert_eq!(r.how, "focused");
        let annotated = annotate(json!({ "ok": true }), &r);
        assert_eq!(annotated["resolved"]["how"], "focused");
        assert!(annotated["resolved"]["note"]
            .as_str()
            .unwrap()
            .contains("focused"));
    }

    #[test]
    fn two_open_canvases_and_no_focus_is_ambiguous_and_lists_both() {
        let all = surfaces_with_focus(None);
        let err = resolve_canvas(&Target::default(), &all, Some("cluster-1")).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("levels/one") && err.message.contains("levels/two"));
        assert_eq!(err.data.unwrap()["kind"], "ambiguous-canvas");
    }

    /// With focus in a terminal and one canvas open, the one canvas is the answer.
    #[test]
    fn a_single_open_canvas_is_the_default_when_nothing_is_focused() {
        let mut all = surfaces_with_focus(None);
        all.retain(|s| s.instance != "canvas-2" && s.instance != "canvas-3");
        let r = resolve_canvas(&Target::default(), &all, Some("cluster-1")).unwrap();
        assert_eq!(r.how, "only-open");
        assert_eq!(r.canvas.as_deref(), Some("levels/one"));
    }

    /// A pane in an inactive cluster has no page mounted, so it reports no canvas
    /// (`canvas-3` in the fixture). It must still count: with it present, "the only canvas
    /// open" is a guess, and the ambiguity path has to be the one taken.
    #[test]
    fn an_unidentified_pane_in_an_inactive_cluster_makes_the_default_ambiguous() {
        let mut all = surfaces_with_focus(None);
        all.retain(|s| s.instance != "canvas-2");
        let hidden = all.iter().find(|s| s.instance == "canvas-3").unwrap();
        assert_eq!(
            hidden.file(),
            None,
            "the fixture's inactive pane reports nothing"
        );
        let err = resolve_canvas(&Target::default(), &all, Some("cluster-1")).unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "ambiguous-canvas");
        assert!(err.message.contains("canvas-3"), "{}", err.message);
        assert!(err.message.contains("no file"), "{}", err.message);
        // Naming the canvas still works and does not need the hidden pane to answer.
        let named = resolve_canvas(
            &target(Some("levels/one"), None, None),
            &all,
            Some("cluster-1"),
        );
        assert_eq!(named.unwrap().how, "explicit");
    }

    #[test]
    fn only_unidentified_panes_say_so_instead_of_claiming_nothing_is_open() {
        let mut all = surfaces_with_focus(None);
        all.retain(|s| s.instance == "canvas-3");
        let err = resolve_canvas(&Target::default(), &all, Some("cluster-1")).unwrap_err();
        assert_eq!(err.data.as_ref().unwrap()["kind"], "canvas-unknown");
        assert!(!err.message.contains("none is open"), "{}", err.message);
        assert!(err.message.contains("inactive") || err.message.contains("on screen"));
    }

    #[test]
    fn list_canvases_flags_panes_whose_canvas_is_unknown() {
        let all = surfaces_with_focus(None);
        let out = list_open(&all, Some("cluster-1"));
        let rows = out["canvases"].as_array().unwrap();
        let hidden = rows.iter().find(|r| r["instance"] == "canvas-3").unwrap();
        assert_eq!(hidden["canvas"], Value::Null);
        assert_eq!(hidden["canvasKnown"], false);
        let known = rows.iter().find(|r| r["instance"] == "canvas-1").unwrap();
        assert_eq!(known["canvasKnown"], true);
        assert!(out["note"].as_str().unwrap().contains("cluster"));
    }

    /// Regression: `set_parent` with no `canvas` resolved to the focused canvas and
    /// silently reparented it, though the schema said `canvas` was required.
    #[test]
    fn set_parent_and_link_frame_refuse_to_default_the_canvas() {
        for tool in NAMED_CANVAS_ONLY {
            let route = ROUTES.iter().find(|r| r.tool == *tool).unwrap();
            assert_eq!(route.scope, Scope::Canvas, "{tool}");
            let nothing = require_named_canvas(tool, &Target::default()).unwrap_err();
            assert_eq!(nothing.data.as_ref().unwrap()["kind"], "canvas-required");
            assert!(
                nothing.message.contains("requires `canvas`"),
                "{}",
                nothing.message
            );
            // A pane's instance names a canvas, but not the one the caller meant to move.
            let by_pane = require_named_canvas(tool, &target(None, Some("canvas-2"), None));
            assert!(
                by_pane.is_err(),
                "{tool} must not take an instance in its place"
            );
            assert!(require_named_canvas(tool, &target(Some("levels/one"), None, None)).is_ok());
        }
        // Tools that are meant to default are untouched.
        assert!(require_named_canvas("view_diagram", &Target::default()).is_ok());
        assert!(require_named_canvas("set_frame", &Target::default()).is_ok());
    }

    #[test]
    fn nothing_open_and_nothing_named_asks_for_a_canvas() {
        let err = resolve_canvas(&Target::default(), &[], Some("cluster-1")).unwrap_err();
        assert!(err.message.contains("none is open"), "{}", err.message);
    }

    #[test]
    fn a_canvas_id_open_in_two_clusters_needs_a_cluster() {
        let mut all = surfaces_with_focus(None);
        let mut twin = all
            .iter()
            .find(|s| s.instance == "canvas-1")
            .unwrap()
            .clone();
        twin.instance = "canvas-7".into();
        twin.cluster = "cluster-2".into();
        all.push(twin);
        let err = resolve_canvas(
            &target(Some("levels/one"), None, None),
            &all,
            Some("cluster-1"),
        )
        .unwrap_err();
        assert!(
            err.message.contains("cluster-1, cluster-2"),
            "{}",
            err.message
        );
        let r = resolve_canvas(
            &target(Some("levels/one"), None, Some("cluster-2")),
            &all,
            None,
        )
        .unwrap();
        assert_eq!(r.instance.as_deref(), Some("canvas-7"));
    }

    #[test]
    fn a_canvas_that_is_not_open_falls_back_to_the_active_cluster() {
        let all = surfaces_with_focus(None);
        let r = resolve_canvas(
            &target(Some("levels/closed"), None, None),
            &all,
            Some("cluster-1"),
        )
        .unwrap();
        assert_eq!(r.cluster, "cluster-1");
        assert_eq!(r.instance, None);
    }

    #[test]
    fn cluster_tools_prefer_a_named_cluster_then_the_focused_pane_then_the_active_one() {
        let all = surfaces_with_focus(Some("canvas-1"));
        let named = resolve_cluster(
            &target(None, None, Some("cluster-2")),
            &all,
            Some("cluster-1"),
        )
        .unwrap();
        assert_eq!(
            (named.cluster.as_str(), named.how),
            ("cluster-2", "explicit")
        );
        let focused = resolve_cluster(&Target::default(), &all, Some("cluster-2")).unwrap();
        assert_eq!(
            (focused.cluster.as_str(), focused.how),
            ("cluster-1", "focused-cluster")
        );
        let fallback = resolve_cluster(
            &Target::default(),
            &surfaces_with_focus(None),
            Some("cluster-2"),
        )
        .unwrap();
        assert_eq!(
            (fallback.cluster.as_str(), fallback.how),
            ("cluster-2", "active-cluster")
        );
    }

    #[test]
    fn method_params_always_say_agent_and_carry_the_resolved_id() {
        let args: Map<String, Value> = serde_json::from_value(json!({
            "canvas": "x", "instance": "canvas-1", "cluster": "c", "actor": "human",
            "diagram": "playfield",
        }))
        .unwrap();
        let params = method_params(&args, Some("levels/one"), "canvas/set-values");
        assert_eq!(params["actor"], "agent");
        assert_eq!(params["id"], "levels/one");
        assert_eq!(params["diagram"], "playfield");
        assert!(params.get("instance").is_none() && params.get("cluster").is_none());
    }

    #[test]
    fn list_open_reports_every_canvas_and_what_would_be_the_default() {
        let all = surfaces_with_focus(Some("canvas-1"));
        let out = list_open(&all, Some("cluster-1"));
        assert_eq!(out["count"], 3);
        assert_eq!(out["canvases"][0]["focused"], true);
        assert_eq!(out["ifNoCanvasIsNamed"]["canvas"], "levels/one");
        let none_focused = list_open(&surfaces_with_focus(None), Some("cluster-1"));
        assert!(none_focused["ifNoCanvasIsNamed"]["error"].is_string());
    }

    fn descriptions(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(map) => {
                if let Some(Value::String(d)) = map.get("description") {
                    out.push(d.clone());
                }
                map.values().for_each(|x| descriptions(x, out));
            }
            Value::Array(items) => items.iter().for_each(|x| descriptions(x, out)),
            _ => {}
        }
    }

    /// Regression: `link_frame`'s description, the `list_canvases` note and the
    /// `canvas-required` error carried runs of spaces where a `\` line continuation had
    /// been lost, and agents read them that way.
    #[test]
    fn no_agent_facing_text_carries_a_run_of_spaces() {
        let mut texts: Vec<String> = Vec::new();
        for tool in TOOLS {
            texts.push(tool.description.to_string());
            descriptions(&(tool.schema)(), &mut texts);
        }
        texts.push(
            list_open(&surfaces_with_focus(None), Some("cluster-1"))["note"]
                .as_str()
                .unwrap()
                .to_string(),
        );
        texts.push(
            require_named_canvas("set_parent", &Target::default())
                .unwrap_err()
                .message,
        );
        for text in texts {
            assert!(!text.contains("  "), "a run of spaces in: {text}");
        }
    }

    /// The E2E agent had no way to read the drawing manual through the tools and
    /// guessed property names; `drawing_guide` serves it.
    #[test]
    fn drawing_guide_serves_both_manuals_and_refuses_an_unknown_topic() {
        let none: Map<String, Value> = Map::new();
        let design = style::brief(&style::resolve(None, None, None, None));
        let drawing = guide(&none, &design).unwrap();
        assert_eq!(drawing["topic"], "drawing");
        assert!(drawing["text"].as_str().unwrap().contains("## Palette"));
        let args: Map<String, Value> =
            serde_json::from_value(json!({ "topic": "frames" })).unwrap();
        let frames = guide(&args, &design).unwrap();
        assert!(frames["text"]
            .as_str()
            .unwrap()
            .contains("canvas/link-frame"));
        let bad_topic: Map<String, Value> =
            serde_json::from_value(json!({ "topic": "colour" })).unwrap();
        assert!(guide(&bad_topic, &design).is_err());
        let route = ROUTES.iter().find(|r| r.tool == "drawing_guide").unwrap();
        assert_eq!((route.scope, route.read_only), (Scope::Guide, true));
    }

    /// The person's detail level and style reach the agent through the guide: the
    /// drawing manual ends with the effective guidance, and a different choice
    /// gives different text.
    #[test]
    fn the_guide_carries_the_effective_detail_and_style() {
        let none: Map<String, Value> = Map::new();
        let standard = guide(
            &none,
            &style::brief(&style::resolve(None, None, None, None)),
        )
        .unwrap();
        let text = standard["text"].as_str().unwrap();
        assert!(text.contains("## Detail level and style for this canvas"));
        assert!(text.contains(style::detail("standard").unwrap().guidance));
        assert!(text.contains(style::style("blueprint").unwrap().guidance));
        assert_eq!(standard["design"]["detail"], "standard");

        let picked = style::brief(&style::resolve(
            None,
            None,
            Some("sparse"),
            Some("whiteboard"),
        ));
        let sketch = guide(&none, &picked).unwrap();
        let text = sketch["text"].as_str().unwrap();
        assert!(text.contains(style::detail("sparse").unwrap().guidance));
        assert!(text.contains(style::style("whiteboard").unwrap().guidance));
        assert!(!text.contains(style::detail("standard").unwrap().guidance));
        assert_eq!(sketch["design"]["style"], "whiteboard");

        let args: Map<String, Value> = serde_json::from_value(json!({ "topic": "style" })).unwrap();
        let catalog = guide(&args, &picked).unwrap();
        let text = catalog["text"].as_str().unwrap();
        for d in style::DETAIL_LEVELS {
            assert!(text.contains(d.guidance));
        }
    }

    /// A style that names a colour the layout does not have would tell agents to
    /// draw in a colour that comes out as ink.
    #[test]
    fn every_style_palette_name_is_a_palette_name() {
        for s in style::STYLES {
            for (role, name) in s.palette {
                assert!(PALETTE.contains(name), "{}: `{name}` ({role})", s.id);
            }
        }
    }

    /// The schema's palette is the layout's: a name missing here is refused by a
    /// validating client, and one only here is drawn in ink.
    #[test]
    fn the_add_shapes_palette_matches_the_canvas_app() {
        let draw = include_str!("../../../../apps/canvas/ui/src/draw.ts");
        let start = draw.find("export const PALETTE").unwrap();
        let block = &draw[start..start + draw[start..].find("};").unwrap()];
        let names: Vec<&str> = block
            .lines()
            .filter_map(|l| l.trim().split_once(": {").map(|(name, _)| name))
            .collect();
        assert_eq!(names, PALETTE);
    }

    /// The E2E agent tripped over a required `frame.id` the schema never mentioned,
    /// found the icons only through an error, and guessed field kinds.
    #[test]
    fn add_shapes_and_save_type_schemas_say_what_is_required_and_allowed() {
        let schema = |name: &str| (TOOLS.iter().find(|t| t.name == name).unwrap().schema)();
        let add = schema("add_shapes");
        let frame = &add["properties"]["frame"];
        assert_eq!(frame["required"], json!(["id", "title"]));
        assert!(frame["properties"]["x"].is_object());
        let shape = &add["properties"]["shapes"]["items"];
        assert_eq!(shape["required"], json!(["id", "type"]));
        assert_eq!(shape["properties"]["color"]["enum"], json!(PALETTE));
        assert!(shape["properties"]["fill"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("solid")));
        let mermaid = schema("import_mermaid");
        assert_eq!(
            mermaid["properties"]["frame"]["required"],
            json!(["id", "title"])
        );
        let save = schema("save_type");
        let def = &save["properties"]["type"]["properties"];
        assert_eq!(def["icon"]["enum"], json!(crate::apps::canvas::TYPE_ICONS));
        assert_eq!(
            def["fields"]["items"]["properties"]["kind"]["enum"],
            json!(crate::apps::canvas::FIELD_KINDS)
        );
        for tool in ["get_frame", "frame_image", "set_frame", "link_frame"] {
            let help = schema(tool)["properties"]["frame"]["description"].clone();
            assert!(
                help.as_str().unwrap().contains("diagram id"),
                "{tool}: {help}"
            );
        }
    }

    #[test]
    fn a_non_string_target_is_refused_by_name() {
        let args: Map<String, Value> = serde_json::from_value(json!({ "canvas": 7 })).unwrap();
        let err = Target::from_args(&args).unwrap_err();
        assert!(err.message.contains("`canvas`"));
    }
}
