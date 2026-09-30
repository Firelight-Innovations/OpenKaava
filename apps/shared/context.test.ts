import { describe, expect, it, vi } from "vitest";

vi.mock("@openkaava/bridge", () => ({ invoke: vi.fn() }));

import { contextKey } from "./context";

describe("contextKey", () => {
  it("joins the parts of a source with slashes", () => {
    expect(contextKey("blender", "art/crate", "three-quarter")).toBe(
      "blender/art/crate/three-quarter",
    );
  });

  it("drops a scheme, backslashes, edge slashes and empty parts", () => {
    expect(contextKey("godot", "res://levels/main.tscn", "frame")).toBe(
      "godot/levels/main.tscn/frame",
    );
    expect(contextKey("file", "src\\a.ts:1-4", null, undefined, "")).toBe("file/src/a.ts:1-4");
    expect(contextKey("play", "/scene/", "log")).toBe("play/scene/log");
  });

  it("is the same for the same source every time", () => {
    expect(contextKey("godot", "res://m.tscn", "tree")).toBe(
      contextKey("godot", "res://m.tscn", "tree"),
    );
  });
});
