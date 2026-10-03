import { describe, expect, it } from "vitest";
import { COMPACT_FOOTER_BELOW, footerIsCompact } from "./layout";

describe("footerIsCompact", () => {
  it("collapses secondary footer labels in a 740px pane", () => {
    expect(footerIsCompact(740)).toBe(true);
  });

  it("keeps every label in a wide pane", () => {
    expect(footerIsCompact(COMPACT_FOOTER_BELOW)).toBe(false);
    expect(footerIsCompact(1400)).toBe(false);
  });

  it("does not collapse before the pane has been measured", () => {
    expect(footerIsCompact(0)).toBe(false);
  });
});
