/**
 * Dragging a row out of the tree and onto a terminal.
 *
 * This app cannot see where the drag goes. It draws inside an iframe, and an
 * iframe's pointer events stop at its own edge. So the gesture is split: this
 * half owns the *press* and says `veistra/drag` when one becomes a drag and again
 * when it is released; the shell owns everything after that, and nothing comes
 * back. What that costs, what it deliberately does not tell this app, and why
 * pointer capture was the wrong answer: `docs/design-notes/drag-files-to-terminal.md`.
 */
import { useCallback } from "react";
import { invoke } from "@veistra/bridge";
import type { Row } from "./useTree";

/**
 * How far the pointer travels before a press becomes a drag. Four pixels, the
 * number `src/shell/drag/useDrag.tsx` uses and for its reason: a row's
 * `onClick` selects it, so a press that never moves stays a click. Restated
 * rather than shared — `rpc.ts` gives the rule, that nothing in `apps/files/`
 * may reach into `src/`.
 */
const PRESS_THRESHOLD = 4;

/** Fire-and-forget. A refusal means the shell declined the drag, which this app
 *  cannot act on and will not draw — but it must not be a silently rejected
 *  promise either. */
function tell(phase: "begin" | "end", paths: string[]): void {
  void invoke("veistra/drag", { phase, paths }).catch((e: unknown) => {
    console.error(`veistra: files could not report a ${phase} drag`, e);
  });
}

/** What a row spreads onto itself to become draggable. */
export interface RowDragProps {
  onPointerDown: (event: React.PointerEvent) => void;
}

/** How the last press takes its listeners down, if it has not already. One slot
 *  at module scope, because there is one pointer. It exists for the release this
 *  document never sees — let go over the shell's chrome and `pointerup` goes to
 *  the shell, so the handlers below never run and never remove themselves.
 *  Clearing the previous press bounds the leak at one stale set. */
let endPreviousPress: (() => void) | null = null;

/**
 * A factory rather than props, so an undragged row pays nothing beyond one
 * handler — `TreeRow` renders up to 30,000 times and its header is explicit
 * that the cheapest element wins. The whole gesture lives inside
 * `onPointerDown`, as the shell's `useDrag` does: local closures, added on press
 * and removed by the one `detach` closing over them, so no re-render can add one
 * function and remove another.
 */
export function useRowDrag(): (row: Row) => RowDragProps {
  return useCallback(
    (row: Row): RowDragProps => ({
      onPointerDown: (event: React.PointerEvent) => {
        // Only the primary button. A right-click opens the context menu, and a
        // gesture begun there would have no release to end it.
        if (event.button !== 0) return;
        endPreviousPress?.();

        // Deliberately no `setPointerCapture`. The shell's own window listeners
        // are what track this once the cursor leaves the frame, and capturing
        // here would keep routing the pointer into this document instead —
        // the one thing that would stop a drag ever reaching a terminal.
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        let began = false;

        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId || began) return;
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < PRESS_THRESHOLD) return;
          began = true;
          tell("begin", [row.entry.path]);
        };

        const detach = () => {
          endPreviousPress = null;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onEnd);
          window.removeEventListener("pointercancel", onEnd);
        };

        const onEnd = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          detach();
          // Only a drag that began has anything to end: a press that stayed a
          // click never told the shell anything. Reaching here means the release
          // was inside this frame, the only one this document is sent — so this
          // is the gesture's *cancel* half, never its drop half.
          if (began) tell("end", []);
        };

        endPreviousPress = detach;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
      },
    }),
    [],
  );
}
