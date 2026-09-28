import { describe, expect, it } from "vitest";
import { DOCKED_MAX_WIDTH, layoutFor } from "./layout";

describe("layoutFor", () => {
  it("is docked below the threshold and expanded from it up", () => {
    expect(layoutFor(DOCKED_MAX_WIDTH - 1)).toBe("docked");
    expect(layoutFor(DOCKED_MAX_WIDTH)).toBe("expanded");
    expect(layoutFor(DOCKED_MAX_WIDTH + 200)).toBe("expanded");
  });

  it("is docked at zero, before any measurement has landed", () => {
    expect(layoutFor(0)).toBe("docked");
  });
});
