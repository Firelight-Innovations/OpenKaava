// @vitest-environment jsdom
/** The cluster switcher pill is always on the title bar, with zero clusters and with one. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Cluster } from "../contract";

vi.mock("./MenuBar", () => ({ default: () => null }));
vi.mock("./HamburgerMenu", () => ({ default: () => null }));
vi.mock("./WindowControls", () => ({ default: () => null }));
vi.mock("./useNarrowTitlebar", () => ({ useNarrowTitlebar: () => false }));

import TitleBar from "./TitleBar";

afterEach(cleanup);

const handlers = () => ({
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNewCluster: vi.fn(),
  onNewWorktreeCluster: vi.fn(),
  onSwitchProject: vi.fn(),
  onHome: vi.fn(),
});

function mount(clusters: Cluster[], project: string | null) {
  const h = handlers();
  render(
    <TitleBar
      kind="main"
      project={project}
      environment={null}
      environmentLabel={null}
      environmentCount={0}
      menus={[]}
      switcher={{
        clusters,
        activeClusterId: clusters[0]?.id ?? null,
        ahead: 0,
        behind: 0,
        terminals: [],
        ...h,
      }}
    />,
  );
  return h;
}

const one = {
  id: "a",
  name: "one",
  tree: { kind: "leaf", tabs: [], active: null },
  project: "C:/p",
  worktree: null,
  activeTerminal: null,
  bandHeight: null,
  pinned: false,
} as unknown as Cluster;

describe("the cluster switcher pill", () => {
  it("is drawn with no project and no clusters, and can start one", () => {
    const h = mount([], null);
    fireEvent.click(screen.getByRole("button", { name: /^Switch cluster/ }));
    expect(screen.getByText("This window has no clusters yet.")).toBeTruthy();
    fireEvent.click(screen.getByText("New cluster…"));
    expect(h.onNewCluster).toHaveBeenCalled();
  });

  it("is drawn with a single cluster", () => {
    mount([one], "proj");
    expect(screen.getByRole("button", { name: /^Switch cluster/ })).toBeTruthy();
  });
});
