/**
 * What a tutorial is made of: a closed set of block kinds rather than
 * Markdown, so a malformed tutorial is a type error. `docs/tutorials.md` §3
 * has the argument, the kind-by-kind table, and the writing conventions.
 *
 * Inside a block's own text, `**bold**` and backticked code are borrowed from
 * Markdown and nothing else is — `Inline.tsx` is the whole of that parser.
 */
import type { MockName } from "../mocks/registry";

/** A key chord, said the way the tutorial says it out loud: `"Ctrl+Shift+P"`. */
export type Chord = string;

export type Block =
  | { kind: "text"; body: string }
  | { kind: "heading"; body: string }
  // Numbered by position at render time, so inserting one mid-tutorial does
  // not renumber the rest.
  | { kind: "step"; body: string; chord?: Chord }
  | { kind: "note"; body: string }
  // Its own kind rather than a `note` with different words — see §3.
  | { kind: "soon"; body: string }
  | { kind: "code"; body: string }
  | { kind: "keys"; rows: { chord: Chord; what: string }[] }
  // A picture of Veistra's UI, built only from `mocks/chrome.tsx`'s primitives.
  | { kind: "mock"; view: MockName; caption?: string }
  // A path of steps in a row, joined by arrows, rather than a numbered list.
  | { kind: "flow"; steps: string[] };

/**
 * One tutorial's body. The catalog entry — title, blurb, minutes, section —
 * lives in `src-tauri/src/apps/tutorial.rs`, because Home draws it too.
 * `takeaway` is required, not optional: writing one forces an answer to
 * "what was this for".
 */
export interface Body {
  blocks: Block[];
  takeaway: string;
}
