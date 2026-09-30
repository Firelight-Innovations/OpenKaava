import { describe, expect, it } from "vitest";
import { arrow, el, pin, pose } from "./fixtures";
import { buildMarkupJson, isMarkupJson } from "./format";
import { annotateTargets } from "./targets";

const host = {
  describe: () => ({ kind: "scene", glb: "assets/house.glb" }),
  size: () => ({ width: 800, height: 600 }),
};

describe("buildMarkupJson", () => {
  const stamped = annotateTargets(
    [
      arrow("a", 100, 100, 50, 0),
      el({ id: "box", type: "rectangle", x: 0, y: 0, width: 40, height: 20 }),
      el({ id: "lbl", type: "text", text: "wrong height", containerId: "box" }),
      el({ id: "free", type: "text", text: "check this", x: 5, y: 5 }),
      el({ id: "gone", type: "freedraw", isDeleted: true }),
    ],
    () => ({ nodePath: "Root/Wall", worldPoint: [0, 1, 0] }),
  );
  const json = buildMarkupJson({
    host,
    elements: [...stamped, ...pin(2, 30, 30, [1, 1, 1]), ...pin(1, 10, 10)],
    camera: pose(3),
  });

  it("has the documented top-level shape", () => {
    expect(Object.keys(json).sort()).toEqual(
      ["annotations", "camera", "excalidraw", "pins", "size", "source", "version"].sort(),
    );
    expect(json.version).toBe(1);
    expect(json.source).toEqual({ kind: "scene", glb: "assets/house.glb" });
    expect(json.size).toEqual({ width: 800, height: 600 });
    expect(json.camera).toEqual(pose(3));
    expect(isMarkupJson(json)).toBe(true);
  });

  it("lists pins in number order with only the fields that exist", () => {
    expect(json.pins).toEqual([
      { n: 1, note: "note 1" },
      { n: 2, note: "note 2", nodePath: "Root/Node2", worldPoint: [1, 1, 1] },
    ]);
  });

  it("lists annotations without pins, bound labels or deleted ink", () => {
    expect(json.annotations.map((a) => a.kind)).toEqual(["arrow", "rectangle", "text"]);
  });

  it("attaches targets, bounds and the text of a bound label", () => {
    const [arrowA, box, free] = json.annotations;
    expect(arrowA.targets).toEqual([{ nodePath: "Root/Wall", worldPoint: [0, 1, 0], at: "head" }]);
    expect(arrowA.bounds).toEqual({ x: 100, y: 100, width: 50, height: 0 });
    expect(box.text).toBe("wrong height");
    expect(free.text).toBe("check this");
    expect(free.targets).toBeUndefined();
  });

  it("carries the live elements and a transparent background", () => {
    expect(json.excalidraw.elements.some((e) => e.id === "gone")).toBe(false);
    expect(json.excalidraw.appState).toEqual({ viewBackgroundColor: "transparent" });
  });

  it("omits the camera for a host that has none", () => {
    const noCam = buildMarkupJson({ host, elements: [] });
    expect("camera" in noCam).toBe(false);
    expect(noCam.pins).toEqual([]);
  });

  it("survives a JSON round trip", () => {
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("isMarkupJson", () => {
  it("rejects other versions and other shapes", () => {
    expect(isMarkupJson(null)).toBe(false);
    expect(isMarkupJson({ version: 2 })).toBe(false);
    expect(isMarkupJson({ type: "excalidraw", elements: [] })).toBe(false);
  });
});
