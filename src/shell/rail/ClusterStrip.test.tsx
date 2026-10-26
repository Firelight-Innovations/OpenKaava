// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Cluster } from "../contract";
import ClusterStrip, { type ClusterStripProps } from "./ClusterStrip";

afterEach(cleanup);

function cluster(id: string, name: string, over: Partial<Cluster> = {}): Cluster {
  return {
    id,
    name,
    tree: { kind: "leaf", tabs: [], active: null } as unknown as Cluster["tree"],
    project: "C:/code/veistra",
    worktree: { path: `C:/wt/${name}`, branch: `feat/${name}`, base: "main" },
    activeTerminal: null,
    bandHeight: null,
    pinned: false,
    ...over,
  };
}

const CLUSTERS = [cluster("a", "auth"), cluster("b", "billing"), cluster("c", "godot-port")];

function setup(over: Partial<ClusterStripProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <ClusterStrip clusters={CLUSTERS} activeClusterId="a" terminals={[]} {...handlers} {...over} />,
  );
  return handlers;
}

describe("ClusterStrip", () => {
  it("draws one badge per cluster, in a navigation landmark of its own", () => {
    setup();
    const nav = screen.getByRole("navigation", { name: "Clusters" });
    expect(nav.querySelectorAll(".clusterstrip__badge")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: /^godot-port/ }).querySelector(".cluster-chip")
        ?.textContent,
    ).toBe("GP");
  });

  it("names each badge for the cluster and gives project · branch as the tooltip", () => {
    setup();
    const badge = screen.getByRole("button", { name: /^billing/ });
    expect(badge.getAttribute("title")).toBe("veistra · feat/billing");
  });

  it("marks the open cluster with aria-current and nothing else", () => {
    setup();
    expect(screen.getByRole("button", { name: /^auth/ }).getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("button", { name: /^billing/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("switches on click, using the same handler as the old tab", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /^billing/ }));
    expect(h.onSelect).toHaveBeenCalledWith("b");
  });

  it("adds a cluster from the plus", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "New cluster" }));
    expect(h.onAdd).toHaveBeenCalledTimes(1);
  });

  it("dots only a background cluster whose agent finished", () => {
    setup({
      terminals: [
        { clusterId: "b", agentFinished: true },
        { clusterId: "a", agentFinished: true },
      ],
    });
    const dots = document.querySelectorAll(".clusterstrip__dot");
    expect(dots).toHaveLength(1);
    expect(dots[0].closest("button")?.getAttribute("data-cluster-id")).toBe("b");
  });

  it("flags a cluster whose worktree folder is missing", () => {
    setup({ clusters: [cluster("a", "auth", { environmentMissing: true })] });
    expect(document.querySelector(".clusterstrip__warn")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^auth/ }).getAttribute("title")).toContain(
      "missing",
    );
  });

  it("opens a menu with switch, rename and close on right-click", () => {
    const h = setup();
    const badge = screen.getByRole("button", { name: /^billing/ });
    // `false` means preventDefault was called, which is what makes the shell's own
    // edit menu stand down.
    expect(fireEvent.contextMenu(badge, { clientX: 10, clientY: 10 })).toBe(false);

    expect(screen.getByRole("menu", { name: "billing actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close cluster" }));
    expect(h.onClose).toHaveBeenCalledWith("b");
  });

  it("draws the chosen emoji in place of the initials, and only for that cluster", () => {
    setup({
      clusters: [
        cluster("a", "auth", { icon: { emoji: "🚀", color: "blue" } }),
        cluster("b", "billing"),
      ],
    });
    const withIcon = screen.getByRole("button", { name: /^auth/ });
    expect(withIcon.querySelector(".cluster-chip")?.textContent).toBe("🚀");
    expect(withIcon.querySelector(".cluster-chip")?.getAttribute("data-kind")).toBe("emoji");
    expect(withIcon.querySelector(".cluster-chip")?.getAttribute("data-icon-color")).toBe("blue");
    expect(
      screen.getByRole("button", { name: /^billing/ }).querySelector(".cluster-chip")?.textContent,
    ).toBe("BI");
  });

  it("puts Change icon… in the right-click menu when a picker is wired", () => {
    const onChangeIcon = vi.fn();
    setup({ onChangeIcon });
    fireEvent.contextMenu(screen.getByRole("button", { name: /^billing/ }), {
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Change icon…" }));
    expect(onChangeIcon).toHaveBeenCalledWith("b");
  });

  it("hands the drag handle's pointer-down to the badge", () => {
    const onPointerDown = vi.fn();
    setup({ dragHandleForCluster: () => ({ onPointerDown, style: { cursor: "grab" } }) });
    fireEvent.pointerDown(screen.getByRole("button", { name: /^billing/ }));
    expect(onPointerDown).toHaveBeenCalled();
  });

  it("lists each cluster's open agents under its row and opens one on click", () => {
    const onOpenAgent = vi.fn();
    setup({
      onOpenAgent,
      agents: new Map([
        [
          "a",
          [
            { id: "agent-1", label: "Hammer fling", state: "working" as const },
            { id: "agent-2", label: "Uppercut", state: "ready" as const },
          ],
        ],
      ]),
    });
    const list = screen.getByRole("list", { name: "auth agents" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.queryByRole("list", { name: "billing agents" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Uppercut" }));
    expect(onOpenAgent).toHaveBeenCalledWith("agent-2");
  });

  it("opens the agent menu on right-click of an agent row, and runs a live row on it", async () => {
    const close = vi.fn();
    setup({
      agents: new Map([
        ["a", [{ id: "agent-1", label: "Hammer fling", state: "working" as const }]],
      ]),
      agentMenu: { close },
    });
    expect(fireEvent.contextMenu(screen.getByRole("button", { name: "Hammer fling" }))).toBe(false);
    expect(screen.getByRole("menu", { name: "Agent actions" })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork Chat" }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(close).toHaveBeenCalledWith("agent-1");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Agent actions" })).toBeNull());
  });

  it("shows each cluster's branch beside its name", () => {
    setup();
    expect(screen.getByRole("button", { name: /^billing/ }).textContent).toContain("feat/billing");
  });

  it("folds away from its own button, and marks itself collapsed when told to", () => {
    const onToggleCollapsed = vi.fn();
    setup({ onToggleCollapsed });
    fireEvent.click(screen.getByRole("button", { name: "Hide clusters" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ collapsed: true, onToggleCollapsed });
    expect(document.querySelector(".clusterstrip")?.hasAttribute("data-collapsed")).toBe(true);
  });
});
