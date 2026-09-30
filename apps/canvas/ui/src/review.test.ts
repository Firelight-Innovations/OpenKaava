import { describe, expect, it } from "vitest";
import {
  diagramKey,
  frameAt,
  frameForKey,
  framesIn,
  regionTarget,
  selectionTarget,
} from "./review";
import type { SceneElement } from "./scene";

const el = (id: string, type: string, x: number, y: number, w: number, h: number, extra = {}) =>
  ({ id, type, x, y, width: w, height: h, version: 1, versionNonce: 1, ...extra }) as SceneElement;

const named = (id: string, diagram: string, x: number, w = 400) =>
  el(id, "frame", x, 0, w, 300, {
    name: `Frame ${diagram}`,
    customData: { kaava: { diagram: { id: diagram, title: `Title ${diagram}`, level: "detail" } } },
  });

const scene: SceneElement[] = [
  named("f-run", "run", 600),
  named("f-states", "states", 0),
  el("plain", "frame", 1200, 0, 200, 200, { name: "Loose" }),
  el("inner", "frame", 20, 20, 100, 100),
  el("a", "rectangle", 30, 30, 20, 20, { frameId: "inner" }),
  el("b", "rectangle", 200, 200, 20, 20, { frameId: "f-states" }),
  el("c", "rectangle", 700, 100, 20, 20, { frameId: "f-run" }),
  el("stray", "rectangle", 5000, 5000, 20, 20),
  el("gone", "frame", 0, 0, 5000, 5000, { isDeleted: true }),
];

describe("framesIn", () => {
  it("lists live frames left to right, with the diagram's title when named", () => {
    const rows = framesIn(scene);
    expect(rows.map((r) => r.elementId)).toEqual(["f-states", "inner", "f-run", "plain"]);
    expect(rows[0]).toMatchObject({ diagramId: "states", title: "Title states", level: "detail" });
    expect(rows[3]).toMatchObject({ diagramId: null, title: "Loose" });
    expect(rows[1]!.title).toBe("Untitled frame");
  });
});

describe("frameAt", () => {
  it("picks the smallest frame containing the point and ignores deleted ones", () => {
    expect(frameAt(scene, 50, 50)?.id).toBe("inner");
    expect(frameAt(scene, 300, 250)?.id).toBe("f-states");
    expect(frameAt(scene, 4000, 4000)).toBeNull();
  });
});

describe("selectionTarget", () => {
  it("asks for a selection when there is none", () => {
    expect(selectionTarget(scene, {})).toHaveProperty("error");
    expect(selectionTarget(scene, { b: false })).toHaveProperty("error");
  });

  it("targets the frame the selected elements share", () => {
    expect(selectionTarget(scene, { b: true })).toEqual({
      frameId: "f-states",
      elementIds: ["b"],
    });
  });

  it("treats a selected frame as its own target", () => {
    expect(selectionTarget(scene, { "f-run": true })).toEqual({
      frameId: "f-run",
      elementIds: ["f-run"],
    });
  });

  it("refuses a selection spread over two frames or outside every frame", () => {
    expect(selectionTarget(scene, { b: true, c: true })).toEqual({
      error: "Select things in one frame at a time.",
    });
    expect(selectionTarget(scene, { stray: true })).toHaveProperty("error");
  });
});

describe("regionTarget", () => {
  it("returns a frame-relative region, whichever way the box was dragged", () => {
    const forward = regionTarget(scene, { x: 650, y: 50, width: 100, height: 60 });
    const backward = regionTarget(scene, { x: 750, y: 110, width: -100, height: -60 });
    expect(forward).toEqual({ frameId: "f-run", region: { x: 50, y: 50, width: 100, height: 60 } });
    expect(backward).toEqual(forward);
  });

  it("clips the region to the frame and rounds it", () => {
    const r = regionTarget(scene, { x: 940.4, y: 250.6, width: 100, height: 40 });
    expect(r).toEqual({ frameId: "f-run", region: { x: 340, y: 251, width: 60, height: 40 } });
  });

  it("refuses a click-sized box and a box outside every frame", () => {
    expect(regionTarget(scene, { x: 650, y: 50, width: 2, height: 2 })).toHaveProperty("error");
    expect(regionTarget(scene, { x: 4000, y: 4000, width: 50, height: 50 })).toHaveProperty(
      "error",
    );
  });
});

describe("diagram keys", () => {
  it("stores a named frame by its diagram id and a plain one by element id", () => {
    expect(diagramKey(scene, "f-run")).toBe("run");
    expect(diagramKey(scene, "plain")).toBe("plain");
  });

  it("finds the frame again from either key", () => {
    expect(frameForKey(scene, "run")?.id).toBe("f-run");
    expect(frameForKey(scene, "f-run")?.id).toBe("f-run");
    expect(frameForKey(scene, "plain")?.id).toBe("plain");
    expect(frameForKey(scene, "gone")).toBeNull();
  });
});
