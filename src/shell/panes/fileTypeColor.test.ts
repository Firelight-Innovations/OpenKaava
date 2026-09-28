import { describe, expect, it } from "vitest";
import { fileTypeColor } from "./fileTypeColor";

describe("fileTypeColor", () => {
  it("maps every extension the board names to its own token", () => {
    expect(fileTypeColor("player.gd")).toBe("var(--syn-type)");
    expect(fileTypeColor("main.rs")).toBe("var(--syn-rust)");
    expect(fileTypeColor("Level.tscn")).toBe("var(--info)");
  });

  it("groups .toml and .md under the same grey", () => {
    expect(fileTypeColor("Cargo.toml")).toBe(fileTypeColor("README.md"));
  });

  it("is case-insensitive", () => {
    expect(fileTypeColor("main.RS")).toBe(fileTypeColor("main.rs"));
  });

  it("falls back to the same grey for an extension no board shows", () => {
    expect(fileTypeColor("image.png")).toBe("var(--txt-disabled)");
  });

  it("falls back for a name with no extension", () => {
    expect(fileTypeColor("Dockerfile")).toBe("var(--txt-disabled)");
    expect(fileTypeColor(".gitignore")).toBe("var(--txt-disabled)");
  });
});
