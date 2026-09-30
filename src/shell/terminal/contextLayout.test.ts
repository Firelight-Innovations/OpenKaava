import { describe, expect, it } from "vitest";
import {
  BOTTOM_ABOVE_ASPECT,
  BOTTOM_BELOW_WIDTH,
  SIDE_ABOVE_WIDTH,
  SIDE_BELOW_ASPECT,
  nextStripLayout,
  type StripLayout,
} from "./contextLayout";

describe("nextStripLayout", () => {
  it("puts a tall narrow dock on the bottom (Braden's 700 x 950)", () => {
    expect(nextStripLayout("side", { width: 700, height: 950 })).toBe("bottom");
  });

  it("keeps a wide pane on the side", () => {
    expect(nextStripLayout("side", { width: 1200, height: 700 })).toBe("side");
  });

  it("goes to the bottom when the pane is narrow even if it is not tall", () => {
    expect(nextStripLayout("side", { width: BOTTOM_BELOW_WIDTH - 1, height: 300 })).toBe("bottom");
  });

  it("ignores a hidden or unmeasured pane", () => {
    expect(nextStripLayout("bottom", { width: 0, height: 0 })).toBe("bottom");
    expect(nextStripLayout("side", { width: 0, height: 800 })).toBe("side");
  });

  it("does not flip while a pane hovers around either threshold", () => {
    // Widths straddling the enter/leave bands, height low so only width decides.
    let layout: StripLayout = "side";
    const seen: StripLayout[] = [];
    for (const width of [600, 559, 580, 620, 639, 620, 600, 559, 630]) {
      layout = nextStripLayout(layout, { width, height: 400 });
      seen.push(layout);
    }
    // Entered the bottom once at 559 and stayed until a width past 640 was needed.
    expect(seen).toEqual([
      "side",
      "bottom",
      "bottom",
      "bottom",
      "bottom",
      "bottom",
      "bottom",
      "bottom",
      "bottom",
    ]);
    expect(nextStripLayout("bottom", { width: SIDE_ABOVE_WIDTH + 1, height: 400 })).toBe("side");
  });

  it("uses a separate aspect band to come back", () => {
    const width = 900;
    const enter = width * BOTTOM_ABOVE_ASPECT + 1;
    const between = width * ((BOTTOM_ABOVE_ASPECT + SIDE_BELOW_ASPECT) / 2);
    const leave = width * SIDE_BELOW_ASPECT - 1;
    expect(nextStripLayout("side", { width, height: between })).toBe("side");
    expect(nextStripLayout("side", { width, height: enter })).toBe("bottom");
    expect(nextStripLayout("bottom", { width, height: between })).toBe("bottom");
    expect(nextStripLayout("bottom", { width, height: leave })).toBe("side");
  });
});
