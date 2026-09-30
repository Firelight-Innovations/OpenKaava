/**
 * The Godot Viewer as a context provider: the scene tree as text and the
 * rendered frame as an image, for the agent working in this environment. The
 * store and the strip beside each terminal are the host's (`context/put`).
 */
import { invoke } from "@openkaava/bridge";
import { contextKey, type ContextRef } from "../../../shared/context";
import type { MarkupJson } from "@kaava/markup";
import type { GodotNode, GodotViewerState } from "./rpc";

export { dragContext } from "../../../shared/context";

/** The tree as indented text: name, class, and the script or scene behind it. */
export function treeText(state: Pick<GodotViewerState, "scenePath" | "source" | "nodes">): string {
  const how = state.source === "parsed" ? "read from the scene file" : "read by Godot";
  const rows: string[] = [`Godot scene ${state.scenePath ?? ""} (${how})`];
  const walk = (node: GodotNode, depth: number) => {
    const extra = [
      node.script && `script ${node.script}`,
      node.instance && `scene ${node.instance}`,
    ]
      .filter(Boolean)
      .join(", ");
    rows.push(`${"  ".repeat(depth)}${node.name} (${node.type})${extra ? ` - ${extra}` : ""}`);
    node.children.forEach((c) => walk(c, depth + 1));
  };
  state.nodes.forEach((n) => walk(n, 0));
  return rows.join("\n");
}

export function putTree(state: GodotViewerState) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("godot", state.scenePath ?? "scene", "tree"),
    kind: "text",
    title: `${state.scenePath ?? "Godot"} - scene tree`,
    label: "Godot - scene tree",
    text: treeText(state),
  });
}

export function putFrame(base64: string, scenePath: string | null) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("godot", scenePath ?? "scene", "frame"),
    kind: "image",
    title: `${scenePath ?? "Godot"} - rendered view`,
    label: "Godot - rendered view",
    bytesBase64: base64,
  });
}

/** Text the store keeps whole; over this it cuts at a line, which would break the JSON. */
const MAX_JSON_BYTES = 240 * 1024;

/**
 * The markup JSON as text an agent reads. The raw Excalidraw elements are for
 * reopening the drawing in Canvas and can be large (a freehand stroke is
 * hundreds of points), so when the whole document would not fit they are left
 * out and `excalidrawOmitted` says so; pins, annotations and the camera, which
 * are what an agent acts on, are always kept.
 */
export function markupJsonText(json: MarkupJson): string {
  const whole = JSON.stringify(json, null, 2);
  if (new TextEncoder().encode(whole).length <= MAX_JSON_BYTES) return whole;
  return JSON.stringify(
    {
      ...json,
      excalidraw: { elements: [], appState: json.excalidraw.appState },
      excalidrawOmitted: true,
    },
    null,
    2,
  );
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In slices: spreading a whole PNG into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Sends a markup export: the picture under `godot/<scene>/markup` and the JSON
 * beside it under `godot/<scene>/markup-json`. Both keys are stable, so marking
 * up the same scene again replaces these two items rather than adding more.
 * Resolves with the picture's item, which is what a drag onto a terminal carries.
 */
export async function putMarkup(
  png: Blob,
  json: MarkupJson,
  scenePath: string | null,
): Promise<ContextRef> {
  const scene = scenePath ?? "scene";
  const image = await invoke<ContextRef>("context/put", {
    key: contextKey("godot", scene, "markup"),
    kind: "image",
    title: `${scene} - markup`,
    label: "Godot - markup",
    bytesBase64: await blobBase64(png),
  });
  await invoke<ContextRef>("context/put", {
    key: contextKey("godot", scene, "markup-json"),
    kind: "text",
    title: `${scene} - markup notes (JSON)`,
    label: "Godot - markup JSON",
    text: markupJsonText(json),
  });
  return image;
}
