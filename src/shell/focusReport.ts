/**
 * Telling the backend where the person's focus is.
 *
 * Focus lives in the DOM and the backend cannot see it, yet an agent connected
 * over MCP wants to know which pane the person is working in, and to be told
 * when that changes. So each window reports it: `readFocus` takes a reading,
 * and `createFocusReporter` sends one only when it differs from the last, after
 * the focus events have stopped for a moment.
 *
 * Kept free of React so the debounce and the no-op-on-same-focus rules, which
 * are the whole point, are testable with fake timers and no component.
 */

/** Mirrors `mcp::focus::FocusReport`. */
export interface FocusReport {
  window: string;
  windowHasFocus: boolean;
  /** `app` (a mounted app frame), `terminal`, `shell` (any other element) or `nothing`. */
  focusIn: "app" | "terminal" | "shell" | "nothing";
  /** The surface holding DOM focus, resolved through `data-instance`. */
  instance: string | null;
  /** The pane the shell treats as active. */
  pane: string | null;
  /** The cluster on screen. */
  cluster: string | null;
}

/** What the DOM cannot say for itself: this window's name and the shell's own notion of active. */
export interface FocusContext {
  window: string;
  cluster: string | null;
  pane: string | null;
}

/**
 * One reading of focus.
 *
 * An app is an `<iframe>`, so when focus is inside one this document's
 * `activeElement` is the frame itself; that is how `app` is told apart from
 * `shell` without reaching into another document. A terminal's emulator is in
 * this document, under `.xterm`.
 */
export function readFocus(doc: Document, context: FocusContext): FocusReport {
  const active = doc.activeElement;
  const element = active instanceof HTMLElement && active !== doc.body ? active : null;

  let focusIn: FocusReport["focusIn"] = "nothing";
  if (element instanceof HTMLIFrameElement) focusIn = "app";
  else if (element?.closest(".xterm")) focusIn = "terminal";
  else if (element) focusIn = "shell";

  return {
    window: context.window,
    windowHasFocus: doc.hasFocus(),
    focusIn,
    instance: element?.closest<HTMLElement>("[data-instance]")?.dataset.instance ?? null,
    pane: context.pane,
    cluster: context.cluster,
  };
}

/** Two readings the backend would treat as the same focus. */
export function sameFocus(a: FocusReport, b: FocusReport): boolean {
  return (
    a.window === b.window &&
    a.windowHasFocus === b.windowHasFocus &&
    a.focusIn === b.focusIn &&
    a.instance === b.instance &&
    a.pane === b.pane &&
    a.cluster === b.cluster
  );
}

export interface FocusReporter {
  /** Something may have changed; look again once things have settled. */
  schedule(): void;
  /** Cancel anything pending. */
  dispose(): void;
}

/** Long enough to swallow the blur/focus pair of one click, short enough not to be felt. */
export const FOCUS_DEBOUNCE_MS = 150;

/**
 * Send a report when focus has settled on something new.
 *
 * `schedule` restarts the timer, so a burst of events costs one reading when it
 * ends. The reading is compared to the last one *sent*, not the last one seen:
 * focus that leaves and comes back inside the window sends nothing.
 */
export function createFocusReporter(
  read: () => FocusReport,
  send: (report: FocusReport) => void,
  delayMs: number = FOCUS_DEBOUNCE_MS,
): FocusReporter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: FocusReport | null = null;

  return {
    schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = read();
        if (last !== null && sameFocus(last, next)) return;
        last = next;
        send(next);
      }, delayMs);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
