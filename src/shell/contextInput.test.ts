/**
 * What a drop or a paste says about itself, and what it asks Rust for. The
 * insertion itself is Rust's and is tested there (`harness.rs`,
 * `context_commands.rs`); this pins the frontend half of the conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextInserted } from "../bindings";

const { terminalDropPaths, terminalPasteImage, terminalInsertItems } = vi.hoisted(() => ({
  terminalDropPaths: vi.fn(),
  terminalPasteImage: vi.fn(),
  terminalInsertItems: vi.fn(),
}));

vi.mock("../bindings", () => ({ terminalDropPaths, terminalPasteImage, terminalInsertItems }));

import {
  describe as describeResult,
  dropPaths,
  fileToBase64,
  insertItems,
  pasteImage,
} from "./contextInput";
import { clear, noticeFor } from "./terminalNotice";

function inserted(over: Partial<ContextInserted> = {}): ContextInserted {
  return { text: "", count: 0, harness: "claude", items: [], refused: [], ...over };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clear("t1");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("describe", () => {
  it("counts references and names the harness", () => {
    expect(describeResult(inserted({ text: "@a.png ", count: 1 }))).toEqual({
      text: "Inserted 1 reference for Claude Code",
      error: false,
    });
    expect(
      describeResult(inserted({ text: "@a.png @b.png ", count: 2, harness: "gemini" }))?.text,
    ).toBe("Inserted 2 references for Gemini");
  });

  it("calls a plain shell's insertion paths, not references", () => {
    expect(
      describeResult(inserted({ text: "'C:/x y.png' ", count: 1, harness: "shell" }))?.text,
    ).toBe("Inserted 1 path");
  });

  it("says a refusal as an error, ahead of anything else", () => {
    const said = describeResult(
      inserted({ text: "@a ", count: 1, refused: ["setup.exe: looks like an executable."] }),
    );
    expect(said).toEqual({ text: "setup.exe: looks like an executable.", error: true });
  });

  it("has nothing to say about an empty insertion", () => {
    expect(describeResult(inserted())).toBeNull();
  });
});

describe("fileToBase64", () => {
  it("encodes bytes, including ones past a single slice", async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251);
    const b64 = await fileToBase64({ arrayBuffer: () => Promise.resolve(bytes.buffer) });
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });
});

describe("pasteImage", () => {
  it("sends the bytes once and posts what was inserted", async () => {
    terminalPasteImage.mockResolvedValue(inserted({ text: "@.kaava/context/x.png ", count: 1 }));
    const bytes = new Uint8Array([1, 2, 3]);

    await pasteImage("t1", { arrayBuffer: () => Promise.resolve(bytes.buffer), name: "image.png" });

    expect(terminalPasteImage).toHaveBeenCalledWith("t1", btoa("\u0001\u0002\u0003"), undefined);
    expect(noticeFor("t1")).toMatchObject({
      text: "Inserted 1 reference for Claude Code",
      error: false,
    });
  });

  it("keeps a real file name and reports a failure instead of throwing", async () => {
    terminalPasteImage.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await pasteImage("t1", {
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      name: "hero.png",
    });

    expect(terminalPasteImage.mock.calls[0][2]).toBe("hero.png");
    expect(noticeFor("t1")).toMatchObject({ text: "Could not paste that image", error: true });
    err.mockRestore();
  });

  it("surfaces Rust's refusal, such as an image over the size limit", async () => {
    terminalPasteImage.mockResolvedValue(
      inserted({ refused: ["that image is 9.1 MB; the limit is 8 MB"] }),
    );
    await pasteImage("t1", { arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
    expect(noticeFor("t1")).toMatchObject({ error: true });
  });
});

describe("dropPaths and insertItems", () => {
  it("passes the paths straight to Rust, unquoted, for Rust to reference", async () => {
    terminalDropPaths.mockResolvedValue(inserted({ text: "@a.png ", count: 1 }));
    await dropPaths("t1", ["C:\\a b\\a.png"]);
    expect(terminalDropPaths).toHaveBeenCalledWith("t1", ["C:\\a b\\a.png"]);
  });

  it("never rejects, so a closed terminal cannot become an unhandled rejection", async () => {
    terminalDropPaths.mockRejectedValue(new Error("gone"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(dropPaths("t1", ["a"])).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("re-inserts by id", async () => {
    terminalInsertItems.mockResolvedValue(inserted({ text: "@a.png ", count: 1 }));
    await insertItems("t1", ["ctx_1"]);
    expect(terminalInsertItems).toHaveBeenCalledWith("t1", ["ctx_1"]);
  });
});

describe("the notice", () => {
  it("fades on its own, later for an error", () => {
    terminalDropPaths.mockResolvedValue(inserted({ text: "@a ", count: 1 }));
    return dropPaths("t1", ["a"]).then(() => {
      expect(noticeFor("t1")).toBeDefined();
      vi.advanceTimersByTime(4001);
      expect(noticeFor("t1")).toBeUndefined();
    });
  });
});
