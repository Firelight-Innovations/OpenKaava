import { describe, expect, it } from "vitest";
import { viewMissesContent, type ViewBox } from "./viewFit";
import type { SceneElement } from "./scene";

const box = (x: number, y: number): SceneElement => ({
  id: `${x},${y}`,
  type: "rectangle",
  x,
  y,
  width: 100,
  height: 50,
});

const view = (over: Partial<ViewBox> = {}): ViewBox => ({
  scrollX: 0,
  scrollY: 0,
  zoom: { value: 1 },
  width: 800,
  height: 600,
  ...over,
});

describe("viewMissesContent", () => {
  it("is false when an element is in view", () => {
    expect(viewMissesContent([box(10, 10)], view())).toBe(false);
  });

  it("is true when every element is far outside the viewport", () => {
    expect(viewMissesContent([box(50000, 50000), box(-9000, 4000)], view())).toBe(true);
  });

  it("follows scroll and zoom", () => {
    const far = box(5000, 5000);
    expect(viewMissesContent([far], view())).toBe(true);
    expect(viewMissesContent([far], view({ scrollX: -4900, scrollY: -4900 }))).toBe(false);
    expect(
      viewMissesContent([far], view({ zoom: { value: 0.1 }, width: 8000, height: 6000 })),
    ).toBe(false);
  });

  it("is false for an empty or fully deleted scene", () => {
    expect(viewMissesContent([], view())).toBe(false);
    expect(viewMissesContent([{ ...box(90000, 0), isDeleted: true }], view())).toBe(false);
  });
});
