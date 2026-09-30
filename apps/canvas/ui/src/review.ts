/**
 * What the sidebar needs to know about frames, selections and comment targets,
 * as pure functions over the scene's plain elements.
 *
 * A comment is pinned to one diagram (a frame) and points at element ids or a
 * box relative to that frame's top-left, the shape `canvas/create-comment`
 * takes (see `src-tauri/src/apps/canvas/comments.rs`). Working out which frame
 * a selection or a dragged box belongs to happens here, so the panel and its
 * tests share one answer.
 *
 * Rejected: asking Rust to resolve the frame from scene coordinates. Rust reads
 * the file on disk, and the person is pointing at what the editor shows, which
 * may be a few hundred milliseconds of edits ahead of the last autosave.
 */
import type { SceneElement } from "./scene";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameRow {
  /** The frame element's id: what a comment's `diagram` is sent as. */
  elementId: string;
  /** The named diagram's id, or null for a plain frame. */
  diagramId: string | null;
  title: string;
  level: string | null;
  summary: string;
}

const live = (els: readonly SceneElement[]) => els.filter((e) => !e.isDeleted);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function boxOf(el: SceneElement): Box {
  return { x: num(el.x), y: num(el.y), width: num(el.width), height: num(el.height) };
}

function diagramMeta(el: SceneElement): Record<string, unknown> | null {
  const custom = el.customData as { kaava?: { diagram?: unknown } } | undefined;
  const d = custom?.kaava?.diagram;
  return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
}

/** Every live frame, left to right, with its diagram name when it has one. */
export function framesIn(elements: readonly SceneElement[]): FrameRow[] {
  return live(elements)
    .filter((e) => e.type === "frame" || e.type === "magicframe")
    .sort((a, b) => num(a.x) - num(b.x) || num(a.y) - num(b.y))
    .map((el) => {
      const d = diagramMeta(el);
      const diagramId = typeof d?.id === "string" ? d.id : null;
      const title =
        (typeof d?.title === "string" && d.title) ||
        (typeof el.name === "string" && el.name) ||
        diagramId ||
        "Untitled frame";
      return {
        elementId: el.id,
        diagramId,
        title,
        level: typeof d?.level === "string" ? d.level : null,
        summary: typeof d?.summary === "string" ? d.summary : "",
      };
    });
}

const contains = (outer: Box, x: number, y: number) =>
  x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;

/** The frame a scene point falls in; the smallest when frames overlap. */
export function frameAt(
  elements: readonly SceneElement[],
  x: number,
  y: number,
): SceneElement | null {
  let best: SceneElement | null = null;
  for (const el of live(elements)) {
    if (el.type !== "frame" && el.type !== "magicframe") continue;
    const b = boxOf(el);
    if (!contains(b, x, y)) continue;
    if (!best || b.width * b.height < num(best.width) * num(best.height)) best = el;
  }
  return best;
}

/**
 * The frame a selection is in, and the ids to comment on. A selected frame is
 * its own target; otherwise every selected element must share one frame.
 */
export function selectionTarget(
  elements: readonly SceneElement[],
  selectedIds: Record<string, unknown> | undefined,
): { frameId: string; elementIds: string[] } | { error: string } {
  const ids = Object.keys(selectedIds ?? {}).filter((k) => selectedIds?.[k]);
  if (ids.length === 0) return { error: "Select something first, or drag an area." };
  const byId = new Map(live(elements).map((e) => [e.id, e]));
  const frames = new Set<string>();
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) continue;
    if (el.type === "frame" || el.type === "magicframe") frames.add(el.id);
    else if (typeof el.frameId === "string") frames.add(el.frameId);
    else {
      const b = boxOf(el);
      const f = frameAt(elements, b.x + b.width / 2, b.y + b.height / 2);
      if (f) frames.add(f.id);
      else return { error: "That selection is outside every frame. Comments belong to a frame." };
    }
  }
  if (frames.size !== 1) return { error: "Select things in one frame at a time." };
  const [frameId] = [...frames];
  return { frameId: frameId!, elementIds: ids.filter((id) => byId.has(id)) };
}

/** A dragged box in scene coordinates, as a frame and a frame-relative region. */
export function regionTarget(
  elements: readonly SceneElement[],
  drag: Box,
): { frameId: string; region: Box } | { error: string } {
  const x = Math.min(drag.x, drag.x + drag.width);
  const y = Math.min(drag.y, drag.y + drag.height);
  const width = Math.abs(drag.width);
  const height = Math.abs(drag.height);
  if (width < 4 || height < 4) return { error: "Drag a larger area." };
  const frame = frameAt(elements, x + width / 2, y + height / 2);
  if (!frame) return { error: "Drag inside a frame. Comments belong to a frame." };
  const f = boxOf(frame);
  const left = Math.max(x, f.x);
  const top = Math.max(y, f.y);
  const right = Math.min(x + width, f.x + f.width);
  const bottom = Math.min(y + height, f.y + f.height);
  return {
    frameId: frame.id,
    region: {
      x: Math.round(left - f.x),
      y: Math.round(top - f.y),
      width: Math.round(right - left),
      height: Math.round(bottom - top),
    },
  };
}

/** The diagram key a comment stores for a frame: its name, else its element id. */
export function diagramKey(elements: readonly SceneElement[], frameElementId: string): string {
  const el = live(elements).find((e) => e.id === frameElementId);
  const d = el ? diagramMeta(el) : null;
  return typeof d?.id === "string" ? d.id : frameElementId;
}

/** The frame element a stored comment's `frameId` names. */
export function frameForKey(elements: readonly SceneElement[], key: string): SceneElement | null {
  return (
    live(elements).find(
      (e) =>
        (e.type === "frame" || e.type === "magicframe") &&
        (e.id === key || diagramMeta(e)?.id === key),
    ) ?? null
  );
}
