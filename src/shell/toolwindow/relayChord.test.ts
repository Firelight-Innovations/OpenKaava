// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { relayChord } from "./relayChord";

describe("relayChord", () => {
  it("replays a chord as a keydown with its modifiers", () => {
    const seen: KeyboardEvent[] = [];
    const doc = { dispatchEvent: vi.fn((e: Event) => seen.push(e as KeyboardEvent)) };
    expect(
      relayChord({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }, doc as never),
    ).toBe(true);
    expect(seen[0].key).toBe("P");
    expect(seen[0].ctrlKey).toBe(true);
    expect(seen[0].shiftKey).toBe(true);
    expect(seen[0].altKey).toBe(false);
  });

  it("refuses a bare key, so a frame cannot type into the shell", () => {
    const doc = { dispatchEvent: vi.fn() };
    expect(relayChord({ key: "a" }, doc as never)).toBe(false);
    expect(relayChord({ key: "a", shiftKey: true }, doc as never)).toBe(false);
    expect(doc.dispatchEvent).not.toHaveBeenCalled();
  });

  it("refuses malformed params", () => {
    const doc = { dispatchEvent: vi.fn() };
    for (const bad of [null, "x", 3, {}, { key: 5, ctrlKey: true }, { key: "", ctrlKey: true }]) {
      expect(relayChord(bad, doc as never)).toBe(false);
    }
    expect(doc.dispatchEvent).not.toHaveBeenCalled();
  });
});
