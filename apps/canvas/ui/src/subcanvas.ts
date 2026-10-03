/**
 * Sub-canvas frames: a frame whose elements were moved into a child canvas of
 * their own (`canvas/split-frames`, `src-tauri/src/apps/canvas/subcanvas.rs`).
 * The parent keeps the empty frame, linked to the child and marked
 * `customData.kaava.subcanvas`, and the editor draws a picture of the child into
 * it: one locked image element per frame, which `toSaved` never writes.
 *
 * A picture instead of the elements is the point. Excalidraw repaints every
 * element on every pan; thirty frames of a few hundred elements each was a
 * slideshow, thirty images is not.
 *
 * Pure, and free of Excalidraw, so it is tested without a DOM. The drawing
 * itself is `snapshots.ts`.
 */
import { childOf, isFrame } from "./nesting";
import { isSnapshot, type SceneElement } from "./scene";

export { isSnapshot };

/** A frame with at least this many elements is worth splitting. Mirrors
 *  `subcanvas::MIN_ELEMENTS`. */
export const SPLIT_MIN_ELEMENTS = 40;

/** A canvas with more live elements than this offers to split its frames. */
export const HEAVY_CANVAS = 1500;

/** The picture element's id for frame `frameId`. */
export const snapshotIdFor = (frameId: string) => `kaava-snapshot:${frameId}`;

/** The child canvas a sub-canvas frame shows, or `null` for any other element. */
export function subcanvasChild(el: SceneElement): string | null {
  if (!isFrame(el) || el.isDeleted) return null;
  const kaava = (el.customData as { kaava?: { subcanvas?: unknown } } | undefined)?.kaava;
  return kaava?.subcanvas === true ? childOf(el) : null;
}

/** Every live sub-canvas frame, with its child. */
export function subcanvasFrames(
  elements: readonly SceneElement[],
): { frame: SceneElement; child: string }[] {
  const out: { frame: SceneElement; child: string }[] = [];
  for (const el of elements) {
    const child = subcanvasChild(el);
    if (child) out.push({ frame: el, child });
  }
  return out;
}

/**
 * A number that changes whenever any element does: the sum of versions and
 * nonces, Excalidraw's own `getSceneVersion` idea. Excalidraw mutates
 * elements in place, so the array's identity alone does not say "unchanged".
 */
export function sceneVersion(elements: readonly SceneElement[]): number {
  let v = elements.length;
  for (const el of elements) v += (el.version ?? 0) + (el.versionNonce ?? 0);
  return v;
}

/** How many live, non-picture elements each frame holds, by frame id. */
function memberCounts(elements: readonly SceneElement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const el of elements) {
    if (el.isDeleted || isSnapshot(el)) continue;
    const frameId = el.frameId as string | null | undefined;
    if (frameId) counts.set(frameId, (counts.get(frameId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether to offer splitting: the canvas is heavy, and at least one frame
 * that is not already linked to a child has enough elements to move.
 */
export function splitCandidates(elements: readonly SceneElement[]): number {
  let live = 0;
  for (const el of elements) if (!el.isDeleted && !isSnapshot(el)) live += 1;
  if (live < HEAVY_CANVAS) return 0;
  const counts = memberCounts(elements);
  return elements.filter(
    (el) =>
      isFrame(el) &&
      !el.isDeleted &&
      !childOf(el) &&
      (counts.get(el.id) ?? 0) >= SPLIT_MIN_ELEMENTS,
  ).length;
}

/** The file id of the stand-in picture shown until a frame's real one exists. */
export const PLACEHOLDER_FILE_ID = "kaava-snapshot:placeholder";

/** A neutral "rendering..." picture, as an SVG data URL. Drawn right after a
 *  split so a frame is never empty while its snapshot renders. */
export const PLACEHOLDER_DATA_URL =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">' +
      '<text x="200" y="150" text-anchor="middle" dominant-baseline="middle" ' +
      'font-family="sans-serif" font-size="22" fill="#8a8a8a">Rendering...</text></svg>',
  );

/** What the notice after "Split into sub-canvases" says: how many frames were
 *  split, how many were left alone, and that the split can be undone. */
export function splitSummary(out: {
  split: readonly unknown[];
  skipped: readonly { frame: string; reason: string }[];
  checkpoint: string | null;
}): string {
  const n = out.split.length;
  const k = out.skipped.length;
  let text = `Split ${n} frame${n === 1 ? "" : "s"} into sub-canvases`;
  text +=
    k === 0
      ? "."
      : `, skipped ${k}: ${out.skipped.map((s) => `${s.frame} (${s.reason})`).join("; ")}.`;
  if (n > 0 && out.checkpoint)
    text += " Undo is available: restore the checkpoint taken before the split.";
  return text;
}

/** A picture ready to place: the Excalidraw file id holding it. */
export interface Placed {
  fileId: string;
}

/** The locked image element showing `fileId` over all of `frame`. */
export function snapshotElement(frame: SceneElement, fileId: string): SceneElement {
  const id = snapshotIdFor(frame.id);
  return {
    id,
    type: "image",
    x: frame.x as number,
    y: frame.y as number,
    width: frame.width as number,
    height: frame.height as number,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: frame.id,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: true,
    status: "saved",
    fileId,
    scale: [1, 1],
    crop: null,
    customData: { kaava: { snapshot: true } },
  };
}

/**
 * `elements` with one picture per sub-canvas frame that has one in `pictures`
 * (keyed by frame id), each drawn just before its frame so the frame clips it,
 * and any other picture removed. `null` when that is what is there already, so
 * the caller can skip an update that would only churn the scene.
 */
export function placeSnapshots(
  elements: readonly SceneElement[],
  pictures: ReadonlyMap<string, Placed>,
): SceneElement[] | null {
  const existing = new Map<string, SceneElement>();
  for (const el of elements) if (isSnapshot(el) && !el.isDeleted) existing.set(el.id, el);
  const out: SceneElement[] = [];
  let changed = false;
  const wanted = new Set<string>();
  for (const el of elements) {
    if (isSnapshot(el)) continue;
    const child = subcanvasChild(el);
    const pic = child ? pictures.get(el.id) : undefined;
    if (pic) {
      const id = snapshotIdFor(el.id);
      wanted.add(id);
      const prev = existing.get(id);
      const same =
        prev &&
        prev.fileId === pic.fileId &&
        prev.x === el.x &&
        prev.y === el.y &&
        prev.width === el.width &&
        prev.height === el.height;
      if (same) out.push(prev);
      else {
        changed = true;
        const next = snapshotElement(el, pic.fileId);
        next.version = ((prev?.version as number | undefined) ?? 0) + 1;
        next.versionNonce = Math.floor(Math.random() * 2 ** 31);
        out.push(next);
      }
    }
    out.push(el);
  }
  for (const id of existing.keys()) if (!wanted.has(id)) changed = true;
  return changed ? out : null;
}

/** The fields of a child's frame its parent's sub-canvas frame copies. */
export interface ChildFrame {
  width: number;
  height: number;
  name: string | null;
}

/**
 * `elements` with each sub-canvas frame resized and renamed to match its
 * child's frame (`frames`, keyed by child id), or `null` when all match. A
 * person resizes the frame inside the child; the parent follows.
 */
export function syncFrames(
  elements: readonly SceneElement[],
  frames: ReadonlyMap<string, ChildFrame>,
): SceneElement[] | null {
  let changed = false;
  const out = elements.map((el) => {
    const child = subcanvasChild(el);
    const f = child ? frames.get(child) : undefined;
    if (!f) return el;
    const name = f.name ?? (el.name as string | null);
    if (el.width === f.width && el.height === f.height && el.name === name) return el;
    changed = true;
    return {
      ...el,
      width: f.width,
      height: f.height,
      name,
      version: ((el.version as number | undefined) ?? 0) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
    };
  });
  return changed ? out : null;
}

/**
 * The CSS filter that undoes Excalidraw's dark-mode image filter
 * (`invert(100%) hue-rotate(180deg) saturate(1.25)`, applied to raster
 * images so photos keep their colours under the canvas's own inversion).
 * A picture of a drawing should invert *with* the canvas instead, like the
 * elements it stands for, so its pixels are pre-processed with the inverse.
 */
export const UNDO_IMAGE_INVERT = "saturate(0.8) hue-rotate(-180deg) invert(100%)";
