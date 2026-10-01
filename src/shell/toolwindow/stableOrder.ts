/**
 * The order the surfaces are rendered in, kept apart from the order they are laid out in.
 *
 * `ToolWindow` draws every surface as a keyed sibling and positions it over its pane. React
 * keeps a keyed sibling's DOM node only while its position among the siblings is unchanged;
 * when the order changes it moves the node, and moving an iframe's node reloads the app inside
 * it. The layout order changes whenever a tab moves to another pane, so rendering in layout
 * order reloaded every dragged app, and the reloaded frame came up as a new window the shell
 * had not registered.
 *
 * Keeps every id that is still present where it was, drops ids that are gone, and appends new
 * ones at the end.
 */
export function stableOrder(previous: readonly string[], next: readonly string[]): string[] {
  const present = new Set(next);
  const kept = previous.filter((id) => present.has(id));
  const known = new Set(kept);
  return kept.concat(next.filter((id) => !known.has(id)));
}

/** Same content, same order: the caller can keep the array it already has. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
