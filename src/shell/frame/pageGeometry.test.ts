import { describe, expect, it } from "vitest";
import { PROJECT_RAIL_GAP, pageGeometry, pageWidthFromPointer, slotFilled } from "./pageGeometry";

describe("slotFilled", () => {
  it("treats every value React draws nothing for as empty", () => {
    for (const empty of [undefined, null, false, ""]) expect(slotFilled(empty)).toBe(false);
  });

  it("treats an element, text or a number as filled", () => {
    expect(slotFilled("page")).toBe(true);
    expect(slotFilled(0)).toBe(true);
    expect(slotFilled({ type: "div", props: {}, key: null } as never)).toBe(true);
  });
});

describe("pageGeometry", () => {
  const page = "page body";

  // The bug this module exists for: `rightPage && <DockedPage/>` is `null` with
  // no page open, and the old `!== undefined` check drew an empty column for it.
  it("draws no docked column when no page is open", () => {
    expect(pageGeometry(null, null, false)).toEqual({ docked: false, expanded: false });
    expect(pageGeometry(undefined, undefined, false)).toEqual({
      docked: false,
      expanded: false,
    });
  });

  it("draws the docked column for a docked page", () => {
    expect(pageGeometry(page, page, false)).toEqual({ docked: true, expanded: false });
  });

  it("draws only the expanded geometry for an expanded page", () => {
    expect(pageGeometry(page, page, true)).toEqual({ docked: false, expanded: true });
  });

  it("draws neither when expanded is asked for with nothing to expand", () => {
    expect(pageGeometry(page, null, true)).toEqual({ docked: false, expanded: false });
  });
});

describe("pageWidthFromPointer", () => {
  // The page's right edge is the right-hand box's margin (6px) and border (1px)
  // further in than the window's, and forgetting them lands the page 7px off.
  it("measures from the page's own right edge, past the rail, margin and border", () => {
    expect(PROJECT_RAIL_GAP).toBe(7);
    expect(pageWidthFromPointer(1000, 44, 500)).toBe(449);
  });

  it("is wider the further left the pointer goes", () => {
    expect(pageWidthFromPointer(1000, 44, 400)).toBe(549);
  });
});
