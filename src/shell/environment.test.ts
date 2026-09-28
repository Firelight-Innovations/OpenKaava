import { describe, expect, it } from "vitest";
import { environmentOf, sameEnvironment } from "./environment";
import type { Cluster } from "./contract";

function cluster(over: Partial<Cluster>): Cluster {
  return {
    id: "cluster-1",
    name: "Flashlight",
    tree: { kind: "leaf", id: "pane-1", tabs: [], activeTab: null },
    project: null,
    worktree: null,
    activeTerminal: null,
    bandHeight: null,
    ...over,
  };
}

describe("environmentOf", () => {
  it("is the worktree path when the cluster has one", () => {
    const c = cluster({
      project: "/repo",
      worktree: { path: "/repo/../.worktrees/repo/flashlight-cone", branch: "wt/flashlight-cone" },
    });
    expect(environmentOf(c)).toBe("/repo/../.worktrees/repo/flashlight-cone");
  });

  it("falls back to the project folder with no worktree", () => {
    expect(environmentOf(cluster({ project: "/repo" }))).toBe("/repo");
  });

  it("is null for a cluster pointed at nothing yet", () => {
    expect(environmentOf(cluster({}))).toBeNull();
  });
});

describe("sameEnvironment", () => {
  it("is true for two clusters checked out at the same place", () => {
    const a = cluster({ id: "a", project: "/repo" });
    const b = cluster({ id: "b", project: "/repo" });
    expect(sameEnvironment(a, b)).toBe(true);
  });

  it("is false for two different worktrees of the same repo", () => {
    const a = cluster({ id: "a", project: "/repo", worktree: { path: "/wt/one", branch: null } });
    const b = cluster({ id: "b", project: "/repo", worktree: { path: "/wt/two", branch: null } });
    expect(sameEnvironment(a, b)).toBe(false);
  });

  /** Nowhere is not a place two clusters can share — see the function's own
   *  doc comment for why this is refused rather than allowed. */
  it("is false for two clusters that both have no project yet", () => {
    const a = cluster({ id: "a" });
    const b = cluster({ id: "b" });
    expect(sameEnvironment(a, b)).toBe(false);
  });

  it("is false against null", () => {
    expect(sameEnvironment(cluster({ project: "/repo" }), null)).toBe(false);
    expect(sameEnvironment(null, cluster({ project: "/repo" }))).toBe(false);
  });
});
