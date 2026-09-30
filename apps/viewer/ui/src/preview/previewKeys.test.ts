import { describe, expect, it } from "vitest";
import { createPreviewKeyMatcher, CHORD_WINDOW_MS, type KeyLike } from "./previewKeys";
import { previewKindFor } from "./previewKind";
import { routePreviewKey, type PreviewControl } from "./previewControl";
import { pick, type OpenFile } from "../viewer/registry";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

const file = (name: string): OpenFile => ({
  path: `C:\\p\\${name}`,
  name,
  ext: name.includes(".") ? (name.split(".").pop() as string).toLowerCase() : "",
  size: 1,
  mtime: 1,
});

function fakeControl() {
  const calls: string[] = [];
  const control: PreviewControl = {
    kind: "markdown",
    mode: "source",
    toggle: () => calls.push("toggle"),
    toggleSide: () => calls.push("side"),
  };
  return { control, calls };
}

describe("which files have a preview", () => {
  it("covers markdown, mermaid, svg and html, case-insensitively", () => {
    expect(previewKindFor("md")).toBe("markdown");
    expect(previewKindFor("markdown")).toBe("markdown");
    expect(previewKindFor("MD")).toBe("markdown");
    expect(previewKindFor("mmd")).toBe("mermaid");
    expect(previewKindFor("mermaid")).toBe("mermaid");
    expect(previewKindFor("svg")).toBe("svg");
    expect(previewKindFor("html")).toBe("html");
    expect(previewKindFor("htm")).toBe("html");
  });

  it("has none for source code, images or extensionless files", () => {
    for (const ext of ["rs", "ts", "png", "json", "txt", ""]) {
      expect(previewKindFor(ext)).toBeNull();
    }
  });

  it("does not make Markdown or HTML open rendered by default", () => {
    // Like VS Code: source first, Ctrl+Shift+V for the preview.
    expect(pick(file("README.md")).id).toBe("text");
    expect(pick(file("page.html")).id).toBe("text");
    // These two were already rendered-first and stay so.
    expect(pick(file("flow.mmd")).id).toBe("mermaid");
    expect(pick(file("logo.svg")).id).toBe("svg");
  });
});

describe("the preview chords", () => {
  it("Ctrl+Shift+V toggles", () => {
    const m = createPreviewKeyMatcher();
    expect(m.match(key("V", { ctrlKey: true, shiftKey: true }))).toBe("toggle");
    expect(m.match(key("v", { ctrlKey: true, shiftKey: true }))).toBe("toggle");
  });

  it("plain Ctrl+V and Ctrl+Shift+other are not ours", () => {
    const m = createPreviewKeyMatcher();
    expect(m.match(key("v", { ctrlKey: true }))).toBeNull();
    expect(m.match(key("P", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(m.match(key("V", { shiftKey: true }))).toBeNull();
    expect(m.match(key("V", { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it("Ctrl+K then V opens to the side, with or without Ctrl still held", () => {
    const m = createPreviewKeyMatcher();
    expect(m.match(key("k", { ctrlKey: true }))).toBe("pending");
    expect(m.match(key("v"))).toBe("side");

    expect(m.match(key("k", { ctrlKey: true }))).toBe("pending");
    expect(m.match(key("v", { ctrlKey: true }))).toBe("side");
  });

  it("a bare V, with no Ctrl+K before it, is just typing", () => {
    const m = createPreviewKeyMatcher();
    expect(m.match(key("v"))).toBeNull();
  });

  it("another key between Ctrl+K and V cancels the chord", () => {
    const m = createPreviewKeyMatcher();
    m.match(key("k", { ctrlKey: true }));
    expect(m.match(key("a"))).toBeNull();
    expect(m.match(key("v"))).toBeNull();
  });

  it("a modifier press between them does not cancel it", () => {
    const m = createPreviewKeyMatcher();
    m.match(key("k", { ctrlKey: true }));
    expect(m.match(key("Control"))).toBeNull();
    expect(m.match(key("v"))).toBe("side");
  });

  it("the chord times out", () => {
    let clock = 0;
    const m = createPreviewKeyMatcher(() => clock);
    m.match(key("k", { ctrlKey: true }));
    clock = CHORD_WINDOW_MS + 1;
    expect(m.match(key("v"))).toBeNull();
  });
});

describe("routing a keystroke", () => {
  it("runs the control and claims the event for a previewable file", () => {
    const { control, calls } = fakeControl();
    const m = createPreviewKeyMatcher();
    expect(routePreviewKey(m, control, key("V", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(routePreviewKey(m, control, key("k", { ctrlKey: true }))).toBe(true);
    expect(routePreviewKey(m, control, key("v"))).toBe(true);
    expect(calls).toEqual(["toggle", "side"]);
  });

  it("claims nothing when no previewable file is showing, so paste stays paste", () => {
    // `control` is null for a `.rs` file, an image, or a terminal frame that
    // never mounts a viewer at all.
    const m = createPreviewKeyMatcher();
    expect(routePreviewKey(m, null, key("V", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(routePreviewKey(m, null, key("k", { ctrlKey: true }))).toBe(false);
  });

  it("leaves unrelated keys, and Ctrl+K's other chords, alone", () => {
    const { control, calls } = fakeControl();
    const m = createPreviewKeyMatcher();
    expect(routePreviewKey(m, control, key("s", { ctrlKey: true }))).toBe(false);
    routePreviewKey(m, control, key("k", { ctrlKey: true }));
    expect(routePreviewKey(m, control, key("c", { ctrlKey: true }))).toBe(false);
    expect(calls).toEqual([]);
  });
});
