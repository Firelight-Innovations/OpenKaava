# Canvas frames, types and nesting

A **frame** is the unit of detail on a canvas. Select a frame and the Inspector
shows its name, type, that type's fields and its child canvas. A plain shape
shows its frame's summary; a shape in no frame offers **Frame selection**, which
wraps the selection in a new labelled frame. Frames do not nest inside frames.

## Where it is stored

The canvas file stays an Excalidraw scene. A frame's detail lives on the frame
element, so Excalidraw round-trips it untouched:

```json
{ "type": "frame", "name": "Gurney",
  "customData": { "kaava": {
    "object": { "type": "model", "props": { "size_m": 2, "review_state": "draft" } },
    "child": "world/gurney" } },
  "link": "kaava://canvas/world/gurney" }
```

The frame's `name` is its label. `child` is a canvas id; the canvas file's own
`kaava.parent` points back up. Cycles are refused on write.

Older canvases kept a spec card on a plain shape (`customData.kaava.spec`).
Reading migrates it in memory to a Model frame around that shape (the result's
`migrated` lists them); the file is rewritten on the next edit. Nothing is lost.

## Types

Built in: Feature, Model, UI screen, System/Mechanic, Note. A type is a name, a
colour, an icon and fields. A field has a `key`, `label` and `kind`: `text`,
`multiline`, `number`, `enum` (with `options`), `path-list` or `bool`, plus an
optional `default`. Changing a frame's type keeps every stored value, including
those the new type has no field for.

Custom types are made in **Manage types** and saved per project in
`.kaava/canvas/types.json` (written to a temp file, then renamed). A custom type
cannot reuse a built-in id.

## Methods for agents

All take `actor: "agent"`. Canvas ids are the id or a `canvas/x.json` path.

| Method | Params | Result |
|---|---|---|
| `canvas/types` | | `{builtin, custom, path, problem}` |
| `canvas/frames` | `canvas?`, `recursive?` | `{scope, canvases, frames, legacyCards, unreadable, problems}`; no `canvas` means the whole project |
| `canvas/search-frames` | `query?`, `type?`, `canvas?`, `limit?` | `{query, type, total, matches}`, each a frame plus `score`, `matchedIn` |
| `canvas/frame` | `canvas`, `frame` (element id, diagram id, or exact title; the element id is the primary key) | the frame, its `typeDef`, `contents`, `canvasPath`, `image` |
| `canvas/frame-image` | `canvas`, `frame`, `scale?`, `maxDimension?`, `theme?` | `{path, relative, width, height, scale, bytes, frame, hint}` |
| `canvas/tree` | | `{roots, cycles, problems}`; a node is `{id, title, path, parent, frames, error, children}` |
| `canvas/save-type` | `type: {id?, name, color, icon, description?, fields}` | the saved type |
| `canvas/delete-type` | `id` | |
| `canvas/set-frame` | `canvas`, `frame` (id or name), `name?`, `type?`, `values?` (field key to value, `null` unsets) | `{frame, mtime}` |
| `canvas/create-frame` | `canvas`, `name`, `type?`, `values?`, and one of `elementIds` (wrap those shapes) or `bbox {x,y,width,height}` (empty frame) | `{frame, adopted, mtime}` |
| `canvas/set-parent` | `id`, `parent` (a canvas id or `null`; required, omitting it is an error) | `{id, parent, unlinkedFrames}`; frames in the old parent that linked to this canvas are unlinked |
| `canvas/link-frame` | `canvas`, `frame`, `child` (an existing canvas or `null` to unlink), `reparent?` | Sets the frame's `child` and `link` and the child's `parent`, and releases any previous child. Refused for a missing child, a loop (itself or an ancestor), or a child already nested elsewhere unless `reparent` is true |

A frame in results is `{canvas, id, diagramId, name, type, typeName, typeKnown, props,
extraProps, bbox, childCanvas, elements}`. `canvas/frame-image` renders to
`.kaava/preview/canvas/<canvas>/<frame id>.png`, overwritten in place.

## A frame can be a diagram, a typed object and a link at once

`customData.kaava` on one frame may hold `diagram` (from `add_shapes`), `object` (its
type and values) and `child` (a nested canvas) together. Rebuilding a diagram with
`add_shapes` replaces only `kaava.diagram`; the object, child and `link` are kept.
`get_frame` and the other frame methods accept the element id (`frame:board-title`),
the diagram id (`board-title`) or the title; the element id is the primary key and
`diagramId` is reported next to it. A typed frame with no diagram metadata whose element
id is not `frame:<id>` cannot be adopted by `add_shapes`.

A frame with a child shows a small badge at its top-right in the editor; clicking it
opens the child, like a double-click on the frame.
