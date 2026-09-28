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
    pinned: false,
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
        worktree: {
          path: "/repo/.kaava/worktrees/flashlight",
          branch: "wt/flashlight-cone",
          base: null,
        },
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
        worktree: {
          path: "/repo/.kaava/worktrees/design",
          branch: DESIGN_WORKTREE_BRANCH,
          base: null,
        },
      }),
    );
    expect(env.kind).toBe("design");
  });

  it("drops the branch field for a detached HEAD rather than reporting null", () => {
    const env = environmentOf(
      cluster({ worktree: { path: "/repo/.kaava/worktrees/x", branch: null, base: null } }),
    );
    expect(env.kind).toBe("worktree");
    expect(env.branch).toBeUndefined();
  });

  it("never derives cloud from the legacy fields — nothing in worktree names a session", () => {
    for (const worktree of [null, { path: "/a", branch: "wt/a", base: null }]) {
      expect(environmentOf(cluster({ worktree, environment: null })).kind).not.toBe("cloud");
    }
  });

  it("prefers cluster.environment over worktree when both are set", () => {
    const env = environmentOf(
      cluster({
        worktree: { path: "/repo/wt/legacy", branch: "wt/legacy", base: null },
        environment: {
          kind: "localWorktree",
          name: "flashlight",
          path: "/repo/wt/flashlight",
          branch: "wt/flashlight-cone",
          base: "main",
        },
      }),
    );
    expect(env).toEqual({
      kind: "worktree",
      branch: "wt/flashlight-cone",
      base: "main",
      path: "/repo/wt/flashlight",
    });
  });

  it("reads a cloud environment only from cluster.environment", () => {
    const env = environmentOf(
      cluster({
        environment: {
          kind: "cloud",
          sessionId: "job-7f3a",
          vm: "agent/anom-142",
          branch: "wt/anomaly",
        },
      }),
    );
    expect(env).toEqual({
      kind: "cloud",
      sessionId: "job-7f3a",
      vm: "agent/anom-142",
      branch: "wt/anomaly",
    });
  });

  it("falls back to worktree derivation when environment is absent or null", () => {
    const withoutField = environmentOf(
      cluster({ worktree: { path: "/repo/wt/x", branch: "wt/x", base: null } }),
    );
    expect(withoutField.kind).toBe("worktree");

    const withNull = environmentOf(
      cluster({ worktree: { path: "/repo/wt/x", branch: "wt/x", base: null }, environment: null }),
    );
    expect(withNull.kind).toBe("worktree");
  });
});

describe("environmentKey", () => {
  it("gives every main environment the same key", () => {
    expect(environmentKey({ kind: "main" })).toBe(environmentKey({ kind: "main" }));
  });

  it("keys two clusters on the same worktree path identically", () => {
    const a = environmentOf(
      cluster({ worktree: { path: "/repo/wt/x", branch: "wt/x", base: null } }),
    );
    const b = environmentOf(
      cluster({ id: "c2", worktree: { path: "/repo/wt/x", branch: "wt/x-renamed", base: null } }),
    );
    expect(environmentKey(a)).toBe(environmentKey(b));
  });

  it("keys two different worktree paths differently", () => {
    const a = environmentOf(
      cluster({ worktree: { path: "/repo/wt/a", branch: "wt/a", base: null } }),
    );
    const b = environmentOf(
      cluster({ worktree: { path: "/repo/wt/b", branch: "wt/b", base: null } }),
    );
    expect(environmentKey(a)).not.toBe(environmentKey(b));
  });
});
