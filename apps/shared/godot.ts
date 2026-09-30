/**
 * What Play and the Godot Viewer both ask the Godot half of the backend:
 * where the engine is, which projects the environment holds, and "Open in
 * Godot". Restated here, not imported from `src-tauri`, for the reason
 * `comments.ts` restates the comment shapes. Both apps answer `godot/*` by
 * delegating to `src-tauri/src/godot/rpc.rs`.
 */
import { invoke } from "@openkaava/bridge";

export type AddonState = "no" | "yes" | "partial";

export interface GodotFound {
  path: string;
  source: "setting" | "env" | "path" | "common" | "steam";
  /** The line `godot --version` printed. */
  version: string;
  major: number;
  minor: number;
}

export interface GodotProject {
  /** Folder relative to the environment root, `.` for the root itself. */
  rel: string;
  name: string;
  mainScene: string | null;
  mainScenePath: string | null;
  engineMajor: number;
  addon: AddonState;
}

export interface GodotStatus {
  environment: { root: string | null; readOnly: boolean };
  executable: { found: GodotFound | null; problems: string[]; setting: string };
  projects: GodotProject[];
}

/** `refresh` forgets the remembered executable and searches again. */
export const getStatus = (refresh = false) => invoke<GodotStatus>("godot/status", { refresh });

export const openInGodot = (project?: string) =>
  invoke<{ pid: number; project: string; godot: string }>("godot/open-editor", { project });

/** The message of a failed call, whatever shape the bridge threw. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return "Something went wrong.";
}
