/**
 * Viewport maths shared by picking and projection, kept apart from the engine
 * so a synthetic scene can prove they are inverses of each other without a GL
 * context. `pick` turns a pixel into a world point on geometry; `project` turns
 * a world point back into that pixel. If those two drift apart, a pin lands
 * somewhere other than where it was placed, which is the failure the round-trip
 * test in `projection.test.ts` exists to catch.
 */
import { Raycaster, Vector2, Vector3 } from "three";
import type { Mesh, Object3D, PerspectiveCamera } from "three";
import { nodePath, selectableFor } from "./nodePath";
import type { PickHit, Vec3, ViewportPoint } from "./markupHost";

/** Viewport pixels (origin top left, y down) to normalised device coordinates. */
export function viewportToNdc(x: number, y: number, width: number, height: number): Vector2 {
  return new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
}

/** A world point in viewport pixels, and whether it is inside the frustum. */
export function projectPoint(
  camera: PerspectiveCamera,
  point: Vec3,
  width: number,
  height: number,
): ViewportPoint {
  camera.updateMatrixWorld();
  const ndc = new Vector3(point[0], point[1], point[2]).project(camera);
  const inFront = ndc.z > -1 && ndc.z < 1;
  const inside = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((1 - ndc.y) / 2) * height,
    visible: inFront && inside,
  };
}

function isVisibleInTree(obj: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/**
 * The first visible mesh under `root` along the ray through viewport pixel
 * (`x`, `y`), reported as the enclosing selectable node. Anything without a
 * path (the root itself) is not a hit.
 */
export function pickNode(
  root: Object3D,
  camera: PerspectiveCamera,
  x: number,
  y: number,
  width: number,
  height: number,
  raycaster: Raycaster = new Raycaster(),
): PickHit | null {
  if (width <= 0 || height <= 0) return null;
  camera.updateMatrixWorld();
  raycaster.setFromCamera(viewportToNdc(x, y, width, height), camera);
  const hits = raycaster.intersectObject(root, true);
  const hit = hits.find((h) => (h.object as Mesh).isMesh === true && isVisibleInTree(h.object));
  if (!hit) return null;
  const path = nodePath(selectableFor(hit.object, root), root);
  if (path === null) return null;
  return { nodePath: path, worldPoint: [hit.point.x, hit.point.y, hit.point.z] };
}
