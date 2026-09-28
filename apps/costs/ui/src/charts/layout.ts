/**
 * Docked vs expanded is chosen by the app's own pane width, not the window's
 * — the host decides how much room this app gets, and a docked rail pane can
 * be wider than a narrow expanded one (`docs/design/COST-TRACKER-CHARTS.md`
 * §5, `docs/design/KAAVA-UX-SPEC.md` boards 06 and 11).
 */
export type Layout = "docked" | "expanded";

/** Below this, the docked reading — C1 plus categories only — fits; above it, the full page. */
export const DOCKED_MAX_WIDTH = 700;

export function layoutFor(width: number): Layout {
  return width < DOCKED_MAX_WIDTH ? "docked" : "expanded";
}
