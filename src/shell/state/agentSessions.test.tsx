// @vitest-environment jsdom
/**
 * Reading every agent tab's session for the Agents page: one attach per tab,
 * then the shell's event stream, with events the attachment already holds
 * dropped and events that beat it replayed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PaneNode } from "../contract";
import {
  agentClusters,
  agentsDot,
  applyEvent,
  clipPrompt,
  NO_SESSION,
  PROMPT_CHARS,
  sessionOf,
  useAgentSessions,
  type AgentSession,
} from "./agentSessions";

afterEach(cleanup);

const leaf = (id: string, tabs: string[]): PaneNode =>
  ({ kind: "leaf", id, tabs, active: tabs[0] ?? null }) as unknown as PaneNode;

const user = (text: string) => ({ kind: { kind: "userMessage", text } });

describe("agentClusters", () => {
  it("keeps each cluster, with only its agent tabs, in layout order", () => {
    const instances = new Map([
      ["a1", { appId: "agent-tab", title: "Agent" }],
      ["f1", { appId: "files", title: "Files" }],
      ["a2", { appId: "agent-tab" }],
    ]);
    const clusters = agentClusters(
      [
        { id: "c1", name: "api", tree: leaf("p1", ["a1", "f1", "a2"]) },
        { id: "c2", name: "web", tree: leaf("p2", ["f1"]) },
      ],
      instances,
    );
    expect(clusters).toEqual([
      {
        id: "c1",
        name: "api",
        tabs: [
          { id: "a1", title: "Agent" },
          { id: "a2", title: "" },
        ],
      },
      { id: "c2", name: "web", tabs: [] },
    ]);
  });
});

describe("sessionOf and applyEvent", () => {
  it("reads the state, harness and latest prompt from an attachment", () => {
    expect(
      sessionOf({
        status: { state: "ready", harness: "claude" },
        items: [user("first"), { kind: { kind: "assistantText" } }, user("second")],
        seq: 4,
      }),
    ).toEqual({ state: "ready", harness: "claude", prompt: "second" });
    expect(sessionOf({ status: null, items: [], seq: 0 })).toEqual(NO_SESSION);
  });

  it("moves on with a status or a new prompt, clears on reset, and ignores the rest", () => {
    const working = applyEvent(NO_SESSION, {
      type: "status",
      status: { state: "working", harness: "codex" },
    });
    expect(working).toEqual({ state: "working", harness: "codex", prompt: null });
    // The host sends a prompt as a completed item (normalize.rs `begin_turn`).
    expect(applyEvent(working, { type: "itemCompleted", item: user("go") }).prompt).toBe("go");
    expect(applyEvent(working, { type: "turnStarted" })).toBe(working);
    // A reset retires the session with no last status: only the reset clears it.
    expect(applyEvent(working, { type: "reset" })).toEqual(NO_SESSION);
  });

  it("keeps a prompt on one line, cut short", () => {
    expect(clipPrompt("  fix\n\tthe  build ")).toBe("fix the build");
    const long = clipPrompt("x".repeat(PROMPT_CHARS * 10));
    expect(long).toHaveLength(PROMPT_CHARS);
    expect(long.endsWith("…")).toBe(true);
    const pasted = sessionOf({ status: null, items: [user("y".repeat(1_000_000))], seq: 1 });
    expect(pasted.prompt).toHaveLength(PROMPT_CHARS);
    expect(applyEvent(NO_SESSION, { type: "itemCompleted", item: user("a\nb") }).prompt).toBe(
      "a b",
    );
  });
});

describe("agentsDot", () => {
  const map = (...states: AgentSession["state"][]) =>
    new Map(states.map((state, i) => [String(i), { ...NO_SESSION, state }]));

  it("is amber when a session needs you, blue while one works, and absent otherwise", () => {
    expect(agentsDot(map("working", "needsInput"))).toBe("var(--warning)");
    expect(agentsDot(map("ready", "working"))).toBe("var(--info)");
    // A session still starting counts as at work.
    expect(agentsDot(map("ready", "starting"))).toBe("var(--info)");
    expect(agentsDot(map("ready", "stopped"))).toBeUndefined();
  });
});

/** A stand-in for the event stream, and for the host's attach. */
function host(answers: Record<string, () => Promise<unknown>> = {}) {
  let emit: (payload: unknown) => void = () => {};
  const unlisten = vi.fn();
  const listen = vi.fn(async (cb: (payload: unknown) => void) => {
    emit = cb;
    return unlisten;
  });
  const read = vi.fn((id: string) =>
    (answers[id] ?? (() => Promise.resolve({ status: READY, items: [user(id)], seq: 1 })))(),
  ) as unknown as (id: string) => Promise<{
    status: { state: AgentSession["state"]; harness: string } | null;
    items: { kind: { kind: string; text?: string } }[];
    seq: number;
  }>;
  return { listen, read, unlisten, emit: (payload: unknown) => act(() => emit(payload)) };
}

const READY = { state: "ready" as const, harness: "claude" };
const status = (instanceId: string, seq: number, state: AgentSession["state"]) => ({
  instanceId,
  seq,
  event: { type: "status", status: { state, harness: "claude" } },
});

describe("useAgentSessions", () => {
  it("asks nothing again for a new array of the same tabs", async () => {
    const h = host();
    const { result, rerender } = renderHook(({ ids }) => useAgentSessions(ids, h.read, h.listen), {
      initialProps: { ids: ["a1"] },
    });
    await waitFor(() => expect(result.current.get("a1")?.state).toBe("ready"));
    rerender({ ids: ["a1"] });
    rerender({ ids: ["a1"] });
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.listen).toHaveBeenCalledTimes(1);
  });

  it("attaches only a tab that is new, and forgets one that has gone", async () => {
    const h = host();
    const { result, rerender } = renderHook(({ ids }) => useAgentSessions(ids, h.read, h.listen), {
      initialProps: { ids: ["a1"] },
    });
    await waitFor(() => expect(result.current.has("a1")).toBe(true));
    rerender({ ids: ["a1", "a2"] });
    await waitFor(() => expect(result.current.get("a2")?.prompt).toBe("a2"));
    expect(vi.mocked(h.read).mock.calls.map(([id]) => id)).toEqual(["a1", "a2"]);
    expect(h.listen).toHaveBeenCalledTimes(1);

    rerender({ ids: ["a2"] });
    expect(result.current.has("a1")).toBe(false);
    // A gone tab's events are no longer followed.
    h.emit(status("a1", 9, "working"));
    expect(result.current.has("a1")).toBe(false);
  });

  it("sends no attach until the listener is in place", async () => {
    let registered: (stop: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((resolve) => (registered = resolve)));
    const h = host();
    renderHook(() => useAgentSessions(["a1"], h.read, listen));
    await Promise.resolve();
    expect(h.read).not.toHaveBeenCalled();
    await act(async () => registered(() => {}));
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("keeps what came in before a failed attach, follows what comes after, and stops on unmount", async () => {
    let refuse: (err: Error) => void = () => {};
    const h = host({ a1: () => new Promise((_, reject) => (refuse = reject)) });
    const { result, unmount } = renderHook(() => useAgentSessions(["a1"], h.read, h.listen));
    await waitFor(() => expect(h.read).toHaveBeenCalled());

    h.emit(status("a1", 4, "needsInput"));
    await act(async () => refuse(new Error("busy")));
    // The failure does not overwrite what the stream already said.
    expect(result.current.get("a1")?.state).toBe("needsInput");

    h.emit(status("a1", 5, "working"));
    expect(result.current.get("a1")?.state).toBe("working");

    unmount();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("stops a listener that registers after the hook has gone", async () => {
    let registered: (stop: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((resolve) => (registered = resolve)));
    const h = host();
    const { unmount } = renderHook(() => useAgentSessions(["a1"], h.read, listen));
    unmount();
    const stop = vi.fn();
    await act(async () => registered(stop));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("attaches each tab once, then follows its events, dropping ones already seen", async () => {
    let emit: (payload: unknown) => void = () => {};
    const listen = vi.fn(async (cb: (payload: unknown) => void) => {
      emit = cb;
      return () => {};
    });
    const read = vi.fn(async () => ({
      status: { state: "ready" as const, harness: "claude" },
      items: [user("hello")],
      seq: 5,
    }));
    const ids = ["a1"];
    const { result } = renderHook(() => useAgentSessions(ids, read, listen));

    await waitFor(() => expect(result.current.get("a1")?.state).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);

    act(() => {
      emit({
        instanceId: "a1",
        seq: 5,
        event: { type: "status", status: { state: "failed", harness: "claude" } },
      });
      emit({
        instanceId: "other",
        seq: 9,
        event: { type: "status", status: { state: "failed", harness: "claude" } },
      });
    });
    expect(result.current.get("a1")?.state).toBe("ready");
    expect(result.current.has("other")).toBe(false);

    act(() => {
      emit({
        instanceId: "a1",
        seq: 6,
        event: { type: "status", status: { state: "working", harness: "claude" } },
      });
    });
    expect(result.current.get("a1")?.state).toBe("working");
  });

  it("replays an event that arrived before its tab's attachment", async () => {
    let emit: (payload: unknown) => void = () => {};
    const listen = vi.fn(async (cb: (payload: unknown) => void) => {
      emit = cb;
      return () => {};
    });
    let answer: (value: { status: null; items: never[]; seq: number }) => void = () => {};
    const read = vi.fn(
      () => new Promise<{ status: null; items: never[]; seq: number }>((r) => (answer = r)),
    );
    const ids = ["a1"];
    const { result } = renderHook(() => useAgentSessions(ids, read, listen));
    await waitFor(() => expect(listen).toHaveBeenCalled());

    act(() => {
      emit({ instanceId: "a1", seq: 3, event: { type: "itemCompleted", item: user("early") } });
    });
    await act(async () => answer({ status: null, items: [], seq: 2 }));

    expect(result.current.get("a1")?.prompt).toBe("early");
  });
});
