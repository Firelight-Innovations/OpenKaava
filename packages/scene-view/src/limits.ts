/**
 * Triangle counting and the cap that keeps a huge scene from hanging the pane.
 *
 * The count is done on the parsed scene, before anything is uploaded to the
 * GPU, so a scene over the cap costs a parse but not a frozen renderer.
 */
import type { BufferGeometry, Object3D } from "three";

export const DEFAULT_MAX_TRIANGLES = 2_000_000;

function trianglesIn(geometry: BufferGeometry): number {
  const indexed = geometry.getIndex();
  const vertices = indexed ? indexed.count : (geometry.getAttribute("position")?.count ?? 0);
  return Math.floor(vertices / 3);
}

/**
 * Triangles under `root`. Lines and points count as zero; they are cheap next
 * to the meshes that decide whether a scene is too big. An instanced mesh
 * counts once per instance, because that is what the GPU draws.
 */
export function countTriangles(root: Object3D): number {
  let total = 0;
  root.traverse((obj) => {
    const mesh = obj as Object3D & {
      isMesh?: boolean;
      isInstancedMesh?: boolean;
      count?: number;
      geometry?: BufferGeometry;
    };
    if (mesh.isMesh !== true || !mesh.geometry) return;
    const perInstance = trianglesIn(mesh.geometry);
    total += perInstance * (mesh.isInstancedMesh === true ? (mesh.count ?? 1) : 1);
  });
  return total;
}

export interface CapVerdict {
  exceeded: boolean;
  triangles: number;
  limit: number;
}

/** Whether `triangles` is over `limit`. A non-positive limit disables the cap. */
export function checkTriangleCap(triangles: number, limit: number): CapVerdict {
  return { exceeded: limit > 0 && triangles > limit, triangles, limit };
}

/** The sentence shown in place of a scene that was not loaded. */
export function capNotice(verdict: CapVerdict): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `This scene has ${fmt(verdict.triangles)} triangles, over the ${fmt(
    verdict.limit,
  )} limit for the preview. It was not loaded.`;
}

/** Whether the glTF authored any light (KHR_lights_punctual arrives as three lights). */
export function hasPunctualLights(root: Object3D): boolean {
  let found = false;
  root.traverse((o) => {
    if ((o as { isLight?: boolean }).isLight === true) found = true;
  });
  return found;
}
