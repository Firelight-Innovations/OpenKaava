import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  open: vi.fn<(...args: unknown[]) => Promise<string>>(),
  activate: vi.fn<(id: string) => Promise<void>>(),
  appCall: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../../bindings", () => ({
  openInstance: calls.open,
  activateInstance: calls.activate,
  appCall: calls.appCall,
  onSettingsChanged: () => Promise.resolve(() => {}),
}));

import type { PaneNode } from "../contract";
import { agentTabIn, refusalCode, sendToAgent } from "./agentBar";

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
      { harness: "claude", text: "hi" },
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
      { harness: "claude", text: "hi" },
      { instanceId: "agent-new" },
    );
  });

  it("rejects with the refusal code Rust sent", async () => {
    calls.appCall.mockRejectedValue({ code: -32010, message: "no", data: { code: "busy" } });
    await expect(
      sendToAgent({ label: "main", tree, instances, paneId: null }, "hi"),
    ).rejects.toThrow("busy");
  });
});

describe("refusalCode", () => {
  it("answers failed for anything that is not a refusal", () => {
    expect(refusalCode(new Error("boom"))).toBe("failed");
    expect(refusalCode({ code: -32601, data: { code: "busy" } })).toBe("failed");
    expect(refusalCode(null)).toBe("failed");
  });
});
