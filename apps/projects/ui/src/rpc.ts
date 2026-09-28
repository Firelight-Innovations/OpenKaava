/**
 * Every call this app makes to its host, in one file.
 *
 * The shapes mirror `src-tauri/src/apps/projects.rs` and are restated rather
 * than imported, for the same reason as every other app's `rpc.ts`: an app
 * knows its host only through `@openkaava/bridge`.
 */
import { KaavaRpcError, invoke } from "@openkaava/bridge";

// --- projects/list --------------------------------------------------------

/** `OPENKAAVA-PLANE-DESIGN.md` §3.1, restated field for field — snake_case
 * because the record is written by `kaava-project` (Python), not by this
 * app, and the schema is one thing regardless of which side reads it. */
export interface PlaneProjectRef {
  workspace: string;
  project_id: string;
  identifier: string;
}

export interface ProjectRecord {
  schema: number;
  slug: string;
  name: string;
  game: string | null;
  plane: PlaneProjectRef;
  artifacts: string;
  repo: string | null;
  hindsight_banks: string[];
  created: string;
  archived: boolean;
}

export interface ProjectsList {
  source: "live" | "fixture";
  profile: string;
  projects: ProjectRecord[];
  /** One malformed record's own message; the rest of the list still loads. */
  problems: string[];
}

export const list = (): Promise<ProjectsList> => invoke<ProjectsList>("projects/list");

// --- the wake flow ("Starting Plane… Ns") ---------------------------------

export type WakeSnapshot =
  | { phase: "idle" }
  | { phase: "waking"; elapsedSeconds: number; detail: string }
  | { phase: "healthy"; elapsedSeconds: number }
  | { phase: "cancelled" }
  | { phase: "timedOut"; detail: string }
  | { phase: "failed"; detail: string };

export const wakeStart = (): Promise<{ started: boolean }> => invoke("projects/wake-start");

export const wakeStatus = (): Promise<WakeSnapshot> => invoke<WakeSnapshot>("projects/wake-status");

export const wakeCancel = (): Promise<{ cancelled: boolean }> => invoke("projects/wake-cancel");

// --- the Plane REST proxy --------------------------------------------------

export const planeGet = <T = unknown>(
  path: string,
  query?: Record<string, string | number>,
): Promise<T> => invoke<T>("projects/plane-get", { path, query });

export const planePost = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  invoke<T>("projects/plane-post", { path, body });

export const planePatch = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  invoke<T>("projects/plane-patch", { path, body });

// --- the hosts-file check --------------------------------------------------

export interface HostsCheck {
  ok: boolean;
  resolved: string | null;
  /** A one-line fix, present only when `ok` is false. Never applied for you —
   * design rule: this app never edits the hosts file itself. */
  fix: string | null;
}

export const hostsCheck = (): Promise<HostsCheck> => invoke<HostsCheck>("projects/hosts-check");

// --- the child webview ------------------------------------------------------

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const webviewOpen = (bounds: Bounds, url: string): Promise<{ opened: boolean }> =>
  invoke("projects/webview-open", { bounds, url });

export const webviewNavigate = (url: string): Promise<{ navigated: boolean }> =>
  invoke("projects/webview-navigate", { url });

export const webviewBounds = (bounds: Bounds): Promise<{ moved: boolean }> =>
  invoke("projects/webview-bounds", { bounds });

export const webviewClose = (): Promise<{ closed: boolean }> => invoke("projects/webview-close");

// --- shared helpers ---------------------------------------------------------

/** The backend's `cloud::Trouble`, tagged by `kind` — see `apps/agents/ui`'s
 * own copy of this type for why it is restated per app rather than shared. */
export type Trouble =
  | { kind: "gcloudMissing" }
  | { kind: "signedOut"; detail: string }
  | { kind: "denied"; detail: string }
  | { kind: "missing"; what: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "api"; status: number; detail: string }
  | { kind: "fixture"; detail: string };

export function troubleOf(error: unknown): Trouble | null {
  if (!(error instanceof KaavaRpcError)) return null;
  const data = error.data as { kind?: unknown } | undefined;
  return data && typeof data.kind === "string" ? (data as Trouble) : null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
