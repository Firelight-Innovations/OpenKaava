/**
 * Monaco's tokens as `<span>`s coloured by this app's own classes.
 *
 * Monaco's `colorize` would do this in one call, but it emits `mtk` classes
 * whose colours come from the editor theme — which is a dark theme in both app
 * themes, so a code block would be pale text on a pale page in light mode. The
 * tokenizer is the part worth borrowing; the colours are `preview.css`'s, from
 * design tokens, and follow the theme.
 */

export interface RawToken {
  offset: number;
  type: string;
}

/** Token types Monaco's Monarch grammars emit, by their first dotted segment. */
const KNOWN = new Set([
  "comment",
  "string",
  "number",
  "keyword",
  "type",
  "regexp",
  "tag",
  "attribute",
  "predefined",
  "constant",
  "annotation",
  "metatag",
  "operator",
  "delimiter",
  "variable",
]);

/** The class suffix for a token type, or `null` for plain text. */
export function tokenClass(type: string): string | null {
  const head = type.split(".")[0];
  return KNOWN.has(head) ? head : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One HTML string for the whole block. `lines` and `tokens` are parallel, as
 * `monaco.editor.tokenize` returns them; a line with no tokens is plain.
 */
export function tokensToHtml(lines: string[], tokens: RawToken[][]): string {
  return lines
    .map((line, index) => {
      const row = tokens[index] ?? [];
      if (row.length === 0) return escapeHtml(line);
      let out = "";
      for (let i = 0; i < row.length; i += 1) {
        const start = row[i].offset;
        const end = i + 1 < row.length ? row[i + 1].offset : line.length;
        const text = escapeHtml(line.slice(start, end));
        const cls = tokenClass(row[i].type);
        out += cls ? `<span class="tok tok-${cls}">${text}</span>` : text;
      }
      return out;
    })
    .join("\n");
}
