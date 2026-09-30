import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({ invoke }));

import {
  canSendToAgent,
  isRaster,
  lineRef,
  putFile,
  putSelection,
  relativePath,
  selectionText,
} from "./fileContext";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ id: "ctx-1" });
});

describe("selection text", () => {
  it("names the file and the line range, then quotes the snippet", () => {
    expect(selectionText("src/foo.ts", 12, 30, "const a = 1;")).toBe(
      "src/foo.ts:12-30\n```\nconst a = 1;\n```",
    );
  });

  it("writes a single line without a range", () => {
    expect(lineRef("src/foo.ts", 7, 7)).toBe("src/foo.ts:7");
  });
});

describe("paths", () => {
  it("writes a path from the project root with forward slashes", () => {
    expect(relativePath("C:\\game", "C:\\game\\src\\foo.ts")).toBe("src/foo.ts");
    expect(relativePath("C:\\game", "D:\\elsewhere\\a.ts")).toBe("D:\\elsewhere\\a.ts");
    expect(relativePath(null, "a.ts")).toBe("a.ts");
  });

  it("recognises the formats the store takes as an image", () => {
    expect(isRaster("C:\\a\\shot.PNG")).toBe(true);
    expect(isRaster("a/b.webp")).toBe(true);
    expect(isRaster("a/icon.svg")).toBe(false);
    expect(isRaster("a/png")).toBe(false);
  });
});

describe("context puts", () => {
  it("sends a file by path, not by bytes", async () => {
    await putFile("C:\\game\\src\\foo.ts", "src/foo.ts");
    const [method, params] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("context/put");
    expect(params).toMatchObject({
      kind: "file",
      path: "C:\\game\\src\\foo.ts",
      title: "src/foo.ts",
    });
    expect(params).not.toHaveProperty("bytesBase64");
    expect(params).not.toHaveProperty("text");
  });

  it("sends an image file as an image, still by path", async () => {
    await putFile("C:\\game\\art\\hero.png");
    const [, params] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).toMatchObject({ kind: "image", path: "C:\\game\\art\\hero.png" });
    expect(params).not.toHaveProperty("bytesBase64");
  });

  it("sends a selection as text carrying the path and range", async () => {
    await putSelection("src/foo.ts", 12, 30, "x");
    const [, params] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).toMatchObject({ kind: "text", title: "src/foo.ts:12-30" });
    expect(params.text).toBe("src/foo.ts:12-30\n```\nx\n```");
    expect(params).not.toHaveProperty("path");
  });

  it("lets a refusal through so the caller can say why", async () => {
    invoke.mockRejectedValue(new Error("over the 25 MB copy limit"));
    await expect(putFile("C:\\big.bin")).rejects.toThrow("copy limit");
  });
});

describe("the menu item", () => {
  it("is for a file that is there, and nothing else", () => {
    expect(canSendToAgent({ path: "a", name: "a", kind: "file" })).toBe(true);
    expect(canSendToAgent({ path: "a", name: "a", kind: "dir" })).toBe(false);
    expect(canSendToAgent({ path: null, name: null, kind: null })).toBe(false);
    expect(canSendToAgent({ path: "a", name: null, kind: "file" })).toBe(false);
  });
});
