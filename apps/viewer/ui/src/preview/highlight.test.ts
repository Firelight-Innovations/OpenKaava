import { describe, expect, it } from "vitest";
import { tokenClass, tokensToHtml } from "./highlight";

describe("code block tokens", () => {
  it("maps Monaco token types by their first segment", () => {
    expect(tokenClass("keyword.ts")).toBe("keyword");
    expect(tokenClass("string.escape.rust")).toBe("string");
    expect(tokenClass("identifier.ts")).toBeNull();
    expect(tokenClass("")).toBeNull();
  });

  it("wraps classed spans and escapes everything else", () => {
    const html = tokensToHtml(
      ["let a = <b>;"],
      [
        [
          { offset: 0, type: "keyword.rs" },
          { offset: 3, type: "" },
          { offset: 8, type: "string.rs" },
        ],
      ],
    );
    expect(html).toBe(
      '<span class="tok tok-keyword">let</span> a = <span class="tok tok-string">&lt;b&gt;;</span>',
    );
  });

  it("escapes lines that have no tokens", () => {
    expect(tokensToHtml(["<script>"], [[]])).toBe("&lt;script&gt;");
  });
});
