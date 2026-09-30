import { describe, expect, it } from "vitest";
import { ACCENT_KEY, selectStyle } from "./selectStyle";
import type { SelectOption } from "../../../bindings";

function options(...labels: string[]): SelectOption[] {
  return labels.map((label) => ({ value: label.toLowerCase(), label, description: "" }));
}

describe("selectStyle", () => {
  it("draws the accent as swatches whatever its options are", () => {
    expect(selectStyle(ACCENT_KEY, options("Blue", "Amber", "Green", "Violet", "Coral"))).toBe(
      "swatches",
    );
  });

  it("draws Dark, Light and System as a segmented control", () => {
    expect(selectStyle("appearance.theme", options("Dark", "Light", "System"))).toBe("segmented");
  });

  it("draws the line-number choices as a segmented control", () => {
    expect(selectStyle("editor.lineNumbers", options("On", "Off", "Relative"))).toBe("segmented");
  });

  it("falls back to a menu past four options", () => {
    expect(selectStyle("x", options("A", "B", "C", "D", "E"))).toBe("menu");
  });

  it("falls back to a menu when the labels are too wide for a track", () => {
    expect(selectStyle("x", options("Never", "Except between words", "Always"))).toBe("menu");
  });
});
