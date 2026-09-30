/**
 * Blender as a context provider: what this viewer can hand to an agent, and
 * how. The store itself (`context/put`, the strip beside each terminal) is the
 * host's; this file only decides what each thing is called and what kind of
 * item it becomes, so the viewer's buttons and its drag share one path.
 */
import { invoke } from "@openkaava/bridge";
import type { BlenderPart, BlenderViewerState } from "./rpc";

/** The slice of `ContextItem` this app reads back. */
export interface ContextRef {
  id: string;
}

const PRESS_THRESHOLD = 4;

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

function tell(phase: "begin" | "end", items: string[]): void {
  void invoke("kaava/drag", { phase, items }).catch((e: unknown) => {
    console.error(`kaava: blender could not report a ${phase} drag`, e);
  });
}

let endPrevious: (() => void) | null = null;

/**
 * Press handler that turns a moved press into a drag of one context item. The
 * item is registered lazily, when the press becomes a drag, because most
 * presses are clicks and should not fill the store. Same split as Files: this
 * half reports begin and cancel; the shell owns the drop.
 */
export function dragContext(put: () => Promise<ContextRef>) {
  return (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    endPrevious?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let began = false;
    let live = true;

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || began) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < PRESS_THRESHOLD) return;
      began = true;
      void put()
        .then((item) => {
          // Released while the put was in flight: there is nothing to drag.
          if (live) tell("begin", [item.id]);
        })
        .catch((err: unknown) => console.error("kaava: blender could not add context", err));
    };
    const detach = () => {
      live = false;
      endPrevious = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const wasDrag = began;
      detach();
      if (wasDrag) tell("end", []);
    };
    endPrevious = detach;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
}
