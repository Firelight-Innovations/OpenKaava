/**
 * The wire shapes `canvas/*` answers with, restated for the same reason the
 * other apps restate theirs: a frontend calls the bridge, not the Rust module
 * (`src-tauri/src/apps/canvas.rs`).
 */
import { invoke, KaavaRpcError } from "@openkaava/bridge";
import type { SceneFile } from "./scene";
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
