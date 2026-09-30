/**
 * A one-line notice per terminal, for "Inserted 2 references for Claude Code" and
 * for a refusal. An external store rather than React state held above the deck,
 * because the writers (a drop handled in `useFileDrag`, a paste in `XTermView`)
 * are not descendants of the one component that draws it.
 */
export interface TerminalNotice {
  text: string;
  error: boolean;
  /** Distinguishes two identical messages in a row, so the second re-arms the fade. */
  seq: number;
}

const notices = new Map<string, TerminalNotice>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

/** How long a notice stays. Errors are read, not glanced at, so they stay longer. */
const SHOW_MS = 4000;
const SHOW_ERROR_MS = 8000;

function emit(): void {
  for (const l of listeners) l();
}

export function notify(id: string, text: string, error = false): void {
  notices.set(id, { text, error, seq: ++seq });
  const pending = timers.get(id);
  if (pending) clearTimeout(pending);
  timers.set(
    id,
    setTimeout(() => clear(id), error ? SHOW_ERROR_MS : SHOW_MS),
  );
  emit();
}

export function clear(id: string): void {
  const pending = timers.get(id);
  if (pending) clearTimeout(pending);
  timers.delete(id);
  if (notices.delete(id)) emit();
}

export function noticeFor(id: string): TerminalNotice | undefined {
  return notices.get(id);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
