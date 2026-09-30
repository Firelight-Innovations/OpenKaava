/**
 * A trailing debounce with `cancel` and `flush`, for renderer resizes.
 *
 * Resizing a WebGL drawing buffer reallocates it and blanks the canvas until
 * the next frame, so doing it at splitter-drag frequency flickers. Between
 * calls the canvas keeps its old buffer, stretched by CSS, which is blurry for
 * a moment and never blank. `flush` exists for capture: a screenshot must not
 * be taken from a buffer that is about to be replaced.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  /** Run a pending call now. A no-op when nothing is pending. */
  flush(): void;
  pending(): boolean;
}

export const RESIZE_DEBOUNCE_MS = 120;

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  const debounced = ((...args: A) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, waitMs);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };
  debounced.pending = () => timer !== null;
  return debounced;
}
