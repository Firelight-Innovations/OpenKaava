import { describe, expect, it } from "vitest";
import { activeSegment, planSegment } from "./modeRules";

describe("the lit segment", () => {
  it("is Steps whenever Steps is chosen, whatever the preview says", () => {
    expect(activeSegment("steps", "preview")).toBe("steps");
    expect(activeSegment("steps", null)).toBe("steps");
  });

  it("is Preview for a rendered or split file, Code otherwise", () => {
    expect(activeSegment("code", "preview")).toBe("preview");
    expect(activeSegment("code", "side")).toBe("preview");
    expect(activeSegment("code", "source")).toBe("code");
    expect(activeSegment("code", null)).toBe("code");
  });
});

describe("clicking a segment", () => {
  it("Steps never touches the preview", () => {
    expect(planSegment("steps", "preview")).toEqual({ view: "steps", toggle: false });
  });

  it("Code flips a rendered file back to source and leaves source alone", () => {
    expect(planSegment("code", "preview").toggle).toBe(true);
    expect(planSegment("code", "side").toggle).toBe(true);
    expect(planSegment("code", "source").toggle).toBe(false);
  });

  it("Preview flips source to rendered and leaves rendered alone", () => {
    expect(planSegment("preview", "source").toggle).toBe(true);
    expect(planSegment("preview", "preview").toggle).toBe(false);
  });

  it("a file with no rendered form has no flip to make", () => {
    expect(planSegment("code", null)).toEqual({ view: "code", toggle: false });
  });
});
