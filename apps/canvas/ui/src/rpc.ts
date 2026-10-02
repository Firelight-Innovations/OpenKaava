/**
 * The wire shapes `canvas/*` answers with, restated for the same reason the
 * other apps restate theirs: a frontend calls the bridge, not the Rust module
 * (`src-tauri/src/apps/canvas/`).
 */
import { invoke, KaavaRpcError } from "@openkaava/bridge";
import type { SceneFile } from "./scene";
import type { TypeDef } from "./objects";
import type { AssetsResult } from "./spec";

export interface CanvasState {
  hasEnvironment: boolean;
  /** The environment is the read-only main checkout: writes are refused. */
  readOnly: boolean;
  /** The folder canvases live in, relative to the environment. */
  dir: string;
}

export interface CanvasSummary {
  id: string;
  title: string;
  parent: string | null;
  mtime: number | null;
  path: string;
  /** Set when the file could not be read as a canvas. */
  error: string | null;
}

export interface CanvasDoc {
  id: string;
  path: string;
  scene: SceneFile;
  mtime: number | null;
}

export const getState = () => invoke<CanvasState>("canvas/state");
export const listCanvases = () => invoke<CanvasSummary[]>("canvas/list");
export const readCanvas = (id: string) => invoke<CanvasDoc>("canvas/read", { id });
export const statCanvas = (id: string) => invoke<{ mtime: number | null }>("canvas/stat", { id });
export const listAssets = () => invoke<AssetsResult>("canvas/assets");
export const createCanvas = (id: string, title: string, parent?: string) =>
  invoke<CanvasDoc>("canvas/create", { id, title, parent });
export const writeCanvas = (id: string, scene: SceneFile, baseMtime: number | null) =>
  invoke<{ id: string; mtime: number | null }>("canvas/write", { id, scene, baseMtime });

/**
 * Open the shell's Settings on the Canvas section, where the detail level and the
 * drawing style agents use are chosen. A host method rather than a `canvas/*`
 * one: the screen belongs to the shell, and an app has no other way to ask for it.
 */
export const openCanvasSettings = () =>
  invoke<{ section: string | null }>("shell/open-settings", { section: "canvas" });

// --- review comments and reference images -------------------------------------
// Every one of these names its actor; the sidebar is always a person.

export interface CommentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasComment {
  id: string;
  canvas: string;
  /** The diagram id, or the frame element id for an unnamed frame. */
  frameId: string;
  elementIds: string[];
  region: CommentRegion | null;
  text: string;
  author: string;
  createdAt: string;
  status: "open" | "resolved";
  resolution: { note: string; by: string; at: string } | null;
  path: string;
}

export interface CommentList {
  comments: CanvasComment[];
  open: number;
  total: number;
  unreadable: string[];
}

export interface RefRow {
  name: string;
  ref: string;
  path: string;
  mimeType: string;
  /** The scene's file id for it, when it is placed. */
  fileId: string | null;
}

const HUMAN = { actor: "human" } as const;

export const listComments = (id: string) =>
  invoke<CommentList>("canvas/list-comments", { id, status: "all", ...HUMAN });
export const createComment = (
  id: string,
  diagram: string,
  target: { elementIds: string[] } | { region: CommentRegion },
  text: string,
) => invoke<CanvasComment>("canvas/create-comment", { id, diagram, ...target, text, ...HUMAN });
export const resolveComment = (id: string, commentId: string, note: string) =>
  invoke<CanvasComment>("canvas/resolve-comment", { id, commentId, note, ...HUMAN });
export const reopenComment = (id: string, commentId: string) =>
  invoke<CanvasComment>("canvas/reopen-comment", { id, commentId, ...HUMAN });
export const listRefs = (id: string) =>
  invoke<{ refs: RefRow[]; dir: string }>("canvas/refs", { id, ...HUMAN });

// --- object types and nesting ---------------------------------------------------

export interface TypesResult {
  builtin: TypeDef[];
  custom: TypeDef[];
  path: string;
  /** Set when `.kaava/canvas/types.json` could not be read. */
  problem: string | null;
}

export const listTypes = () => invoke<TypesResult>("canvas/types", HUMAN);
export const saveType = (type: Omit<TypeDef, "builtin">) =>
  invoke<{ type: TypeDef }>("canvas/save-type", { type, ...HUMAN });
export const deleteType = (id: string) =>
  invoke<{ id: string; deleted: boolean }>("canvas/delete-type", { id, ...HUMAN });
export const setParent = (id: string, parent: string | null) =>
  invoke<{ id: string; parent: string | null }>("canvas/set-parent", { id, parent, ...HUMAN });

// --- reading the errors -------------------------------------------------------

function kindOf(err: unknown): string | null {
  if (!(err instanceof KaavaRpcError)) return null;
  const data = err.data as { kind?: unknown } | undefined;
  return typeof data?.kind === "string" ? data.kind : null;
}

/** A `canvas/write` that lost a race, and the mtime it lost to. */
export function staleWrite(err: unknown): { mtime: number | null } | null {
  if (kindOf(err) !== "stale") return null;
  const data = (err as KaavaRpcError).data as { mtime?: unknown };
  return { mtime: typeof data.mtime === "number" ? data.mtime : null };
}

export const isCorrupt = (err: unknown) => kindOf(err) === "corrupt";
export const isMissing = (err: unknown) => kindOf(err) === "missing";
export const isExists = (err: unknown) => kindOf(err) === "exists";

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
