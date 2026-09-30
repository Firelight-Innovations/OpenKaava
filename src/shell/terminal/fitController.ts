/**
 * When the terminal is allowed to refit, kept apart from xterm so it can be
 * tested with plain fakes.
 *
 * - While a splitter drag is in progress nothing is fitted and no pty resize is
 *   sent; the old canvas stays where it is, clipped by its container.
 * - When the drag ends there is exactly one fit and one pty resize.
 * - Any other size change (window maximise, a panel opening, the Context strip
 *   changing side or collapsing) is debounced: one fit after the size has been
 *   stable for `delayMs`, never one per frame.
 * - A container that is hidden or 0x0 is never fitted. The first real size
 *   after that is fitted at once, so switching tabs does not show a stale grid.
 */

export interface FitDeps {
  /** The container's current box. */
  measure: () => { width: number; height: number };
  /** What the addon would choose; `undefined` when it cannot say. */
  propose: () => { cols: number; rows: number } | undefined;
  fit: () => void;
  resize: (cols: number, rows: number) => void;
  isResizing: () => boolean;
  subscribeResizing: (listener: () => void) => () => void;
  delayMs?: number;
}

export const FIT_DEBOUNCE_MS = 120;

export interface FitController {
  /** The container's size may have changed. */
  notify: () => void;
  dispose: () => void;
}

export function createFitController(deps: FitDeps): FitController {
  const delay = deps.delayMs ?? FIT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasFitted = false;
  let wasHidden = true;
  let last: { cols: number; rows: number } | null = null;
  let disposed = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const run = () => {
    timer = null;
    if (disposed || deps.isResizing()) return;
    const box = deps.measure();
    if (!(box.width > 0) || !(box.height > 0)) {
      wasHidden = true;
      return;
    }
    const dims = deps.propose();
    if (
      !dims ||
      !Number.isFinite(dims.cols) ||
      !Number.isFinite(dims.rows) ||
      dims.cols <= 0 ||
      dims.rows <= 0
    ) {
      return;
    }
    wasHidden = false;
    hasFitted = true;
    deps.fit();
    if (last && last.cols === dims.cols && last.rows === dims.rows) return;
    last = { cols: dims.cols, rows: dims.rows };
    deps.resize(dims.cols, dims.rows);
  };

  const notify = () => {
    if (disposed || deps.isResizing()) return;
    const box = deps.measure();
    if (!(box.width > 0) || !(box.height > 0)) {
      clear();
      wasHidden = true;
      return;
    }
    clear();
    if (!hasFitted || wasHidden) {
      run();
      return;
    }
    timer = setTimeout(run, delay);
  };

  const unsubscribe = deps.subscribeResizing(() => {
    if (disposed) return;
    clear();
    // Drag started: whatever was waiting is stale, the size is still moving.
    // Drag ended: one fit for wherever it was let go.
    if (!deps.isResizing()) run();
  });

  return {
    notify,
    dispose: () => {
      disposed = true;
      clear();
      unsubscribe();
    },
  };
}
