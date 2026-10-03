/**
 * "Something happened that may mean a different program is running in this
 * terminal": ask the Context strip to re-run harness detection.
 *
 * Detection is a process-tree walk in Rust, so it is never put on a timer.
 * These triggers are events (the terminal took focus, its title changed, a
 * reference was inserted), and they are throttled to at most one run per
 * `HARNESS_REFRESH_MS` per session. A request inside the window is coalesced
 * into one trailing run at the window's end; a burst of titles from a TUI costs
 * one detection, not one per title.
 */

export const HARNESS_REFRESH_MS = 2000;

interface Slot {
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
}

const slots = new Map<string, Slot>();

function slot(id: string): Slot {
  let s = slots.get(id);
  if (!s) {
    s = { last: -Infinity, timer: null, listeners: new Set() };
    slots.set(id, s);
  }
  return s;
}

function fire(s: Slot): void {
  s.last = Date.now();
  for (const l of [...s.listeners]) l();
}

/** Called by whatever wants detection re-run. Cheap; safe to call on every event. */
export function requestHarnessRefresh(id: string): void {
  const s = slot(id);
  if (s.timer !== null) return;
  const wait = HARNESS_REFRESH_MS - (Date.now() - s.last);
  if (wait <= 0) {
    fire(s);
    return;
  }
  s.timer = setTimeout(() => {
    s.timer = null;
    fire(s);
  }, wait);
}

/** The strip's hook listens here. Returns an unsubscribe. */
export function subscribeHarnessRefresh(id: string, listener: () => void): () => void {
  const s = slot(id);
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
    if (s.listeners.size === 0 && s.timer === null) slots.delete(id);
  };
}

/** For tests. */
export function resetHarnessRefresh(): void {
  for (const s of slots.values()) if (s.timer !== null) clearTimeout(s.timer);
  slots.clear();
}
