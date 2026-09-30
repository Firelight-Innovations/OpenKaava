/**
 * The two bugs in issue #50, each with the test that would have caught it.
 *
 * The fake emulator's `paste` records into `writes`, which is faithful to the
 * real chain: `Terminal.paste` emits one data event, `XTermView` has that bound
 * to `transport.write`, and `transport.write` is `terminalWrite` on the pty. So
 * "appears in `writes`" and "reaches the pty" are the same statement here.
 */
import { describe, expect, it } from "vitest";
import {
  firstImage,
  handleContextMenu,
  handleKey,
  handlePaste,
  isClusterCycleKey,
  isPasteKey,
} from "./clipboard";

function fakeTerminal(selection = "", textareaValue = "") {
  const writes: string[] = [];
  const textarea = { value: textareaValue };
  return {
    writes,
    textarea,
    paste: (data: string) => void writes.push(data),
    getSelection: () => selection,
  };
}

function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false,
  };
}

function pasteEvent(text: string) {
  const seen = { prevented: false, stopped: false };
  return {
    seen,
    clipboardData: { getData: () => text },
    preventDefault: () => void (seen.prevented = true),
    stopPropagation: () => void (seen.stopped = true),
  };
}

describe("Ctrl+V", () => {
  it("is claimed as a paste rather than left to xterm's control-byte table", () => {
    // Left to xterm, this pair becomes SYN (0x16) and the event is cancelled,
    // so the webview's own paste never runs. Declining the key is what lets it.
    expect(handleKey(key("v", { ctrl: true }))).toBe(false);
    expect(handleKey(key("V", { ctrl: true, shift: true }))).toBe(false);
  });

  it("produces a clipboard paste written to the pty, and nothing else", () => {
    const term = fakeTerminal();

    expect(handleKey(key("v", { ctrl: true }))).toBe(false);
    expect(term.writes).toEqual([]); // no SYN, no keystroke — the key alone types nothing.

    const ev = pasteEvent("cargo test\n");
    handlePaste(term, ev);

    expect(term.writes).toEqual(["cargo test\n"]);
    expect(ev.seen.stopped).toBe(true); // xterm must not send it a second time.
  });

  it("leaves nothing in the hidden textarea for a later right-click to replay", () => {
    const term = fakeTerminal();
    const ev = pasteEvent("secret");

    handlePaste(term, ev);

    // The bug: xterm forwards the text but never prevents the default action,
    // which writes it straight back into the textarea it just blanked.
    expect(ev.seen.prevented).toBe(true);
    expect(term.textarea.value).toBe("");
  });

  it("leaves every other key to the emulator", () => {
    expect(handleKey(key("v"))).toBe(true);
    expect(handleKey(key("c", { ctrl: true }))).toBe(true);
    expect(handleKey(key("V", { shift: true }))).toBe(true);
  });

  it("is not AltGr+V, which is a character on non-US layouts", () => {
    expect(isPasteKey(key("v", { ctrl: true, alt: true }))).toBe(false);
    expect(handleKey(key("v", { ctrl: true, alt: true }))).toBe(true);
  });
});

describe("right-click", () => {
  it("writes nothing to the pty on its own", () => {
    // The reported bug: a second right-click pasted again without the menu's
    // Paste ever being chosen. Nothing on the contextmenu path may reach the pty.
    const term = fakeTerminal("", "a previous paste");

    handleContextMenu(term);

    expect(term.writes).toEqual([]);
  });

  it("clears a previous paste out of the textarea instead of re-arming it", () => {
    const term = fakeTerminal("", "a previous paste");

    handleContextMenu(term);

    expect(term.textarea.value).toBe("");
  });

  it("still leaves the selection there, which is what the menu's Copy reads", () => {
    const term = fakeTerminal("src/shell/terminal", "a previous paste");

    handleContextMenu(term);

    expect(term.textarea.value).toBe("src/shell/terminal");
    expect(term.writes).toEqual([]);
  });
});

/** A clipboard carrying text, files, or both. */
function mixedPaste(text: string, files: { type: string; name?: string }[]) {
  const seen = { prevented: false, stopped: false };
  return {
    seen,
    clipboardData: { getData: () => text, files },
    preventDefault: () => void (seen.prevented = true),
    stopPropagation: () => void (seen.stopped = true),
  };
}

describe("Ctrl+V with an image", () => {
  it("hands a screenshot to the image path and cancels the event", () => {
    const term = fakeTerminal();
    const got: unknown[] = [];
    const png = { type: "image/png", name: "image.png" };
    const ev = mixedPaste("", [png]);

    handlePaste(term, ev, (f) => got.push(f));

    expect(got).toEqual([png]);
    expect(term.writes).toEqual([]); // no text was invented for it.
    expect(ev.seen.stopped).toBe(true); // xterm must not also try to paste.
    expect(ev.seen.prevented).toBe(true);
  });

  it("lets text win when the clipboard carries both", () => {
    // A copied spreadsheet range: a bitmap and the text that was meant.
    const term = fakeTerminal();
    const got: unknown[] = [];
    handlePaste(term, mixedPaste("a	b", [{ type: "image/png" }]), (f) => got.push(f));

    expect(term.writes).toEqual(["a	b"]);
    expect(got).toEqual([]);
  });

  it("ignores a non-image file and leaves the event to xterm", () => {
    const term = fakeTerminal();
    const got: unknown[] = [];
    const ev = mixedPaste("", [{ type: "application/pdf" }]);

    handlePaste(term, ev, (f) => got.push(f));

    expect(got).toEqual([]);
    expect(ev.seen.stopped).toBe(false);
    expect(ev.seen.prevented).toBe(false);
  });

  it("does nothing with an image when nobody is listening for one", () => {
    const term = fakeTerminal();
    const ev = mixedPaste("", [{ type: "image/png" }]);

    handlePaste(term, ev);

    expect(ev.seen.stopped).toBe(false);
    expect(term.writes).toEqual([]);
  });

  it("still leaves the paste key to the webview, so the paste event exists at all", () => {
    expect(handleKey(key("v", { ctrl: true }))).toBe(false);
  });

  it("finds the first image among several files", () => {
    const files = [
      { type: "text/plain" },
      { type: "image/jpeg", name: "b" },
      { type: "image/png" },
    ];
    expect(firstImage(files)?.name).toBe("b");
    expect(firstImage([])).toBeUndefined();
    expect(firstImage(undefined)).toBeUndefined();
  });
});

describe("the shell's cluster-cycle chords", () => {
  it("are declined by xterm so they bubble up to the shell", () => {
    expect(handleKey(key("Tab", { ctrl: true }))).toBe(false);
    expect(handleKey(key("Tab", { ctrl: true, shift: true }))).toBe(false);
  });

  it("leave a plain Tab, and Alt or Meta chords, to the terminal", () => {
    expect(handleKey(key("Tab"))).toBe(true);
    expect(handleKey(key("Tab", { shift: true }))).toBe(true);
    expect(isClusterCycleKey(key("Tab", { ctrl: true, alt: true }))).toBe(false);
  });
});
