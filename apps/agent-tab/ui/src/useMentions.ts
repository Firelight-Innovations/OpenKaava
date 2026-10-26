/** Debounced, caret-aware project search; stale answers cannot replace a newer query. */
import { useEffect, useState } from "react";
import { mentionAt, type MentionHit } from "./mentions";
import * as rpc from "./rpc";
import { strings } from "./strings";

/** The kinds a scope searches, where it is more than its own name. */
const SCOPE_KINDS: Record<string, string[]> = {
  file: ["file", "folder"],
  comment: ["comment", "design-comment"],
};

export function useMentions(text: string, caret: number, scope: string | null = null) {
  const query = mentionAt(text, caret);
  const [result, setResult] = useState<{
    query: string | null;
    scope: string | null;
    items: MentionHit[];
    note: string | null;
  }>({ query: null, scope: null, items: [], note: null });
  const typed = query?.query;
  const key = `${typed ?? ""}:${scope ?? ""}`;
  useEffect(() => {
    if (typed === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc.searchContext(typed, scope ? (SCOPE_KINDS[scope] ?? [scope]) : undefined).then(
        ({ items }) => {
          if (!live) return;
          // An empty scope with nothing typed has not been searched yet; say how to start.
          const note = items.length
            ? null
            : scope && !typed
              ? strings.mentions.typeToSearch
              : strings.mentions.empty;
          setResult({ query: key, scope, items, note });
        },
        () => {
          if (live) setResult({ query: key, scope, items: [], note: strings.mentions.failed });
        },
      );
    }, 140);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed, scope, key]);
  if (!query) return { query: null, items: [], note: null, pending: false };
  if (result.query === key)
    return { query, items: result.items, note: result.note, pending: false };
  // While the next answer is on its way, the last one for the same scope stays up, so
  // the list does not blank on every keystroke. They are `pending`: a pick waits for the answer.
  const stale = result.scope === scope ? result.items : [];
  return {
    query,
    items: stale,
    note: stale.length ? null : strings.mentions.searching,
    pending: true,
  };
}
