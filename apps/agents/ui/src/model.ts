/**
 * How the overview becomes the rail: session states, titles, and the two
 * groupings (by machine, by workflow run). Pure, so it is tested without a DOM.
 */
import type { Machine, Overview, Session } from "./rpc";

/**
 * A `running` session with no hook event for this long is reported as stale.
 * The VM may have stopped mid-turn, and a stopped VM's hook never writes
 * `ended`. `docs/cloud-services.md` §5 asks the UI to flag it rather than
 * trust the last state it saw.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export type State = "running" | "idle" | "ended" | "stale" | "stopped" | "unknown";

/**
 * `machineStatus` is the session's VM as Compute reports it, or `null` when
 * the VM is not in the list. A session that last said running or idle on a
 * machine that is not `RUNNING` has no process behind it any more.
 */
export function stateOf(session: Session, now: number, machineStatus: string | null = null): State {
  const state = session.status?.state;
  const live = state === "running" || state === "idle";
  if (live && machineStatus !== null && machineStatus !== "RUNNING") return "stopped";
  if (state === "running") {
    const at = Date.parse(updatedOf(session));
    return Number.isFinite(at) && now - at > STALE_AFTER_MS ? "stale" : "running";
  }
  if (state === "idle" || state === "ended") return state;
  return "unknown";
}

/** Running and idle sessions still have a Claude process behind them. */
export const isLive = (state: State): boolean => state === "running" || state === "idle";

/** The hook's own clock when it wrote one, else the object's write time. */
export function updatedOf(session: Session): string {
  return session.status?.updated ?? session.written;
}

export const keyOf = (s: Pick<Session, "agent" | "sessionId">): string =>
  `${s.agent}/${s.sessionId}`;

/**
 * What a row calls a session. The hook keeps `prompt` only until the next
 * event, so most sessions fall back to the transcript's first request, which
 * the caller passes in once it has loaded one.
 */
export function titleOf(session: Session, firstRequest?: string | null): string {
  const text = session.status?.prompt || firstRequest;
  if (text) return oneLine(text);
  const wf = session.status?.workflow;
  if (wf) return `${wf.name} · ${wf.step}`;
  return `Session ${session.sessionId.slice(0, 8)}`;
}

export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const byNewest = (a: Session, b: Session): number => updatedOf(b).localeCompare(updatedOf(a));

// --- by machine ---------------------------------------------------------------

export interface MachineGroup {
  name: string;
  /** `null` for an agent whose sessions are in the bucket but whose VM is not
   *  in the Compute list: deleted, renamed, or the list was denied. */
  machine: Machine | null;
  live: Session[];
  recent: Session[];
}

/** One group per machine and per agent that has sessions, machines first. */
export function byMachine(overview: Overview, now: number): MachineGroup[] {
  const groups = new Map<string, MachineGroup>();
  for (const machine of overview.machines) {
    groups.set(machine.name, { name: machine.name, machine, live: [], recent: [] });
  }
  for (const session of [...overview.sessions].sort(byNewest)) {
    let group = groups.get(session.agent);
    if (!group) {
      group = { name: session.agent, machine: null, live: [], recent: [] };
      groups.set(session.agent, group);
    }
    const state = stateOf(session, now, group.machine?.status ?? null);
    (isLive(state) ? group.live : group.recent).push(session);
  }
  return [...groups.values()].sort(
    (a, b) => Number(!a.machine) - Number(!b.machine) || a.name.localeCompare(b.name),
  );
}

// --- by workflow --------------------------------------------------------------

export interface RunGroup {
  /** `null` for the sessions that were started by hand. */
  workflow: string | null;
  run: string | null;
  /** Oldest first, so the steps read in the order they ran. */
  sessions: Session[];
  latest: string;
}

/** Runs newest first; the hand-started sessions last. */
export function byWorkflow(sessions: Session[]): RunGroup[] {
  const runs = new Map<string, RunGroup>();
  const loose: Session[] = [];
  for (const session of sessions) {
    const wf = session.status?.workflow;
    if (!wf) {
      loose.push(session);
      continue;
    }
    const key = `${wf.name}\u0000${wf.run}`;
    let group = runs.get(key);
    if (!group) {
      group = { workflow: wf.name, run: wf.run, sessions: [], latest: "" };
      runs.set(key, group);
    }
    group.sessions.push(session);
  }
  const groups = [...runs.values()];
  for (const g of groups) {
    g.sessions.sort((a, b) => updatedOf(a).localeCompare(updatedOf(b)));
    g.latest = updatedOf(g.sessions[g.sessions.length - 1]);
  }
  groups.sort((a, b) => b.latest.localeCompare(a.latest));
  if (loose.length > 0) {
    loose.sort(byNewest);
    groups.push({ workflow: null, run: null, sessions: loose, latest: updatedOf(loose[0]) });
  }
  return groups;
}

// --- machines -----------------------------------------------------------------

export type Tone = "ok" | "warn" | "off" | "err";

export function machineTone(status: string): Tone {
  if (status === "RUNNING") return "ok";
  if (status === "TERMINATED" || status === "SUSPENDED") return "off";
  if (status === "REPAIRING") return "err";
  return "warn";
}

export const stateTone: Record<State, Tone> = {
  running: "ok",
  idle: "warn",
  ended: "off",
  stale: "err",
  stopped: "off",
  unknown: "off",
};

/** The status of the machine a session ran on, or `null` if it is not listed. */
export function machineStatusOf(overview: Overview, agent: string): string | null {
  return overview.machines.find((m) => m.name === agent)?.status ?? null;
}

/** Compute Engine's word for stopped, in the words the rail uses. */
export function machineLabel(status: string): string {
  return status === "TERMINATED" ? "stopped" : status.toLowerCase();
}

// --- time ---------------------------------------------------------------------

/** "just now", "4 min ago", "3 h ago", then a date. */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toISOString().slice(0, 10);
}
