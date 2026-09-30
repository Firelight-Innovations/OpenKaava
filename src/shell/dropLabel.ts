import type { DropTarget } from "./contract";

/**
 * What the floating hint bar says while a tab is in the air — board 07's
 * "Split right | Ctrl copy | Esc cancel" strip, minus the middle clause:
 * nothing in the backend can duplicate an instance, so this never claims a
 * modifier that does not exist rather than draw one that silently does
 * nothing. `null` means no hint at all, either because nothing is being
 * dragged or because the target has nothing worth saying (`none`, which a
 * tab never actually resolves to — see `useDrag`'s `resolve`).
 *
 * A pure function of the target so it is trivially testable and so a reader
 * never has to know the five zones' names itself. A shared leaf module
 * (STANDARDS.md §1.2) rather than something under `drag/`: `panes/PaneTree.tsx`
 * reads it too, for the label drawn on a pane's own edge indicator, and a
 * region may not reach into another region's directory.
 */
export function dropLabel(target: DropTarget | null): string | null {
  if (!target) return null;
  switch (target.kind) {
    case "pane":
      if (target.edge === "row") return target.before ? "Split left" : "Split right";
      if (target.edge === "column") return target.before ? "Split up" : "Split down";
      return "Add as tab";
    case "strip":
      return "Add as tab";
    case "cluster":
      return target.refused ? "Can't move here — different environment" : "Move into this cluster";
    case "new-cluster":
      return "Open in a new cluster";
    case "panel":
      return "Move to the terminal panel";
    case "detach":
      return "Release to open a new window";
    case "none":
      return null;
  }
}
