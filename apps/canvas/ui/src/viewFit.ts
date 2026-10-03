/**
 * Whether a canvas opens on empty space. A saved scroll and zoom, or one carried
 * over from the session, can point at nothing once the scene has grown or moved;
 * the editor then shows a blank sheet. Pure, so it is tested without Excalidraw.
 */
import type { SceneElement } from "./scene";

export interface ViewBox {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  width: number;
  height: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * True when the scene has live elements and the viewport shows none of them.
 * Excalidraw's scroll is in scene units, offset the other way: a scene point
 * `p` is drawn at `(p + scroll) * zoom`.
 */
export function viewMissesContent(elements: readonly SceneElement[], view: ViewBox): boolean {
  const zoom = view.zoom.value > 0 ? view.zoom.value : 1;
  const left = -view.scrollX;
  const top = -view.scrollY;
  const right = left + view.width / zoom;
  const bottom = top + view.height / zoom;
  let any = false;
  for (const el of elements) {
    if (el.isDeleted) continue;
    any = true;
    const x = num(el.x);
    const y = num(el.y);
    const w = Math.abs(num(el.width));
    const h = Math.abs(num(el.height));
    const x0 = Math.min(x, x + num(el.width));
    const y0 = Math.min(y, y + num(el.height));
    if (x0 <= right && x0 + w >= left && y0 <= bottom && y0 + h >= top) return false;
  }
  return any;
}
