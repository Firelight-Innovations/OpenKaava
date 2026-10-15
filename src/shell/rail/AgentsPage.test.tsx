// @vitest-environment jsdom
/**
 * The Agents page: each cluster's sessions with their live state, a row that
 * opens its tab, and a `+` that opens a new one in that cluster.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentCluster, AgentSession } from "../state/agentSessions";
import AgentsPage from "./AgentsPage";

afterEach(cleanup);

const CLUSTERS: AgentCluster[] = [
  {
    id: "c1",
    name: "api",
    tabs: [
      { id: "a1", title: "Agent" },
      { id: "a2", title: "Agent" },
    ],
  },
  { id: "c2", name: "web", tabs: [] },
];

const SESSIONS = new Map<string, AgentSession>([
  ["a1", { state: "working", harness: "claude", prompt: "Fix the session expiry check" }],
  ["a2", { state: "needsInput", harness: "codex", prompt: "Run the migrations" }],
]);

function draw(overrides: Partial<Parameters<typeof AgentsPage>[0]> = {}) {
  const onOpen = vi.fn();
  const onNew = vi.fn();
  render(
    <AgentsPage
      clusters={CLUSTERS}
      sessions={SESSIONS}
      activeClusterId="c1"
      onOpen={onOpen}
      onNew={onNew}
      {...overrides}
    />,
  );
  return { onOpen, onNew };
}

describe("AgentsPage", () => {
  it("lists each cluster's sessions by their latest prompt, with harness and state", () => {
    draw();
    const api = screen.getByRole("region", { name: "api" });
    const rows = within(api).getAllByRole("button", { name: /·/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      "Fix the session expiry checkClaude · Working",
      "Run the migrationsCodex · Needs you",
    ]);
    expect(rows[1].getAttribute("data-state")).toBe("needsInput");
    expect(within(api).getByText("Current cluster")).not.toBeNull();
  });

  it("says a cluster has no sessions rather than leaving it blank", () => {
    draw();
    const web = screen.getByRole("region", { name: "web" });
    expect(within(web).getByText("No agent sessions")).not.toBeNull();
    expect(within(web).queryByText("Current cluster")).toBeNull();
  });

  it("shows a tab that never sent a prompt as not started, under its title", () => {
    draw({ sessions: new Map() });
    const rows = within(screen.getByRole("region", { name: "api" })).getAllByRole("button", {
      name: /Not started/,
    });
    expect(rows[0].textContent).toBe("AgentNot started");
  });

  it("opens a session's tab, and a new session in the cluster whose + was pressed", () => {
    const { onOpen, onNew } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Run the migrations/ }));
    expect(onOpen).toHaveBeenCalledWith("a2");
    fireEvent.click(screen.getByRole("button", { name: "New agent session in web" }));
    expect(onNew).toHaveBeenCalledWith("c2");
  });
});
