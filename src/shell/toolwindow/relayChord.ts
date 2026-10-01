/**
 * An app frame reporting a shell chord (`kaava/key`). Keys typed in an iframe
 * never reach the shell's `document`, so Ctrl+Shift+P and the like were dead
 * whenever an app had focus. The report is replayed as a `keydown` on the
 * shell's document, which is what `useKeyboard` already listens for.
 *
 * Only the key and its four modifiers are read, and only a chord shaped like a
 * shell shortcut is replayed: a frame cannot use this to type into the shell.
 */
export function relayChord(params: unknown, doc: Pick<Document, "dispatchEvent">): boolean {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  if (typeof p.key !== "string" || p.key.length === 0 || p.key.length > 16) return false;
  const flag = (k: string) => p[k] === true;
  const ctrlKey = flag("ctrlKey");
  const metaKey = flag("metaKey");
  const altKey = flag("altKey");
  if (!ctrlKey && !metaKey && !altKey) return false;
  doc.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: p.key,
      code: typeof p.code === "string" ? p.code : "",
      ctrlKey,
      metaKey,
      altKey,
      shiftKey: flag("shiftKey"),
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
