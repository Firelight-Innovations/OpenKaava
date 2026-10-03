import { describe, expect, it } from "vitest";
import { MAX_PNG_SIDE, frameBounds, inkOrigin, pngLayout } from "./composite";

describe("pngLayout", () => {
  it("is the viewport times the device pixel ratio", () => {
    expect(pngLayout({ width: 800, height: 600 }, 2)).toEqual({
      width: 1600,
      height: 1200,
      scale: 2,
    });
  });

  it("rounds fractional sizes and keeps at least one pixel", () => {
    expect(pngLayout({ width: 333, height: 100 }, 1.5)).toMatchObject({ width: 500, height: 150 });
    expect(pngLayout({ width: 0, height: 0 }, 2)).toMatchObject({ width: 1, height: 1 });
  });

  it("falls back to 1 for a nonsense ratio", () => {
    expect(pngLayout({ width: 10, height: 10 }, 0).scale).toBe(1);
    expect(pngLayout({ width: 10, height: 10 }, Number.NaN).scale).toBe(1);
  });

  it("caps the longest side and keeps the aspect ratio", () => {
    const l = pngLayout({ width: 4000, height: 2000 }, 3);
    expect(l.width).toBe(MAX_PNG_SIDE);
    expect(l.height).toBe(MAX_PNG_SIDE / 2);
    expect(l.scale).toBeCloseTo(MAX_PNG_SIDE / 4000);
  });
});

describe("inkOrigin", () => {
  it("scales the scene offset of the exported ink", () => {
    expect(inkOrigin(0, 0, 2)).toEqual({ x: 0, y: 0 });
    expect(inkOrigin(-10.5, 4, 2)).toEqual({ x: -21, y: 8 });
  });
});

describe("frameBounds", () => {
  it("spans the whole viewport from the origin", () => {
    expect(frameBounds({ width: 640, height: 480 })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
  });
});
