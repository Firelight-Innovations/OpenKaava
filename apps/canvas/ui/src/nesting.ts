/**
 * Nested canvases: a frame links to a child canvas, and the child links back to
 * its parent. `docs/cloud-services.md` §4 fixes the two halves of the link:
 *
 * - the frame element carries `customData.kaava.child = "<canvas-id>"`;
 * - the child's file carries `kaava.parent = "<canvas-id>"`, which is what the
 *   breadcrumb follows upward.
 *
 * Everything here is pure, so the hit test and the breadcrumb are tested
 * without Excalidraw.
 */
import type { CanvasSummary } from "./rpc";
import type { SceneElement } from "./scene";

/** The deepest folder nesting the backend accepts; see `canvas.rs`. */
const MAX_DEPTH = 4;

interface Kaava {
  child?: unknown;
}

function kaavaData(el: SceneElement): Kaava | undefined {
  const custom = el.customData as { kaava?: Kaava } | undefined;
  return custom?.kaava;
}

export function isFrame(el: SceneElement): boolean {
  return el.type === "frame" || el.type === "magicframe";
}

/** The child canvas a frame links to, or `null`. */
export function childOf(el: SceneElement): string | null {
  if (!isFrame(el) || el.isDeleted) return null;
  const child = kaavaData(el)?.child;
  return typeof child === "string" && child !== "" ? child : null;
}

/**
 * `el` with its child link set (or cleared, with `null`). Returns a new element
 * with a raised `version`: Excalidraw and the save signature both decide what
 * changed by comparing versions, so an edit that leaves it alone would neither
 * redraw nor save.
 */
export function withChild(el: SceneElement, child: string | null): SceneElement {
  const custom = { ...((el.customData as Record<string, unknown> | undefined) ?? {}) };
  const kaava = { ...((custom.kaava as Record<string, unknown> | undefined) ?? {}) };
  if (child === null) delete kaava.child;
  else kaava.child = child;
  if (Object.keys(kaava).length > 0) custom.kaava = kaava;
  else delete custom.kaava;
  return {
    ...el,
    customData: Object.keys(custom).length > 0 ? custom : undefined,
    version: (el.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}

/** The one selected element, when it is a live frame; otherwise `null`. */
export function selectedFrame(
  elements: readonly SceneElement[],
  selectedIds: Record<string, unknown> | undefined,
): SceneElement | null {
  const ids = Object.keys(selectedIds ?? {}).filter((id) => selectedIds?.[id]);
  if (ids.length !== 1) return null;
  const el = elements.find((e) => e.id === ids[0]);
  return el && !el.isDeleted && isFrame(el) ? el : null;
}

/** A viewport (client) point in scene coordinates, the inverse of Excalidraw's
 *  own `sceneCoordsToViewportCoords`. */
export function viewportToScene(
  clientX: number,
  clientY: number,
  view: {
    scrollX: number;
    scrollY: number;
    offsetLeft: number;
    offsetTop: number;
    zoom: { value: number };
  },
): { x: number; y: number } {
  return {
    x: (clientX - view.offsetLeft) / view.zoom.value - view.scrollX,
    y: (clientY - view.offsetTop) / view.zoom.value - view.scrollY,
  };
}

/**
 * The frame with a child link under a scene point, or `null`. Where linked
 * frames overlap the smallest wins, so a frame nested inside another opens its
 * own child rather than its container's. A frame's name label sits just above
 * its box and counts as part of it, so double-clicking the title works too.
 */
export function hitLinkedFrame(
  elements: readonly SceneElement[],
  point: { x: number; y: number },
  labelHeight = 28,
): SceneElement | null {
  let best: SceneElement | null = null;
  let bestArea = Infinity;
  for (const el of elements) {
    if (!childOf(el)) continue;
    const x = Number(el.x);
    const y = Number(el.y);
    const width = Number(el.width);
    const height = Number(el.height);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    const inside =
      point.x >= x && point.x <= x + width && point.y >= y - labelHeight && point.y <= y + height;
    if (inside && width * height < bestArea) {
      best = el;
      bestArea = width * height;
    }
  }
  return best;
}

/**
 * The canvases from the root down to `id`, following each one's `parent`. Stops
 * at a missing parent (a canvas not pulled yet, or deleted) and at a cycle, so a
 * hand-edited file cannot hang the breadcrumb.
 */
export function ancestry(rows: readonly CanvasSummary[], id: string): CanvasSummary[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: CanvasSummary[] = [];
  const seen = new Set<string>();
  let at = byId.get(id);
  while (at && !seen.has(at.id)) {
    chain.unshift(at);
    seen.add(at.id);
    at = at.parent ? byId.get(at.parent) : undefined;
  }
  return chain;
}

/** The canvas ids from `id` upward, `id` first; the ones a link must not point at. */
export function selfAndAncestors(rows: readonly CanvasSummary[], id: string): Set<string> {
  return new Set(ancestry(rows, id).map((r) => r.id));
}

/**
 * The id for a new child canvas: a file in a folder named after its parent
 * (`levels` + `ward-b` = `levels/ward-b`), as board 12 shows. At the depth
 * limit it goes beside the parent instead; the hierarchy is in the `parent`
 * field either way, not in the folders.
 */
export function childId(parentId: string, slug: string): string {
  const depth = parentId.split("/").length;
  if (depth < MAX_DEPTH) return `${parentId}/${slug}`;
  const dir = parentId.slice(0, parentId.lastIndexOf("/") + 1);
  return `${dir}${slug}`;
}
