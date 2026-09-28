import { describe, expect, it } from "vitest";
import type { Cluster } from "./contract";
import { DESIGN_WORKTREE_BRANCH, environmentKey, environmentOf } from "./environment";

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
      cluster({ worktree: { path: "/repo/.kaava/worktrees/flashlight", branch: "wt/flashlight-cone" } }),
    );
    expect(env).toEqual({
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/.kaava/worktrees/flashlight",
    });
  });

  it("reads the standing wt/design worktree as the design canvas", () => {
    const env = environmentOf(
      cluster({ worktree: { path: "/repo/.kaava/worktrees/design", branch: DESIGN_WORKTREE_BRANCH } }),
    );
    expect(env.kind).toBe("design");
  });

  it("drops the branch field for a detached HEAD rather than reporting null", () => {
    const env = environmentOf(cluster({ worktree: { path: "/repo/.kaava/worktrees/x", branch: null } }));
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
    const b = environmentOf(cluster({ id: "c2", worktree: { path: "/repo/wt/x", branch: "wt/x-renamed" } }));
    expect(environmentKey(a)).toBe(environmentKey(b));
  });

  it("keys two different worktree paths differently", () => {
    const a = environmentOf(cluster({ worktree: { path: "/repo/wt/a", branch: "wt/a" } }));
    const b = environmentOf(cluster({ worktree: { path: "/repo/wt/b", branch: "wt/b" } }));
    expect(environmentKey(a)).not.toBe(environmentKey(b));
  });
});
