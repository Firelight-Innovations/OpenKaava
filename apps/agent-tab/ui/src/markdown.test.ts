// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("draws an image as its alt text and fetches nothing", () => {
    const html = renderMarkdown("see ![a <b> chart](https://example.com/track.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("example.com");
    expect(html).toContain("a &lt;b&gt; chart");
  });

  it("drops raw HTML", () => {
    expect(renderMarkdown('<img src="https://example.com/x.png">')).not.toContain("<img");
  });
});
