/**
 * How a keystroke is written down, and what counts as holding the modifier.
 *
 * Veistra ships on Windows only, so both questions have one answer — `Ctrl`, and
 * `ctrlKey` — and this module is where it is given, in place of the `⌘K` the
 * search slot used to draw and the `e.metaKey ||` two listeners used to test.
 * `menus.ts` and `shortcuts.ts` keep their accelerators as literals, being data
 * tables; `accelerators.test.ts` is what walks those for glyphs instead.
 */

/** The modifier every shell shortcut hangs off. */
export const PRIMARY_MODIFIER = "Ctrl";

/** A keystroke to write down. Deliberately the same shape as `Chord`. */
export interface Accelerator {
  key: string;
  shift?: boolean;
}

/** `{ key: "P", shift: true }` becomes `"Ctrl+Shift+P"`. */
export function accelerator({ key, shift }: Accelerator): string {
  return shift ? `${PRIMARY_MODIFIER}+Shift+${key}` : `${PRIMARY_MODIFIER}+${key}`;
}

/**
 * True when this event carries the primary modifier. `metaKey` is not
 * consulted: on Windows that is the Windows key, and taking it here would mean
 * Win+S quietly saving a file. The two guards that test it to rule a keystroke
 * *out* still do, where ignoring it would add false positives instead.
 */
export function hasPrimaryModifier(event: Pick<KeyboardEvent, "ctrlKey">): boolean {
  return event.ctrlKey;
}

/** Command, Option, Control, Shift, Delete, Return, Enter, Escape, Tab, Caps. */
const MAC_KEY_GLYPHS = "⌘⌥⌃⇧⌫⏎⌤⎋⇥⇪";

/** Every Mac key glyph in `text`, in order. Empty when there are none. */
export function macGlyphsIn(text: string): string[] {
  return [...text].filter((char) => MAC_KEY_GLYPHS.includes(char));
}
