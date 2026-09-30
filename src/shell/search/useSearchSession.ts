/**
 * The one piece of state the whole search feature shares.
 *
 * The trigger lives in the cluster row and the dialog holds the field, the
 * filters and the results — two components, one query. Everything the feature
 * needs is owned here and handed to both. `WindowRoot` instantiates it,
 * because it is already where the open flag lives and where the active
 * cluster is resolved.
 *
 * Deriving the focused hit rather than storing it is deliberate. Results
 * arrive asynchronously and replace each other; an index into the current list
 * cannot dangle, whereas a stored `SearchHit` can easily outlive the search
 * that produced it and leave the preview showing a file that is no longer in
 * any result.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALL_KINDS, orderByKind } from "./kinds";
import { compilePathFilter, parseQuery, toQueryString } from "./query";
import { runSearch } from "./searchSource";
import type { ParsedQuery } from "./query";
import type { LocatorFocus, ResultRow, SearchHit, SearchKind } from "./types";

/**
 * How long the field sits quiet before a walk starts.
 *
 * The walk is not cancellable mid-`files/list`, only between directories, so
 * the cost of starting one on every keystroke is real. This is long enough
 * that ordinary typing produces one search rather than eight, and short enough
 * that it does not read as lag.
 */
const DEBOUNCE_MS = 140;

export interface SearchSession {
  /** The raw field text, tokens and all. The single source of truth — see
   *  `toggleKind`. */
  query: string;
  setQuery: (query: string) => void;
  /** The field text parsed into its filters and search term. Recomputed on
   *  every keystroke, which is cheap: it is a tokenizer over one short line. */
  parsed: ParsedQuery;

  /**
   * The kinds currently being searched.
   *
   * **Derived from `query`, not stored beside it.** The filter popover and the
   * `kind:` tokens are one state, so a click has to be visible in the field
   * and a typed token has to light up the button — which only holds if there
   * is exactly one place the answer lives, and the field is the one the user
   * can see.
   *
   * No `kind:` token means all four, because an unfiltered search is the
   * sensible reading of an unfiltered query and because "all four" and "no
   * restriction" describe the same result set.
   */
  kinds: SearchKind[];
  /**
   * Toggle one kind, by rewriting the field text.
   *
   * Selecting every kind writes *no* tokens rather than four, since the two
   * mean the same thing and the shorter one keeps the field readable.
   *
   * Deselecting the last remaining kind selects them all again instead of
   * leaving none. Zero kinds is unrepresentable in this grammar — the absence
   * of a token already means "all" — and rather than invent a token for
   * "search nothing", which is not a thing anyone wants, the last click wraps
   * around. This is the one place the shared-state decision cost something;
   * see the note in the search section of the mailbox.
   */
  toggleKind: (kind: SearchKind) => void;

  hits: SearchHit[];
  /**
   * `hits` flattened to drawn rows — a file, then each of its matches. The
   * cursor and the arrow keys both index into *this*, not into `hits`, because
   * a match is a stop and a file with nine of them is nine of them.
   */
  rows: ResultRow[];
  /** Matches across every hit. What the results header and replace-all count. */
  matchCount: number;
  /** A walk is in flight. The results region says so rather than looking empty. */
  searching: boolean;
  /** Why the last search failed, or `null`. Shown in place of the results, and
   *  also written to the console so it lands in `recent_errors`. */
  error: string | null;
  /** The last search was cut short (a cap or the backend's time budget), so
   *  `hits` is real but not everything. */
  truncated: boolean;

  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Arrow-key movement, clamped. Returns true if it handled the key. */
  moveActive: (delta: number) => void;

  /** What the locator tree reveals and the preview shows. Null when there is nothing. */
  focus: LocatorFocus | null;

  /** Clears the query and results without touching whether the overlay is open. */
  reset: () => void;
}

export function useSearchSession(root: string | null, clusterId: string | null): SearchSession {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const parsed = useMemo(() => parseQuery(query), [query]);

  // An absent `kind:` token means every kind — see `SearchSession.kinds`.
  const kinds = useMemo<SearchKind[]>(
    () => (parsed.kinds.length > 0 ? parsed.kinds : ALL_KINDS),
    [parsed.kinds],
  );

  // Rebuilt only when the filters actually change, not on every keystroke of
  // the needle: this compiles a `RegExp` per glob, and the walk calls the
  // result once per file.
  const accept = useMemo(
    () => compilePathFilter(parsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the filters, not the needle
    [parsed.include, parsed.exclude, parsed.paths, parsed.kinds, parsed.extensions],
  );

  // Aborts the walk this one supersedes. Held in a ref because it must survive
  // re-renders without causing them — nothing draws differently because an old
  // search is being torn down.
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    inFlight.current?.abort();

    // The *needle* being empty is what makes a search pointless, not the field
    // being empty. A field holding only filters (`*.md`) parses to an empty
    // needle, and `search_content` answers an empty query with an empty
    // response — so this stops here rather than round-tripping for nothing.
    // Listing the files a filter alone selects is a real request (it is the
    // example in Braden's own brief) and needs a backend mode that does not
    // exist yet; see the note in the mailbox.
    if (root === null || parsed.needle.trim() === "") {
      setHits([]);
      setSearching(false);
      setError(null);
      setTruncated(false);
      return;
    }

    const controller = new AbortController();
    inFlight.current = controller;
    setSearching(true);
    setError(null);

    const timer = window.setTimeout(() => {
      void runSearch({
        root,
        clusterId,
        query: parsed.needle,
        kinds,
        accept,
        signal: controller.signal,
      })
        .then((found) => {
          // The guard is what makes an out-of-order walk harmless: a slow
          // search that finishes after a newer one started has already been
          // aborted, and must not overwrite the newer results.
          if (controller.signal.aborted) return;
          setHits(found.hits);
          setTruncated(found.truncated);
          setSearching(false);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          // Abort is handled above. Anything else is a real failure — the
          // backend refused the query, or never answered — and it is shown as
          // one rather than as an empty result, and reported so it reaches
          // `recent_errors` instead of vanishing.
          const message = e instanceof Error ? e.message : String(e);
          console.error(`project search failed: ${message}`);
          setHits([]);
          setTruncated(false);
          setError(message);
          setSearching(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [root, clusterId, parsed.needle, kinds, accept]);

  // A new result set invalidates where the cursor was pointing. Going back to
  // the top is the only position that is meaningful across two different
  // lists — keeping the index would point at an unrelated file that happens to
  // sit at the same offset.
  useEffect(() => {
    setActiveIndex(0);
  }, [hits]);

  const toggleKind = useCallback(
    (kind: SearchKind) => {
      const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];

      // Both ends of the range collapse to "no tokens": all four selected and
      // none selected are written the same way, because the grammar has one
      // spelling for "unrestricted" and none for "nothing". See `toggleKind`
      // in `SearchSession` for why the empty case wraps around rather than
      // searching nothing.
      const tokens = next.length === 0 || next.length === ALL_KINDS.length ? [] : next;

      // Written through `toQueryString` rather than by splicing the field
      // text, so the button and the keyboard produce byte-identical queries.
      setQuery(toQueryString({ ...parsed, kinds: tokens }));
    },
    [kinds, parsed],
  );

  // Grouped by kind, then flattened once per result set rather than per render: the list is walked by
  // the arrow keys, by the scroll-into-view effect and by the renderer, and all
  // three have to agree on what row N is.
  const rows = useMemo<ResultRow[]>(() => {
    const flat: ResultRow[] = [];
    for (const hit of orderByKind(hits)) {
      flat.push({ row: "file", hit });
      hit.matches.forEach((match, index) => {
        flat.push({ row: "match", hit, match, ordinal: index + 1 });
      });
    }
    return flat;
  }, [hits]);

  const matchCount = useMemo(
    () => hits.reduce((total, hit) => total + hit.matches.length, 0),
    [hits],
  );

  const moveActive = useCallback(
    (delta: number) => {
      setActiveIndex((index) => {
        if (rows.length === 0) return 0;
        return Math.min(Math.max(index + delta, 0), rows.length - 1);
      });
    },
    [rows.length],
  );

  const reset = useCallback(() => {
    setQuery("");
    setHits([]);
    setActiveIndex(0);
  }, []);

  // A file row previews its file from the top; a match row previews the same
  // file scrolled to that match. Which is why the cursor sits on rows rather
  // than on hits — the two lower panes need to be told *which* match, and a
  // hit alone cannot say.
  const focus = useMemo<LocatorFocus | null>(() => {
    const row = rows[activeIndex];
    if (row === undefined) return null;
    return { path: row.hit.path, match: row.row === "match" ? row.match : null };
  }, [rows, activeIndex]);

  return {
    query,
    setQuery,
    parsed,
    kinds,
    toggleKind,
    hits,
    rows,
    matchCount,
    searching,
    error,
    truncated,
    activeIndex,
    setActiveIndex,
    moveActive,
    focus,
    reset,
  };
}
