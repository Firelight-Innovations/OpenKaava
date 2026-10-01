/**
 * Getting the exported `.glb` into the 3D view, and relating its nodes to the
 * parts list. Free of React so both are testable on their own.
 */
import { decodeBase64 } from "../../../shared/sceneNodes";
import type { BlenderPart } from "./rpc";

/**
 * The 3D view names a node by its path from the scene root (`Bed/Frame`); the
 * parts list names an object by itself. glTF keeps Blender's parenting, so
 * walking each part's `parent` chain gives the path the view will report, and
 * the value is the part's name. A cycle or a missing parent ends the walk.
 */
export function partNodeMap(parts: BlenderPart[]): Record<string, string> {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const map: Record<string, string> = {};
  for (const part of parts) {
    const names = [part.name];
    let at = part.parent;
    while (at && byName.has(at) && !names.includes(at)) {
      names.unshift(at);
      at = byName.get(at)?.parent ?? null;
    }
    map[names.join("/")] = part.name;
  }
  return map;
}

export type GlbState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; glb: ArrayBuffer }
  | { kind: "failed"; message: string };

/** Fetches the glb as bytes. A failed read says why, in the backend's words. */
export async function fetchGlb(
  get: () => Promise<{ base64: string }>,
): Promise<Exclude<GlbState, { kind: "none" | "loading" }>> {
  try {
    return { kind: "ready", glb: decodeBase64((await get()).base64) };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}
