import { useCallback, useEffect, useState } from "react";
import {
  contextList,
  contextThumb,
  onContextChanged,
  terminalHarness,
  type ContextItem,
  type HarnessInfo,
} from "../../bindings";
import { subscribeHarnessRefresh } from "../harnessRefresh";
import { mergeItems } from "./mergeContext";

/**
 * The context items of the environment this terminal is in, newest first,
 * refetched whenever Rust says a store changed. One fetch per event rather than
 * a patch: the list is at most a few hundred small records, and refetching
 * cannot drift from what is on disk.
 */
export function useContextItems(sessionId: string): ContextItem[] {
  const [items, setItems] = useState<ContextItem[]>([]);

  const refresh = useCallback(() => {
    contextList(sessionId).then(
      (list) => setItems(mergeItems(list)),
      () => setItems([]),
    );
  }, [sessionId]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    refresh();
    void onContextChanged(() => {
      if (live) refresh();
    }).then((unlisten) => {
      if (live) stop = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [refresh]);

  return items;
}

/** What this terminal is aimed at, re-read when `refreshKey` changes. Detection
 *  is a process-tree walk, so it runs on demand and never on a timer. */
export function useHarnessInfo(
  sessionId: string,
  refreshKey: unknown,
): { info: HarnessInfo | null; refresh: () => void } {
  const [info, setInfo] = useState<HarnessInfo | null>(null);
  const refresh = useCallback(() => {
    terminalHarness(sessionId).then(setInfo, () => setInfo(null));
  }, [sessionId]);
  useEffect(refresh, [refresh, refreshKey]);
  // Focus, a title change or an insert may mean a different program is now
  // running; `harnessRefresh.ts` throttles those to one detection per ~2s.
  useEffect(() => subscribeHarnessRefresh(sessionId, refresh), [sessionId, refresh]);
  return { info, refresh };
}

const thumbs = new Map<string, string>();

/** What identifies one version of an item's bytes: a re-send keeps the id and
 *  changes the hash, so the thumbnail is fetched again. */
function thumbKey(item: ContextItem): string {
  return `${item.id}:${item.sha256 ?? item.updatedAt ?? item.createdAt}`;
}

/** A `data:` URL for an image item, or `null` until it has loaded (or for a
 *  kind with no picture). Cached per version of the bytes for the life of the
 *  window; a re-send of the same source is a new version. */
export function useThumb(sessionId: string, item: ContextItem): string | null {
  const wants = (item.kind === "image" || item.kind === "panel") && !item.missing;
  const cacheKey = thumbKey(item);
  const [, setLoaded] = useState(0);

  useEffect(() => {
    if (!wants || thumbs.has(cacheKey)) return;
    let live = true;
    contextThumb(sessionId, item.id).then(
      ([mime, base64]) => {
        thumbs.set(cacheKey, `data:${mime};base64,${base64}`);
        if (live) setLoaded((n) => n + 1);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sessionId, item.id, cacheKey, wants]);

  return wants ? (thumbs.get(cacheKey) ?? null) : null;
}
