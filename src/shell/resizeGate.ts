/**
 * "A user is dragging a splitter right now", as one window-wide signal.
 *
 * Every drag handle in the shell (the bottom band, the docked page, pane
 * dividers, the worktree panel's section divider) calls `beginResize()` when
 * the gesture starts and the function it returns when it ends. The terminal
 * reads the signal and does no fit and sends no pty resize until the last
 * drag is over, then fits once. Fitting on every pointermove tears the
 * emulator's canvas down and rebuilds it 60 times a second, which flickers and
 * has corrupted the pty's idea of its own size before.
 *
 * A counter rather than a boolean so two overlapping gestures cannot release
 * each other. Losing window focus ends every drag: the `pointerup` a drag was
 * waiting for goes to another window and never arrives.
 */

let active = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Marks a drag as started. Call the result once when it ends; extra calls do nothing. */
export function beginResize(): () => void {
  active += 1;
  if (active === 1) emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    if (active === 0) emit();
  };
}

export function isResizing(): boolean {
  return active > 0;
}

/** Called when the first drag starts and when the last one ends. Returns an unsubscribe. */
export function subscribeResizing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forces the signal off. Only for the window-blur backstop and for tests. */
export function resetResizing(): void {
  if (active === 0) return;
  active = 0;
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("blur", resetResizing);
}
