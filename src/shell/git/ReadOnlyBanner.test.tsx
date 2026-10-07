// @vitest-environment jsdom
/**
 * The read-only notice: plain words naming the real branch, one primary button into the
 * existing worktree-cluster flow, and the init offer when there is no repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const repo = vi.hoisted(() => ({
  state: { state: "ready" } as unknown,
  branch: "main" as string | null,
}));
const init = vi.hoisted(() => vi.fn());

vi.mock("../../bindings", () => ({
  gitRepoState: () => Promise.resolve(repo.state),
  gitDefaultBranch: () => Promise.resolve(repo.branch),
  gitInitProject: init,
}));

import ReadOnlyBanner from "./ReadOnlyBanner";

beforeEach(() => {
  repo.state = { state: "ready" };
  repo.branch = "main";
  init.mockReset();
});
afterEach(cleanup);

describe("ReadOnlyBanner", () => {
  it("says the branch is read-only and starts the worktree cluster flow", async () => {
    repo.branch = "master";
    const onNew = vi.fn();
    render(<ReadOnlyBanner projectPath="C:/p" onNewWorktreeCluster={onNew} />);
    await waitFor(() => expect(screen.getByText("master is read-only.")).toBeTruthy());
    expect(screen.getByText(/need a worktree cluster/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New worktree cluster…" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("offers to initialise git instead when there is no repository", async () => {
    repo.state = { state: "notARepo" };
    init.mockResolvedValue({ branch: "main", committedEverything: true });
    render(<ReadOnlyBanner projectPath="C:/p" onNewWorktreeCluster={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Initialise git repository" });
    expect(screen.getByText(/no git repository/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New worktree cluster…" })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(init).toHaveBeenCalledWith("C:/p"));
  });
});
