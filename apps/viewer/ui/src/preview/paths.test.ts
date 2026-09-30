import { describe, expect, it } from "vitest";
import { classifyLink, resolveRelative } from "./paths";

const WIN = "C:\\code\\proj\\docs\\guide.md";
const POSIX = "/home/me/proj/docs/guide.md";

describe("resolving a relative reference", () => {
  it("resolves siblings, subfolders and parents against the file's folder", () => {
    expect(resolveRelative(WIN, "other.md")).toBe("C:\\code\\proj\\docs\\other.md");
    expect(resolveRelative(WIN, "./img/a.png")).toBe("C:\\code\\proj\\docs\\img\\a.png");
    expect(resolveRelative(WIN, "../README.md")).toBe("C:\\code\\proj\\README.md");
    expect(resolveRelative(POSIX, "../assets/a.svg")).toBe("/home/me/proj/assets/a.svg");
  });

  it("decodes percent escapes and drops the query and fragment", () => {
    expect(resolveRelative(WIN, "my%20doc.md#top")).toBe("C:\\code\\proj\\docs\\my doc.md");
    expect(resolveRelative(WIN, "a.png?raw=1")).toBe("C:\\code\\proj\\docs\\a.png");
  });

  it("keeps the drive prefix and refuses to climb out of the root", () => {
    expect(resolveRelative("C:\\a.md", "../b.md")).toBeNull();
    expect(resolveRelative("C:\\a.md", "b.md")).toBe("C:\\b.md");
  });

  it("does not resolve absolute or schemed references", () => {
    expect(resolveRelative(WIN, "https://x.test/a.png")).toBeNull();
    expect(resolveRelative(WIN, "/etc/passwd")).toBeNull();
    expect(resolveRelative(WIN, "C:\\Windows\\win.ini")).toBeNull();
    expect(resolveRelative(WIN, "#top")).toBeNull();
  });
});

describe("what a link click does", () => {
  it("scrolls to an in-page anchor", () => {
    expect(classifyLink(WIN, "#install")).toEqual({ kind: "anchor", id: "install" });
  });

  it("hands http, https and mailto to the system browser", () => {
    expect(classifyLink(WIN, "https://example.com/x")).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
    expect(classifyLink(WIN, "mailto:a@b.co").kind).toBe("external");
  });

  it("opens a relative markdown link in the viewer", () => {
    expect(classifyLink(WIN, "../README.md#usage")).toEqual({
      kind: "file",
      path: "C:\\code\\proj\\README.md",
      fragment: "usage",
    });
  });

  it("blocks every other scheme and absolute path", () => {
    for (const href of [
      "javascript:alert(1)",
      "file:///C:/x",
      "ms-settings:",
      "/etc/hosts",
      "\\\\server\\share",
    ]) {
      expect(classifyLink(WIN, href).kind).toBe("blocked");
    }
  });
});
