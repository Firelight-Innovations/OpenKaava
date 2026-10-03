import { describe, expect, it } from "vitest";
import { sameOrder, stableOrder } from "./stableOrder";

describe("stableOrder", () => {
  it("keeps the order a tab was first rendered in when it moves to another pane", () => {
    // Layout order after canvas-8 is dragged from the left pane into the right one.
    expect(stableOrder(["canvas-8", "home-2", "term-4"], ["home-2", "term-4", "canvas-8"])).toEqual(
      ["canvas-8", "home-2", "term-4"],
    );
  });

  it("drops closed tabs and appends new ones at the end", () => {
    expect(stableOrder(["a", "b", "c"], ["c", "d", "a"])).toEqual(["a", "c", "d"]);
  });

  it("starts from the layout order", () => {
    expect(stableOrder([], ["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("sameOrder", () => {
  it("compares content and order", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
  });
});
