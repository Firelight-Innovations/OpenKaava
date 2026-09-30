/**
 * An app frame reporting Escape (`kaava/escape`). Keys typed inside an iframe
 * never reach the shell's `document`, so once an expanded rail page has focus
 * the shell's "Esc leaves the page" binding cannot hear the key itself.
 *
 * Only the rail page's own frame is honoured: a pane's Escape belongs to that
 * pane. The report is replayed as a `keydown` on the shell's document, which
 * is what the keyboard effect in `WindowRoot` already listens for, so the key
 * behaves the same whichever side of the iframe had focus.
 */
export function relayPageEscape(
  frameId: string,
  pageInstanceId: string | null,
  doc: Pick<Document, "dispatchEvent">,
): boolean {
  if (pageInstanceId === null || frameId !== pageInstanceId) return false;
  doc.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  return true;
}
