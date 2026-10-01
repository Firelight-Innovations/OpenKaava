import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Who owns the title bar's search box. By default it is the project file search;
 * a surface with a filter of its own can claim it instead of drawing a second
 * bar. The convention is in `docs/design-notes/titlebar-search.md`.
 *
 * A module-level store rather than a context, so the regions that touch it share
 * nothing but this file, as STANDARDS.md 1.2 requires.
 */

/**
 * One surface's claim. Claims form a stack and the most recent wins; releasing
 * one hands the field to the claim beneath it, and an empty stack reverts to
 * project search. Updating a claim never changes its place; only a fresh claim
 * does. Claims made in one commit land children first.
 */
export interface TitlebarSearchClaim {
  /** What the empty field says, e.g. "Search settings". Also its accessible name. */
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter in the field. */
  onSubmit?: () => void;
  /** Escape in the field. Absent means Escape is left to whoever else handles it. */
  onEscape?: () => void;
}

interface Entry {
  claim: TitlebarSearchClaim;
}

let stack: Entry[] = [];
let snapshot: TitlebarSearchClaim | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
  const next = top === undefined ? null : top.claim;
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Take the field. Returns the handle to update or release the claim. */
export function claimTitlebarSearch(claim: TitlebarSearchClaim): {
  update: (next: TitlebarSearchClaim) => void;
  release: () => void;
} {
  const entry: Entry = { claim };
  stack.push(entry);
  publish();
  return {
    update(next) {
      entry.claim = next;
      publish();
    },
    release() {
      stack = stack.filter((e) => e !== entry);
      publish();
    },
  };
}

/** The claim currently showing in the title bar, or null for project search. */
export function activeTitlebarSearch(): TitlebarSearchClaim | null {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For the title bar: re-renders whenever the winning claim changes. */
export function useActiveTitlebarSearch(): TitlebarSearchClaim | null {
  return useSyncExternalStore(subscribe, activeTitlebarSearch, activeTitlebarSearch);
}

/**
 * For a surface: claim the title bar's search field while mounted.
 *
 * Pass `null` to hold off (a surface that is mounted but not the active one).
 * The claim is made when the argument goes from null to non-null and released
 * on the way back or on unmount; every other render just updates it.
 */
export function useTitlebarSearch(claim: TitlebarSearchClaim | null): void {
  const handle = useRef<ReturnType<typeof claimTitlebarSearch> | null>(null);
  const latest = useRef(claim);
  latest.current = claim;
  const wanted = claim !== null;

  useEffect(() => {
    if (!wanted || latest.current === null) return;
    handle.current = claimTitlebarSearch(latest.current);
    return () => {
      handle.current?.release();
      handle.current = null;
    };
  }, [wanted]);

  // Runs every render, after the claim effect above, so a first render's claim
  // exists by the time it is updated and a later keystroke reaches the store.
  useEffect(() => {
    if (claim !== null) handle.current?.update(claim);
  });
}

/** Test seam: forget every claim. */
export function resetTitlebarSearch(): void {
  stack = [];
  publish();
}
