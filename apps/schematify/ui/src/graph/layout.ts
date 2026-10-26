/**
 * The shape of `layout/<schematic-slug>.json` (PRD §6.1) — the cosmetic layer,
 * the only file a node drag writes. The type lives beside the seam rather than
 * inside the engine because it is a storage contract: the wave that wires the
 * real backend has to serialise exactly this, and the engine merely converts
 * to and from it (`../engine/layout.ts`).
 *
 * Nothing here carries meaning. Positions, sizes, collapse state, the
 * annotation tier (PRD §11.3) and where the viewport was left, and no more.
 */

/** One node's stored geometry. Size is stored as well as position: a group is
 *  resized by hand, and a collapsed box is not the size of its open one. */
export interface LayoutNode {
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed?: boolean;
}

/** A group or a comment, stored whole. An annotation node exists nowhere else
 *  — it is not in `nodes/`, so it can never reach reconciliation. */
export interface LayoutAnnotation extends LayoutNode {
  id: string;
  kind: "group" | "comment";
  slug: string;
  title: string;
  parentId: string | null;
  author?: string;
  body?: string;
}

/** Where the Schematic was left. Structurally the engine's `Viewport`. */
export interface LayoutViewport {
  x: number;
  y: number;
  zoom: number;
}

/** The file. `version` exists so a later wave migrates rather than guesses. */
export interface LayoutFile {
  version: 1;
  schematic: string;
  nodes: Record<string, LayoutNode>;
  annotations: LayoutAnnotation[];
  viewport?: LayoutViewport;
}

/** The path the file is written to, relative to the `.veistra/` root. */
export function layoutPath(slug: string): string {
  return `layout/${slug}.json`;
}

/** The state before anybody has moved anything. */
export function emptyLayout(slug: string): LayoutFile {
  return { version: 1, schematic: slug, nodes: {}, annotations: [] };
}
