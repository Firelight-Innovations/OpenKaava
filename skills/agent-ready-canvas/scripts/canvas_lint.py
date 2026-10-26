"""Check that a canvas is agent-ready: every element lives in a named frame, and every multi-part
object (sprite, table, labelled box, diagram) is a group or a bound container, so one click or one
selection hands an agent the whole object.

Usage: python canvas_lint.py canvas/foo.json [--json] [--max-issues 15]
Exit code 0 = pass, 1 = fail.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from excal import bbox, inside, live, load, overlap_area, area, touches, label  # noqa: E402

GENERIC_NAME = re.compile(r"^\s*(frame|section|group|untitled|new frame)?\s*\d*\s*$", re.I)


def lint(doc):
    els = live(doc)
    by_id = {e["id"]: e for e in els}
    frames = [e for e in els if e["type"] in ("frame", "magicframe")]
    content = [e for e in els if e["type"] not in ("frame", "magicframe")]
    issues = defaultdict(list)

    # --- frames ---
    names = Counter((f.get("name") or "").strip() for f in frames)
    for f in frames:
        n = (f.get("name") or "").strip()
        if not n or GENERIC_NAME.match(n):
            issues["frame_unnamed"].append(f"{f['id']} has generic name {n!r}")
        elif names[n] > 1:
            issues["frame_duplicate_name"].append(f"{f['id']} {n!r}")
        if f.get("frameId"):
            issues["frame_nested"].append(f"{f['id']} {n!r} sits inside frame {f['frameId']}")
    for a in range(len(frames)):
        for b in range(a + 1, len(frames)):
            ba, bb = bbox(frames[a]), bbox(frames[b])
            if overlap_area(ba, bb) > 0.02 * min(area(ba), area(bb)):
                issues["frame_overlap"].append(f"{frames[a].get('name')!r} overlaps {frames[b].get('name')!r}")

    # --- frame membership ---
    framed = [e for e in content if e.get("frameId") in by_id]
    for e in content:
        if e.get("containerId"):  # bound text follows its container
            continue
        fid = e.get("frameId")
        if not fid:
            issues["outside_frame"].append(f"{e['id']} {e['type']} {label(e)!r}")
        elif fid not in by_id:
            issues["dangling_frame_ref"].append(f"{e['id']} -> missing frame {fid}")
        elif not inside(bbox(e), bbox(by_id[fid]), tol=2):
            issues["clipped_by_frame"].append(f"{e['id']} {e['type']} pokes outside {by_id[fid].get('name')!r}")

    # --- groups ---
    group_frames = defaultdict(set)
    for e in content:
        for g in e.get("groupIds") or []:
            group_frames[g].add(e.get("frameId"))
    for g, fs in group_frames.items():
        if len(fs) > 1:
            issues["group_spans_frames"].append(f"group {g} spans {len(fs)} frames")

    def linked(a, b):
        if a.get("containerId") == b["id"] or b.get("containerId") == a["id"]:
            return True
        return bool(set(a.get("groupIds") or []) & set(b.get("groupIds") or []))

    # Fragments: two small parts that touch but share no group = a multi-part object that will be
    # selected one stray piece at a time. Large backgrounds (panels) are allowed to stand alone.
    by_frame = defaultdict(list)
    for e in content:
        by_frame[e.get("frameId")].append(e)
    frag_ids, unbound = set(), []
    for fid, items in by_frame.items():
        fb = bbox(by_id[fid]) if fid in by_id else None
        small = [e for e in items if not fb or area(bbox(e)) < 0.25 * area(fb)]
        boxes = {e["id"]: bbox(e) for e in small}
        small.sort(key=lambda e: boxes[e["id"]][0])
        for i, a in enumerate(small):
            ba = boxes[a["id"]]
            for b in small[i + 1:]:
                bb = boxes[b["id"]]
                if bb[0] > ba[2] + 1:
                    break
                if a["type"] == "text" and b["type"] == "text":
                    continue
                if touches(ba, bb, gap=1) and not linked(a, b):
                    contain = inside(ba, bb) or inside(bb, ba)
                    big, little = (b, a) if area(bb) >= area(ba) else (a, b)
                    if contain and little["type"] == "text" and big["type"] in ("rectangle", "ellipse", "diamond"):
                        unbound.append(f"{little['id']} {label(little)!r} sits in {big['id']} but is not bound/grouped")
                    else:
                        frag_ids.update((a["id"], b["id"]))
    issues["loose_label"] = unbound
    if frag_ids:
        issues["loose_fragments"] = [f"{len(frag_ids)} touching parts share no group, e.g. "
                                     + ", ".join(sorted(frag_ids)[:8])]

    grouped = [e for e in content if e.get("groupIds") or e.get("containerId")
               or any(x.get("containerId") == e["id"] for x in content)]
    stats = {
        "elements": len(content), "frames": len(frames),
        "framed_pct": round(100 * len(framed) / max(1, len(content)), 1),
        "groups": len(group_frames),
        "grouped_pct": round(100 * len(grouped) / max(1, len(content)), 1),
        "loose_fragment_elements": len(frag_ids),
        "loose_fragment_pct": round(100 * len(frag_ids) / max(1, len(content)), 1),
        "frame_names": [f.get("name") for f in frames],
    }
    # Hard failures break agent selection outright; warnings are worth fixing but tolerable.
    hard = ["frame_unnamed", "frame_duplicate_name", "frame_nested", "outside_frame",
            "dangling_frame_ref", "clipped_by_frame", "group_spans_frames", "loose_label"]
    failed = [k for k in hard if issues.get(k)]
    if len(content) >= 10 and not frames:
        failed.insert(0, "no_frames")
    if stats["loose_fragment_pct"] > 2:
        failed.append("loose_fragments")
    return {"pass": not failed, "failed_checks": failed, "stats": stats,
            "issues": {k: v for k, v in issues.items() if v}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--max-issues", type=int, default=15)
    a = ap.parse_args()
    r = lint(load(a.path))
    if a.json:
        print(json.dumps(r, indent=2))
    else:
        s = r["stats"]
        print(f"{a.path}: {'PASS' if r['pass'] else 'FAIL'}")
        print(f"  {s['elements']} elements, {s['frames']} frames, {s['framed_pct']}% framed, "
              f"{s['groups']} groups, {s['grouped_pct']}% grouped/bound, "
              f"{s['loose_fragment_elements']} loose fragments ({s['loose_fragment_pct']}% of elements)")
        if s["frame_names"]:
            print("  frames: " + " | ".join(map(str, s["frame_names"])))
        for k, v in r["issues"].items():
            print(f"  [{'FAIL' if k in r['failed_checks'] else 'warn'}] {k}: {len(v)}")
            for line in v[:a.max_issues]:
                print(f"      {line}")
            if len(v) > a.max_issues:
                print(f"      ... {len(v) - a.max_issues} more")
        if "no_frames" in r["failed_checks"]:
            print("  [FAIL] no_frames: canvas has content but no frames")
    sys.exit(0 if r["pass"] else 1)


if __name__ == "__main__":
    main()
