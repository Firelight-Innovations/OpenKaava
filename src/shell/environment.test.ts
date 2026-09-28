import { describe, expect, it } from "vitest";
import type { Cluster } from "./contract";
import {
  DESIGN_WORKTREE_BRANCH,
  environmentKey,
  environmentOf,
  sameEnvironment,
} from "./environment";

function cluster(overrides: Partial<Cluster>): Cluster {
  return {
    id: "c1",
    name: "Flashlight",
    tree: { kind: "leaf", id: "p1", tabs: [], activeTab: null },
    project: "anomaly",
    worktree: null,
    activeTerminal: null,
    bandHeight: null,
    ...overrides,
  };
}

describe("environmentOf", () => {
  it("reads a cluster with no worktree as main, read-only", () => {
    expect(environmentOf(cluster({ worktree: null }))).toEqual({ kind: "main" });
  });

  it("reads a checked-out worktree as a worktree environment", () => {
    const env = environmentOf(
      cluster({
        worktree: { path: "/repo/.kaava/worktrees/flashlight", branch: "wt/flashlight-cone" },
      }),
    );
    expect(env).toEqual({
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/.kaava/worktrees/flashlight",
    });
  });

  it("reads the standing wt/design worktree as the design canvas", () => {
    const env = environmentOf(
      cluster({
        worktree: { path: "/repo/.kaava/worktrees/design", branch: DESIGN_WORKTREE_BRANCH },
      }),
    );
    expect(env.kind).toBe("design");
  });

  it("drops the branch field for a detached HEAD rather than reporting null", () => {
    const env = environmentOf(
      cluster({ worktree: { path: "/repo/.kaava/worktrees/x", branch: null } }),
    );
    expect(env.kind).toBe("worktree");
    expect(env.branch).toBeUndefined();
  });

  it("never derives cloud — nothing in Cluster names a session yet", () => {
    for (const worktree of [null, { path: "/a", branch: "wt/a" }]) {
      expect(environmentOf(cluster({ worktree })).kind).not.toBe("cloud");
    }
  });
});

describe("environmentKey", () => {
  it("gives every main environment the same key", () => {
    expect(environmentKey({ kind: "main" })).toBe(environmentKey({ kind: "main" }));
  });

  it("keys two clusters on the same worktree path identically", () => {
    const a = environmentOf(cluster({ worktree: { path: "/repo/wt/x", branch: "wt/x" } }));
    const b = environmentOf(
      cluster({ id: "c2", worktree: { path: "/repo/wt/x", branch: "wt/x-renamed" } }),
    );
    expect(environmentKey(a)).toBe(environmentKey(b));
  });

  it("keys two different worktree paths differently", () => {
    const a = environmentOf(cluster({ worktree: { path: "/repo/wt/a", branch: "wt/a" } }));
    const b = environmentOf(cluster({ worktree: { path: "/repo/wt/b", branch: "wt/b" } }));
    expect(environmentKey(a)).not.toBe(environmentKey(b));
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

  it("is false for a main cluster against a different project's main cluster", () => {
    // The case `environmentKey` alone would get wrong — see `sameEnvironment`'s
    // own doc comment for why it is built on `clusterRoot` instead.
    const a = cluster({ id: "a", project: "/repo-one" });
    const b = cluster({ id: "b", project: "/repo-two" });
    expect(sameEnvironment(a, b)).toBe(false);
  });

  it("is false for two clusters that both have no project yet", () => {
    // Nowhere is not a place two clusters can share — see the function's own
    // doc comment for why this is refused rather than allowed.
    const a = cluster({ id: "a", project: null });
    const b = cluster({ id: "b", project: null });
    expect(sameEnvironment(a, b)).toBe(false);
  });

  it("is false against null", () => {
    expect(sameEnvironment(cluster({ project: "/repo" }), null)).toBe(false);
    expect(sameEnvironment(null, cluster({ project: "/repo" }))).toBe(false);
  });
});
