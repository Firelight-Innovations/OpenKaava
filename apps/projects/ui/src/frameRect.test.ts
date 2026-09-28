import { describe, expect, it } from "vitest";
import { absoluteBounds, isFrameRect } from "./frameRect";

describe("isFrameRect", () => {
  it("accepts a well-formed rect", () => {
    expect(isFrameRect({ x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  });

  it("rejects anything missing a numeric field", () => {
    expect(isFrameRect(null)).toBe(false);
    expect(isFrameRect(undefined)).toBe(false);
    expect(isFrameRect("nope")).toBe(false);
    expect(isFrameRect({ x: 1, y: 2, width: 3 })).toBe(false);
    expect(isFrameRect({ x: "1", y: 2, width: 3, height: 4 })).toBe(false);
  });
});

describe("absoluteBounds", () => {
  it("adds the iframe's window-space origin to a rect measured inside it", () => {
    const frame = { x: 200, y: 40, width: 900, height: 700 };
    const local = { x: 260, y: 12, width: 640, height: 688 };
    expect(absoluteBounds(frame, local)).toEqual({ x: 460, y: 52, width: 640, height: 688 });
  });

  it("keeps the local width and height untouched", () => {
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    const local = { x: 0, y: 0, width: 321, height: 654 };
    expect(absoluteBounds(frame, local)).toEqual({ x: 0, y: 0, width: 321, height: 654 });
  });
});
