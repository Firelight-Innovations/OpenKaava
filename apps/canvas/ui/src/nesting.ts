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

/**
 * A frame with a child canvas also carries this as its Excalidraw `link`, so the
 * editor draws its link badge on the frame and a click on it opens the child.
 */
export const CANVAS_LINK = "kaava://canvas/";

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
  const link =
    child !== null
      ? `${CANVAS_LINK}${child}`
      : typeof el.link === "string" && el.link.startsWith(CANVAS_LINK)
        ? null
        : el.link;
  return {
    ...el,
    customData: Object.keys(custom).length > 0 ? custom : undefined,
    link,
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

export interface TreeRow {
  row: CanvasSummary;
  depth: number;
}

/**
 * The canvases as a tree, parents before their children, siblings by title: what
 * the picker lists, indented by `depth`. A canvas whose parent is missing is a
 * root, and one that sits in a parent loop is listed last at depth 0 rather than
 * dropped, so a hand-edited file cannot hide a canvas.
 */
export function treeOrder(rows: readonly CanvasSummary[]): TreeRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, CanvasSummary[]>();
  const roots: CanvasSummary[] = [];
  for (const r of rows) {
    if (r.parent && ids.has(r.parent) && r.parent !== r.id) {
      kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
    } else roots.push(r);
  }
  const byTitle = (a: CanvasSummary, b: CanvasSummary) =>
    a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (r: CanvasSummary, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ row: r, depth });
    for (const k of (kids.get(r.id) ?? []).slice().sort(byTitle)) walk(k, depth + 1);
  };
  for (const r of roots.slice().sort(byTitle)) walk(r, 0);
  for (const r of rows) if (!seen.has(r.id)) walk(r, 0);
  return out;
}

/** The canvases a frame may link to as an existing child: not this one, not an
 *  ancestor of it, and not already nested under some other canvas. */
export function linkable(rows: readonly CanvasSummary[], current: string): CanvasSummary[] {
  const blocked = selfAndAncestors(rows, current);
  return rows.filter(
    (r) => !r.error && !blocked.has(r.id) && (r.parent === null || r.parent === current),
  );
}

/** Whether some live frame in `elements` still links to canvas `child`. */
export function stillLinked(elements: readonly SceneElement[], child: string): boolean {
  return elements.some((el) => childOf(el) === child);
}

/** A "↳ child" chip to draw over a frame that links to a child canvas. */
export interface LinkBadge {
  /** The frame's element id. */
  id: string;
  child: string;
  label: string;
  /** Pixels from the editor's top-left to the chip's right edge, and to its bottom edge. */
  right: number;
  bottom: number;
  /** The frame is too small on screen for words; draw the arrow alone. */
  compact: boolean;
  /** Drawn under the frame's bottom edge because the top edge's label would be covered. */
  below: boolean;
}

/** What the badges need of Excalidraw's `appState`. */
export interface BadgeView {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
}

/** Frames narrower than this on screen (px) get no badge at all. */
const BADGE_MIN_PX = 28;
/** Rough on-screen size of Excalidraw's frame-name label: it does not scale with zoom. */
const LABEL_CHAR_PX = 8;
const LABEL_PAD_PX = 12;
/** Rough size of the chip: arrow, padding and the child's name at 12px. */
const CHIP_CHAR_PX = 7;
const CHIP_FIXED_PX = 30;
const CHIP_COMPACT_PX = 24;
const CHIP_MAX_PX = 220;
const CHIP_HEIGHT_PX = 22;
/** Frames narrower than this on screen get the arrow without the name. */
const BADGE_COMPACT_PX = 140;

/**
 * The badges for every linked frame, in editor pixels. A scene point goes to the
 * viewport as `(scene + scroll) * zoom`, the inverse of [`viewportToScene`], so the
 * chip follows the frame as the person pans and zooms; it is drawn over the editor
 * rather than put in the scene, so it is never saved and never selected. It sits on
 * the frame's top edge, at the right-hand corner, clear of the name label on the left.
 */
export function linkBadges(
  elements: readonly SceneElement[],
  view: BadgeView,
  titleOf: (canvasId: string) => string,
): LinkBadge[] {
  const zoom = view.zoom.value;
  const out: LinkBadge[] = [];
  for (const el of elements) {
    const child = childOf(el);
    if (!child) continue;
    const x = Number(el.x);
    const y = Number(el.y);
    const width = Number(el.width);
    const height = Number(el.height);
    if (![x, y, width, height, zoom, view.scrollX, view.scrollY].every(Number.isFinite)) continue;
    const px = width * zoom;
    if (px < BADGE_MIN_PX) continue;
    const label = titleOf(child);
    const compact = px < BADGE_COMPACT_PX;
    // The name label owns the top edge's left end. If the chip would run into it,
    // the chip goes under the frame's bottom edge instead, where nothing is drawn.
    const nameChars = typeof el.name === "string" && el.name ? el.name.length : 5;
    const labelPx = nameChars * LABEL_CHAR_PX + LABEL_PAD_PX;
    const chipPx = compact
      ? CHIP_COMPACT_PX
      : Math.min(CHIP_MAX_PX, CHIP_FIXED_PX + label.length * CHIP_CHAR_PX);
    const below = labelPx + chipPx > px;
    const edge = below ? y + height : y;
    out.push({
      id: el.id,
      child,
      label,
      right: Math.round((x + width + view.scrollX) * zoom),
      bottom: Math.round((edge + view.scrollY) * zoom) + (below ? CHIP_HEIGHT_PX + 4 : -4),
      compact,
      below,
    });
  }
  return out;
}
