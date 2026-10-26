---
name: agent-ready-canvas
description: Structure every Veistra / Kaava / Excalidraw canvas so humans and agents can select, comment on and reference whole objects - each section a named frame, each multi-part object (sprite, table, labelled box, diagram, callout) a group or a bound container. Use this skill whenever you create, edit, generate, restyle, extend or audit a canvas or design board - any canvas/*.json, .excalidraw file, veistra://canvas or kaava://canvas link, GDD board, wireframe, mockup, diagram, bestiary/level/spec sheet, or a script that emits Excalidraw elements - even if the user only asks for "a quick diagram", "add a panel" or "move this box" and never mentions frames or groups. Also use it when a selection or comment on a canvas arrives as bare element IDs that are hard to interpret, because that is the symptom of a flat canvas.
---

# Agent-ready canvas

A canvas is a shared workspace between the user and agents. In Veistra, when the user clicks
something or leaves a comment, the agent receives **element IDs**, nothing more. Whether those IDs
mean anything depends entirely on how the canvas was built:

- Flat canvas: the user clicks a sprite and the agent gets one 8x8 rectangle out of 140. The user
  selects a panel and the agent gets an empty background box. The agent has to guess from
  coordinates, and guesses wrong.
- Structured canvas: the same click selects the sprite's group, so the agent gets every part plus
  the frame it lives in ("2. Clamshell"). A comment on the frame anchors to a named section.

So structure is not decoration. Build every canvas so that **anything a person would point at and
talk about is one selectable unit with a name nearby.**

## The model

```
canvas
└── frame  "Level 1-1: Gearwood Meadow"        (named section - one per topic, never nested)
    ├── panel background rect + title text     (may stay loose inside the frame)
    ├── group  tile map                        (one object = one group)
    │   ├── group  checkpoint flag             (nested group = part of an object)
    │   └── ...
    ├── rectangle "Coins: 30"  <- bound text   (label lives inside its box via containerId)
    └── group  diagram: boxes + arrows         (connectors join objects into an outer group)
```

1. **Frames are sections.** Every element belongs to exactly one frame (`frameId`). One frame per
   topic a person would name in conversation: "the reaction matrix", "the Clamshell card".
   Excalidraw frames cannot nest and they clip their children, so make them non-overlapping and
   large enough to hold everything they own.
2. **Frame names are the handle.** Agents and comments refer to sections by name, so names must be
   specific, unique and human: `Fling physics and scoring`, not `Frame 3` or `Section`. Number them
   if order matters (`1. Bumblenut`).
3. **Groups are objects.** Anything drawn from more than one primitive is a group: a pixel-art
   sprite, a table, a card, a state box and its label, a chart, a legend row. A single loose
   rectangle is only acceptable when it really is a standalone thing.
4. **Nest groups for parts.** Excalidraw selects the outermost group on click and drills in on
   double-click, so nest: pose strip > pose > hammer head. `groupIds` is ordered innermost first.
5. **Labels are bound, not floating.** Text inside a shape should be its bound text
   (`containerId` on the text, `{type:"text"}` in the shape's `boundElements`). If you need a
   layout that bound text cannot produce, group the label with the shape instead. A caption under
   an object belongs in the object's group.
6. **Arrows are bound too.** Set `startBinding` / `endBinding` on arrows that point at shapes and
   list the arrow in those shapes' `boundElements`, so moving a box keeps the diagram intact and the
   agent can read "A -> B" from the data.
7. **Stable, meaningful IDs.** Keep IDs stable across edits (comments and selections reference
   them). Prefix generated IDs per section when you control them (`hammer_state_idle`), never reuse
   an ID for a different object.

`references/excalidraw-structure.md` has the exact JSON for frames, groups, bound text, bound
arrows and z-ordering. Read it before writing canvas JSON by hand or in a generator.

## Workflow

### Creating a canvas or a new section
1. Decide the frames first: list the sections and their names before drawing anything.
2. Build each object inside its frame and group it as you go. It is far easier to assign a
   `groupIds` entry when you create the parts than to reconstruct it later.
3. Put children before their frame in the `elements` array and keep `index` values increasing.
4. Lint and preview (below).

### Editing an existing canvas
- New content goes into the frame it belongs to. If it does not fit, grow the frame (and move
  neighbouring frames) rather than leaving the content outside, because outside means clipped or
  orphaned.
- Adding a part to an existing object: add it to that object's group.
- Deleting: remove the whole group, not just the part you can see.
- Do not strip existing frames/groups, and keep IDs the user may have commented on.

### Retrofitting a flat canvas
When a canvas has no frames or groups (the linter says `no_frames` / high `loose_fragments`), run
the restructurer. It turns top-level panels into named frames, nested panels into groups, and
touching parts (sprites, tables, labelled boxes) into groups, connector-joined objects into outer
groups. It never touches elements that already have a frame or group, so it is safe to re-run.

```bash
python <skill>/scripts/canvas_restructure.py canvas/foo.json --dry-run   # see frames it would make
python <skill>/scripts/canvas_restructure.py canvas/foo.json             # writes foo.json.bak first
```

Then check its frame names: it guesses from the title text near each panel's top-left corner,
which is usually right but not always. Rename any that read poorly.

### If a script generates the canvas
Canvases built by code (for example a `tools/gdd/` generator) get rebuilt from scratch, which wipes
any structure added by hand or by the restructurer. Fix the generator so it emits frames and
`groupIds` itself, and then regenerate. Retrofitting only the JSON is a stopgap; tell the user.

### Live canvas vs file on disk
If the harness exposes canvas tools (e.g. a `veistra-canvas` / `kaava-canvas` MCP server), use them,
and apply the same rules to what you create through them. If you edit the JSON file while the
canvas is open in the app, the app may overwrite your change on its next save. Tell the user to
reload the canvas, or make the change through the live tools.

## Verify before you finish

Inside Veistra, lint with the `lint_canvas` tool of the `veistra-canvas` MCP server. It runs the
same checks as `canvas_lint.py`, on the live canvas, with no Python needed. Use the script below
only when that tool is not available.

Always run both, and fix what they report before saying the canvas is done:

```bash
python <skill>/scripts/canvas_lint.py canvas/foo.json                 # exit 0 = agent-ready
python <skill>/scripts/canvas_preview.py canvas/foo.json /tmp/foo.png --scale 0.25
python <skill>/scripts/canvas_preview.py canvas/foo.json /tmp/f.png --frame "Clamshell" --level inner
```

The linter fails on: content outside frames, unnamed / duplicate / nested frames, children poking
outside their frame, groups spanning frames, labels sitting in a box without being bound or grouped,
and touching parts that share no group. Look at the preview image: blue boxes are frames, coloured
boxes are what one click selects (`--level inner` shows what a double-click selects), red boxes are
orphans. If a coloured box swallows several things a person would talk about separately, split the
group.

When you report back, list the frames by name so the user knows the handles they can use in
comments and selections.

## Reading a selection or comment
When a selection or comment arrives as element IDs, resolve it upward before answering: element ->
its groups (all members) -> its frame (name and contents). Describe what was selected in those
terms ("the Clamshell sprite in frame '2. Clamshell'"), not as raw shapes. If the IDs land on a flat
canvas, say so and offer to restructure it.
