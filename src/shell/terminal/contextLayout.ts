/**
 * Which side of the terminal the Context strip sits on.
 *
 * Decided from the terminal pane's own measured box, never the window's. A tall,
 * narrow pane puts the strip on the bottom as a band, because a 200px column
 * would take a third of its width and truncate every path; a wide pane keeps the
 * column.
 *
 * Two bands, so a pane hovering around one threshold does not flip the layout
 * back and forth: it takes a clearly narrow or clearly tall pane to go to the
 * bottom, and a clearly wide and clearly not tall one to come back. In between,
 * the layout stays as it was.
 */

export type StripLayout = "side" | "bottom";

/** Below this width the column costs too much of the terminal. */
export const BOTTOM_BELOW_WIDTH = 560;
/** Back to the side only above this width. */
export const SIDE_ABOVE_WIDTH = 640;
/** Bottom once height exceeds width by this factor. */
export const BOTTOM_ABOVE_ASPECT = 1.15;
/** Back to the side only once height/width is below this. */
export const SIDE_BELOW_ASPECT = 1.0;

export function nextStripLayout(
  prev: StripLayout,
  box: { width: number; height: number },
): StripLayout {
  // A hidden or not-yet-laid-out pane says nothing; keep what we had.
  if (!(box.width > 0) || !(box.height > 0)) return prev;
  const aspect = box.height / box.width;
  if (prev === "side") {
    return box.width < BOTTOM_BELOW_WIDTH || aspect > BOTTOM_ABOVE_ASPECT ? "bottom" : "side";
  }
  return box.width > SIDE_ABOVE_WIDTH && aspect < SIDE_BELOW_ASPECT ? "side" : "bottom";
}
