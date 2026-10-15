/**
 * The agent tabs in this window's clusters and what each one's session is
 * doing, for the Agents page on the rail.
 *
 * Each tab is asked once with `agent-tab/attach`, which only reads: it never
 * starts a session. After that the shell's own `agent-tab:event` stream keeps
 * the answer current, the same events `ToolWindow` relays to each tab.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  /**
   * The latest prompt sent in it, on one line and cut to `PROMPT_CHARS`, or
   * `null` before the first one. A pasted log is not kept whole in state.
   */
  prompt: string | null;
}

/** How much of a prompt a row keeps. */
export const PROMPT_CHARS = 200;

/** A prompt on one line, cut to `PROMPT_CHARS` with an ellipsis. */
export function clipPrompt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_CHARS ? `${flat.slice(0, PROMPT_CHARS - 1)}…` : flat;
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
    | {
        type: "itemStarted" | "itemUpdated" | "itemCompleted";
        item: { kind: { kind: string; text?: string } };
      }
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
      prompt = clipPrompt(kind.text);
      break;
    }
  }
  if (attachment.status === null) return { ...NO_SESSION, prompt };
  return { state: attachment.status.state, harness: attachment.status.harness, prompt };
}

/**
 * A session moved on by one event, or the same object when the event changes
 * nothing. The host sends a prompt as `itemCompleted`; any item event counts.
 * A reset retires the session without a last status, so it clears the row here.
 */
export function applyEvent(session: AgentSession, event: Envelope["event"]): AgentSession {
  if (event.type === "status" && "status" in event) {
    return { ...session, state: event.status.state, harness: event.status.harness };
  }
  if (event.type === "reset") return NO_SESSION;
  if ("item" in event) {
    const kind = event.item.kind;
    if (kind.kind === "userMessage" && typeof kind.text === "string") {
      return { ...session, prompt: clipPrompt(kind.text) };
    }
  }
  return session;
}

function attach(instanceId: string): Promise<Attachment> {
  return appCall(AGENT_TAB_APP, "agent-tab/attach", undefined, {
    instanceId,
  }) as Promise<Attachment>;
}

/** One listener for the hook's life, and the tabs it follows. */
interface Tracker {
  /** Follow exactly these tabs: attach the new ones, forget the gone ones. */
  follow(ids: readonly string[]): void;
  stop(): void;
}

function track(
  read: (instanceId: string) => Promise<Attachment>,
  listen: typeof onAgentTabEvent,
  setSessions: (
    next: (prev: ReadonlyMap<string, AgentSession>) => ReadonlyMap<string, AgentSession>,
  ) => void,
): Tracker {
  let live = true;
  let unlisten: (() => void) | undefined;
  const want = new Set<string>();
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

  // Registered before any attach is sent, so no event can fall between a
  // tab's snapshot and the listener that should have heard what came next.
  const listening = listen((payload) => {
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
  }).then((stop) => {
    if (live) unlisten = stop;
    else stop();
  });

  // A tab that cannot be read keeps what it showed, and its events still count.
  const settle = (id: string, attachment: Attachment | null) => {
    if (!live || !want.has(id)) return;
    let at = attachment?.seq ?? 0;
    const replay: Envelope[] = [];
    for (const envelope of early.get(id) ?? []) {
      if (envelope.seq <= at) continue;
      replay.push(envelope);
      at = envelope.seq;
    }
    early.delete(id);
    seen.set(id, at);
    update(id, (prev) =>
      replay.reduce(
        (session, envelope) => applyEvent(session, envelope.event),
        attachment ? sessionOf(attachment) : prev,
      ),
    );
  };

  return {
    follow(ids) {
      const next = new Set(ids);
      for (const id of [...want]) {
        if (next.has(id)) continue;
        want.delete(id);
        seen.delete(id);
        early.delete(id);
      }
      // Drop tabs that have gone, so the map never outgrows the window.
      setSessions((prev) => {
        if ([...prev.keys()].every((id) => next.has(id))) return prev;
        return new Map([...prev].filter(([id]) => next.has(id)));
      });
      for (const id of next) {
        if (want.has(id)) continue;
        want.add(id);
        void listening.then(() => {
          if (!live || !want.has(id)) return;
          read(id).then(
            (attachment) => settle(id, attachment),
            () => settle(id, null),
          );
        });
      }
    },
    stop() {
      live = false;
      unlisten?.();
    },
  };
}

/**
 * The live session of every agent tab named in `ids`. A tab not yet answered
 * reads as `NO_SESSION`. Each tab is attached once, when it first appears: a
 * tab opened or closed elsewhere asks nothing again of the rest. `read` and
 * `listen` are swapped out by tests.
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

  const tracker = useRef<Tracker | null>(null);
  useEffect(() => {
    const next = track(read, listen, setSessions);
    tracker.current = next;
    return () => {
      next.stop();
      tracker.current = null;
    };
  }, [read, listen]);
  // After the effect above, so a tracker made for a new `read` or `listen`
  // is told the tabs too.
  useEffect(() => tracker.current?.follow(wanted), [wanted, read, listen]);

  return sessions;
}

/**
 * The rail dot for the Agents page: amber for a session that needs you, else
 * blue for one at work, where a session still starting counts as at work,
 * else none.
 */
export function agentsDot(sessions: ReadonlyMap<string, AgentSession>): string | undefined {
  const states = [...sessions.values()].map((s) => s.state);
  if (states.includes("needsInput")) return "var(--warning)";
  if (states.includes("working") || states.includes("starting")) return "var(--info)";
  return undefined;
}
