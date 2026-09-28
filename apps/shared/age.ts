/**
 * "Age of render" labels — the Godot Viewer's and the Blender Viewer's header
 * both name how stale the thing they're showing is, per
 * `docs/KAAVA-UX-REWORK.md` §3.1/§3.2. Shared because both viewers need the
 * exact same rounding so "a render from three minutes ago" reads the same way
 * in both panes.
 */

/**
 * `renderedAt` (milliseconds since the Unix epoch, or `null` when nothing has
 * rendered yet) as a short relative label. `null` reads as "no render yet"
 * rather than "0 seconds ago" — the honest-empty-state rule applies to this
 * label as much as to the body of the pane.
 */
export function formatRenderAge(renderedAt: number | null, now: number = Date.now()): string {
  if (renderedAt === null) {
    return "no render yet";
  }
  const deltaMs = Math.max(0, now - renderedAt);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 5) {
    return "rendered just now";
  }
  if (seconds < 60) {
    return `rendered ${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `rendered ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `rendered ${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `rendered ${days}d ago`;
}
