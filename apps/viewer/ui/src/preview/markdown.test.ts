// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ANCHOR_PREFIX, renderMarkdown, slugify } from "./markdown";

const html = (source: string) => renderMarkdown(source).html;

describe("sanitising", () => {
  it("removes script elements", () => {
    const out = html("hello\n\n<script>window.pwned = 1</script>\n");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("pwned");
  });

  it("removes event handlers and javascript: links", () => {
    const out = html('<img src="x" onerror="alert(1)">\n\n[click](javascript:alert(1))\n');
    expect(out).not.toContain("onerror");
    expect(out).not.toMatch(/href="javascript:/i);
  });

  it("removes frames, forms, styles and inline style attributes", () => {
    const out = html(
      '<iframe src="https://evil.test"></iframe><form action="x"><input name="a"></form><style>body{display:none}</style><p style="position:fixed">x</p>',
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("style=");
  });

  it("keeps the raw HTML READMEs actually use", () => {
    const out = html("<details><summary>More</summary>\n\nbody\n\n</details>\n");
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>More</summary>");
  });
});

describe("GitHub-flavoured features", () => {
  it("renders tables", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toContain("<table");
    expect(out).toContain("<th>a</th>");
  });

  it("renders task lists as disabled checkboxes", () => {
    const out = html("- [ ] todo\n- [x] done\n");
    expect(out.match(/<input/g)).toHaveLength(2);
    expect(out).toMatch(/type="checkbox"[^>]*disabled/);
    expect(out).toMatch(/checked/);
    expect(out).toContain("todo");
    expect(out).not.toContain("[ ]");
  });

  it("renders strikethrough and autolinks", () => {
    expect(html("~~gone~~")).toContain("<s>gone</s>");
    expect(html("see https://example.com now")).toContain('href="https://example.com"');
  });

  it("does not turn a filename into a web link", () => {
    expect(html("open README.md please")).not.toContain("<a ");
  });

  it("marks fenced code with its language", () => {
    expect(html("```ts\nconst a = 1;\n```\n")).toContain('class="language-ts"');
  });

  it("leaves relative image and link targets as written, for the pane to resolve", () => {
    const out = html("![alt](./img/a.png)\n\n[doc](../other.md)\n");
    expect(out).toContain('src="./img/a.png"');
    expect(out).toContain('href="../other.md"');
  });
});

describe("headings", () => {
  it("get prefixed ids and a hover anchor", () => {
    const out = html("# Hello, World!\n");
    expect(out).toContain(`id="${ANCHOR_PREFIX}hello-world"`);
    expect(out).toContain('class="md__anchor"');
    expect(out).toContain('href="#hello-world"');
  });

  it("de-duplicates repeated headings the way GitHub does", () => {
    const out = html("## Usage\n\n## Usage\n");
    expect(out).toContain(`id="${ANCHOR_PREFIX}usage"`);
    expect(out).toContain(`id="${ANCHOR_PREFIX}usage-1"`);
  });

  it("slugifies", () => {
    expect(slugify("Getting Started (v2)")).toBe("getting-started-v2");
  });
});

describe("mermaid fences", () => {
  it("become a placeholder and are reported", () => {
    const rendered = renderMarkdown("intro\n\n```mermaid\ngraph TD; A-->B;\n```\n");
    expect(rendered.hasMermaid).toBe(true);
    expect(rendered.html).toContain('class="md__mermaid"');
    expect(rendered.html).toContain("A--&gt;B");
  });

  it("are not reported when there are none", () => {
    expect(renderMarkdown("```ts\nx\n```\n").hasMermaid).toBe(false);
  });

  it("cannot smuggle markup through the diagram source", () => {
    const rendered = renderMarkdown("```mermaid\n</code></pre><img src=x onerror=alert(1)>\n```\n");
    expect(rendered.html).not.toContain("<img");
    // Present only as escaped text inside the code element.
    expect(rendered.html).toContain("&lt;img");
  });
});

describe("source lines", () => {
  it("stamps blocks with their 1-based source line", () => {
    const out = html("# Title\n\npara one\n\npara two\n");
    expect(out).toContain('data-line="1"');
    expect(out).toContain('data-line="3"');
    expect(out).toContain('data-line="5"');
  });

  it("keeps lines honest after YAML front matter", () => {
    const out = html("---\ntitle: x\n---\n\n# Title\n");
    expect(out).toContain('class="md__front"');
    expect(out).toContain('data-line="5"');
  });
});
