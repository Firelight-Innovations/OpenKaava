import { describe, expect, it } from "vitest";
import {
  activeHighlights,
  placement,
  sceneBox,
  toScreen,
  unionBox,
  type HighlightSpec,
} from "./commentHighlight";
import type { SceneElement } from "./scene";

const el = (id: string, type: string, x: number, y: number, w: number, h: number, extra = {}) =>
  ({ id, type, x, y, width: w, height: h, version: 1, versionNonce: 1, ...extra }) as SceneElement;

const scene = [
  el("f", "frame", 100, 200, 800, 600, {
    customData: { kaava: { diagram: { id: "world" } } },
  }),
  el("a", "rectangle", 150, 250, 100, 50),
  el("b", "rectangle", 400, 400, 60, 80),
  el("dead", "rectangle", 0, 0, 5000, 5000, { isDeleted: true }),
];

const still = { scrollX: 0, scrollY: 0 };

describe("unionBox", () => {
  it("spans every named live element", () => {
    expect(unionBox(scene, ["a", "b"])).toEqual({ x: 150, y: 250, width: 310, height: 230 });
  });
  it("ignores deleted and unknown ids", () => {
    expect(unionBox(scene, ["dead", "nope"])).toBeNull();
    expect(unionBox(scene, ["a", "dead"])).toEqual({ x: 150, y: 250, width: 100, height: 50 });
  });
});

describe("sceneBox", () => {
  it("offsets a region by its frame, found by diagram name", () => {
    const spec: HighlightSpec = {
      frameId: "world",
      region: { x: 10, y: 20, width: 30, height: 40 },
    };
    expect(sceneBox(scene, spec)).toEqual({ x: 110, y: 220, width: 30, height: 40 });
  });
  it("falls back to the frame when its elements are gone", () => {
    expect(sceneBox(scene, { frameId: "f", elementIds: ["gone"] })).toEqual({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    });
  });
  it("is null when the frame is gone too", () => {
    expect(sceneBox(scene, { frameId: "zzz", elementIds: ["gone"] })).toBeNull();
    expect(
      sceneBox(scene, { frameId: "zzz", region: { x: 0, y: 0, width: 5, height: 5 } }),
    ).toBeNull();
  });
});

describe("toScreen", () => {
  it("applies scroll then zoom, as Excalidraw does", () => {
    const got = toScreen(
      { x: 10, y: 20, width: 30, height: 40 },
      { scrollX: 5, scrollY: -10, zoom: { value: 2 } },
    );
    expect(got).toEqual({ x: 30, y: 20, width: 60, height: 80 });
  });
});

describe("placement", () => {
  const size = { width: 1000, height: 800 };
  it("pads the border and hangs the pin off the top-left corner", () => {
    const p = placement({ x: 300, y: 300, width: 100, height: 50 }, size);
    expect(p.rect).toEqual({ x: 296, y: 296, width: 108, height: 58 });
    expect(p.pin.x).toBeLessThan(p.rect.x + 12);
    expect(p.pin.y).toBeLessThan(p.rect.y + 12);
    expect(p.offscreen).toBe(false);
  });
  it("clamps the pin inside the editor when the corner is out of view", () => {
    const p = placement({ x: -500, y: 100, width: 300, height: 100 }, size);
    expect(p.pin.x).toBeGreaterThanOrEqual(12);
    expect(p.pin.y).toBeGreaterThanOrEqual(12);
    expect(p.leader).not.toBeNull();
  });
  it("draws no leader when the pin already touches the border", () => {
    expect(placement({ x: 300, y: 300, width: 100, height: 50 }, size).leader).toBeNull();
  });
  it("flags a box wholly outside the viewport and still pins to an edge", () => {
    const p = placement({ x: 5000, y: 100, width: 10, height: 10 }, size);
    expect(p.offscreen).toBe(true);
    expect(p.pin.x).toBeLessThanOrEqual(size.width);
  });
  it("tracks zoom: a zoomed-out box gives a smaller border", () => {
    const box = { x: 0, y: 0, width: 400, height: 400 };
    const big = placement(toScreen(box, { ...still, zoom: { value: 1 } }), size);
    const small = placement(toScreen(box, { ...still, zoom: { value: 0.25 } }), size);
    expect(small.rect.width).toBeLessThan(big.rect.width);
  });
});

describe("activeHighlights", () => {
  const spec: HighlightSpec = { frameId: "f", elementIds: ["a"] };
  it("is empty with nothing to show", () => {
    expect(activeHighlights(null, null)).toEqual([]);
  });
  it("shows the draft and a hovered open comment together", () => {
    const got = activeHighlights(spec, { id: "c1", status: "open", spec });
    expect(got.map((h) => h.key)).toEqual(["draft", "c:c1"]);
  });
  it("skips resolved comments", () => {
    expect(activeHighlights(null, { id: "c1", status: "resolved", spec })).toEqual([]);
  });
});
