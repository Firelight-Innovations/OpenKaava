/**
 * What the floating Code | Preview | Steps control shows and does, as pure
 * functions so the rules can be tested without a DOM.
 *
 * Two pieces of state feed it: `view` (Code or Steps) lives in `App.tsx`, and
 * the preview mode lives in `Viewer.tsx`, reached through `previewControl`.
 * Code and Preview both mean "the file is showing" and differ only in the
 * second; Steps is the first.
 */
import type { PreviewMode } from "./preview/previewControl";

export type ViewMode = "code" | "steps";
export type Segment = "code" | "preview" | "steps";

/** The lit segment. `previewMode` is `null` for a file with no rendered form. */
export function activeSegment(view: ViewMode, previewMode: PreviewMode | null): Segment {
  if (view === "steps") return "steps";
  return previewMode !== null && previewMode !== "source" ? "preview" : "code";
}

export interface ModePlan {
  view: ViewMode;
  /** Run the preview control's `toggle` after switching. */
  toggle: boolean;
}

/**
 * Clicking a segment. The preview control only flips between source and
 * rendered, so the plan says whether a flip is needed to land where asked.
 */
export function planSegment(target: Segment, previewMode: PreviewMode | null): ModePlan {
  if (target === "steps") return { view: "steps", toggle: false };
  if (previewMode === null) return { view: "code", toggle: false };
  const rendered = previewMode !== "source";
  if (target === "code") return { view: "code", toggle: rendered };
  return { view: "code", toggle: !rendered };
}
