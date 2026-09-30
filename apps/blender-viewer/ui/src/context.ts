/**
 * Blender as a context provider: what this viewer can hand to an agent, and
 * how. The store itself (`context/put`, the strip beside each terminal) is the
 * host's; this file only decides what each thing is called and what kind of
 * item it becomes, so the viewer's buttons and its drag share one path.
 */
import { invoke } from "@openkaava/bridge";
import type { ContextRef } from "../../../shared/context";
import type { BlenderPart, BlenderViewerState } from "./rpc";

export { dragContext } from "../../../shared/context";

/** The parts list as the plain text an agent reads: one line per object. */
export function partsText(state: BlenderViewerState): string {
  const head = `Blender scene ${state.rel ?? ""} (${state.parts.length} objects)`;
  const rows = state.parts.map((p: BlenderPart) => {
    if (p.kind !== "mesh") return `${p.name} | ${p.kind}${p.parent ? ` | parent ${p.parent}` : ""}`;
    const dims = p.dimensions.map((d) => d.toFixed(2)).join(" x ");
    return [
      p.name,
      "mesh",
      `${p.tris} tris`,
      `${p.verts} verts`,
      p.materials.join(", ") || "no material",
      dims ? `${dims} m` : "",
      p.visible ? "" : "hidden",
      p.parent ? `parent ${p.parent}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  });
  return [head, ...rows].join("\n");
}

export function putRender(base64: string, label: string, rel: string | null) {
  return invoke<ContextRef>("context/put", {
    kind: "image",
    title: `${rel ?? "Blender"} - ${label}`,
    label: `Blender - ${label}`,
    bytesBase64: base64,
  });
}

export function putParts(state: BlenderViewerState) {
  return invoke<ContextRef>("context/put", {
    kind: "text",
    title: `${state.rel ?? "Blender"} - parts`,
    label: "Blender - parts list",
    text: partsText(state),
  });
}

export function putGlb(state: BlenderViewerState) {
  return invoke<ContextRef>("context/put", {
    kind: "file",
    title: `${state.rel ?? "Blender"} - model`,
    label: "Blender - .glb",
    path: state.model,
  });
}
