import { describe, expect, it } from "vitest";
import { sameWindowRect, windowRectOfPane } from "./surfaceRect";

describe("windowRectOfPane", () => {
  it("adds the container's own window offset to a container-relative pane rect", () => {
    const rect = windowRectOfPane(
      { left: 40, top: 24 },
      { left: 100, top: 60, width: 300, height: 200 },
    );
    expect(rect).toEqual({ x: 140, y: 84, width: 300, height: 200 });
  });

  it("passes width and height through unchanged — only position is relative", () => {
    const rect = windowRectOfPane(
      { left: 0, top: 0 },
      { left: 10, top: 20, width: 640, height: 480 },
    );
    expect(rect).toEqual({ x: 10, y: 20, width: 640, height: 480 });
  });
});

describe("sameWindowRect", () => {
  it("treats a sub-pixel difference as no change", () => {
    const a = { x: 10, y: 10, width: 100, height: 100 };
    const b = { x: 10.2, y: 9.9, width: 100, height: 100 };
    expect(sameWindowRect(a, b)).toBe(true);
  });

  it("treats a real move as a change", () => {
    const a = { x: 10, y: 10, width: 100, height: 100 };
    const b = { x: 12, y: 10, width: 100, height: 100 };
    expect(sameWindowRect(a, b)).toBe(false);
  });
});
