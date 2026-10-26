"""Shared helpers for reading, measuring and writing Excalidraw scenes (Veistra / Kaava canvases)."""
import json
import random
import time

B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
SHAPES = {"rectangle", "ellipse", "diamond", "line", "arrow", "freedraw", "image", "embeddable", "iframe"}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(path, doc):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


def live(doc):
    return [e for e in doc.get("elements", []) if not e.get("isDeleted")]


def bbox(e):
    """Axis-aligned (x0, y0, x1, y1). Lines/arrows/freedraw store x,y as the first point."""
    if e.get("points"):
        xs = [e["x"] + p[0] for p in e["points"]]
        ys = [e["y"] + p[1] for p in e["points"]]
        return min(xs), min(ys), max(xs), max(ys)
    return e["x"], e["y"], e["x"] + e["width"], e["y"] + e["height"]


def area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inside(inner, outer, tol=1.0):
    return (inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol
            and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol)


def touches(a, b, gap=0.0):
    return not (a[2] + gap < b[0] or b[2] + gap < a[0] or a[3] + gap < b[1] or b[3] + gap < a[1])


def overlap_area(a, b):
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def union(boxes):
    boxes = list(boxes)
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def label(e, n=60):
    t = (e.get("text") or e.get("name") or "").replace("\n", " ").strip()
    return t[:n]


def index_keys(n):
    """n strictly increasing Excalidraw fractional-index keys (a0..az, b00..bzz, c000..)."""
    keys = []
    for i in range(n):
        if i < 62:
            keys.append("a" + B62[i])
        elif i < 62 + 62 ** 2:
            j = i - 62
            keys.append("b" + B62[j // 62] + B62[j % 62])
        else:
            j = i - 62 - 62 ** 2
            keys.append("c" + B62[j // 3844 % 62] + B62[j // 62 % 62] + B62[j % 62])
    return keys


def reindex(elements):
    for e, k in zip(elements, index_keys(len(elements))):
        e["index"] = k


def new_id(prefix, taken):
    while True:
        i = prefix + "".join(random.choice(B62) for _ in range(10))
        if i not in taken:
            taken.add(i)
            return i


def make_frame(fid, name, b):
    now = int(time.time() * 1000)
    return {
        "id": fid, "type": "frame", "name": name,
        "x": b[0], "y": b[1], "width": b[2] - b[0], "height": b[3] - b[1],
        "angle": 0, "strokeColor": "#bbb", "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 0, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": None,
        "seed": random.randint(1, 2 ** 31), "version": 1, "versionNonce": random.randint(1, 2 ** 31),
        "isDeleted": False, "boundElements": None, "updated": now, "link": None, "locked": False,
    }
