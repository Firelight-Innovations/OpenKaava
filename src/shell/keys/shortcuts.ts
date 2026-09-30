/**
 * Every keystroke the shell binds, as something to read.
 *
 * A second table describing bindings that live in `useKeyboard.ts` is a copy,
 * and a copy of a keymap goes stale silently — the screen keeps promising a
 * chord that was renamed months ago, and nothing fails. `shortcuts.test.ts` is
 * what makes that impossible: it walks `CHORDS` and this list and fails when
 * either holds a binding the other does not.
 *
 * That check covers the primary-modifier chords, which is most of them. The
 * four rows it cannot reach are the ones the listener handles before it
 * consults `CHORDS` at all — F11, Ctrl+1…9, Ctrl+R, Ctrl+. — plus Ctrl+K and
 * Escape, which `SearchSlot` owns. Those carry no `chords` and are marked
 * below; they are checked by reading, not by the test.
 */

/** One half of a `CHORDS` row: the key, and whether Shift was held. */
export interface Chord {
  key: string;
  shift: boolean;
}

export interface Shortcut {
  /** What the keystroke does, in the words the menu uses for it. */
  label: string;
  /** The chips, in order. Split rather than `"Ctrl+="` so a `+` can be a key. */
  keys: string[];
  /**
   * Which `CHORDS` entries this row accounts for. Omitted for the bindings the
   * listener resolves ahead of that table — see the header.
   */
  chords?: Chord[];
  /** A sentence, when the row needs one. Shown under the label. */
  note?: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

const ctrl = (key: string, shift = false): Chord => ({ key, shift });

/**
 * The groups, in the order the menu bar puts them — Apps, File, View, Terminal
 * — with the tool chips first because they are the only ones that are not in a
 * menu at all, and Search last because it is the one surface that owns its own
 * keys.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Tools",
    items: [
      {
        label: "Select tool by position",
        keys: ["Ctrl", "1"],
        note: "Ctrl+1 through Ctrl+9, counting along this window's bar.",
      },
      { label: "Re-scan tools", keys: ["Ctrl", "R"] },
      {
        label: "Cancel the booting tool",
        keys: ["Ctrl", "."],
        note: "Only while one is starting. Does nothing otherwise.",
      },
    ],
  },
  {
    title: "File",
    items: [
      { label: "New File", keys: ["Ctrl", "N"], chords: [ctrl("n")] },
      { label: "New Cluster", keys: ["Ctrl", "Shift", "N"], chords: [ctrl("n", true)] },
      { label: "Open Project", keys: ["Ctrl", "O"], chords: [ctrl("o")] },
      { label: "Save", keys: ["Ctrl", "S"], chords: [ctrl("s")] },
      { label: "Save As", keys: ["Ctrl", "Shift", "S"], chords: [ctrl("s", true)] },
      { label: "Duplicate", keys: ["Ctrl", "D"], chords: [ctrl("d")] },
      {
        label: "Close Window",
        keys: ["Ctrl", "Shift", "W"],
        chords: [ctrl("w", true)],
        note: "Shift is required. Plain Ctrl+W closes a tab everywhere else, and this window is not one.",
      },
    ],
  },
  {
    title: "View",
    items: [
      { label: "Command Palette", keys: ["Ctrl", "Shift", "P"], chords: [ctrl("p", true)] },
      { label: "Open App…", keys: ["Ctrl", "Shift", "A"], chords: [ctrl("a", true)] },
      { label: "Show/Hide Panel", keys: ["Ctrl", "B"], chords: [ctrl("b")] },
      { label: "Show/Hide Terminal", keys: ["Ctrl", "`"] },
      { label: "Full Screen", keys: ["F11"] },
      {
        label: "Zoom In",
        keys: ["Ctrl", "="],
        chords: [ctrl("="), ctrl("=", true), ctrl("+"), ctrl("+", true)],
        note: "Ctrl++ too — the same physical key, and which half arrives depends on the layout.",
      },
      {
        label: "Zoom Out",
        keys: ["Ctrl", "-"],
        chords: [ctrl("-"), ctrl("-", true), ctrl("_"), ctrl("_", true)],
      },
    ],
  },
  {
    title: "Terminal",
    items: [
      { label: "New Terminal", keys: ["Ctrl", "Shift", "`"] },
      { label: "Split Terminal", keys: ["Ctrl", "\\"], chords: [ctrl("\\")] },
    ],
  },
  {
    title: "Search",
    items: [
      { label: "Open search", keys: ["Ctrl", "K"] },
      { label: "Close search", keys: ["Esc"] },
    ],
  },
];
