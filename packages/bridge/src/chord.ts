/**
 * Shell chords, from inside an app frame. Keys typed in an iframe never reach
 * the shell's `document`, so Ctrl+Shift+P, Alt+1 and the rest went dead the
 * moment an app had focus. The frame tells the shell, which replays the key.
 *
 * Deliberately narrow: only chords an editing surface does not use for
 * editing. Ctrl+C, Ctrl+V, Ctrl+Z, Ctrl+B and friends belong to the app and
 * are never forwarded.
 */

/** The parts of a `keydown` this decides on. */
export interface ChordKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
}

/** What crosses the bridge: the key and its modifiers, nothing else. */
export interface ChordPayload {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"]);

/**
 * True for Ctrl or Meta with Shift or Alt, and for Alt+1 to Alt+9 alone, when
 * the app has not claimed the key. AltGr arrives as Ctrl+Alt on Windows and
 * types characters, so a Ctrl+Alt chord that produced one is left alone.
 */
export function shouldForwardChord(e: ChordKeyEvent): boolean {
  if (e.defaultPrevented || MODIFIER_KEYS.has(e.key)) return false;
  const primary = e.ctrlKey || e.metaKey;
  if (primary && e.shiftKey) return true;
  if (primary && e.altKey) return e.key.length !== 1 || e.key === "p" || e.key === "P";
  return e.altKey && !primary && /^[1-9]$/.test(e.key);
}

/** The payload for one chord. */
export function chordPayload(e: ChordKeyEvent): ChordPayload {
  return {
    key: e.key,
    code: e.code ?? "",
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  };
}

/**
 * Call `send` for each chord the app leaves unclaimed. Bubble phase, so the
 * app's own handlers have had the chance to `preventDefault`. Returns the
 * function that removes the listener.
 */
export function installChordForwarder(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  send: (chord: ChordPayload) => void,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (shouldForwardChord(e)) send(chordPayload(e));
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
