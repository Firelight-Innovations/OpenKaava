/** Debounced, caret-aware project search; stale answers cannot replace a newer query. */
import { useEffect, useState } from "react";
import { mentionAt, type MentionHit } from "./mentions";
import * as rpc from "./rpc";
import { strings } from "./strings";

export function useMentions(text: string, caret: number, scope: string | null = null) {
  const query = mentionAt(text, caret);
  const [result, setResult] = useState<{
    query: string | null;
    items: MentionHit[];
    note: string | null;
  }>({ query: null, items: [], note: null });
  const typed = query?.query;
  const key = `${typed ?? ""}:${scope ?? ""}`;
  useEffect(() => {
    if (typed === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc
        .searchContext(typed, scope === "file" ? ["file", "folder"] : scope ? [scope] : undefined)
        .then(
          ({ items }) => {
            if (live)
              setResult({ query: key, items, note: items.length ? null : strings.mentions.empty });
          },
          () => {
            if (live) setResult({ query: key, items: [], note: strings.mentions.failed });
          },
        );
    }, 140);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed, scope, key]);
  if (!query) return { query: null, items: [], note: null };
  return {
    query,
    items: result.query === key ? result.items : [],
    note: result.query === key ? result.note : strings.mentions.searching,
  };
}
