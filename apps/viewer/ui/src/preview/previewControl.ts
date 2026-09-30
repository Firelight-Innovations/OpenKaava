/**
 * What the Preview button and the Monaco keybinding can ask of the viewer.
 *
 * `Viewer.tsx` owns the state that decides which viewer is mounted, and neither
 * the toolbar (in `App.tsx`) nor Monaco (in `TextViewer`) can reach into it. So
 * the viewer publishes a small control object here and they read it — the same
 * seam `viewer/activeEditor.ts` is for the editor, for the same reason: at most
 * one is live, and the things that need it are not its descendants.
 */
import type { PreviewKind } from "./previewKind";
import type { PreviewKeyMatcher } from "./previewKeys";

/** `source` is Monaco alone, `preview` the rendered form alone, `side` both. */
export type PreviewMode = "source" | "preview" | "side";

export interface PreviewControl {
  kind: PreviewKind;
  mode: PreviewMode;
  /** Ctrl+Shift+V: source to preview and back. From `side`, closes the split. */
  toggle(): void;
  /** Ctrl+K V: open beside the source, or close it again. */
  toggleSide(): void;
}

let current: PreviewControl | null = null;
const listeners = new Set<() => void>();

export function setPreviewControl(next: PreviewControl | null): void {
  current = next;
  listeners.forEach((cb) => cb());
}

/** Stable by reference between changes, so a legal `useSyncExternalStore` snapshot. */
export function previewControl(): PreviewControl | null {
  return current;
}

export function subscribePreviewControl(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Route one keystroke. Returns `true` when it was a preview command that ran, in
 * which case the caller must `preventDefault`.
 *
 * `kind` is `null` for a file with no rendered form. Then nothing is claimed and
 * Ctrl+Shift+V keeps whatever it means to the browser or to Monaco (plain-text
 * paste) — the binding applies only where there is something to preview.
 * Ctrl+K is likewise left alone, so Monaco's own Ctrl+K chords are unaffected.
 */
export function routePreviewKey(
  matcher: PreviewKeyMatcher,
  control: PreviewControl | null,
  event: Parameters<PreviewKeyMatcher["match"]>[0],
): boolean {
  if (!control) return false;
  const command = matcher.match(event);
  if (command === null) return false;
  if (command === "pending") return true;
  if (command === "toggle") control.toggle();
  else control.toggleSide();
  return true;
}
