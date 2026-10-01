import { describe, expect, it } from "vitest";
import {
  ancestry,
  childId,
  childOf,
  hitLinkedFrame,
  linkBadges,
  linkable,
  selectedFrame,
  stillLinked,
  treeOrder,
  viewportToScene,
  withChild,
} from "./nesting";
import type { CanvasSummary } from "./rpc";
import type { SceneElement } from "./scene";

const frame = (id: string, x: number, y: number, w: number, h: number, child?: string) =>
  ({
    id,
    type: "frame",
    x,
    y,
    width: w,
    height: h,
    version: 1,
    versionNonce: 1,
    ...(child ? { customData: { kaava: { child } } } : {}),
  }) as SceneElement;

const row = (id: string, parent: string | null): CanvasSummary => ({
  id,
  title: id,
  parent,
  mtime: 1,
  path: `canvas/${id}.json`,
  error: null,
});

describe("child links on frames", () => {
  it("reads the link from customData.kaava.child, on frames only", () => {
    expect(childOf(frame("f", 0, 0, 1, 1, "levels/ward-b"))).toBe("levels/ward-b");
    expect(childOf(frame("f", 0, 0, 1, 1))).toBeNull();
    const rect = { ...frame("r", 0, 0, 1, 1, "x"), type: "rectangle" } as SceneElement;
    expect(childOf(rect)).toBeNull();
    expect(childOf({ ...frame("d", 0, 0, 1, 1, "x"), isDeleted: true } as SceneElement)).toBeNull();
  });

  it("sets and clears a link, raising the version each time and keeping other custom data", () => {
    const base = { ...frame("f", 0, 0, 1, 1), customData: { other: 1 } } as SceneElement;
    const linked = withChild(base, "a/b");
    expect(childOf(linked)).toBe("a/b");
    expect(linked.version).toBe(2);
    expect((linked.customData as { other: number }).other).toBe(1);
    const cleared = withChild(linked, null);
    expect(childOf(cleared)).toBeNull();
    expect(cleared.version).toBe(3);
    expect(cleared.customData).toEqual({ other: 1 });
    expect(withChild(frame("g", 0, 0, 1, 1, "x"), null).customData).toBeUndefined();
  });

  it("does not mutate the element it was given", () => {
    const base = frame("f", 0, 0, 1, 1);
    withChild(base, "x");
    expect(childOf(base)).toBeNull();
    expect(base.version).toBe(1);
  });
});

describe("selectedFrame", () => {
  const els = [frame("f", 0, 0, 10, 10), { id: "r", type: "rectangle" } as SceneElement];
  it("is the single selected frame", () => {
    expect(selectedFrame(els, { f: true })?.id).toBe("f");
  });
  it("is null for nothing, several, a non-frame, or a false entry", () => {
    expect(selectedFrame(els, {})).toBeNull();
    expect(selectedFrame(els, undefined)).toBeNull();
    expect(selectedFrame(els, { f: true, r: true })).toBeNull();
    expect(selectedFrame(els, { r: true })).toBeNull();
    expect(selectedFrame(els, { f: false })).toBeNull();
  });
});

describe("double-click hit test", () => {
  const view = { scrollX: 100, scrollY: -50, offsetLeft: 10, offsetTop: 20, zoom: { value: 2 } };

  it("maps a click to scene coordinates through scroll, offset and zoom", () => {
    expect(viewportToScene(210, 220, view)).toEqual({ x: 0, y: 150 });
  });

  it("hits a linked frame inside its box and on its title, not outside", () => {
    const f = frame("f", 0, 100, 200, 100, "child");
    expect(hitLinkedFrame([f], { x: 50, y: 150 })?.id).toBe("f");
    expect(hitLinkedFrame([f], { x: 50, y: 80 })?.id).toBe("f");
    expect(hitLinkedFrame([f], { x: 50, y: 50 })).toBeNull();
    expect(hitLinkedFrame([f], { x: 250, y: 150 })).toBeNull();
  });

  it("ignores frames with no link", () => {
    expect(hitLinkedFrame([frame("f", 0, 0, 100, 100)], { x: 50, y: 50 })).toBeNull();
  });

  it("opens the innermost linked frame where two overlap", () => {
    const outer = frame("outer", 0, 0, 500, 500, "o");
    const inner = frame("inner", 100, 100, 50, 50, "i");
    expect(hitLinkedFrame([outer, inner], { x: 120, y: 120 })?.id).toBe("inner");
    expect(hitLinkedFrame([inner, outer], { x: 120, y: 120 })?.id).toBe("inner");
    expect(hitLinkedFrame([outer, inner], { x: 400, y: 400 })?.id).toBe("outer");
  });
});

describe("breadcrumb", () => {
  const rows = [
    row("anomaly", null),
    row("anomaly/levels", "anomaly"),
    row("anomaly/levels/hospital-wing", "anomaly/levels"),
  ];

  it("runs from the root down to the open canvas", () => {
    expect(ancestry(rows, "anomaly/levels/hospital-wing").map((r) => r.title)).toEqual([
      "anomaly",
      "anomaly/levels",
      "anomaly/levels/hospital-wing",
    ]);
    expect(ancestry(rows, "anomaly").map((r) => r.id)).toEqual(["anomaly"]);
  });

  it("stops at a parent that is not there", () => {
    expect(ancestry([row("orphan", "gone")], "orphan").map((r) => r.id)).toEqual(["orphan"]);
    expect(ancestry(rows, "nope")).toEqual([]);
  });

  it("survives a parent cycle", () => {
    const cyclic = [row("a", "b"), row("b", "a")];
    expect(ancestry(cyclic, "a").map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("childId", () => {
  it("puts a child in a folder named after its parent", () => {
    expect(childId("levels", "ward-b")).toBe("levels/ward-b");
    expect(childId("a/b", "c")).toBe("a/b/c");
  });
  it("goes beside the parent at the depth limit", () => {
    expect(childId("a/b/c/d", "e")).toBe("a/b/c/e");
  });
});

describe("treeOrder", () => {
  it("lists children under their parent with a depth", () => {
    const rows = [row("b", "a"), row("a", null), row("c", "b"), row("z", null)];
    expect(treeOrder(rows).map((t) => [t.row.id, t.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["z", 0],
    ]);
  });

  it("keeps a canvas in a parent loop rather than hiding it", () => {
    const rows = [row("a", "b"), row("b", "a")];
    expect(
      treeOrder(rows)
        .map((t) => t.row.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("linkable", () => {
  it("leaves out the current canvas, its ancestors and canvases already nested elsewhere", () => {
    const rows = [
      row("root", null),
      row("mid", "root"),
      row("cur", "mid"),
      row("free", null),
      row("taken", "root"),
    ];
    expect(linkable(rows, "cur").map((r) => r.id)).toEqual(["free"]);
  });
});

describe("stillLinked", () => {
  it("is true while a live frame links to the canvas", () => {
    const f = withChild(frame("a", 0, 0, 10, 100), "kid");
    expect(stillLinked([f], "kid")).toBe(true);
    expect(stillLinked([f], "other")).toBe(false);
    expect(stillLinked([{ ...f, isDeleted: true }], "kid")).toBe(false);
  });
});

describe("linkBadges", () => {
  const view = { scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  const title = (id: string) => `T:${id}`;

  it("puts a chip at the frame's top-right corner, named for the child", () => {
    const f = withChild(frame("a", 100, 50, 300, 100), "world/kid");
    expect(linkBadges([f], view, title)).toEqual([
      { id: "a", child: "world/kid", label: "T:world/kid", right: 400, bottom: 46, compact: false, below: false },
    ]);
  });

  it("moves under the frame when the top edge has no room beside the name label", () => {
    const narrow = { ...withChild(frame("n", 100, 50, 150, 100), "world/kid"), name: "Zone" };
    const [b] = linkBadges([narrow], view, title);
    expect(b).toMatchObject({ below: true, bottom: 50 + 100 + 26 });
    const wide = { ...withChild(frame("w", 100, 50, 400, 100), "kid"), name: "Zone" };
    expect(linkBadges([wide], view, title)[0]?.below).toBe(false);
  });

  it("follows scroll and zoom", () => {
    const f = withChild(frame("a", 100, 50, 300, 100), "kid");
    const [b] = linkBadges([f], { scrollX: -20, scrollY: 10, zoom: { value: 2 } }, title);
    // (100 + 300 - 20) * 2 = 760; (50 + 10) * 2 - 4 = 116
    expect(b).toMatchObject({ right: 760, bottom: 116 });
  });

  it("skips frames with no child and deleted ones, and shrinks tiny ones", () => {
    const plain = frame("p", 0, 0, 300, 100);
    const gone = { ...withChild(frame("g", 0, 0, 300, 100), "kid"), isDeleted: true };
    const small = withChild(frame("s", 0, 0, 100, 100), "kid");
    const tiny = withChild(frame("t", 0, 0, 100, 100), "kid");
    expect(linkBadges([plain, gone], view, title)).toEqual([]);
    expect(linkBadges([small], view, title)[0]?.compact).toBe(true);
    expect(linkBadges([tiny], { ...view, zoom: { value: 0.1 } }, title)).toEqual([]);
  });
});
