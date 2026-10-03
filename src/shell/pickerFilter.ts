import type { Openable } from "../bindings";

/**
 * The picker's filter, kept out of the component so it can be tested without a
 * DOM. Matches the app's name, its id and its description, case-insensitively.
 *
 * Ranked rather than merely filtered, because "fi" should put Files above an
 * app whose description happens to mention a file: a name that starts with the
 * text first, then a name that contains it, then everything else. The sort is
 * stable, so within a rank the registry's own order is kept.
 */
export function filterApps(apps: Openable[], query: string): Openable[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return apps;

  const rank = (app: Openable): number => {
    const name = app.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (app.id.toLowerCase().includes(needle)) return 2;
    if (app.description.toLowerCase().includes(needle)) return 3;
    return -1;
  };

  return apps
    .map((app, order) => ({ app, order, rank: rank(app) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((row) => row.app);
}

/** Where the highlight goes when the arrow keys run off either end: it wraps. */
export function stepIndex(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return 0;
  return (current + delta + count) % count;
}
