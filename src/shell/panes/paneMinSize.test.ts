import { describe, expect, it } from "vitest";
import { clampDividerShare, MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from "./paneMinSize";

describe("clampDividerShare", () => {
  it("passes a wanted position through when it clears the floor on both sides", () => {
    // 1000px row split, pair holds the whole thing: 200px floor is 20%.
    expect(clampDividerShare(0.5, 1, 1000, MIN_PANE_WIDTH_PX)).toBe(0.5);
  });

  it("clamps to the pixel floor when the drag asks for less than 200px", () => {
    // 100px would be 10%, under the 20% floor on a 1000px axis.
    expect(clampDividerShare(0.1, 1, 1000, MIN_PANE_WIDTH_PX)).toBeCloseTo(0.2);
  });

  it("clamps the far side the same way, symmetrically", () => {
    expect(clampDividerShare(0.95, 1, 1000, MIN_PANE_WIDTH_PX)).toBeCloseTo(0.8);
  });

  it("uses the height floor for a column split", () => {
    // 120px floor on an 800px axis is 15%.
    expect(clampDividerShare(0.05, 1, 800, MIN_PANE_HEIGHT_PX)).toBeCloseTo(0.15);
  });

  it("never demands more than half the pair's own share", () => {
    // A tiny 100px axis makes the 200px floor exceed the whole pair; the
    // clamp settles on the midpoint rather than an unsatisfiable range.
    expect(clampDividerShare(0.5, 0.3, 100, MIN_PANE_WIDTH_PX)).toBeCloseTo(0.15);
  });

  it("still applies the 5% fractional floor when the axis is very large", () => {
    // 200px on a 100 000px axis is 0.2% — the fractional floor wins instead.
    expect(clampDividerShare(0.001, 1, 100_000, MIN_PANE_WIDTH_PX)).toBeCloseTo(0.05);
  });
});
