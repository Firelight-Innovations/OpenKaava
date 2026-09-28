/**
 * Every call this app makes to its host, in one file.
 *
 * The shapes mirror `src-tauri/src/apps/agents.rs` and are restated rather
 * than imported, for the same reason as every other app's `rpc.ts`: an app
 * knows its host only through `@openkaava/bridge`.
 */
import { KaavaRpcError, invoke } from "@openkaava/bridge";

// --- what the backend returns -------------------------------------------------

export interface Machine {
  name: string;
  zone: string;
  /** `RUNNING`, `STAGING`, `STOPPING`, `TERMINATED`, and rarer states. */
  status: string;
  machineType: string;
  role: string | null;
  lastStart: string | null;
  lastStop: string | null;
}

export interface StoredObject {
  name: string;
  generation: number;
  updated: string;
  size: number;
}

/** `status.json` as `infra/images/agent/files/kaava-session-hook` writes it. */
export interface Status {
  schema?: number;
  session_id?: string;
  agent?: string;
  user?: string;
  cwd?: string;
  state?: string;
  last_event?: string;
  updated?: string;
  /** Present only right after `UserPromptSubmit`; the next event clears it. */
  prompt?: string | null;
  end_reason?: string | null;
  workflow?: { name: string; run: string; step: string } | null;
}

export interface Session {
  agent: string;
  sessionId: string;
  statusGeneration: number;
  written: string;
  /** `null` when the object would not parse. */
  status: Status | null;
  transcript: StoredObject | null;
}

/** The backend's `cloud::Trouble`, tagged by `kind`. */
export type Trouble =
  | { kind: "gcloudMissing" }
  | { kind: "signedOut"; detail: string }
  | { kind: "denied"; detail: string }
  | { kind: "missing"; what: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "api"; status: number; detail: string }
  | { kind: "fixture"; detail: string };

export interface Problem {
  area: "machines" | "sessions";
  message: string;
  trouble: Trouble;
}

export interface Overview {
  source: "live" | "fixture";
  project: string;
  machines: Machine[];
  sessions: Session[];
  problems: Problem[];
}

export interface Transcript {
  generation: number | null;
  size: number;
  updated: string | null;
  unchanged: boolean;
  text: string;
  truncated: boolean;
}

// --- calls --------------------------------------------------------------------

/** Listing every agent's sessions can take a while on a cold first poll. */
const OVERVIEW_TIMEOUT_MS = 60_000;

export const overview = (): Promise<Overview> =>
  invoke<Overview>("agents/overview", undefined, OVERVIEW_TIMEOUT_MS);

export const transcript = (
  agent: string,
  sessionId: string,
  knownGeneration: number | null,
): Promise<Transcript> =>
  invoke<Transcript>("agents/transcript", {
    agent,
    sessionId,
    ...(knownGeneration === null ? {} : { knownGeneration }),
  });

export const startMachine = (name: string): Promise<{ started: string }> =>
  invoke("agents/start", { name });

/** The trouble an error carries, when the backend attached one. */
export function troubleOf(error: unknown): Trouble | null {
  if (!(error instanceof KaavaRpcError)) return null;
  const data = error.data as { kind?: unknown } | undefined;
  return data && typeof data.kind === "string" ? (data as Trouble) : null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
