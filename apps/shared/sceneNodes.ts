/**
 * Mapping between the paths an engine's own tree uses (`World/Player`, a Blender
 * object name) and the paths the 3D view reports for the same node. Shared by
 * the viewers that show an exported glTF.
 */

/** Engine path to the path the 3D view uses, and back. Both fall back to the nearest node that has one. */
export interface NodeLookup {
  toScene(viewPath: string | null): string | null;
  toView(scenePath: string | null): string | null;
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  let at = path;
  for (;;) {
    out.push(at);
    const cut = at.lastIndexOf("/");
    if (cut < 0) return out;
    at = at.slice(0, cut);
  }
}

/**
 * Some nodes have nothing to draw (a `CanvasLayer`, a script-only node, an
 * empty) and some drawn parts have no node of their own, so a lookup that
 * misses walks up to the closest ancestor that did map: clicking a part of the
 * chair selects the chair, and clicking a label in the list highlights the
 * nearest thing that is drawn instead of nothing.
 */
export function nodeLookup(nodeMap: Record<string, string>): NodeLookup {
  const reverse = new Map<string, string>();
  for (const [view, scene] of Object.entries(nodeMap)) reverse.set(scene, view);
  return {
    toScene(viewPath) {
      if (viewPath === null) return null;
      for (const at of ancestors(viewPath)) {
        const scene = nodeMap[at];
        if (scene !== undefined) return scene;
      }
      return null;
    },
    toView(scenePath) {
      if (scenePath === null) return null;
      for (const at of ancestors(scenePath)) {
        const view = reverse.get(at);
        if (view !== undefined) return view;
      }
      return null;
    },
  };
}

/** The glb's location as an agent would open it: from `.kaava` down when it is inside one. */
export function projectRelative(absolute: string): string {
  const path = absolute.replace(/\\/g, "/");
  const at = path.indexOf("/.kaava/");
  return at >= 0 ? path.slice(at + 1) : path;
}

/** A base64 string as the bytes three.js loads. */
export function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
