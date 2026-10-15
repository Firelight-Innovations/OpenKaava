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
    open: vi.fn<(...args: unknown[]) => Promise<string>>(),
    activate: vi.fn<(id: string) => Promise<void>>(),
    appCall: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    heard,
    listen,
  };
});

vi.mock("../../bindings", () => ({
  openInstance: calls.open,
  activateInstance: calls.activate,
  appCall: calls.appCall,
  onSettingsChanged: calls.listen("settings"),
  onAgentTabChosen: calls.listen("chosen"),
  onAgentTabEvent: calls.listen("event"),
}));

import type { PaneNode } from "../contract";
import {
  agentBarShown,
  agentTabIn,
  chooseHarness,
  refusalCode,
  sendToAgent,
  useAgentBarStatus,
} from "./agentBar";

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

beforeEach(() => {
  calls.open.mockReset().mockResolvedValue("agent-new");
  calls.activate.mockReset().mockResolvedValue();
  calls.appCall.mockReset().mockResolvedValue({});
});

describe("agentTabIn", () => {
  it("finds the cluster's agent tab in any pane", () => {
    expect(agentTabIn(tree, instances)).toBe("agent-1");
  });

  it("answers null when the cluster has none", () => {
    expect(agentTabIn(tree, new Map([["files-1", { appId: "files" }]]))).toBeNull();
  });
});

describe("sendToAgent", () => {
  it("brings an existing agent tab forward and sends as it", async () => {
    await sendToAgent({ label: "main", tree, instances, paneId: "p1" }, "hi");
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.activate).toHaveBeenCalledWith("agent-1");
    expect(calls.appCall).toHaveBeenCalledWith(
      "agent-tab",
      "agent-tab/send",
      { text: "hi" },
      { instanceId: "agent-1" },
    );
  });

  it("opens an agent tab when there is none, then sends as the new one", async () => {
    const empty = new Map([["files-1", { appId: "files" }]]);
    await sendToAgent({ label: "main", tree, instances: empty, paneId: "p1", dir: "row" }, "hi");
    expect(calls.open).toHaveBeenCalledWith("main", "agent-tab", "p1", "row");
    expect(calls.appCall).toHaveBeenCalledWith(
      "agent-tab",
      "agent-tab/send",
      { text: "hi" },
      { instanceId: "agent-new" },
    );
  });

  it("chooses a harness picked in the bar before it sends", async () => {
    const empty = new Map([["files-1", { appId: "files" }]]);
    await sendToAgent({ label: "main", tree, instances: empty, paneId: "p1" }, "hi", "pi");
    expect(calls.appCall.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ["agent-tab/choose", { harness: "pi" }, { instanceId: "agent-new" }],
      ["agent-tab/send", { text: "hi" }, { instanceId: "agent-new" }],
    ]);
  });

  it("sends nothing when the tab refuses the harness", async () => {
    calls.appCall.mockRejectedValueOnce({ code: -32010, data: { code: "running" } });
    await expect(
      sendToAgent({ label: "main", tree, instances, paneId: null }, "hi", "pi"),
    ).rejects.toThrow("running");
    expect(calls.appCall).toHaveBeenCalledTimes(1);
  });

  it("rejects with the refusal code Rust sent", async () => {
    calls.appCall.mockRejectedValue({ code: -32010, message: "no", data: { code: "busy" } });
    await expect(
      sendToAgent({ label: "main", tree, instances, paneId: null }, "hi"),
    ).rejects.toThrow("busy");
  });
});

describe("chooseHarness", () => {
  it("chooses as the agent tab", async () => {
    await chooseHarness("agent-1", "pi");
    expect(calls.appCall).toHaveBeenCalledWith(
      "agent-tab",
      "agent-tab/choose",
      { harness: "pi" },
      { instanceId: "agent-1" },
    );
  });

  it("rejects with the refusal code Rust sent", async () => {
    calls.appCall.mockRejectedValue({ code: -32010, data: { code: "running" } });
    await expect(chooseHarness("agent-1", "pi")).rejects.toThrow("running");
  });
});

describe("useAgentBarStatus", () => {
  const answer = (current: string, extra: object = {}) => ({
    blocked: null,
    harnesses: [],
    current,
    ...extra,
  });

  it("asks about the agent tab, and fills what an older host leaves out", async () => {
    calls.appCall.mockResolvedValue(answer("claude"));
    const { result } = renderHook(() => useAgentBarStatus("c1", "env", "agent-1"));
    await waitFor(() => expect(result.current?.current).toBe("claude"));
    expect(calls.appCall).toHaveBeenCalledWith("agent-tab", "agent-tab/harnesses", undefined, {
      clusterId: "c1",
      instanceId: "agent-1",
    });
    expect(result.current).toMatchObject({ running: null, model: null });
  });

  it("asks about the cluster alone while it has no agent tab", async () => {
    calls.appCall.mockResolvedValue(answer("claude"));
    renderHook(() => useAgentBarStatus("c1", "env", null));
    await waitFor(() =>
      expect(calls.appCall).toHaveBeenCalledWith("agent-tab", "agent-tab/harnesses", undefined, {
        clusterId: "c1",
      }),
    );
  });

  it("asks again when its own tab chooses, and not for another tab", async () => {
    calls.appCall.mockResolvedValue(answer("claude"));
    const { result } = renderHook(() => useAgentBarStatus("c1", "env", "agent-1"));
    await waitFor(() => expect(result.current?.current).toBe("claude"));
    await waitFor(() => expect(calls.heard.chosen).toBeDefined());

    calls.appCall.mockResolvedValue(answer("pi"));
    act(() => calls.heard.chosen({ instanceId: "agent-2", harness: "pi" }));
    expect(calls.appCall).toHaveBeenCalledTimes(1);

    act(() => calls.heard.chosen({ instanceId: "agent-1", harness: "pi" }));
    await waitFor(() => expect(result.current?.current).toBe("pi"));
  });

  it("asks again when its tab's session starts or resets, not on every event", async () => {
    calls.appCall.mockResolvedValue(answer("claude"));
    const { result } = renderHook(() => useAgentBarStatus("c1", "env", "agent-1"));
    await waitFor(() => expect(result.current?.current).toBe("claude"));
    await waitFor(() => expect(calls.heard.event).toBeDefined());

    act(() => calls.heard.event({ instanceId: "agent-1", event: { type: "message" } }));
    expect(calls.appCall).toHaveBeenCalledTimes(1);

    calls.appCall.mockResolvedValue(answer("claude", { running: "claude", model: "Opus" }));
    act(() => calls.heard.event({ instanceId: "agent-1", event: { type: "status" } }));
    await waitFor(() => expect(result.current?.model).toBe("Opus"));
  });
});

describe("refusalCode", () => {
  it("answers failed for anything that is not a refusal", () => {
    expect(refusalCode(new Error("boom"))).toBe("failed");
    expect(refusalCode({ code: -32601, data: { code: "busy" } })).toBe("failed");
    expect(refusalCode(null)).toBe("failed");
  });

  it("names the shell's read-only refusal for what it is", () => {
    expect(refusalCode({ code: -32003, message: "main is read-only" })).toBe("mainCheckout");
    expect(refusalCode({ code: -32010, data: { code: "busy" } })).toBe("busy");
  });
});

describe("agentBarShown", () => {
  const blocked = (code: string | null) => ({
    blocked: code,
    harnesses: [],
    current: "claude",
    running: null,
    model: null,
  });

  it("shows the bar for a cluster that may run an agent, or may once it is a worktree", () => {
    expect(agentBarShown(blocked(null))).toBe(true);
    expect(agentBarShown(blocked("mainCheckout"))).toBe(true);
    expect(agentBarShown(blocked("notAWorktree"))).toBe(true);
  });

  it("keeps it shut until the answer is known, and while developer mode is off", () => {
    expect(agentBarShown(null)).toBe(false);
    expect(agentBarShown(blocked("developerMode"))).toBe(false);
  });
});
