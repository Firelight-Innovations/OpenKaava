/**
 * Every cluster's agent tabs and what each one's session is doing, for the
 * Agents page on the rail.
 *
 * Each tab is asked once with `agent-tab/attach`, which only reads: it never
 * starts a session. After that the shell's own `agent-tab:event` stream keeps
 * the answer current, the same events `ToolWindow` relays to each tab.
 */
import { useEffect, useMemo, useState } from "react";
import { appCall, onAgentTabEvent, type Cluster } from "../../bindings";
import { paneTabs } from "../contract";
import { AGENT_TAB_APP } from "./agentBar";

/** Mirrors the tab's `SessionState`, plus `"none"` for a tab that never sent a prompt. */
export type AgentSessionState =
  "none" | "starting" | "ready" | "working" | "needsInput" | "stopped" | "failed";

/** What the page shows for one agent tab. */
export interface AgentSession {
  state: AgentSessionState;
  /** Which harness runs it, once a session has started. */
  harness: string | null;
  /** The latest prompt sent in it, or `null` before the first one. */
  prompt: string | null;
}

/** One cluster's agent tabs, in layout order. */
export interface AgentCluster {
  id: string;
  name: string;
  tabs: { id: string; title: string }[];
}

/** The parts of an `Attachment` and an `Envelope` this reads. */
interface Attachment {
  status: { state: AgentSessionState; harness: string } | null;
  items: { kind: { kind: string; text?: string } }[];
  seq: number;
}

interface Envelope {
  instanceId: string;
  seq: number;
  event:
    | { type: "status"; status: { state: AgentSessionState; harness: string } }
    | { type: "itemStarted"; item: { kind: { kind: string; text?: string } } }
    | { type: string };
}

export const NO_SESSION: AgentSession = { state: "none", harness: null, prompt: null };

/** Every cluster with its agent tabs, in the order given. A cluster with none keeps an empty list. */
export function agentClusters(
  clusters: readonly Pick<Cluster, "id" | "name" | "tree">[],
  instances: ReadonlyMap<string, { appId: string; title?: string }>,
): AgentCluster[] {
  return clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    tabs: paneTabs(cluster.tree).flatMap((id) => {
      const instance = instances.get(id);
      return instance?.appId === AGENT_TAB_APP ? [{ id, title: instance.title ?? "" }] : [];
    }),
  }));
}

/** A session read from its attachment. */
export function sessionOf(attachment: Attachment): AgentSession {
  let prompt: string | null = null;
  for (let i = attachment.items.length - 1; i >= 0; i--) {
    const kind = attachment.items[i].kind;
    if (kind.kind === "userMessage" && typeof kind.text === "string") {
      prompt = kind.text;
      break;
    }
  }
  if (attachment.status === null) return { ...NO_SESSION, prompt };
  return { state: attachment.status.state, harness: attachment.status.harness, prompt };
}

/** A session moved on by one event, or the same object when the event changes nothing. */
export function applyEvent(session: AgentSession, event: Envelope["event"]): AgentSession {
  if (event.type === "status" && "status" in event) {
    return { ...session, state: event.status.state, harness: event.status.harness };
  }
  if (event.type === "itemStarted" && "item" in event) {
    const kind = event.item.kind;
    if (kind.kind === "userMessage" && typeof kind.text === "string") {
      return { ...session, prompt: kind.text };
    }
  }
  return session;
}

function attach(instanceId: string): Promise<Attachment> {
  return appCall(AGENT_TAB_APP, "agent-tab/attach", undefined, {
    instanceId,
  }) as Promise<Attachment>;
}

/**
 * The live session of every agent tab named in `ids`. A tab not yet answered
 * reads as `NO_SESSION`. `read` and `listen` are swapped out by tests.
 */
export function useAgentSessions(
  ids: readonly string[],
  read: (instanceId: string) => Promise<Attachment> = attach,
  listen: typeof onAgentTabEvent = onAgentTabEvent,
): ReadonlyMap<string, AgentSession> {
  const [sessions, setSessions] = useState<ReadonlyMap<string, AgentSession>>(new Map());
  // A stable key, so a new array holding the same ids asks nothing again.
  const key = ids.join("\n");
  const wanted = useMemo(() => (key === "" ? [] : key.split("\n")), [key]);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    const want = new Set(wanted);
    // The seq each attachment reflects: events at or below it are already in it.
    const seen = new Map<string, number>();
    // Events that arrive before their tab's attachment, replayed once it lands.
    const early = new Map<string, Envelope[]>();

    const update = (id: string, next: (prev: AgentSession) => AgentSession) =>
      setSessions((prev) => {
        const before = prev.get(id) ?? NO_SESSION;
        const after = next(before);
        if (after === before && prev.has(id)) return prev;
        const map = new Map(prev);
        map.set(id, after);
        return map;
      });

    // Drop tabs that have gone, so the map never outgrows the window.
    setSessions((prev) => {
      if ([...prev.keys()].every((id) => want.has(id))) return prev;
      return new Map([...prev].filter(([id]) => want.has(id)));
    });

    void (async () => {
      const stop = await listen((payload) => {
        const envelope = payload as Envelope | null;
        if (!live || !envelope || !want.has(envelope.instanceId)) return;
        const at = seen.get(envelope.instanceId);
        if (at === undefined) {
          early.set(envelope.instanceId, [...(early.get(envelope.instanceId) ?? []), envelope]);
          return;
        }
        if (envelope.seq <= at) return;
        seen.set(envelope.instanceId, envelope.seq);
        update(envelope.instanceId, (prev) => applyEvent(prev, envelope.event));
      });
      if (!live) return stop();
      unlisten = stop;
    })();

    const settle = (id: string, attachment: Attachment) => {
      if (!live) return;
      let session = sessionOf(attachment);
      let at = attachment.seq;
      for (const envelope of early.get(id) ?? []) {
        if (envelope.seq <= at) continue;
        session = applyEvent(session, envelope.event);
        at = envelope.seq;
      }
      early.delete(id);
      seen.set(id, at);
      update(id, () => session);
    };
    for (const id of wanted) {
      read(id).then(
        (attachment) => settle(id, attachment),
        // A tab that cannot be read starts from nothing, and its events still count.
        () => settle(id, { status: null, items: [], seq: 0 }),
      );
    }

    return () => {
      live = false;
      unlisten?.();
    };
  }, [wanted, read, listen]);

  return sessions;
}

/** The rail dot for the Agents page: a session that needs you, else one at work, else none. */
export function agentsDot(sessions: ReadonlyMap<string, AgentSession>): string | undefined {
  const states = [...sessions.values()].map((s) => s.state);
  if (states.includes("needsInput")) return "var(--warning)";
  if (states.includes("working") || states.includes("starting")) return "var(--info)";
  return undefined;
}
