// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const calls = vi.hoisted(() => {
  // The last listener each event was given, so a test can fire it.
  const heard: Record<string, (payload: unknown) => void> = {};
  const listen = (event: string) => (cb: (payload: unknown) => void) => {
    heard[event] = cb;
    return Promise.resolve(() => {});
  };
  return {
    appCall: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    heard,
    listen,
  };
});

vi.mock("../../bindings", () => ({
  appCall: calls.appCall,
  onSettingsChanged: calls.listen("settings"),
  onAgentTabEvent: calls.listen("event"),
}));

import type { PaneNode } from "../contract";
import { agentTabIn, useAgentTabRefresh } from "./agentTab";

const tree: PaneNode = {
  kind: "split",
  id: "s",
  dir: "row",
  sizes: [1, 1],
  children: [
    { kind: "leaf", id: "p1", tabs: ["files-1"], activeTab: "files-1" },
    { kind: "leaf", id: "p2", tabs: ["term-1", "agent-1"], activeTab: "term-1" },
  ],
};

const instances = new Map([
  ["files-1", { appId: "files" }],
  ["term-1", { appId: "terminal" }],
  ["agent-1", { appId: "agent-tab" }],
]);

const asked = [
  "agent-tab",
  "agent-tab/harnesses",
  undefined,
  { clusterId: "c1", instanceId: "agent-1" },
];

beforeEach(() => {
  calls.appCall.mockReset().mockResolvedValue({});
  for (const event of Object.keys(calls.heard)) delete calls.heard[event];
});

describe("agentTabIn", () => {
  it("finds the cluster's agent tab in any pane", () => {
    expect(agentTabIn(tree, instances)).toBe("agent-1");
  });

  it("answers null when the cluster has none", () => {
    expect(agentTabIn(tree, new Map([["files-1", { appId: "files" }]]))).toBeNull();
  });
});

describe("useAgentTabRefresh", () => {
  it("asks as the agent tab when it mounts", () => {
    renderHook(() => useAgentTabRefresh("c1", "env", "agent-1"));
    expect(calls.appCall).toHaveBeenCalledWith(...asked);
  });

  it("asks nothing while the cluster has no agent tab", () => {
    renderHook(() => useAgentTabRefresh("c1", "env", null));
    expect(calls.appCall).not.toHaveBeenCalled();
  });

  // Developer mode turned on: the tab is never sent settings, so only this ask tells it.
  it("asks again when a setting changes", async () => {
    renderHook(() => useAgentTabRefresh("c1", "env", "agent-1"));
    await waitFor(() => expect(calls.heard.settings).toBeDefined());

    act(() => calls.heard.settings({ "developer.mode": true }));
    expect(calls.appCall).toHaveBeenCalledTimes(2);
    expect(calls.appCall).toHaveBeenLastCalledWith(...asked);
  });

  it("asks again when the cluster's environment changes", () => {
    const { rerender } = renderHook(({ env }) => useAgentTabRefresh("c1", env, "agent-1"), {
      initialProps: { env: "main" },
    });
    rerender({ env: "worktree" });
    expect(calls.appCall).toHaveBeenCalledTimes(2);
  });

  it("asks again when its tab's session starts or resets, not on every event", async () => {
    renderHook(() => useAgentTabRefresh("c1", "env", "agent-1"));
    await waitFor(() => expect(calls.heard.event).toBeDefined());

    act(() => calls.heard.event({ instanceId: "agent-1", event: { type: "message" } }));
    act(() => calls.heard.event({ instanceId: "agent-2", event: { type: "status" } }));
    expect(calls.appCall).toHaveBeenCalledTimes(1);

    act(() => calls.heard.event({ instanceId: "agent-1", event: { type: "status" } }));
    act(() => calls.heard.event({ instanceId: "agent-1", event: { type: "reset" } }));
    expect(calls.appCall).toHaveBeenCalledTimes(3);
  });

  it("stops asking once it unmounts", async () => {
    const { unmount } = renderHook(() => useAgentTabRefresh("c1", "env", "agent-1"));
    await waitFor(() => expect(calls.heard.settings).toBeDefined());
    unmount();

    act(() => calls.heard.settings({}));
    expect(calls.appCall).toHaveBeenCalledTimes(1);
  });
});
