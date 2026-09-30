import { describe, expect, it } from "vitest";

import { DEFAULT_KIND, extensionOf, kindOf, orderByKind } from "./kinds";

describe("extensionOf", () => {
  it("takes the last segment only", () => {
    expect(extensionOf("manifest.generated.ts")).toBe("ts");
  });

  it("lowercases", () => {
    expect(extensionOf("Cargo.TOML")).toBe("toml");
  });

  it("reads no extension off a dotfile", () => {
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("reads no extension off a name without one", () => {
    expect(extensionOf("Makefile")).toBe("");
  });
});

describe("kindOf", () => {
  it("classifies OpenKaava's own filenames before their extension", () => {
    expect(kindOf("/repo/kaava.toml")).toBe("kaava");
    expect(kindOf("/repo/Cargo.toml")).toBe("data");
  });

  it("classifies the marker extension wherever it appears", () => {
    expect(kindOf("/repo/my-game.kaava")).toBe("kaava");
  });

  it("classifies everything beneath a .kaava directory", () => {
    expect(kindOf("/repo/.kaava/traces/run.json")).toBe("kaava");
    expect(kindOf("/repo/traces/run.json")).toBe("data");
  });

  it("reads Windows separators", () => {
    expect(kindOf("C:\\repo\\.kaava\\traces\\run.json")).toBe("kaava");
  });

  it("does not match .kaava as a partial segment", () => {
    expect(kindOf("/repo/not.kaava.d/run.json")).toBe("data");
  });

  it("falls back rather than failing on an unknown extension", () => {
    expect(kindOf("/repo/notes.xyz")).toBe(DEFAULT_KIND);
  });
});

describe("orderByKind", () => {
  it("groups by kind in the filter order and keeps walk order inside a group", () => {
    const hits = [
      { kind: "content", id: 1 },
      { kind: "script", id: 2 },
      { kind: "content", id: 3 },
      { kind: "script", id: 4 },
    ] as const;
    expect(orderByKind([...hits]).map((h) => h.id)).toEqual([2, 4, 1, 3]);
  });
});
