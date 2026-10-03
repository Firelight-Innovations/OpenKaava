# Drawing on the canvas

How to draw a design on an OpenKaava canvas, for people and for agents. The worked example is
`docs/canvas-examples/flap-ball.json`, a small game designed in four diagrams plus an index.

An agent that only has the `kaava-canvas` tools can read this page with `drawing_guide`
(`{"topic": "drawing"}`). `{"topic": "frames"}` gives the frames-and-types manual, and
`{"topic": "design"}` gives the brief for designing a game: what the design must contain, from
mechanics with numbers to the asset list and the open questions.

## The rule: show, don't describe

A canvas is a set of pictures. Someone who has never seen the thing should be able to rebuild it
from the diagrams alone. Text labels the picture and does not replace it.

- **Draw it to scale.** If a ball sits at 25% of the width, draw it there and add a dimension
  line. Don't write "ball at 25%".
- **Draw motion as paths.** Draw a jump as its arc, with tap marks on the arc. Don't write "the
  ball rises 1.35 units".
- **Draw states as boxes and arrows,** with the trigger on each arrow.
- **Draw rules as geometry.** For a hit test, draw the circle, the rectangle, the nearest point
  and the distance.
- Put a sentence of prose only where no picture can carry the idea, and keep it short.

## Detail level and style

How much to draw, and how it should look, is the person's choice, made in Settings, Canvas
(and overridable per canvas). `drawing_guide` ends with the guidance for the level and style in
force, so read it to the end; `{"topic": "style"}` lists every option, and `canvas/design-brief`
answers for one canvas and says where each choice came from.

| Detail | Panels per frame | Required |
|---|---|---|
| `sparse` | 1 to 2 | Nothing beyond labelled shapes. No tables or scales. |
| `standard` (default) | 2 to 4 | Real numbers with units, a scale on geometry, a table or a worked example. |
| `dense` | 4 to 6 | Several tables, worked examples with the arithmetic, edge cases, ranges. |

| Style | Look |
|---|---|
| `blueprint` (default) | Thin outlines, muted fills, colour-coded categories, panel titles in caps. |
| `whiteboard` | Hand-drawn strokes, hatched fills, marker colours. |
| `minimal` | Slide-like: white space, one accent colour, no fills. |
| `explainer` | Bold strokes, a colour per concept, filled boxes, numbered steps. |

The style's stroke, roughness, fill pattern and font are applied by `add_shapes` itself; you do
not set them per shape. What the guidance asks of you is what to choose: which palette names,
how much to fill, how to word labels. Follow the person's choice over your own taste, and use
`canvas/set-design` only when they ask.

## Diagrams are named frames

Every diagram is an Excalidraw frame with a stable id. `canvas/add-shapes` creates it, or you can
draw a frame and name it. The frame carries `customData.kaava.diagram`:

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and `-`. Stable: comments and links point at it. |
| `title` | What a person reads at the top of the frame. |
| `summary` | One line: what this diagram shows. |
| `parent` | The id of the diagram this one details, if any. |
| `level` | `overview`, `subsystem` or `detail`. The index has `index`. |
| `covers` | Which checklist topics it covers (see below). |

**Naming.** Name a diagram after what it shows, not after its shape: `playfield`, `flap-timing`,
`game-states`. Use `overview` for the one-screen picture of the whole thing. A subsystem
(physics, spawning, collision, states, UI) gets its own frame, and a detail (an algorithm, a
timing chart, a transition table) gets its own frame with that subsystem as its `parent`.

**The index.** Build it with `{"index": true, "title": "…"}` in `canvas/add-shapes`. It lists
every diagram by level with its summary and topics. Each title is a `kaava://diagram/<id>` link,
so clicking it moves to that diagram. Rebuild it after adding diagrams.

**Big canvases split.** Once a canvas holds thousands of elements, `canvas/split-frames` moves
each heavy frame into a child canvas of its own. The parent then shows a picture of each child.
Keep naming diagrams on the parent as before. `describe-diagram`, `view-diagram`, `add-shapes`
and comments follow a split frame into its child, and the result's `canvas` says which file
they used.

**One concern per canvas.** A game's design and the spec cards for its 3D assets are different
things. A spec card (name, size in metres, triangle budget, style notes, reference images, review
state) belongs to one asset. The game's rules belong in diagrams.

## Palette

Use the eight palette names, never hex values. They are the editor's own picker shades, and its
dark mode inverts the canvas through a filter tuned for those shades. A colour from outside the
palette can turn muddy or disappear in dark mode.

| Name | Use it for |
|---|---|
| `ink` | Outlines, labels, most text. The default. |
| `muted` | Summaries, dimension lines, notes, anything secondary. |
| `blue` | The player, input, links. |
| `green` | Success, safe space, the gap you fly through, scoring. |
| `red` | Failure, danger, collisions, "don't". |
| `orange` | Forces and motion: gravity, velocity, scrolling. |
| `violet` | Timing and state. |
| `teal` | Spawning and the world generator. |

`fill` takes a palette name for its light shade, `solid` for the stroke colour, or `none`. Keep
fills light. A large solid fill hides the text around it.

Any other `color` or `fill`, such as `brown` or `#8B5A2B`, is drawn in `ink`. The answer has a
warning for each one, so read `warnings` after every call. There is no brown or yellow. Use
`orange` for wood and earth.

A `line` with three or more `points` takes a `fill` too. The line is closed into a polygon (the
first point is added again at the end if it is missing), so a roof, a hill or a block face can be
filled. A `fill` on an arrow or on a two-point line does nothing and is warned about.

## Fonts and sizes

The font comes from the style: Nunito for `blueprint`, the editor's "Normal" face, and a different
face for each of the others. `canvas/add-shapes` measures every label in it before placing
anything. There are four sizes, and nothing smaller than 14 px reads at 1x.

| Size | px | Use |
|---|---|---|
| `title` | 28 | The frame's title (added for you). |
| `heading` | 20 | Section heads inside a frame, index links. |
| `body` | 16 | Labels and the summary. The default. |
| `small` | 14 | Arrow labels, dimensions, notes. |

## Spacing

- Everything snaps to a **10 px grid**.
- A frame has **40 px** of padding. Its title and summary sit at the top, and shape coordinates
  are measured from just below them. So `{x: 0, y: 0}` is the top-left of the drawing area, not of
  the frame. With a title alone it is about 110 px below the frame's top. The answer gives it
  exactly as `frame.origin`.
- `frame.x` and `frame.y` are scene coordinates of the frame's top-left. Leave them out and a new
  frame goes to the right of the others; a rebuilt one stays where it is.
- Negative shape coordinates put a shape above or left of the frame. The answer warns about it.
- Leave at least **20 px** between unrelated shapes and **40 px** between groups.
- Boxes grow to fit their labels. Give a `width` only when size means something (to scale).
- Text that lands on other text, or partly across a filled shape, is moved clear and reported in
  `warnings`. Pass `"nudge": false` to only report it, or `"fixed": true` on a shape to pin it.
- Frames fit their content unless you give a size. If you give a size that is too small, the
  warning says it will be clipped.

## Drawing with `canvas/add-shapes`

```json
{
  "id": "flap-ball", "actor": "agent",
  "frame": { "id": "game-states", "title": "Game states", "level": "subsystem",
             "summary": "Ready, Playing and Dead, and what moves between them.",
             "covers": ["states", "input"] },
  "shapes": [
    { "id": "ready",   "type": "rectangle", "x": 0,   "y": 0, "label": "Ready",   "color": "blue" },
    { "id": "playing", "type": "rectangle", "x": 240, "y": 0, "label": "Playing", "color": "green" },
    { "id": "dead",    "type": "rectangle", "x": 480, "y": 0, "label": "Dead",    "color": "red" },
    { "id": "t1", "type": "arrow", "from": "ready",   "to": "playing", "label": "tap" },
    { "id": "t2", "type": "arrow", "from": "playing", "to": "dead",    "label": "hit" }
  ]
}
```

- **Shape types:** `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line` and `image`.
- **Arrows and lines** join shape ids (`from`/`to`) or points (`[x, y]`), or follow `points`.
  They can carry a `label`, and can be `dashed` or `curved`.
- **Images:** `{"type": "image", "ref": "refs/sketch.png"}` places a reference image (see below).
- **Ids:** every element's id is `<diagram>:<shape>`, so `game-states:ready` here. The answer
  maps your ids to them. Rebuilding a frame (the default, `"replace": true`) gives the same ids,
  so a rebuild is a readable diff.
- **One frame per call.** `frame.id` and `frame.title` are required. There are no loose shapes:
  everything `add_shapes` draws is inside its frame.
- **Replace removes everything in the frame.** That includes shapes drawn by hand or wrapped in by
  `create_frame`. The answer names any it removed that it did not draw. Pass `"replace": false`
  to add to a frame instead.
- **`create_frame` is for wrapping shapes, not drawing.** It groups elements that are already on
  the canvas. An element sits in one frame only, so it refuses elements that are inside another
  frame and names that frame. `"move": true` takes them anyway and leaves a gap in the old frame.
  To draw a new picture, call `add_shapes` with a new `frame.id`.
- **Undo:** each call saves a checkpoint first. `canvas/restore-checkpoint` undoes it, and
  `canvas/checkpoints` lists the last five.
- **Mermaid:** `canvas/import-mermaid` with `{"frame": {...}, "source": "stateDiagram-v2 …"}` is
  quicker for a flowchart. Its text is not measured the same way, so check it with
  `view-diagram`.

## Look at what you drew

Always run `canvas/view-diagram` after drawing. It renders only that frame, with nothing from the
editor around it, to `.kaava/canvas-views/<canvas>/<diagram>.png`. Read the PNG.

- **Zoom in:** pass `"region": {"x", "y", "width", "height"}` (frame-relative) to read small labels.
- **Theme:** pass `"theme": "dark"` to check that the colours survive dark mode.
- **Structure:** `canvas/describe-diagram` gives the same frame as text: shapes, labels and what
  each arrow joins.

## Linked values

A number that appears on a diagram and in the spec must not drift. Keep it in the canvas's value
table (`canvas/set-values`, `{"values": {"gravity": {"value": 30, "unit": "u/s²"}}}`) and write
`{{gravity}}` in a label.

- **Tracking:** the label shows the number and remembers its template.
- **Checking:** `canvas/values` lists every value, where it is used, and any label that no longer
  matches its template (for example, someone typed over it).
- **Updating:** `set-values` changes the table and rewrites every label that uses it.

## Coverage checklist

`canvas/coverage` reports which frames cover each topic, from the frames' `covers` lists. By
default the topics are the game checklist:

**input · physics · spawning · scoring · states · UI · audio · tuning**

A missing topic is a gap in the design, not a formatting problem. Draw it, or write in a frame why
it does not apply. Pass `{"checklist": [...]}` for a different kind of design.

## Reference images

Real designs start from pictures.

- **Adding:** drop an image into the editor. It is stored beside the design at
  `canvas/<name>/refs/<file>` rather than as base64 inside the JSON.
- **Placing:** put it inside a frame so `view-diagram` shows it.
- **Listing:** `canvas/refs` lists what there is.
- **Linking:** the Inspector's Reference images chips add one to a spec card.
- **Citing:** refer to one by its `refs/<file>` name in a comment or a label.

## Review: comments

A person selects elements, or drags a box, and leaves a comment for the agent. The agent's loop:

1. `canvas/list-comments` lists the open comments, with the frame and the elements or region.
2. `canvas/view-comment` renders the area the comment points at, with a margin.
3. Fix the diagram, then view it again.
4. `canvas/resolve-comment` with a `note` saying what changed.

Comments live in `canvas/<name>.comments/`, one JSON file each, and are committed with the design.
