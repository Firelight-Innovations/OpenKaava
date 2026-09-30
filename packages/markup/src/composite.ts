/**
 * The arithmetic of the PNG: how big it is, and where the ink goes on it.
 * Kept apart from the canvas calls so the sizes can be tested.
 */
import type { ViewSize } from "./types";

/** Browsers refuse canvases past about 16k on a side; stay well inside it. */
export const MAX_PNG_SIDE = 8192;

export interface PngLayout {
  width: number;
  height: number;
  /** Device pixels per host pixel actually used: the requested ratio, capped by MAX_PNG_SIDE. */
  scale: number;
}

/**
 * The output bitmap for a host of `view` CSS pixels at `dpr`. The scale is
 * capped so neither side exceeds `maxSide`; the aspect ratio never changes.
 */
export function pngLayout(view: ViewSize, dpr: number, maxSide = MAX_PNG_SIDE): PngLayout {
  const want = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const longest = Math.max(view.width, view.height, 1);
  const scale = Math.min(want, maxSide / longest);
  return {
    width: Math.max(1, Math.round(view.width * scale)),
    height: Math.max(1, Math.round(view.height * scale)),
    scale,
  };
}

/**
 * Where the ink bitmap is drawn on the output. Excalidraw crops an export to
 * the bounds of its elements, so the exported ink starts at the scene point
 * (`minX`, `minY`); on the output that is `scale` times that.
 */
export function inkOrigin(minX: number, minY: number, scale: number): { x: number; y: number } {
  return { x: Math.round(minX * scale), y: Math.round(minY * scale) };
}

/**
 * The transparent frame element added to an export so the ink bitmap always
 * spans the whole viewport (its bounds are then at least 0,0 to width,height).
 */
export function frameBounds(view: ViewSize): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: 0, y: 0, width: view.width, height: view.height };
}
