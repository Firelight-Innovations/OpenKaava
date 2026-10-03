import { describe, expect, it } from "vitest";
import {
  PANES_MIN_WIDTH,
  PAGE_SQUEEZED_MIN,
  PROJECT_RAIL_GAP,
  clampPageWidth,
  pageGeometry,
  pageWidthFromPointer,
  slotFilled,
} from "./pageGeometry";

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

describe("clampPageWidth", () => {
  const rail = 44;

  it("leaves the page alone in a window with room, like main", () => {
    expect(clampPageWidth(380, 2000, rail, 320, 640)).toBe(380);
    expect(clampPageWidth(900, 2000, rail, 320, 640)).toBe(640);
    expect(clampPageWidth(100, 2000, rail, 320, 640)).toBe(320);
  });

  // The popped-out window opens at 900px: a page saved at 640 in main left 209px for the panes.
  it("keeps the panes their minimum in a popped-out window", () => {
    const width = clampPageWidth(640, 900, rail, 320, 640);
    expect(900 - rail - PROJECT_RAIL_GAP - width).toBeGreaterThanOrEqual(PANES_MIN_WIDTH);
  });

  it("squeezes below the page minimum in the smallest window rather than crush the panes", () => {
    const width = clampPageWidth(380, 480, rail, 320, 640);
    expect(width).toBe(PAGE_SQUEEZED_MIN);
  });

  it("never returns less than the squeezed floor or more than max", () => {
    expect(clampPageWidth(380, 0, rail, 320, 640)).toBe(PAGE_SQUEEZED_MIN);
    expect(clampPageWidth(380, Number.POSITIVE_INFINITY, rail, 320, 640)).toBe(380);
  });
});
