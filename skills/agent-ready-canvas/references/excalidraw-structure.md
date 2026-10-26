# Excalidraw structure: exact JSON

Every element needs the usual base fields (`id, type, x, y, width, height, angle, strokeColor,
backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, seed, version,
versionNonce, isDeleted, updated, link, locked, roundness`). Only the structural fields are shown
below.

## Contents
1. Frames
2. Groups
3. Bound text (label inside a shape)
4. Bound arrows
5. Ordering and fractional indices
6. Generator pattern (Python)

## 1. Frames

```json
{ "id": "frm_reaction_matrix", "type": "frame", "name": "Reaction matrix (what each attack does)",
  "x": 40, "y": 2190, "width": 2260, "height": 540,
  "strokeColor": "#bbb", "backgroundColor": "transparent", "roughness": 0, "strokeWidth": 2,
  "roundness": null, "groupIds": [], "frameId": null, "boundElements": null }
```

- Children carry `"frameId": "frm_reaction_matrix"`.
- A frame never has a `frameId` (no nesting) and frames should not overlap.
- Frames clip: every child's bounding box must sit inside the frame. For lines/arrows the box is
  `x + points[i][0]`, `y + points[i][1]`, not `x, y, width, height`.
- Bound text inherits its container's frame; give it the same `frameId`.
- `name` is shown above the frame and is what people (and agents) use to refer to it.

## 2. Groups

```json
{ "id": "clam_shell_top", "type": "ellipse", "groupIds": ["g_clam_mouth", "g_clam_sprite", "g_clam_card"] }
```

- `groupIds` lists groups from **innermost to outermost**. Excalidraw selects the outermost group on
  click; each double-click drills one level in.
- Group IDs are just shared strings; there is no group element.
- All members of a group should share the same `frameId`.
- One object = one group. Parts of an object = nested groups. A whole diagram (boxes + arrows) can
  be an outer group around the per-box groups.

## 3. Bound text (label inside a shape)

```json
{ "id": "st_idle", "type": "rectangle", "x": 60, "y": 200, "width": 180, "height": 80,
  "boundElements": [{ "type": "text", "id": "st_idle_label" }] }
{ "id": "st_idle_label", "type": "text", "containerId": "st_idle",
  "text": "IDLE\nhammer on shoulder", "originalText": "IDLE\nhammer on shoulder",
  "textAlign": "center", "verticalAlign": "middle", "fontSize": 20, "fontFamily": 1, "lineHeight": 1.25,
  "x": 70, "y": 215, "width": 160, "height": 50, "autoResize": true }
```

- Container types: rectangle, ellipse, diamond (and arrows, for arrow labels).
- Set the text's x/y/width/height to roughly the padded inside of the container (5 px padding);
  Excalidraw re-lays it out on load.
- Need left/top alignment? `textAlign: "left"`, `verticalAlign: "top"` still works for bound text.
- If you truly need free positioning, group the text with the shape instead.

## 4. Bound arrows

```json
{ "id": "tr_idle_windup", "type": "arrow", "x": 240, "y": 240, "points": [[0,0],[120,0]],
  "startBinding": { "elementId": "st_idle",   "focus": 0, "gap": 4 },
  "endBinding":   { "elementId": "st_windup", "focus": 0, "gap": 4 },
  "startArrowhead": null, "endArrowhead": "arrow" }
```

and on both shapes: `"boundElements": [ ..., { "type": "arrow", "id": "tr_idle_windup" } ]`.

## 5. Ordering and fractional indices

- Excalidraw keeps a frame's children directly **before** the frame element in `elements`.
- `index` is a fractional-index string that must strictly increase along the array (`a0`, `a1`,
  ... `aZ`, `az`, `b00`, ...). After reordering, regenerate them all (`excal.reindex()` in
  `scripts/excal.py` does this).
- Bump `version` (and `updated`) on elements you change so the app's reconciliation accepts them.

## 6. Generator pattern (Python)

When code builds the canvas, emit structure at creation time instead of retrofitting:

```python
class Canvas:
    def __init__(self, prefix):
        self.prefix, self.els, self._frame, self._groups = prefix, [], None, []

    def frame(self, name, x, y, w, h):
        """with c.frame("2. Clamshell", ...): everything drawn inside gets this frameId."""
        c = self
        class _F:
            def __enter__(s):
                s.f = c._base("frame", x, y, w, h, name=name)
                c._frame = s.f["id"]
            def __exit__(s, *a):
                c._frame = None
                c.els.remove(s.f); c.els.append(s.f)   # frame after its children
        return _F()

    def group(self, name):
        """with c.group("clam-sprite"): nested withs give nested groups (innermost first)."""
        c = self
        class _G:
            def __enter__(s): c._groups.insert(0, f"{c.prefix}{name}")
            def __exit__(s, *a): c._groups.pop(0)
        return _G()

    def _base(self, t, x, y, w, h, **kw):
        e = {...,  # usual fields
             "frameId": None if t == "frame" else self._frame,
             "groupIds": [] if t == "frame" else list(self._groups)}
        if t == "frame":
            e["name"] = kw["name"]
        self.els.append(e)
        return e
```

Usage:

```python
with c.frame("2. Clamshell", 40, 1430, 2760, 800):
    c.panel(...)
    with c.group("clam-walk-a"):
        draw_clam(c, x, y)
    with c.group("clam-stat-table"):
        c.table(...)
```
