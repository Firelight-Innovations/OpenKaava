/** The internal shapes the search overlay is built from. Why they are not in
 *  `contract.ts` yet, and what the existing `SearchType`/`SearchResult`/
 *  `SearchIndex` trio there still backs: `docs/design-notes/shell-search.md`. */

/** What a hit *is*, a coarser question than its file extension — the file axis
 *  only, unlike `contract.ts`'s five-way `SearchType`, which mixes file kinds
 *  with "terminal output" and "tool settings". See the design note. */
export type SearchKind = "script" | "data" | "content" | "kaava";

/** One row in the results region. `path` is absolute because every consumer
 *  needs it absolute; relative display is computed at draw time, not stored. */
export interface SearchHit {
  /** Absolute path to the file this hit is in. */
  path: string;
  /** Basename, precomputed only because every row draws it. */
  name: string;
  kind: SearchKind;
  /** Every place inside the file the query matched, in file order. Empty for a
   *  name-only hit — a real and common case, drawn as one row with nothing
   *  nested under it. A list rather than one match because find-and-replace
   *  steps through matches, not files; see the design note. */
  matches: SearchMatch[];
}

export interface SearchMatch {
  /** 1-based, matching what Monaco's `revealLineInCenter` expects. */
  line: number;
  /** 1-based column of the first matched character. */
  column: number;
  /** The matched line's full text, for the row's preview snippet. */
  text: string;
  /** Length of the match within `text`, so the row can mark it. */
  length: number;
}

/** The results region flattened to what it draws: one entry per row. Rendered
 *  and navigated flat rather than as the nested list it is, because the arrow
 *  keys step through *matches* — see the design note. */
export type ResultRow =
  | { row: "file"; hit: SearchHit }
  | {
      row: "match";
      hit: SearchHit;
      match: SearchMatch;
      /** 1-based position within this file's matches, for "3 of 9". */
      ordinal: number;
    };

/** What the overlay is currently pointing at, and why. */
export interface LocatorFocus {
  /** Absolute path of the file to reveal and preview. */
  path: string;
  /** Carried through so the preview can scroll to the hit, when there is one. */
  match: SearchMatch | null;
}
