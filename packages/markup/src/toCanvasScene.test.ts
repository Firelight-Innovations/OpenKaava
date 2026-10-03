import { describe, expect, it } from "vitest";
import { arrow, el, pin } from "./fixtures";
import { buildMarkupJson } from "./format";
import { FRAME_ELEMENT_ID, toCanvasScene } from "./toCanvasScene";

const json = buildMarkupJson({
  host: {
    describe: () => ({ kind: "image", path: "r.png" }),
    size: () => ({ width: 640, height: 480 }),
  },
  elements: [
    arrow("a", 100, 50, 60, 0),
    { ...el({ id: "gone", type: "freedraw" }), isDeleted: true },
    { ...el({ id: "locked", type: "rectangle", x: 1, y: 2 }), locked: true },
    ...pin(1, 200, 200),
  ],
});

describe("toCanvasScene", () => {
  const scene = toCanvasScene(json, "file-1");

  it("is an Excalidraw scene with no files yet", () => {
    expect(scene.type).toBe("excalidraw");
    expect(scene.version).toBe(2);
    expect(scene.files).toEqual({});
  });

  it("starts with the frame as a locked image at the origin", () => {
    const [frame] = scene.elements;
    expect(frame).toMatchObject({
      id: FRAME_ELEMENT_ID,
      type: "image",
      fileId: "file-1",
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      locked: true,
      status: "saved",
    });
  });

  it("keeps the ink where it was over the host, above the frame", () => {
    const a = scene.elements.find((e) => e.id === "a");
    expect(a).toMatchObject({ x: 100, y: 50 });
    expect(scene.elements.indexOf(a!)).toBeGreaterThan(0);
  });

  it("carries pins along with their data", () => {
    const m = scene.elements.find((e) => e.id === "m1");
    expect(m?.customData).toEqual({ kaava: { kind: "pin", n: 1, note: "note 1" } });
  });

  it("drops deleted elements and unlocks ink", () => {
    expect(scene.elements.some((e) => e.id === "gone")).toBe(false);
    expect(scene.elements.find((e) => e.id === "locked")?.locked).toBe(false);
  });

  it("offsets the frame and the ink together", () => {
    const moved = toCanvasScene(json, "f", { origin: { x: 1000, y: -200 } });
    expect(moved.elements[0]).toMatchObject({ x: 1000, y: -200 });
    expect(moved.elements.find((e) => e.id === "a")).toMatchObject({ x: 1100, y: -150 });
    expect(moved.elements.find((e) => e.id === "m1")).toMatchObject({ x: 1184, y: -16 });
  });

  it("does not mutate the markup it was given", () => {
    const before = JSON.stringify(json);
    toCanvasScene(json, "f", { origin: { x: 5, y: 5 } });
    expect(JSON.stringify(json)).toBe(before);
  });
});
