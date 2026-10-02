/**
 * Where a comment's target sits on screen, as pure functions.
 *
 * While a note is being written, and while an open comment is hovered in the
 * panel, the canvas shows a border round the elements or area the note is
 * about, with a pin and a leader line towards it. All of that is DOM over the
 * editor (see `HighlightOverlay.tsx`), never a scene element, so it is not
 * saved, not exported and never reaches an agent.
 *
 * The box is worked out in scene coordinates only when the elements or the
 * target change; panning and zooming just re-run `toScreen`, which is four
 * multiplications.
 */
import { boxOf, frameForKey, type Box } from "./review";
import type { SceneElement } from "./scene";

/** What to outline: element ids, or a region relative to a frame's top-left. */
export type HighlightSpec =
  | { frameId: string; elementIds: string[] }
  | { frameId: string; region: { x: number; y: number; width: number; height: number } };

/** One outline to draw: `key` is stable so React keeps the node between pans. */
export interface Highlight {
  key: string;
  kind: "draft" | "comment";
  spec: HighlightSpec;
}

export interface HighlightView {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  width: number;
  height: number;
}

/** The union of the boxes of every live element named, or null when none are present. */
export function unionBox(elements: readonly SceneElement[], ids: readonly string[]): Box | null {
  const want = new Set(ids);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of elements) {
    if (el.isDeleted || !want.has(el.id)) continue;
    const b = boxOf(el);
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return left === Infinity ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

/** A spec as a scene-coordinate box, or null when what it names is gone. */
export function sceneBox(elements: readonly SceneElement[], spec: HighlightSpec): Box | null {
  if ("region" in spec) {
    const frame = frameForKey(elements, spec.frameId);
    if (!frame) return null;
    const f = boxOf(frame);
    return {
      x: f.x + spec.region.x,
      y: f.y + spec.region.y,
      width: spec.region.width,
      height: spec.region.height,
    };
  }
  const found = unionBox(elements, spec.elementIds);
  if (found) return found;
  // Every named element is gone: the frame is the closest thing left to point at.
  const frame = frameForKey(elements, spec.frameId);
  return frame ? boxOf(frame) : null;
}

/** A scene box in editor pixels, the inverse of `viewportToScene` with no page offset. */
export function toScreen(box: Box, view: Pick<HighlightView, "scrollX" | "scrollY" | "zoom">): Box {
  const z = view.zoom.value;
  return {
    x: (box.x + view.scrollX) * z,
    y: (box.y + view.scrollY) * z,
    width: box.width * z,
    height: box.height * z,
  };
}

/** Pixels the border sits outside the box, so it does not cover the drawing's own edge. */
export const BORDER_PAD = 4;
/** Pin radius, and how far its centre sits off the box's top-left corner. */
export const PIN_R = 12;
const PIN_OFFSET = 18;

export interface Placement {
  /** The padded border rectangle. */
  rect: Box;
  /** Pin centre, kept inside the editor so it is never lost off an edge. */
  pin: { x: number; y: number };
  /** The leader's far end on the border, or null when the pin already touches it. */
  leader: { x: number; y: number } | null;
  /** True when the box is wholly outside the viewport; the pin is then clamped to an edge. */
  offscreen: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The border, pin and leader for a screen box. The pin hangs off the top-left
 * corner; when that corner is out of view the pin slides along the edge of the
 * editor, and the leader keeps it tied to the nearest point of the border.
 */
export function placement(
  screen: Box,
  size: { width: number; height: number },
  pad: number = BORDER_PAD,
): Placement {
  const rect: Box = {
    x: screen.x - pad,
    y: screen.y - pad,
    width: Math.max(screen.width, 0) + pad * 2,
    height: Math.max(screen.height, 0) + pad * 2,
  };
  const pin = {
    x: clamp(rect.x - PIN_OFFSET + PIN_R, PIN_R, Math.max(PIN_R, size.width - PIN_R)),
    y: clamp(rect.y - PIN_OFFSET + PIN_R, PIN_R, Math.max(PIN_R, size.height - PIN_R)),
  };
  const near = {
    x: clamp(pin.x, rect.x, rect.x + rect.width),
    y: clamp(pin.y, rect.y, rect.y + rect.height),
  };
  const dist = Math.hypot(near.x - pin.x, near.y - pin.y);
  const offscreen =
    rect.x + rect.width < 0 ||
    rect.y + rect.height < 0 ||
    rect.x > size.width ||
    rect.y > size.height;
  return { rect, pin, leader: dist > PIN_R ? near : null, offscreen };
}

/**
 * Which outlines to draw. The note being written always shows; a hovered
 * comment adds its own. Resolved comments are not outlined: they are history,
 * and a pin would suggest something is still open.
 */
export function activeHighlights(
  draft: HighlightSpec | null,
  hovered: { id: string; status: string; spec: HighlightSpec } | null,
): Highlight[] {
  const out: Highlight[] = [];
  if (draft) out.push({ key: "draft", kind: "draft", spec: draft });
  if (hovered && hovered.status === "open")
    out.push({ key: `c:${hovered.id}`, kind: "comment", spec: hovered.spec });
  return out;
}
