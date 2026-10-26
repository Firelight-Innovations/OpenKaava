"""Retrofit a flat canvas into an agent-ready one: named frames per section, groups per object.

How it decides:
  * A "container" is a rectangle/ellipse/diamond that fully encloses >= 2 other elements.
  * Top-level containers that are big enough become FRAMES, named after their heading text
    (the largest-font text near the top of the panel). The panel rectangle stays as the background.
  * Content outside every panel (page title, intro notes) is clustered and framed too.
  * Inside a frame, every nested container becomes a GROUP with everything it encloses
    (nested containers give nested groups), and loose parts that touch or overlap
    (pixel-art sprites, table cells, a label inside a box, arrow + its boxes) are grouped together.
  * Children are ordered directly before their frame and fractional indices are regenerated.

Elements that already have a frameId or groupIds are left alone, so the script is safe to re-run.

Usage: python canvas_restructure.py canvas/foo.json [--out new.json] [--dry-run]
       (in place by default; writes foo.json.bak first)
"""
import argparse
import os
import shutil
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from excal import (area, bbox, inside, label, live, load, make_frame, new_id, reindex, save,  # noqa: E402
                   touches, union, overlap_area)

CONTAINER_TYPES = {"rectangle", "ellipse", "diamond"}


class DSU:
    def __init__(self, items):
        self.p = {i: i for i in items}

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def restructure(doc, min_frame_area=60000, gap=2.0, caption_gap=14.0, leftover_gap=60.0, pad=16.0):
    els = live(doc)
    taken = {e["id"] for e in doc["elements"]}
    existing_frames = [e for e in els if e["type"] in ("frame", "magicframe")]
    work = [e for e in els if e["type"] not in ("frame", "magicframe")
            and not e.get("frameId") and not e.get("groupIds") and not e.get("containerId")]
    box = {e["id"]: bbox(e) for e in els}
    ar = {i: area(b) for i, b in box.items()}
    bound_text = defaultdict(list)  # container id -> bound text elements (they follow the container)
    for e in els:
        if e.get("containerId"):
            bound_text[e["containerId"]].append(e)

    # ---- containment tree ----
    work_sorted = sorted(work, key=lambda e: -ar[e["id"]])
    holders = [e for e in work_sorted if e["type"] in CONTAINER_TYPES]
    parent = {}
    for e in work:
        best = None
        for h in holders:
            if ar[h["id"]] <= ar[e["id"]] or h["id"] == e["id"]:
                continue
            if inside(box[e["id"]], box[h["id"]]) and (best is None or ar[h["id"]] < ar[best]):
                best = h["id"]
        parent[e["id"]] = best
    children = defaultdict(list)
    for e in work:
        children[parent[e["id"]]].append(e)
    containers = {h["id"] for h in holders if len(children[h["id"]]) >= 2}
    # an enclosing shape with < 2 children is just a shape; re-parent its child upward
    for e in work:
        p = parent[e["id"]]
        while p is not None and p not in containers:
            p = parent[p]
        parent[e["id"]] = p
    children = defaultdict(list)
    for e in work:
        children[parent[e["id"]]].append(e)

    def descendants(cid):
        out, stack = [], list(children[cid])
        while stack:
            x = stack.pop()
            out.append(x)
            stack.extend(children[x["id"]])
        return out

    by_id = {e["id"]: e for e in els}

    def heading(scope_el, members):
        """Panel title = the real words closest to the panel's top-left corner (titles sit there);
        for free-floating clusters, the biggest text. Single glyphs like '?' are tile art, not titles."""
        texts = [m for m in members if m["type"] == "text" and len((m.get("text") or "").strip()) >= 3]
        if not texts:
            return None
        if scope_el is not None:
            x0, y0 = box[scope_el["id"]][:2]
            t = min(texts, key=lambda t: (box[t["id"]][1] - y0) + 0.2 * (box[t["id"]][0] - x0)
                    - 0.5 * t.get("fontSize", 0))
        else:
            t = max(texts, key=lambda t: (t.get("fontSize", 0), -box[t["id"]][1]))
        return t["text"].split("\n")[0].strip()[:80]

    # ---- frames ----
    frames = []  # (frame element, member elements, scope container id or None)
    sections = [e for e in children[None] if e["id"] in containers
                and ar[e["id"]] >= min_frame_area and len(descendants(e["id"])) >= 3]
    blocked = [box[f["id"]] for f in existing_frames] + [box[s["id"]] for s in sections]
    for s in sections:
        members = [s] + descendants(s["id"])
        name = heading(s, descendants(s["id"])) or "Section"
        frames.append((make_frame(new_id("frm_", taken), name, box[s["id"]]), members, s["id"]))

    section_ids = {s["id"] for s in sections}
    loose = [e for e in children[None] if e["id"] not in section_ids]
    # Stragglers: text that starts in a panel but runs past its edge. Attach to the section
    # it overlaps, growing that frame if it stays clear of its neighbours.
    keep_loose = []
    for e in loose:
        unit = [e] + descendants(e["id"])
        ub = union(box[m["id"]] for m in unit)
        best = None
        for i, (f, _, _) in enumerate(frames):
            fb = bbox(f)
            # must overlap or sit on the edge; a title floating above a panel is not its straggler
            score = overlap_area(ub, fb) + 1 if touches(ub, fb, gap=2) else 0
            if score > 0 and (best is None or score > best[0]):
                best = (score, i)
        if best is not None:
            f, members, _ = frames[best[1]]
            grown = union([bbox(f), ub])
            others = [box[x["id"]] for x in existing_frames] + [
                bbox(g) for j, (g, _, _) in enumerate(frames) if j != best[1]]
            if not any(overlap_area(grown, o) > 0 for o in others):
                f["x"], f["y"] = grown[0], grown[1]
                f["width"], f["height"] = grown[2] - grown[0], grown[3] - grown[1]
                members.extend(unit)
                continue
        keep_loose.append(e)
    loose = keep_loose
    blocked = [box[f["id"]] for f in existing_frames] + [bbox(f) for f, _, _ in frames]
    unframed = []
    if loose:
        units = {e["id"]: [e] + descendants(e["id"]) for e in loose}
        d = DSU(list(units))
        ids = list(units)
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if touches(box[a], box[b], gap=leftover_gap):
                    d.union(a, b)
        clusters = defaultdict(list)
        for i in ids:
            clusters[d.find(i)].extend(units[i])
        for members in clusters.values():
            b = union(box[m["id"]] for m in members)
            p = pad
            while p >= 0:
                fb = (b[0] - p, b[1] - p, b[2] + p, b[3] + p)
                if not any(overlap_area(fb, o) > 0 for o in blocked):
                    break
                p -= 4
            if p < 0:
                unframed.extend(members)
                continue
            blocked.append(fb)
            name = heading(None, members) or "Notes"
            frames.append((make_frame(new_id("frm_", taken), name, fb), members, None))

    # unique names
    seen = defaultdict(int)
    for f, _, _ in frames:
        seen[f["name"]] += 1
        if seen[f["name"]] > 1:
            f["name"] = f"{f['name']} ({seen[f['name']]})"

    # ---- groups (deepest containers first so groupIds stay innermost -> outermost) ----
    group_of = defaultdict(list)
    depth = {}

    def d_of(i):
        if i not in depth:
            depth[i] = 0 if parent.get(i) is None else d_of(parent[i]) + 1
        return depth[i]

    n_groups = 0
    scope_list = sorted([c for c in containers if c not in section_ids], key=lambda c: -d_of(c))
    scopes = [(c, children[c]) for c in scope_list]  # sub-containers: group the whole thing + split inside
    for f, members, sid in frames:
        if sid is not None:
            scopes.append((sid, children[sid]))
        else:
            scopes.append((None, [m for m in members if parent[m["id"]] is None]))

    def assign(group_members):
        nonlocal n_groups
        gid = new_id("grp_", taken)
        n_groups += 1
        for m in group_members:
            group_of[m["id"]].append(gid)
            for bt in bound_text.get(m["id"], []):
                group_of[bt["id"]].append(gid)

    def is_connector(e):
        """Long open lines/arrows (baselines, leader lines, transitions) link objects; they are not
        part of one. Closed polylines are pixel-art polygons and count as shapes."""
        if e["type"] not in ("line", "arrow") or e.get("polygon"):
            return False
        pts = e.get("points") or []
        if len(pts) > 2 and pts[0] == pts[-1]:
            return False
        b = box[e["id"]]
        return max(b[2] - b[0], b[3] - b[1]) >= 60

    def cluster(ids, allow):
        dsu = DSU(ids)
        ids = sorted(ids, key=lambda i: box[i][0])
        for i, a in enumerate(ids):
            ea, ba = by_id[a], box[a]
            for b in ids[i + 1:]:
                bb, eb = box[b], by_id[b]
                if bb[0] > ba[2] + max(gap, caption_gap):
                    break
                ta, tb = ea["type"] == "text", eb["type"] == "text"
                if (ta and tb) or not allow(ea, eb):
                    continue
                if touches(ba, bb, gap=gap):
                    dsu.union(a, b)
                elif ta != tb:  # caption: text just above/below a shape, mostly overlapping it horizontally
                    t, s = (ba, bb) if ta else (bb, ba)
                    hov = min(t[2], s[2]) - max(t[0], s[0])
                    vgap = max(s[1] - t[3], t[1] - s[3])
                    if 0 <= vgap <= caption_gap and hov >= 0.5 * (t[2] - t[0]):
                        dsu.union(a, b)
        return dsu

    for sid, direct in scopes:
        unit_members = {e["id"]: [e] + descendants(e["id"]) for e in direct}
        ids = list(unit_members)
        conn = {i for i in ids if is_connector(by_id[i])}
        # 1) objects: touching parts, ignoring connectors (so a shared baseline doesn't fuse 9 poses)
        d1 = cluster([i for i in ids if i not in conn], lambda a, b: True)
        objects = defaultdict(list)
        for i in ids:
            if i not in conn:
                objects[d1.find(i)].append(i)
        for comp in objects.values():
            if len(comp) >= 2:
                assign([m for i in comp for m in unit_members[i]])
        # 2) diagrams: connectors join several objects into an outer group (boxes + transition arrows)
        if conn:
            d2 = cluster(ids, lambda a, b: a["id"] in conn or b["id"] in conn)
            for comp in objects.values():
                for i in comp[1:]:
                    d2.union(comp[0], i)
            diagrams = defaultdict(list)
            for i in ids:
                diagrams[d2.find(i)].append(i)
            for comp in diagrams.values():
                n_obj = len({d1.find(i) for i in comp if i not in conn})
                if any(i in conn for i in comp) and n_obj >= 1 and len(comp) >= 2 and len(comp) < len(ids):
                    assign([m for i in comp for m in unit_members[i]])
        # 3) the sub-container itself is an object: background + everything it holds
        if sid is not None and sid not in section_ids:
            assign([by_id[sid]] + descendants(sid))

    # ---- apply ----
    now = int(time.time() * 1000)
    touched = set()
    frame_of = {}
    for f, members, _ in frames:
        for m in members:
            frame_of[m["id"]] = f["id"]
            for bt in bound_text.get(m["id"], []):
                frame_of[bt["id"]] = f["id"]
    for e in els:
        if e["id"] in frame_of:
            e["frameId"] = frame_of[e["id"]]
            touched.add(e["id"])
        if group_of.get(e["id"]):
            e["groupIds"] = (e.get("groupIds") or []) + group_of[e["id"]]
            touched.add(e["id"])
    for e in els:
        if e["id"] in touched:
            e["version"] = e.get("version", 1) + 1
            e["updated"] = now

    # children directly before their frame; keep everything else in original z-order
    frame_els = {f["id"]: f for f, _, _ in frames}
    blocks = defaultdict(list)
    for e in doc["elements"]:
        if e.get("frameId") in frame_els:
            blocks[e["frameId"]].append(e)
    out, emitted = [], set()
    for e in doc["elements"]:
        fid = e.get("frameId")
        if fid in frame_els:
            if fid not in emitted:
                emitted.add(fid)
                out.extend(blocks[fid])
                out.append(frame_els[fid])
        else:
            out.append(e)
    doc["elements"] = out
    reindex(out)
    for key in ("veistra", "kaava"):
        if isinstance(doc.get(key), dict):
            doc[key]["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            doc[key]["updated_by"] = "agent"

    sizes = defaultdict(int)
    for e in els:
        for g in e.get("groupIds") or []:
            sizes[g] += 1
    return {
        "frames": [(f["name"], len(m)) for f, m, _ in frames],
        "groups": n_groups,
        "largest_groups": sorted(sizes.values(), reverse=True)[:5],
        "unframed": [f"{e['id']} {e['type']} {label(e)!r}" for e in unframed],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--out")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-frame-area", type=float, default=60000)
    a = ap.parse_args()
    doc = load(a.path)
    r = restructure(doc, min_frame_area=a.min_frame_area)
    print(f"{len(r['frames'])} frames, {r['groups']} groups, largest groups: {r['largest_groups']}")
    for name, n in r["frames"]:
        print(f"  frame {name!r}: {n} elements")
    for u in r["unframed"]:
        print(f"  UNFRAMED (would overlap another frame): {u}")
    if a.dry_run:
        return
    out = a.out or a.path
    if out == a.path:
        shutil.copyfile(a.path, a.path + ".bak")
    save(out, doc)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
