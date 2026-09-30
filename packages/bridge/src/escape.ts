/**
 * Escape, from inside an app frame. Keys typed in an iframe never reach the
 * shell's `document`, so the shell's "Esc leaves the expanded page" binding
 * goes deaf as soon as the page has focus. The frame tells the shell instead.
 */

/** The parts of a `keydown` this decides on. */
export interface EscapeKeyEvent {
  key: string;
  defaultPrevented: boolean;
  target: unknown;
}

/** A field that wants Escape for itself: it clears, cancels or closes a widget. */
function isTextEntry(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

/** True for a bare Escape nothing in the app has claimed. */
export function shouldForwardEscape(e: EscapeKeyEvent): boolean {
  return e.key === "Escape" && !e.defaultPrevented && !isTextEntry(e.target);
}

/**
 * Call `send` for each Escape the app leaves unclaimed. Listens in the bubble
 * phase, after the app's own handlers have had the chance to `preventDefault`.
 * Returns the function that removes the listener.
 */
export function installEscapeForwarder(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  send: () => void,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (shouldForwardEscape(e)) send();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
