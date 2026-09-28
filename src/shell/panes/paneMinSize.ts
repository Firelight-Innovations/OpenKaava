/**
 * The minimum share a divider drag may leave either side — KAAVA-UX-SPEC.md
 * §1.5's stated floor of `200 x 120px`, converted to a fraction of the axis a
 * given drag moves along.
 *
 * Split out of `PaneTree.tsx`'s `Split` so the clamp is a pure function of
 * numbers rather than something only reachable by simulating a pointer drag
 * — see `paneMinSize.test.ts`.
 */

/** KAAVA-UX-SPEC.md §1.5: "Minimum pane size per the written spec: 200 x 120 px." */
export const MIN_PANE_WIDTH_PX = 200;
export const MIN_PANE_HEIGHT_PX = 120;

/**
 * The floor `PaneTree.tsx` already enforced before this file existed —
 * `layout.rs`'s own `MIN_SIZE`. Kept as the absolute lower bound alongside
 * the pixel floor below: a window narrow enough that 200px is more than half
 * its width must not let the pixel floor demand more room than there is, and
 * this fractional one is what the backend still enforces regardless, so the
 * frontend clamp should never be looser than it.
 */
export const MIN_SIZE_FRACTION = 0.05;

/**
 * Turn the pixel floor into a fraction of `totalPx`, the full length of the
 * axis a divider moves along (a split's own `container.getBoundingClientRect()`
 * width or height). Never smaller than `MIN_SIZE_FRACTION`, and never more
 * than half of `pairShare` — the two panes on either side of one divider
 * split *something* between them, and a floor greater than half of it would
 * make the pair's combined share unsatisfiable rather than merely tight.
 */
function shareFloor(totalPx: number, minPx: number, pairShare: number): number {
  const pixelShare = totalPx > 0 ? minPx / totalPx : MIN_SIZE_FRACTION;
  const floor = Math.max(MIN_SIZE_FRACTION, pixelShare);
  return Math.min(floor, pairShare / 2);
}

/**
 * Clamp a divider drag's wanted position for the pane *before* it, given the
 * combined share the pair holds (`pairShare`) and the full pixel length of
 * the axis (`totalPx`). `minPx` is `MIN_PANE_WIDTH_PX` for a row split (the
 * divider moves horizontally, so the floor is on width) and
 * `MIN_PANE_HEIGHT_PX` for a column split.
 */
export function clampDividerShare(
  wantedBefore: number,
  pairShare: number,
  totalPx: number,
  minPx: number,
): number {
  const floor = shareFloor(totalPx, minPx, pairShare);
  return Math.min(Math.max(wantedBefore, floor), pairShare - floor);
}
