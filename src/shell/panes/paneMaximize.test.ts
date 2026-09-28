import { describe, expect, it } from "vitest";
import { toggleMaximize } from "./paneMaximize";

describe("toggleMaximize", () => {
  it("maximises a pane that was not maximised", () => {
    expect(toggleMaximize(null, "pane-1")).toBe("pane-1");
  });

  it("restores when the same pane is toggled again", () => {
    expect(toggleMaximize("pane-1", "pane-1")).toBeNull();
  });

  it("switches straight to a different pane without needing a restore first", () => {
    expect(toggleMaximize("pane-1", "pane-2")).toBe("pane-2");
  });
});
