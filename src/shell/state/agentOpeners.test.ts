/**
 * The Agents page's row and `+`: which cluster comes forward, and which tab
 * the window is told to focus once it is drawn.
 */
import { describe, expect, it, vi } from "vitest";
import { newAgent, openAgent, type AgentOpeners } from "./agentOpeners";

function window(over: Partial<AgentOpeners> = {}) {
  const calls: string[] = [];
  const w: AgentOpeners = {
    label: "main",
    activeClusterId: "c1",
    activePaneId: "p2",
    hideTakeover: vi.fn(() => void calls.push("hide")),
    focusWhenShown: vi.fn((id: string) => void calls.push(`focus ${id}`)),
    activateInstance: vi.fn(async (id: string) => void calls.push(`activate ${id}`)),
    setActiveCluster: vi.fn(async (_: string, id: string) => void calls.push(`cluster ${id}`)),
    openInstance: vi.fn(async (_: string, app: string, pane?: string) => {
      calls.push(`open ${app} ${pane ?? "-"}`);
      return "new-tab";
    }),
    splitDirOnOpen: vi.fn(() => "row" as const),
    report: vi.fn(),
    ...over,
  };
  return { w, calls };
}

describe("openAgent", () => {
  it("brings a tab in another cluster forward, and focuses the pane holding it", async () => {
    const { w, calls } = window();
    await openAgent(w, "a9");
    expect(calls).toEqual(["hide", "focus a9", "activate a9"]);
  });

  it("reports a tab that cannot be brought forward", async () => {
    const { w } = window({ activateInstance: () => Promise.reject(new Error("gone")) });
    await openAgent(w, "a9");
    expect(w.report).toHaveBeenCalled();
  });
});

describe("newAgent", () => {
  it("opens beside the active pane in the cluster on screen, and focuses it", async () => {
    const { w, calls } = window();
    await newAgent(w, "c1");
    expect(calls).toEqual(["hide", "open agent-tab p2", "focus new-tab"]);
    expect(w.setActiveCluster).not.toHaveBeenCalled();
  });

  it("brings another cluster forward first, then opens there and focuses it", async () => {
    const { w, calls } = window();
    await newAgent(w, "c2");
    expect(calls).toEqual(["hide", "cluster c2", "open agent-tab -", "focus new-tab"]);
  });

  it("reports a failed open rather than leaving it unhandled", async () => {
    const { w } = window({ setActiveCluster: () => Promise.reject(new Error("no")) });
    await newAgent(w, "c2");
    expect(w.report).toHaveBeenCalled();
    expect(w.openInstance).not.toHaveBeenCalled();
  });
});
