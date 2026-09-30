import type { ContextItem } from "../../bindings";

/** When the item was last sent; a re-send moves it up. */
export function recency(item: ContextItem): number {
  return Math.max(item.updatedAt ?? 0, item.createdAt);
}

/** True when a later send replaced the first one's content. */
export function wasUpdated(item: ContextItem): boolean {
  return (item.updatedAt ?? 0) > item.createdAt;
}

/**
 * The strip's list: one entry per source key, newest send first.
 *
 * Rust already keeps one record per key, so this is the guard for the moments
 * it cannot: a refetch racing a re-send, or records from before keys existed
 * (no key, so each is its own entry). When two entries share a key the later
 * send wins, and the entry keeps its place in the list by that send, not by
 * where the first one was.
 */
export function mergeItems(items: ContextItem[]): ContextItem[] {
  const byKey = new Map<string, ContextItem>();
  const unkeyed: ContextItem[] = [];
  for (const item of items) {
    if (!item.key) {
      unkeyed.push(item);
      continue;
    }
    const held = byKey.get(item.key);
    if (!held || recency(item) >= recency(held)) byKey.set(item.key, item);
  }
  const out = unkeyed.concat(Array.from(byKey.values()));
  out.sort((a, b) => recency(b) - recency(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}
