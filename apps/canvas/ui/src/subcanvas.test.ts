import { describe, expect, it } from "vitest";
import { signature, toSaved, type SceneElement } from "./scene";
import {
  HEAVY_CANVAS,
  isSnapshot,
  placeSnapshots,
  sceneVersion,
  snapshotIdFor,
  splitCandidates,
  subcanvasChild,
  subcanvasFrames,
  syncFrames,
} from "./subcanvas";

const frame = (id: string, extra: Record<string, unknown> = {}): SceneElement => ({
  id,
  type: "frame",
  name: id,
  x: 100,
  y: 50,
  width: 400,
  height: 300,
  version: 1,
  ...extra,
});

const split = (id: string, child: string) =>
  frame(id, {
    customData: { kaava: { child, subcanvas: true } },
    link: `kaava://canvas/${child}`,
  });

const rect = (id: string, frameId: string | null): SceneElement => ({
  id,
  type: "rectangle",
  frameId,
  version: 1,
});

describe("sub-canvas frames", () => {
  it("are frames marked subcanvas with a child, and nothing else", () => {
    const linkedOnly = frame("f2", { customData: { kaava: { child: "game/b" } } });
    const elements = [split("f1", "game/a"), linkedOnly, rect("r", "f1")];
    expect(subcanvasChild(elements[0]!)).toBe("game/a");
    expect(subcanvasChild(linkedOnly)).toBeNull();
    expect(subcanvasFrames(elements).map((f) => f.child)).toEqual(["game/a"]);
    expect(subcanvasChild({ ...split("f3", "game/c"), isDeleted: true })).toBeNull();
  });
});

describe("splitCandidates", () => {
  it("offers nothing on a light canvas, and counts heavy unlinked frames on a big one", () => {
    const light = [frame("f1"), ...Array.from({ length: 50 }, (_, n) => rect(`r${n}`, "f1"))];
    expect(splitCandidates(light)).toBe(0);
    const heavy: SceneElement[] = [frame("f1"), frame("f2"), split("f3", "x/y")];
    for (let n = 0; n < HEAVY_CANVAS; n++) heavy.push(rect(`a${n}`, n % 2 ? "f1" : null));
    heavy.push(...Array.from({ length: 10 }, (_, n) => rect(`b${n}`, "f2")));
    expect(splitCandidates(heavy)).toBe(1);
  });
});

describe("placeSnapshots", () => {
  it("puts one locked picture just before each sub-canvas frame", () => {
    const elements = [rect("r", null), split("f1", "game/a"), frame("f2")];
    const out = placeSnapshots(elements, new Map([["f1", { fileId: "file-1" }]]))!;
    expect(out.map((e) => e.id)).toEqual(["r", snapshotIdFor("f1"), "f1", "f2"]);
    const pic = out[1]!;
    expect(pic).toMatchObject({
      type: "image",
      fileId: "file-1",
      frameId: "f1",
      locked: true,
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
    expect(isSnapshot(pic)).toBe(true);
  });

  it("answers null when the pictures are already in place, and replaces a stale one", () => {
    const pictures = new Map([["f1", { fileId: "file-1" }]]);
    const once = placeSnapshots([split("f1", "game/a")], pictures)!;
    expect(placeSnapshots(once, pictures)).toBeNull();
    const again = placeSnapshots(once, new Map([["f1", { fileId: "file-2" }]]))!;
    expect(again[0]).toMatchObject({ fileId: "file-2", version: 2 });
    expect(placeSnapshots(once, new Map())!.map((e) => e.id)).toEqual(["f1"]);
  });
});

describe("syncFrames", () => {
  it("resizes and renames a sub-canvas frame to its child's frame", () => {
    const elements = [split("f1", "game/a"), frame("f2")];
    const out = syncFrames(
      elements,
      new Map([["game/a", { width: 900, height: 300, name: "Renamed" }]]),
    )!;
    expect(out[0]).toMatchObject({ width: 900, name: "Renamed", version: 2 });
    expect(out[1]).toBe(elements[1]);
    expect(
      syncFrames(out, new Map([["game/a", { width: 900, height: 300, name: "Renamed" }]])),
    ).toBeNull();
  });
});

describe("saving a parent", () => {
  it("never writes the pictures, or their files, so they cannot change the signature", () => {
    const elements = [split("f1", "game/a")];
    const before = toSaved(elements, {}, {}, undefined);
    const placed = placeSnapshots(elements, new Map([["f1", { fileId: "pic" }]]))!;
    const after = toSaved(placed, {}, { pic: { id: "pic", dataURL: "data:" } }, undefined);
    expect(after.elements.map((e) => e.id)).toEqual(["f1"]);
    expect(after.files).toEqual({});
    expect(signature(after)).toBe(signature(before));
  });
});

describe("sceneVersion", () => {
  it("changes when an element is edited in place", () => {
    const elements = [rect("r", null)];
    const v = sceneVersion(elements);
    elements[0]!.version = 2;
    expect(sceneVersion(elements)).not.toBe(v);
  });
});
