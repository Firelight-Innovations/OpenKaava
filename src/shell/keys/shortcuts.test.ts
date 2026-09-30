/**
 * The Keyboard Shortcuts screen lists what the shell actually binds.
 *
 * `shortcuts.ts` is a second table describing `useKeyboard.ts`'s bindings, and
 * the failure it invites is silent: a chord renamed in one and not the other
 * leaves the screen promising a keystroke that does nothing, with every check
 * still green. These two tests are the reason that table is allowed to exist.
 */
import { describe, expect, it } from "vitest";
import { ALT_CHORDS, CHORDS, altChordFor, type KeyboardActions } from "./useKeyboard";
import { SHORTCUT_GROUPS, type AltChordId, type Chord } from "./shortcuts";

/** `"s+shift"` — one string per bound half of a `CHORDS` row. */
const id = (chord: Chord) => `${chord.key}${chord.shift ? "+shift" : ""}`;

/** Every half of `CHORDS` that is bound to something. */
function boundChords(): string[] {
  const found: string[] = [];
  for (const [key, row] of Object.entries(CHORDS)) {
    if (row.plain) found.push(id({ key, shift: false }));
    if (row.shift) found.push(id({ key, shift: true }));
  }
  return found.sort();
}

/** Every chord the screen claims, across all groups. */
function claimedChords(): string[] {
  return SHORTCUT_GROUPS.flatMap((group) => group.items)
    .flatMap((item) => item.chords ?? [])
    .map(id)
    .sort();
}

describe("the shortcuts list and the keymap", () => {
  it("account for exactly the same chords", () => {
    expect(claimedChords()).toEqual(boundChords());
  });

  /**
   * Separate from the test above because it catches a different mistake: two
   * rows claiming one chord compare equal to a keymap with a duplicate in it
   * only by accident, and a chord listed twice is two rows on screen saying
   * different things about one keystroke.
   */
  it("claim no chord twice", () => {
    const claimed = claimedChords();
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("account for exactly the same Alt chords", () => {
    const altId = (c: AltChordId) =>
      `${c.ctrl ? "ctrl+" : ""}${c.shift ? "shift+" : ""}alt+${c.code}`;
    const claimed = SHORTCUT_GROUPS.flatMap((g) => g.items)
      .flatMap((item) => item.altChords ?? [])
      .map(altId)
      .sort();
    expect(claimed).toEqual(ALT_CHORDS.map(altId).sort());
  });
});

describe("the Switch project chords", () => {
  const press = (over: Partial<KeyboardEvent>) =>
    altChordFor({
      code: "KeyP",
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      ...over,
    });

  /** The name of the action a matched row would run. */
  function runs(row: ReturnType<typeof altChordFor>): string | null {
    if (!row) return null;
    const probe = new Proxy({}, { get: (_t, name) => () => String(name) });
    return (row.run(probe as KeyboardActions) as unknown as () => string)();
  }

  it("Ctrl+Alt+P and Shift+Alt+P both open the switcher", () => {
    expect(runs(press({ ctrlKey: true }))).toBe("switchProject");
    expect(runs(press({ shiftKey: true }))).toBe("switchProject");
  });

  it("match the modifiers exactly", () => {
    expect(press({})).toBeNull();
    expect(press({ ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press({ ctrlKey: true, metaKey: true })).toBeNull();
    expect(press({ ctrlKey: true, altKey: false })).toBeNull();
    expect(press({ ctrlKey: true, code: "KeyO" })).toBeNull();
  });
});
