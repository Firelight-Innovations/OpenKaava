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
