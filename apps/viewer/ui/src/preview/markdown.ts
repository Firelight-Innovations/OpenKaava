/**
 * Markdown to sanitised HTML, GitHub-flavoured.
 *
 * markdown-it parses and DOMPurify does the trusting. The parser is allowed raw
 * HTML because READMEs use `<details>` and `<img>`, and everything it produces
 * goes through DOMPurify before anything touches the document, so a `<script>`,
 * an `onerror=` or a `javascript:` link never becomes live. That order is the
 * security boundary; nothing relies on markdown-it's own `html: false`.
 *
 * Added to markdown-it's GFM defaults (tables, strikethrough, autolinks):
 * `data-line` on every block, for scroll sync; prefixed heading ids and a hover
 * anchor; task-list checkboxes; and ```mermaid fences as a placeholder.
 */
import MarkdownIt from "markdown-it";
import type { MarkdownIt as Parser, Token } from "markdown-it";
import DOMPurify from "dompurify";

export interface RenderedMarkdown {
  html: string;
  /** At least one ```mermaid fence, so the pane knows to load mermaid. */
  hasMermaid: boolean;
}

/** GitHub's slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export const ANCHOR_PREFIX = "user-content-";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textOf(inline: Token): string {
  return (inline.children ?? [])
    .filter((child) => child.type === "text" || child.type === "code_inline")
    .map((child) => child.content)
    .join("");
}

function build(): Parser {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  // `README.md` is not a web address, though `.md` is a country code. Only
  // schemed links and `www.` are autolinked.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

  md.core.ruler.push("openkaava_lines", (state) => {
    for (const token of state.tokens) {
      if (!token.map || token.type === "inline" || token.type === "html_block") continue;
      if (token.nesting === -1) continue;
      token.attrSet("data-line", String(token.map[0] + 1));
    }
  });

  md.core.ruler.push("openkaava_headings", (state) => {
    const seen = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type !== "heading_open") continue;
      const inline = tokens[i + 1];
      if (!inline || inline.type !== "inline") continue;

      const base = slugify(textOf(inline)) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const slug = count === 0 ? base : `${base}-${count}`;
      tokens[i].attrSet("id", ANCHOR_PREFIX + slug);

      const open = new state.Token("link_open", "a", 1);
      open.attrs = [
        ["class", "md__anchor"],
        ["href", `#${slug}`],
        ["aria-label", "Link to this heading"],
      ];
      const glyph = new state.Token("text", "", 0);
      glyph.content = "#";
      const close = new state.Token("link_close", "a", -1);
      inline.children = [...(inline.children ?? []), open, glyph, close];
    }
  });

  md.core.ruler.push("openkaava_tasks", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i += 1) {
      const inline = tokens[i];
      if (
        inline.type !== "inline" ||
        tokens[i - 1].type !== "paragraph_open" ||
        tokens[i - 2].type !== "list_item_open"
      ) {
        continue;
      }
      const match = /^\[([ xX])\][ \t]/.exec(inline.content);
      const first = inline.children?.[0];
      if (!match || !first || first.type !== "text") continue;

      first.content = first.content.replace(/^\[[ xX]\][ \t]+/, "");
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input class="md__check" type="checkbox" disabled${
        match[1] === " " ? "" : " checked"
      }> `;
      inline.children = [box, ...(inline.children ?? [])];
      tokens[i - 2].attrJoin("class", "md__task");
    }
  });

  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "mermaid") {
      const line = token.map ? ` data-line="${token.map[0] + 1}"` : "";
      return `<div class="md__mermaid"${line}><pre><code class="language-mermaid">${escapeHtml(
        token.content,
      )}</code></pre></div>\n`;
    }
    return fence
      ? fence(tokens, idx, options, env, self)
      : `<pre><code>${escapeHtml(token.content)}</code></pre>\n`;
  };

  return md;
}

let parser: Parser | null = null;

/** YAML front matter at the very top of the file, replaced by blank lines. */
function splitFrontMatter(source: string): { body: string; front: string | null } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { body: source, front: null };
  const blanks = "\n".repeat(match[0].split("\n").length - 1);
  return { body: blanks + source.slice(match[0].length), front: match[1] };
}

export function renderMarkdown(source: string): RenderedMarkdown {
  parser ??= build();
  const { body, front } = splitFrontMatter(source);

  let raw = parser.render(body);
  if (front !== null) {
    raw = `<pre class="md__front"><code>${escapeHtml(front)}</code></pre>\n${raw}`;
  }

  const html = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    // The preview draws inside the app's own document. These are how a file
    // would restyle it, embed something in it, or post from it.
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "link", "meta", "svg"],
    FORBID_ATTR: ["style", "formaction", "srcdoc"],
  });

  return { html, hasMermaid: html.includes('class="md__mermaid"') };
}
