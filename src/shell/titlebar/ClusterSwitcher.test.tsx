// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Cluster } from "../contract";
import ClusterSwitcher, { divergence, type ClusterSwitcherProps } from "./ClusterSwitcher";

afterEach(cleanup);

function cluster(
  id: string,
  name: string,
  branch: string | null,
  over: Partial<Cluster> = {},
): Cluster {
  return {
    id,
    name,
    tree: { kind: "leaf", tabs: [], active: null } as unknown as Cluster["tree"],
    project: "C:/code/openkaava",
    worktree: branch ? { path: `C:/wt/${name}`, branch, base: "main" } : null,
    activeTerminal: null,
    bandHeight: null,
    pinned: false,
    ...over,
  };
}

const CLUSTERS = [
  cluster("a", "auth", "feat/auth"),
  cluster("b", "billing", "feat/billing"),
  cluster("c", "main-view", null),
];

function setup(over: Partial<ClusterSwitcherProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNewCluster: vi.fn(),
    onNewWorktreeCluster: vi.fn(),
    onSwitchProject: vi.fn(),
    onHome: vi.fn(),
  };
  render(
    <ClusterSwitcher
      project="OpenKaava"
      environment={{ kind: "worktree", branch: "feat/auth" }}
      environmentLabel="auth"
      environmentCount={3}
      clusters={CLUSTERS}
      activeClusterId="a"
      ahead={2}
      behind={1}
      terminals={[]}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

const pill = () => screen.getByRole("button", { name: /^Switch cluster/ });

describe("ClusterSwitcher", () => {
  it("is a named pill that reports whether its list is open", () => {
    setup();
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pill());
    expect(pill().getAttribute("aria-expanded")).toBe("true");
  });

  it("lists every cluster with its branch, marking the open one", () => {
    setup();
    fireEvent.click(pill());
    const list = screen.getByRole("listbox", { name: "Clusters" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(within(options[0]).getByText("feat/auth")).toBeTruthy();
    expect(within(options[1]).getByText("feat/billing")).toBeTruthy();
    expect(within(options[2]).getByText("default branch")).toBeTruthy();
    expect(within(options[2]).getByText("main")).toBeTruthy();
  });

  it("shows ahead/behind for the open cluster only, and each row's Ctrl+N", () => {
    setup();
    fireEvent.click(pill());
    const options = screen.getAllByRole("option");
    expect(within(options[0]).getByText("↑2 ↓1")).toBeTruthy();
    expect(within(options[1]).queryByText(/↑|↓/)).toBeNull();
    expect(within(options[1]).getByText("Ctrl+2")).toBeTruthy();
  });

  it("puts focus on the open cluster and moves it with the arrow keys", () => {
    setup();
    fireEvent.click(pill());
    const options = screen.getAllByRole("option");
    const last = () => screen.getByRole("button", { name: /Switch project/ });
    expect(document.activeElement).toBe(options[0]);

    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1], { key: "End" });
    expect(document.activeElement).toBe(last());
    fireEvent.keyDown(last(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(last());
  });

  it("switches on click, closes, and does not re-select the open one", async () => {
    const h = setup();
    fireEvent.click(pill());
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(h.onSelect).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());

    fireEvent.click(pill());
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(h.onSelect).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and hands focus back to the pill", async () => {
    setup();
    fireEvent.click(pill());
    fireEvent.keyDown(screen.getAllByRole("option")[0], { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(pill());
  });

  it("offers the new-cluster, new-worktree, home and switch-project actions", async () => {
    const h = setup();
    for (const [name, handler] of [
      [/New cluster/, h.onNewCluster],
      [/New worktree cluster/, h.onNewWorktreeCluster],
      [/Show Home/, h.onHome],
      [/Switch project/, h.onSwitchProject],
    ] as const) {
      fireEvent.click(pill());
      fireEvent.click(screen.getByRole("button", { name }));
      expect(handler).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  it("closes a cluster from its row without switching to it", () => {
    const h = setup();
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole("button", { name: "Close billing" }));
    expect(h.onClose).toHaveBeenCalledWith("b");
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("marks a background cluster whose agent finished", () => {
    setup({ terminals: [{ clusterId: "b", agentFinished: true }] });
    fireEvent.click(pill());
    const options = screen.getAllByRole("option");
    expect(within(options[1]).getByRole("img", { name: /agent finished/ })).toBeTruthy();
    expect(within(options[0]).queryByRole("img")).toBeNull();
  });

  it("stays usable with no project: the pill still opens the list", () => {
    setup({ project: null, environment: null, environmentLabel: null });
    fireEvent.click(pill());
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});

describe("divergence", () => {
  it("is empty when level or unknown", () => {
    expect(divergence(0, 0)).toBeNull();
    expect(divergence()).toBeNull();
    expect(divergence(3)).toBe("↑3");
    expect(divergence(0, 4)).toBe("↓4");
  });
});
