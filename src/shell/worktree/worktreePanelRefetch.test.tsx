// @vitest-environment jsdom
/**
 * The graph must follow the cluster. A cluster repointed at another project
 * keeps its id, and the graph kept drawing the old project's commits until
 * the panel was closed and reopened while the branch picker had already moved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  GitCommit,
  GitControl,
  ReviewControl,
  ReviewSend,
  WorktreeControl,
} from "../contract";
import type { GitStatusHandle } from "./useGitStatus";
import WorktreePanel from "./WorktreePanel";

vi.mock("./SourceControlView", () => ({ default: () => null }));

afterEach(cleanup);

function commit(sha: string, summary: string): GitCommit {
  return { sha, short: sha, summary, author: "a", when: 0, parents: [], refs: [] };
}

function controlWith(graph: WorktreeControl["graph"]): WorktreeControl {
  return {
    list: async () => [],
    graph,
    branches: async () => [],
    divergence: async () => null,
  } as unknown as WorktreeControl;
}

const HANDLE: GitStatusHandle = { status: null, loading: false, error: null, refresh: () => {} };

function panel(control: WorktreeControl, root: string, git: GitStatusHandle = HANDLE) {
  return (
    <WorktreePanel
      clusterId="c1"
      worktreeControl={control}
      gitControl={{} as GitControl}
      reviewControl={{} as ReviewControl}
      reviewSend={(() => {}) as unknown as ReviewSend}
      git={git}
      activeBranch={null}
      root={root}
    />
  );
}

describe("WorktreePanel graph refetch", () => {
  it("re-reads the history when the cluster's root changes", async () => {
    const graph = vi.fn(async () => [commit("aaa", "demo commit")]);
    const control = controlWith(graph);
    const { rerender } = render(panel(control, "demo-game"));
    await screen.findByText("demo commit");

    graph.mockImplementation(async () => [commit("bbb", "orchestrator commit")]);
    rerender(panel(control, "orchestrator"));

    await screen.findByText("orchestrator commit");
    expect(screen.queryByText("demo commit")).toBeNull();
    expect(graph).toHaveBeenCalledTimes(2);
  });

  it("re-reads the history when a status refresh lands", async () => {
    const graph = vi.fn(async () => [commit("aaa", "one")]);
    const control = controlWith(graph);
    const { rerender } = render(panel(control, "p"));
    await screen.findByText("one");

    graph.mockImplementation(async () => [commit("bbb", "two")]);
    rerender(panel(control, "p", { ...HANDLE, status: { branch: "x" } as never }));

    await screen.findByText("two");
  });

  it("drops a slow answer for the old project", async () => {
    let releaseOld: (c: GitCommit[]) => void = () => {};
    const graph = vi
      .fn<WorktreeControl["graph"]>()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockImplementationOnce(async () => [commit("bbb", "new project")]);
    const control = controlWith(graph);
    const { rerender } = render(panel(control, "old"));
    rerender(panel(control, "new"));
    await screen.findByText("new project");

    releaseOld([commit("aaa", "old project")]);
    await waitFor(() => expect(screen.queryByText("old project")).toBeNull());
    expect(screen.getByText("new project")).toBeTruthy();
  });
});
