import { describe, expect, it } from "vitest";
import type { Cluster } from "../bindings";
import { environmentOf } from "./environment";

function cluster(overrides: Partial<Cluster>): Cluster {
  return {
    id: "cluster-1",
    name: "cluster-1",
    tree: { kind: "leaf", id: "pane-1", tabs: [], activeTab: null },
    project: null,
    worktree: null,
    activeTerminal: null,
    bandHeight: null,
    pinned: false,
    ...overrides,
  };
}

describe("environmentOf", () => {
  it("is null for a cluster with no environment and no legacy worktree", () => {
    expect(environmentOf(cluster({}))).toBeNull();
  });

  it("reads a local worktree's branch as its label", () => {
    const display = environmentOf(
      cluster({
        environment: {
          kind: "localWorktree",
          name: "feat-x",
          path: "C:/proj/.kaava/worktrees/feat-x",
          branch: "wt/feat-x",
          base: "main",
        },
      }),
    );
    expect(display).toEqual({ label: "wt/feat-x", branch: "wt/feat-x", readOnly: false });
  });

  it("marks Main as read-only with no branch to show", () => {
    const display = environmentOf(cluster({ environment: { kind: "main" } }));
    expect(display).toEqual({ label: "Main", branch: null, readOnly: true });
  });

  it("falls back to the legacy worktree field when environment is unset", () => {
    const display = environmentOf(
      cluster({ worktree: { path: "C:/old-worktree", branch: "feat-x", base: null } }),
    );
    expect(display).toEqual({ label: "feat-x", branch: "feat-x", readOnly: false });
  });

  it("labels a design environment as Design", () => {
    const display = environmentOf(
      cluster({
        environment: {
          kind: "design",
          path: "C:/proj/.kaava/worktrees/design",
          branch: "wt/design",
        },
      }),
    );
    expect(display).toEqual({ label: "Design", branch: "wt/design", readOnly: false });
  });

  it("falls back to the vm id when a cloud session has no branch yet", () => {
    const display = environmentOf(
      cluster({
        environment: { kind: "cloud", sessionId: "s1", vm: "vm-1", branch: null },
      }),
    );
    expect(display).toEqual({ label: "vm-1", branch: null, readOnly: false });
  });
});
