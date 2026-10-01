// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installChordForwarder, shouldForwardChord, type ChordKeyEvent } from "./chord";

const ev = (over: Partial<ChordKeyEvent>): ChordKeyEvent => ({
  key: "p",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  defaultPrevented: false,
  ...over,
});

describe("shouldForwardChord", () => {
  it("forwards Ctrl+Shift chords and Ctrl+Alt+P", () => {
    expect(shouldForwardChord(ev({ key: "P", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shouldForwardChord(ev({ key: "p", ctrlKey: true, altKey: true }))).toBe(true);
    expect(shouldForwardChord(ev({ key: "A", metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("forwards Alt+digit", () => {
    expect(shouldForwardChord(ev({ key: "3", altKey: true }))).toBe(true);
    expect(shouldForwardChord(ev({ key: "0", altKey: true }))).toBe(false);
  });

  it("leaves editing chords to the app", () => {
    for (const key of ["c", "v", "x", "z", "a", "b", "k", "s"]) {
      expect(shouldForwardChord(ev({ key, ctrlKey: true }))).toBe(false);
    }
  });

  it("leaves AltGr characters alone", () => {
    expect(shouldForwardChord(ev({ key: "@", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("ignores bare modifiers and chords the app claimed", () => {
    expect(shouldForwardChord(ev({ key: "Shift", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(
      shouldForwardChord(ev({ key: "P", ctrlKey: true, shiftKey: true, defaultPrevented: true })),
    ).toBe(false);
  });
});

describe("installChordForwarder", () => {
  it("sends the key and modifiers, and stops after removal", () => {
    const send = vi.fn();
    const off = installChordForwarder(document, send);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }),
    );
    expect(send).toHaveBeenCalledWith({
      key: "P",
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    });
    off();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
