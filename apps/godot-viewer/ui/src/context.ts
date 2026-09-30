/**
 * The Godot Viewer as a context provider: the scene tree as text and the
 * rendered frame as an image, for the agent working in this environment. The
 * store and the strip beside each terminal are the host's (`context/put`).
 */
import { invoke } from "@openkaava/bridge";
import { contextKey, type ContextRef } from "../../../shared/context";
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
