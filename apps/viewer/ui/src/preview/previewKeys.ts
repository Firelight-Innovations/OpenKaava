/**
 * The two preview chords, as a pure matcher.
 *
 * Ctrl+Shift+V toggles the rendered view; Ctrl+K then V opens it beside the
 * source. Both are VS Code's, and both are matched here — in the viewer's own
 * frame — rather than in the shell's `useKeyboard.ts`, for two reasons that are
 * the same reason. A keystroke inside this app's iframe never reaches the
 * shell's document listener, so a shell binding could not fire while the viewer
 * has focus; and a shell binding that *could* fire would take Ctrl+Shift+V from
 * the terminal, where it is paste. Owning the chord here means it exists only
 * when a viewer is focused.
 *
 * The matcher is stateful because the second chord is: `Ctrl+K` arms it and the
 * next key decides. It is a function of (event, clock) with no DOM in it, which
 * is what lets `previewKeys.test.ts` cover it without a document.
 */

export type PreviewCommand = "toggle" | "side";

/** The parts of a `KeyboardEvent` the matcher reads. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** How long Ctrl+K stays armed. VS Code's chord timeout is about this. */
export const CHORD_WINDOW_MS = 2000;

export interface PreviewKeyMatcher {
  /**
   * What this keystroke means, if anything. `"pending"` means it was Ctrl+K:
   * swallow it, the next key decides. `null` means it is none of ours and any
   * armed chord is dropped.
   */
  match(event: KeyLike): PreviewCommand | "pending" | null;
}

const isKey = (event: KeyLike, letter: string) => event.key.toLowerCase() === letter;

export function createPreviewKeyMatcher(now: () => number = Date.now): PreviewKeyMatcher {
  let armedAt: number | null = null;

  return {
    match(event) {
      // A bare modifier press is not "the next key" — Ctrl+K, release, V works
      // in VS Code, and pressing Shift on the way must not disarm it.
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;

      const armed = armedAt !== null && now() - armedAt <= CHORD_WINDOW_MS;
      armedAt = null;

      if (event.metaKey || event.altKey) return null;

      if (event.ctrlKey && event.shiftKey && isKey(event, "v")) return "toggle";

      if (event.ctrlKey && !event.shiftKey && isKey(event, "k")) {
        armedAt = now();
        return "pending";
      }

      // The second half. Ctrl may still be held or not; Shift may not.
      if (armed && !event.shiftKey && isKey(event, "v")) return "side";

      return null;
    },
  };
}
