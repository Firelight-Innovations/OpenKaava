import { describe, expect, it } from "vitest";
import { signature, slugify, toSaved, uniqueId, withDesign, type SceneElement } from "./scene";

const el = (id: string, extra: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 7,
  ...extra,
});

const BG = { viewBackgroundColor: "#fff" };

describe("toSaved", () => {
  it("drops deleted elements and keeps only the view settings worth committing", () => {
    const saved = toSaved(
      [el("a"), el("b", { isDeleted: true })],
      { viewBackgroundColor: "#ffffff", gridSize: 20, scrollX: 5, zoom: { value: 2 } },
      {},
      { title: "T" },
    );
    expect(saved.elements.map((e) => e.id)).toEqual(["a"]);
    expect(saved.appState).toEqual({ viewBackgroundColor: "#ffffff", gridSize: 20 });
    expect(saved.kaava).toEqual({ title: "T" });
    expect(saved.type).toBe("excalidraw");
  });

  it("keeps a pasted image only while an element points at it", () => {
    const saved = toSaved(
      [
        el("img", { type: "image", fileId: "f1" }),
        el("gone", { type: "image", fileId: "f2", isDeleted: true }),
      ],
      {},
      { f1: { id: "f1" }, f2: { id: "f2" }, f3: { id: "f3" } },
      undefined,
    );
    expect(Object.keys(saved.files)).toEqual(["f1"]);
    expect(saved).not.toHaveProperty("kaava");
  });
});

describe("signature", () => {
  const base = () => toSaved([el("a"), el("b")], BG, {}, { title: "T" });

  it("is unchanged by scrolling, zooming and selecting", () => {
    const moved = toSaved(
      [el("a"), el("b")],
      { ...BG, scrollX: 100, zoom: { value: 3 }, selectedElementIds: { a: true } },
      {},
      { title: "T" },
    );
    expect(signature(moved)).toBe(signature(base()));
  });

  it("changes when an element is edited, added or removed", () => {
    const edited = toSaved([el("a", { version: 2 }), el("b")], BG, {}, { title: "T" });
    const added = toSaved([el("a"), el("b"), el("c")], BG, {}, { title: "T" });
    const removed = toSaved([el("a"), el("b", { isDeleted: true })], BG, {}, { title: "T" });
    const sigs = new Set([
      signature(base()),
      signature(edited),
      signature(added),
      signature(removed),
    ]);
    expect(sigs.size).toBe(4);
  });

  it("changes when the title does", () => {
    const renamed = toSaved([el("a"), el("b")], BG, {}, { title: "U" });
    expect(signature(renamed)).not.toBe(signature(base()));
  });
});

describe("ids", () => {
  it("makes a slug the backend accepts", () => {
    expect(slugify("Hospital Wing!")).toBe("hospital-wing");
    expect(slugify("  Ünïcode  &  things ")).toBe("unicode-things");
    expect(slugify("../etc")).toBe("etc");
    expect(slugify("***")).toBe("");
    expect(slugify("a".repeat(100)).length).toBe(64);
  });

  it("finds the first free id", () => {
    expect(uniqueId("world", new Set())).toBe("world");
    expect(uniqueId("world", new Set(["world"]))).toBe("world-2");
    expect(uniqueId("world", new Set(["world", "world-2"]))).toBe("world-3");
    expect(uniqueId("", new Set())).toBe("canvas");
  });
});

describe("design override", () => {
  it("sets one choice without touching the other or the bookkeeping", () => {
    const kaava = { id: "game", title: "Game", design: { style: "whiteboard" } };
    expect(withDesign(kaava, "detail", "dense")).toEqual({
      id: "game",
      title: "Game",
      design: { style: "whiteboard", detail: "dense" },
    });
    expect(kaava.design).toEqual({ style: "whiteboard" });
  });

  it("drops an emptied design so a canvas that follows Settings leaves no trace", () => {
    const one = withDesign({ id: "g", design: { detail: "sparse" } }, "detail", null);
    expect(one).toEqual({ id: "g" });
    expect("design" in one).toBe(false);
    expect(withDesign(undefined, "style", null)).toEqual({});
  });

  it("changes the signature, so choosing a style is saved", () => {
    const base = toSaved([], {}, {}, { id: "g" });
    const picked = toSaved([], {}, {}, withDesign({ id: "g" }, "style", "minimal"));
    expect(signature(picked)).not.toBe(signature(base));
    expect(toSaved([], {}, {}, withDesign({ id: "g" }, "style", "minimal")).kaava?.design).toEqual({
      style: "minimal",
    });
  });
});
