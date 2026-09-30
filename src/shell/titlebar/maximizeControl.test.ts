import { describe, expect, it } from "vitest";
import { maximizeControl } from "./maximizeControl";

describe("maximizeControl", () => {
  it("offers Maximise with a single square while the window is not maximised", () => {
    expect(maximizeControl(false)).toEqual({ icon: "maximise", label: "Maximise" });
  });

  it("offers Restore with the two-square icon while the window is maximised", () => {
    expect(maximizeControl(true)).toEqual({ icon: "restore", label: "Restore" });
  });
});
