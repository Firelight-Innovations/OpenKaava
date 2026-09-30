/**
 * Building Excalidraw elements from plain descriptions, without Excalidraw.
 *
 * `layout.ts` decides where things go; this file turns each placed thing into
 * the JSON Excalidraw stores. It imports nothing from Excalidraw so the whole
 * drawing API runs under vitest, and the webview passes the result through
 * `restoreElements` once to fill any field a newer Excalidraw expects.
 *
 * Rejected: `convertToExcalidrawElements`. It measures text itself, with
 * whatever font happens to be loaded, and grows containers to fit, which is
 * the guessing this API exists to remove. It also mints random ids, and an
 * agent needs ids it can predict and refer back to.
 *
 * The palette is Excalidraw's own picker colours, chosen because its dark mode
 * inverts the canvas through a filter tuned for exactly these shades; a colour
 * from outside it can turn muddy or vanish in dark mode.
 */

export type PaletteName = "ink" | "muted" | "red" | "green" | "blue" | "orange" | "violet" | "teal";

/** Stroke and fill per palette name: Excalidraw's picker shades. */
export const PALETTE: Record<PaletteName, { stroke: string; fill: string }> = {
  ink: { stroke: "#1e1e1e", fill: "#e9ecef" },
  muted: { stroke: "#868e96", fill: "#f1f3f5" },
  red: { stroke: "#e03131", fill: "#ffc9c9" },
  green: { stroke: "#2f9e44", fill: "#b2f2bb" },
  blue: { stroke: "#1971c2", fill: "#a5d8ff" },
  orange: { stroke: "#f08c00", fill: "#ffec99" },
  violet: { stroke: "#9c36b5", fill: "#eebefa" },
  teal: { stroke: "#0c8599", fill: "#99e9f2" },
};

export const TRANSPARENT = "transparent";

export type TextSize = "title" | "heading" | "body" | "small";

/** The four text sizes, in px. Nothing smaller than 14 reads at scale 1. */
export const TEXT_SIZE: Record<TextSize, number> = {
  title: 28,
  heading: 20,
  body: 16,
  small: 14,
};

/** Excalidraw's "Normal" font (Nunito): clean, measured, not hand-drawn. */
export const FONT_FAMILY = 6;

/** Nunito's line height as Excalidraw sets it. */
export const LINE_HEIGHT = 1.35;

/** The padding Excalidraw keeps between a container and its bound text. */
export const BOUND_TEXT_PADDING = 5;

export type Element = Record<string, unknown> & { id: string; type: string };

export function colour(name: string | undefined, fallback: PaletteName = "ink") {
  return PALETTE[(name as PaletteName) in PALETTE ? (name as PaletteName) : fallback];
}

/** A stable 31-bit number from a string, so a rebuild draws the same strokes. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) % 2147483647;
}

interface Base {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frameId: string | null;
  stroke?: string;
  fill?: string;
  dashed?: boolean;
  strokeWidth?: number;
  node?: string;
}

function base(type: string, b: Base): Element {
  return {
    id: b.id,
    type,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    angle: 0,
    strokeColor: b.stroke ?? PALETTE.ink.stroke,
    backgroundColor: b.fill ?? TRANSPARENT,
    fillStyle: "solid",
    strokeWidth: b.strokeWidth ?? 2,
    strokeStyle: b.dashed ? "dashed" : "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: b.frameId,
    roundness: null,
    seed: seedOf(b.id),
    version: 1,
    versionNonce: seedOf(`${b.id}:v`),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    ...(b.node ? { customData: { kaava: { node: b.node } } } : {}),
  };
}

export function shape(
  type: "rectangle" | "ellipse" | "diamond",
  b: Base & { rounded?: boolean },
): Element {
  const el = base(type, b);
  if (type === "rectangle" && b.rounded !== false) el.roundness = { type: 3 };
  if (type === "diamond") el.roundness = { type: 2 };
  return el;
}

export interface TextOptions extends Base {
  text: string;
  fontSize: number;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle";
  containerId?: string | null;
}

export function text(t: TextOptions): Element {
  const el = base("text", { ...t, fill: TRANSPARENT });
  el.boundElements = null;
  return {
    ...el,
    text: t.text,
    originalText: t.text,
    fontSize: t.fontSize,
    fontFamily: FONT_FAMILY,
    textAlign: t.align ?? "left",
    verticalAlign: t.verticalAlign ?? "top",
    containerId: t.containerId ?? null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

export interface Binding {
  elementId: string;
  focus: number;
  gap: number;
}

export function linear(
  type: "arrow" | "line",
  b: Base & {
    points: [number, number][];
    start?: Binding | null;
    end?: Binding | null;
    startHead?: string | null;
    endHead?: string | null;
    curved?: boolean;
  },
): Element {
  const el = base(type, b);
  el.roundness = b.curved ? { type: 2 } : null;
  return {
    ...el,
    points: b.points,
    lastCommittedPoint: null,
    startBinding: b.start ?? null,
    endBinding: b.end ?? null,
    startArrowhead: b.startHead ?? null,
    endArrowhead: type === "arrow" ? (b.endHead === undefined ? "arrow" : b.endHead) : null,
    ...(type === "arrow" ? { elbowed: false } : {}),
  };
}

export function frame(b: {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  diagram: Record<string, unknown>;
}): Element {
  const el = base("frame", { ...b, frameId: null, strokeWidth: 2 });
  el.strokeColor = PALETTE.ink.stroke;
  el.boundElements = null;
  return { ...el, name: b.name, customData: { kaava: { diagram: b.diagram } } };
}

export function image(b: Base & { fileId: string }): Element {
  const el = base("image", { ...b, fill: TRANSPARENT });
  el.strokeColor = TRANSPARENT;
  el.boundElements = null;
  return { ...el, fileId: b.fileId, status: "saved", scale: [1, 1], crop: null };
}

/** Record that `child` is bound to `parent` (text in a shape, arrow on a shape). */
export function bind(parent: Element, child: Element, kind: "text" | "arrow"): void {
  const list = Array.isArray(parent.boundElements)
    ? (parent.boundElements as { id: string; type: string }[])
    : [];
  if (!list.some((b) => b.id === child.id)) list.push({ id: child.id, type: kind });
  parent.boundElements = list;
}
