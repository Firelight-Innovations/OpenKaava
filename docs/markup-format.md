# Markup format

When someone draws on a render to leave a comment for an agent, the result is one JSON document, the same whether the drawing was made over a 3D scene, a Godot or Blender render, or a Canvas. This page is that format. The code that writes it is `packages/markup/src/format.ts`.

A markup export is two files that belong together:

- **`markup.png`**: the frame with the ink on top of it, as a person saw it. Read this first.
- **`markup.json`**: what the ink means. Read this to know which objects were pointed at.

## Shape

```jsonc
{
  "version": 1,
  "source": { "kind": "scene", "glb": "assets/house.glb", "camera": { ... } },
  "size": { "width": 1280, "height": 720 },
  "camera": { "position": [4, 2, 6], "target": [0, 1, 0], "up": [0, 1, 0], "fov": 50 },
  "pins": [
    { "n": 1, "note": "door is too tall", "nodePath": "House/Door", "worldPoint": [1.2, 1.0, 0.1] },
    { "n": 2, "note": "" }
  ],
  "annotations": [
    {
      "kind": "arrow",
      "text": "move this",
      "targets": [{ "nodePath": "House/Window", "worldPoint": [0, 1.5, 2], "at": "head" }],
      "bounds": { "x": 100, "y": 80, "width": 60, "height": 20 }
    }
  ],
  "excalidraw": {
    "elements": [ ... ],
    "appState": { "viewBackgroundColor": "transparent" }
  }
}
```

| Field | Meaning |
|---|---|
| `version` | Always `1`. A reader must refuse any other value. |
| `source` | What the frame is. `kind: "scene"` carries `glb` (the model), the `camera` it was rendered from, and anything the host adds (such as `engine`). `kind: "image"` carries `path` of the image file. |
| `size` | The host viewport in CSS pixels. Every coordinate in this file is in this space, origin top-left. The PNG is `size` times the device pixel ratio, same aspect. |
| `camera` | The camera the frame was seen from. Absent for images. `position`, `target` and `up` are world-space; `fov` is vertical degrees. |
| `pins` | Numbered comments, in number order. |
| `annotations` | Everything else that was drawn, in drawing order. |
| `excalidraw` | The raw Excalidraw elements, so the drawing can be reopened or moved into a Canvas. Agents rarely need this. |

### Pins

A pin is a numbered marker with a note. `n` is stable: numbers are never reused or renumbered, so "pin 3" means the same thing in a later export even if pin 2 was deleted.

`nodePath` and `worldPoint` are present when the host could tell what was under the pin at the moment it was placed. `nodePath` is the scene-graph path of that node; `worldPoint` is the exact point on its surface. **Prefer these to the pixel position**: they say which object, not which part of the picture. A pin with neither was placed over an image, or over empty space.

`note` is the person's words, possibly empty.

### Annotations

`kind` is the Excalidraw type: `arrow`, `rectangle`, `ellipse`, `freedraw`, `text`, `line` or `diamond`.

- `text` is the words of a text element, or of the label written inside an arrow or shape.
- `targets` appears on arrows and shapes when the host could pick. An arrow's target is what its **head** lands on (`at: "head"`); a rectangle's or ellipse's is what is under its **centre** (`at: "centre"`). Each target has `nodePath` and `worldPoint` like a pin.
- `bounds` is the element's box in `size` pixels. For a freehand stroke this is the box around it: it circles or underlines whatever is under that box.

An annotation with no `targets` is a picture on the frame and should be read from the PNG.

## Reading it

1. Open `markup.png`. Note which region each pin number sits in.
2. For every pin, use `nodePath` and `note` to decide what to change; use `worldPoint` to find where on the object.
3. For every annotation with `targets`, treat its `text` as an instruction for that node.
4. If `camera` is present, re-create that view to see what the person saw.

## Views and sessions

Ink is bound to the camera it was drawn from. If the camera moves, the ink is hidden until the camera returns, because a stroke drawn over one view means nothing over another. Pins are the exception: each follows its `worldPoint` and stays visible. One view can hold several markup sessions, each at its own camera. An export contains what was on screen at that moment: the ink of any session whose camera matches, plus every pin that projects into the frame.

## Opening in Canvas

`toCanvasScene(markupJson, imageFileId)` in `@kaava/markup` returns an Excalidraw scene: the frame as a locked image element at the origin, then the ink at the offsets it had over the frame. Pins are ordinary ellipse-and-text groups in it, still carrying `customData.kaava`. The caller registers the PNG under `imageFileId` in the scene's `files`.

## `customData.kaava`

Inside `excalidraw.elements`, elements carry what this format needs on `customData.kaava`:

| `kind` | Extra fields |
|---|---|
| `pin` | `n`, `note`, optional `nodePath`, `worldPoint` |
| `pin-label` | `n`. The number drawn inside the marker; not a separate pin. |
| `arrow`, `rectangle`, `ellipse`, ... | optional `targets` |

Other tools may add their own keys beside `kaava`; a reader ignores what it does not know.

## What is approximate

- Targets are picked at the head or centre only. An arrow that passes over three objects reports the one it ends on.
- `bounds` and `targets` are computed when markup is exported or a session is left, not while drawing.
- Pins follow the camera by projection. If the model has moved since the pin was placed, the pin follows the point in space, not the object.
- Rotated arrows use the unrotated head position.
