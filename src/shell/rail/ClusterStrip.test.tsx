// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Cluster } from "../contract";
import ClusterStrip, { type ClusterStripProps } from "./ClusterStrip";

afterEach(cleanup);

function cluster(id: string, name: string, over: Partial<Cluster> = {}): Cluster {
  return {
    id,
    name,
    tree: { kind: "leaf", tabs: [], active: null } as unknown as Cluster["tree"],
    project: "C:/code/openkaava",
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
    expect(screen.getByRole("button", { name: /^godot-port/ }).textContent).toBe("GP");
  });

  it("names each badge for the cluster and gives project · branch as the tooltip", () => {
    setup();
    const badge = screen.getByRole("button", { name: /^billing/ });
    expect(badge.getAttribute("title")).toBe("openkaava · feat/billing");
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

  it("hands the drag handle's pointer-down to the badge", () => {
    const onPointerDown = vi.fn();
    setup({ dragHandleForCluster: () => ({ onPointerDown, style: { cursor: "grab" } }) });
    fireEvent.pointerDown(screen.getByRole("button", { name: /^billing/ }));
    expect(onPointerDown).toHaveBeenCalled();
  });
});
