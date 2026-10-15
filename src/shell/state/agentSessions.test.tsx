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
  NO_SESSION,
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

  it("moves on with a status or a new prompt, and ignores the rest", () => {
    const working = applyEvent(NO_SESSION, {
      type: "status",
      status: { state: "working", harness: "codex" },
    });
    expect(working).toEqual({ state: "working", harness: "codex", prompt: null });
    expect(applyEvent(working, { type: "itemStarted", item: user("go") }).prompt).toBe("go");
    expect(applyEvent(working, { type: "turnStarted" })).toBe(working);
  });
});

describe("agentsDot", () => {
  const map = (...states: AgentSession["state"][]) =>
    new Map(states.map((state, i) => [String(i), { ...NO_SESSION, state }]));

  it("is amber when a session needs you, blue while one works, and absent otherwise", () => {
    expect(agentsDot(map("working", "needsInput"))).toBe("var(--warning)");
    expect(agentsDot(map("ready", "working"))).toBe("var(--info)");
    expect(agentsDot(map("ready", "stopped"))).toBeUndefined();
  });
});

describe("useAgentSessions", () => {
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
      emit({ instanceId: "a1", seq: 3, event: { type: "itemStarted", item: user("early") } });
    });
    await act(async () => answer({ status: null, items: [], seq: 2 }));

    expect(result.current.get("a1")?.prompt).toBe("early");
  });
});
