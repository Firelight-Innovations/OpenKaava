import type { ReactNode } from "react";

/**
 * Whether a slot holds anything React would draw.
 *
 * `!== undefined` is not enough. A caller writes `rightPage && <DockedPage/>`,
 * and with no page open that is `null`, not `undefined`. The old check let
 * `null` through, so `Frame` drew an empty bordered column beside the panes
 * whenever no page was open.
 */
export function slotFilled(slot: ReactNode): boolean {
  return slot !== undefined && slot !== null && slot !== false && slot !== "";
}

/**
 * Which of the project page's two geometries `Frame` draws, if either.
 *
 * At most one is true. With no page open both are false, and `Frame` draws no
 * docked column, no handle and no border: the panes run up to the rail.
 */
export function pageGeometry(
  docked: ReactNode,
  expanded: ReactNode,
  wantExpanded: boolean,
): { docked: boolean; expanded: boolean } {
  const showExpanded = wantExpanded && slotFilled(expanded);
  return {
    docked: !wantExpanded && slotFilled(docked),
    expanded: showExpanded,
  };
}

/** What sits between the docked page's right edge and the window's: the right-hand
 *  box's 6px margin and its 1px border. */
export const PROJECT_RAIL_GAP = 7;

/** The least width the panes keep when a docked page is as wide as the window allows. */
export const PANES_MIN_WIDTH = 240;
/** The narrowest a docked page is squeezed to in a window too small for its normal minimum. */
export const PAGE_SQUEEZED_MIN = 200;

/**
 * A docked page's width, held to what the window it is in can afford.
 *
 * `min`/`max` are the page's own range. They are absolute, which is right for the main window and
 * wrong for a popped-out one: those open at 900px and can be dragged down to 480, where a page at
 * its 320px minimum plus the rail left about 100px for the panes, and one saved at 640 pushed the
 * rail off the window's edge. The page therefore yields first: it may not take more than leaves
 * `PANES_MIN_WIDTH` for the panes, and gives up its own minimum down to `PAGE_SQUEEZED_MIN` to
 * keep that.
 */
export function clampPageWidth(
  raw: number,
  rowWidth: number,
  railWidth: number,
  min: number,
  max: number,
): number {
  const room = rowWidth - railWidth - PROJECT_RAIL_GAP - PANES_MIN_WIDTH;
  const ceiling = Math.min(max, Math.max(PAGE_SQUEEZED_MIN, room));
  return Math.min(Math.max(raw, Math.min(min, ceiling)), ceiling);
}

/** The docked page's width with its handle dragged to `clientX`. The box's
 *  margin and border count, or the page lands `PROJECT_RAIL_GAP` px off the pointer. */
export function pageWidthFromPointer(rowRight: number, railWidth: number, clientX: number): number {
  return rowRight - railWidth - PROJECT_RAIL_GAP - clientX;
}
