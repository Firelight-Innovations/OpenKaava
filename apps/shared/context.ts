/**
 * What every app that hands things to an agent shares: the slice of a
 * `ContextItem` an app reads back, and the press handler that turns a moved
 * press into a drag of one context item onto a terminal. The store itself
 * (`context/put`, the strip beside each terminal) is the host's; see
 * `apps/README.md`, "Context: pushing things to an agent".
 */
import { invoke } from "@openkaava/bridge";

/** The slice of `ContextItem` an app reads back. */
export interface ContextRef {
  id: string;
}

const PRESS_THRESHOLD = 4;

function tell(phase: "begin" | "end", items: string[]): void {
  void invoke("kaava/drag", { phase, items }).catch((e: unknown) => {
    console.error(`kaava: the app could not report a ${phase} drag`, e);
  });
}

let endPrevious: (() => void) | null = null;

/**
 * Press handler that turns a moved press into a drag of one context item. The
 * item is registered lazily, when the press becomes a drag, because most
 * presses are clicks and should not fill the store. Same split as Files: this
 * half reports begin and cancel; the shell owns the drop.
 */
export function dragContext(put: () => Promise<ContextRef>) {
  return (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    endPrevious?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let began = false;
    let live = true;

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || began) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < PRESS_THRESHOLD) return;
      began = true;
      void put()
        .then((item) => {
          // Released while the put was in flight: there is nothing to drag.
          if (live) tell("begin", [item.id]);
        })
        .catch((err: unknown) => console.error("kaava: the app could not add context", err));
    };
    const detach = () => {
      live = false;
      endPrevious = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const wasDrag = began;
      detach();
      if (wasDrag) tell("end", []);
    };
    endPrevious = detach;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
}
