/**
 * The Agents page's row and `+`: which cluster comes forward, and which tab
 * the window is told to focus once it is drawn.
 */
import { describe, expect, it, vi } from "vitest";
import { emptyAgentTab, newAgent, openAgent, resumeAgent, type AgentOpeners } from "./agentOpeners";
import type { AgentSession } from "./agentSessions";

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
    resume: vi.fn(
      async (tab: string, session: string) => void calls.push(`resume ${session} in ${tab}`),
    ),
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

describe("resumeAgent", () => {
  it("opens the saved session in the cluster's empty agent tab, brought forward", async () => {
    const { w, calls } = window();
    await resumeAgent(w, "s1", "a3");
    expect(calls).toEqual(["hide", "focus a3", "activate a3", "resume s1 in a3"]);
    expect(w.openInstance).not.toHaveBeenCalled();
  });

  it("opens a new agent tab beside the active pane when none is empty", async () => {
    const { w, calls } = window();
    await resumeAgent(w, "s1", null);
    expect(calls).toEqual(["hide", "open agent-tab p2", "focus new-tab", "resume s1 in new-tab"]);
  });

  it("reports a session that could not be opened", async () => {
    const { w } = window({ resume: () => Promise.reject(new Error("busy")) });
    await resumeAgent(w, "s1", "a3");
    expect(w.report).toHaveBeenCalled();
  });
});

describe("emptyAgentTab", () => {
  const cluster = {
    id: "c1",
    name: "api",
    tabs: [
      { id: "a1", title: "Agent" },
      { id: "a2", title: "Agent" },
      { id: "a3", title: "Agent" },
    ],
  };

  it("picks the first tab that never sent a prompt", () => {
    const sessions = new Map<string, AgentSession>([
      ["a1", { state: "ready", harness: "claude", prompt: "Fix it" }],
      // Restored from history: no live agent, but a conversation all the same.
      ["a2", { state: "none", harness: null, prompt: "An old question" }],
    ]);
    expect(emptyAgentTab(cluster, sessions)).toBe("a3");
  });

  it("has none to offer when every tab is in use, or there is no cluster", () => {
    const busy: AgentSession = { state: "working", harness: "codex", prompt: "Go" };
    const sessions = new Map(cluster.tabs.map((tab) => [tab.id, busy]));
    expect(emptyAgentTab(cluster, sessions)).toBeNull();
    expect(emptyAgentTab(undefined, new Map())).toBeNull();
  });
});
