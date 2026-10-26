"""Render a canvas to PNG with its structure drawn on top, so you can see what a click selects.

  * frames: thick blue outline + name tag
  * groups: coloured dashed-looking boxes around each top-level group (one colour per group)
  * anything not in a frame: red outline

Usage: python canvas_preview.py canvas/foo.json out.png [--scale 0.25] [--frame "name substring"] [--level inner]
"""
import argparse
import colorsys
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(__file__))
from excal import bbox, live, load, union  # noqa: E402


def color(c, default=None):
    if not c or c == "transparent":
        return default
    c = c.strip()
    if c.startswith("#") and len(c) == 4:
        c = "#" + "".join(ch * 2 for ch in c[1:])
    return c if c.startswith("#") and len(c) == 7 else default


def font(px):
    for name in ("arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, max(6, int(px)))
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("out")
    ap.add_argument("--scale", type=float, default=0.25)
    ap.add_argument("--frame", help="only render frames whose name contains this text")
    ap.add_argument("--no-overlay", action="store_true")
    ap.add_argument("--level", choices=["outer", "inner"], default="outer",
                    help="outline outermost groups (what one click selects) or innermost (double-click)")
    a = ap.parse_args()

    els = live(load(a.path))
    frames = {e["id"]: e for e in els if e["type"] in ("frame", "magicframe")}
    if a.frame:
        keep = {i for i, f in frames.items() if a.frame.lower() in (f.get("name") or "").lower()}
        if not keep:
            sys.exit(f"no frame matching {a.frame!r}; frames: {[f.get('name') for f in frames.values()]}")
        els = [e for e in els if e["id"] in keep or e.get("frameId") in keep]
    if not els:
        sys.exit("nothing to render")
    bx = union(bbox(e) for e in els)
    m = 40
    s = a.scale
    W, H = int((bx[2] - bx[0]) * s + 2 * m), int((bx[3] - bx[1]) * s + 2 * m + 30)
    if W * H > 120_000_000:
        sys.exit(f"image would be {W}x{H}; lower --scale or use --frame")
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    def P(x, y):
        return ((x - bx[0]) * s + m, (y - bx[1]) * s + m + 30)

    for e in els:
        t = e["type"]
        if t in ("frame", "magicframe"):
            continue
        stroke = color(e.get("strokeColor"), "#1e1e1e")
        fill = color(e.get("backgroundColor"))
        sw = max(1, int(e.get("strokeWidth", 1) * s))
        if t in ("rectangle", "diamond", "embeddable", "iframe", "image"):
            x0, y0 = P(e["x"], e["y"])
            x1, y1 = P(e["x"] + e["width"], e["y"] + e["height"])
            if t == "diamond":
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                d.polygon([(cx, y0), (x1, cy), (cx, y1), (x0, cy)], fill=fill, outline=stroke)
            else:
                d.rectangle([x0, y0, max(x0, x1), max(y0, y1)], fill=fill, outline=stroke, width=sw)
        elif t == "ellipse":
            x0, y0 = P(e["x"], e["y"])
            x1, y1 = P(e["x"] + e["width"], e["y"] + e["height"])
            d.ellipse([x0, y0, max(x0, x1), max(y0, y1)], fill=fill, outline=stroke, width=sw)
        elif t in ("line", "arrow", "freedraw") and e.get("points"):
            pts = [P(e["x"] + p[0], e["y"] + p[1]) for p in e["points"]]
            if fill and len(pts) > 2 and (e.get("polygon") or pts[0] == pts[-1]):
                d.polygon(pts, fill=fill)
            if len(pts) > 1:
                d.line(pts, fill=stroke, width=sw)
        elif t == "text":
            x0, y0 = P(e["x"], e["y"])
            d.multiline_text((x0, y0), e.get("text", ""), fill=stroke, font=font(e.get("fontSize", 16) * s),
                             spacing=max(0, int(e.get("fontSize", 16) * s * 0.25)))

    if not a.no_overlay:
        groups = {}
        for e in els:
            g = (e.get("groupIds") or [None])[-1 if a.level == "outer" else 0]
            if g:
                groups.setdefault(g, []).append(bbox(e))
        for i, (g, boxes) in enumerate(groups.items()):
            r, gr, b = colorsys.hsv_to_rgb((i * 0.618) % 1, 0.85, 0.85)
            c = (int(r * 255), int(gr * 255), int(b * 255))
            u = union(boxes)
            d.rectangle([*P(u[0] - 3, u[1] - 3), *P(u[2] + 3, u[3] + 3)], outline=c, width=2)
        for e in els:
            if e["type"] not in ("frame", "magicframe") and not e.get("frameId") and not e.get("containerId"):
                u = bbox(e)
                d.rectangle([*P(*u[:2]), *P(*u[2:])], outline="red", width=3)
        tag = font(18)
        for f in frames.values():
            if a.frame and f not in els:
                continue
            u = bbox(f)
            d.rectangle([*P(*u[:2]), *P(*u[2:])], outline="#1971c2", width=4)
            x0, y0 = P(u[0], u[1])
            name = f.get("name") or "(unnamed frame)"
            tw = d.textlength(name, font=tag)
            d.rectangle([x0, y0 - 26, x0 + tw + 10, y0 - 2], fill="#1971c2")
            d.text((x0 + 5, y0 - 24), name, fill="white", font=tag)
    img.save(a.out)
    print(f"wrote {a.out} ({W}x{H})")


if __name__ == "__main__":
    main()
