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
  it("classifies Veistra's own filenames before their extension", () => {
    expect(kindOf("/repo/veistra.toml")).toBe("veistra");
    expect(kindOf("/repo/Cargo.toml")).toBe("data");
  });

  it("classifies the marker extension wherever it appears", () => {
    expect(kindOf("/repo/my-game.veistra")).toBe("veistra");
  });

  it("classifies everything beneath a .veistra directory", () => {
    expect(kindOf("/repo/.veistra/traces/run.json")).toBe("veistra");
    expect(kindOf("/repo/traces/run.json")).toBe("data");
  });

  it("reads Windows separators", () => {
    expect(kindOf("C:\\repo\\.veistra\\traces\\run.json")).toBe("veistra");
  });

  it("does not match .veistra as a partial segment", () => {
    expect(kindOf("/repo/not.veistra.d/run.json")).toBe("data");
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
