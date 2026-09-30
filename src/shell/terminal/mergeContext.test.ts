import { describe, expect, it } from "vitest";
import type { ContextItem } from "../../bindings";
import { mergeItems, recency, wasUpdated } from "./mergeContext";

function item(over: Partial<ContextItem> = {}): ContextItem {
  return {
    id: "ctx_a",
    key: "blender/room/top",
    v: 1,
    kind: "image",
    mime: "image/png",
    title: "Room",
    source: { appId: "blender-viewer" },
    method: "put",
    createdAt: 100,
    updatedAt: 100,
    size: 10,
    path: "C:/p/.kaava/context/blender-room-top.png",
    relPath: ".kaava/context/blender-room-top.png",
    owned: true,
    missing: false,
    ...over,
  };
}

describe("mergeItems", () => {
  it("keeps one entry per key, the later send", () => {
    const first = item({ sha256: "aaa" });
    const second = item({ sha256: "bbb", updatedAt: 300 });
    const merged = mergeItems([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sha256).toBe("bbb");
    expect(mergeItems([second, first])[0].sha256).toBe("bbb");
  });

  it("moves a re-sent item to the top", () => {
    const front = item({ id: "ctx_f", key: "blender/room/front", createdAt: 100, updatedAt: 100 });
    const tree = item({ id: "ctx_t", key: "godot/main/tree", createdAt: 200, updatedAt: 200 });
    expect(mergeItems([tree, front]).map((i) => i.id)).toEqual(["ctx_t", "ctx_f"]);
    const resent = { ...front, updatedAt: 400 };
    expect(mergeItems([tree, resent]).map((i) => i.id)).toEqual(["ctx_f", "ctx_t"]);
  });

  it("keeps different views of one source as separate entries", () => {
    const a = item({ id: "ctx_1", key: "blender/room/front" });
    const b = item({ id: "ctx_2", key: "blender/room/top", updatedAt: 150 });
    expect(mergeItems([a, b]).map((i) => i.id)).toEqual(["ctx_2", "ctx_1"]);
  });

  it("treats records without a key as their own entries and orders by createdAt", () => {
    const old1 = item({ id: "ctx_o1", key: "", createdAt: 10, updatedAt: undefined });
    const old2 = item({ id: "ctx_o2", key: undefined, createdAt: 20, updatedAt: undefined });
    expect(mergeItems([old1, old2]).map((i) => i.id)).toEqual(["ctx_o2", "ctx_o1"]);
  });

  it("does not mutate its input", () => {
    const list = [
      item({ id: "ctx_x", key: "a", createdAt: 1, updatedAt: 1 }),
      item({ id: "ctx_y", key: "b", updatedAt: 9 }),
    ];
    const copy = list.slice();
    mergeItems(list);
    expect(list).toEqual(copy);
  });
});

describe("recency and wasUpdated", () => {
  it("use the later of the first and latest send", () => {
    expect(recency(item({ createdAt: 5, updatedAt: undefined }))).toBe(5);
    expect(recency(item({ createdAt: 5, updatedAt: 9 }))).toBe(9);
    expect(wasUpdated(item({ createdAt: 5, updatedAt: 9 }))).toBe(true);
    expect(wasUpdated(item({ createdAt: 5, updatedAt: 5 }))).toBe(false);
  });
});
