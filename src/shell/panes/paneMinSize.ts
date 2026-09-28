/**
 * The minimum share a divider drag may leave either side — KAAVA-UX-SPEC.md
 * §1.5's floor of `200 x 120px`, as a fraction of the axis a drag moves
 * along. Split out of `PaneTree.tsx`'s `Split` so the clamp is a pure,
 * directly-tested function rather than something reachable only by
 * simulating a pointer drag.
 */

/** KAAVA-UX-SPEC.md §1.5's stated floor. */
export const MIN_PANE_WIDTH_PX = 200;
export const MIN_PANE_HEIGHT_PX = 120;

/** `layout.rs`'s own `MIN_SIZE`, already enforced on the backend. The
 *  frontend clamp must never be looser than it. */
export const MIN_SIZE_FRACTION = 0.05;

/**
 * The pixel floor as a fraction of `totalPx`. Never below
 * `MIN_SIZE_FRACTION`, and never above half of `pairShare`, since a floor
 * past half would make the pair's combined share unsatisfiable.
 */
function shareFloor(totalPx: number, minPx: number, pairShare: number): number {
  const pixelShare = totalPx > 0 ? minPx / totalPx : MIN_SIZE_FRACTION;
  const floor = Math.max(MIN_SIZE_FRACTION, pixelShare);
  return Math.min(floor, pairShare / 2);
}

/**
 * Clamp a divider drag's wanted position for the pane *before* it. `minPx`
 * is `MIN_PANE_WIDTH_PX` for a row split, `MIN_PANE_HEIGHT_PX` for a column.
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
