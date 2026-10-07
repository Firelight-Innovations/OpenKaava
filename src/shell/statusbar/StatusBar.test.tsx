// @vitest-environment jsdom
/**
 * The left cluster (project, branch/environment, diff stat) and the
 * environment-conditioned pieces of the right cluster: the "main is
 * read-only" label, and the ahead/behind upgrade once `git` lands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitStatus } from "../contract";
import type { Environment } from "../environment";
import StatusBar from "./StatusBar";

afterEach(cleanup);

function git(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "wt/flashlight-cone",
    ahead: 0,
    behind: 0,
    insertions: 0,
    deletions: 0,
    staged: [],
    unstaged: [],
    ...overrides,
  };
}

describe("StatusBar", () => {
  it("draws nothing in the left cluster while no cluster is open", () => {
    render(<StatusBar project={null} environment={null} git={null} githubOk update={null} />);
    expect(screen.queryByText(/./, { selector: ".statusbar__project" })).toBeNull();
    expect(screen.queryByText(/./, { selector: ".statusbar__branch" })).toBeNull();
  });

  it("draws the project name and a bare branch name before git lands", () => {
    const env: Environment = {
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/wt/fl",
    };
    render(<StatusBar project="OpenKaava" environment={env} git={null} githubOk update={null} />);

    expect(screen.getByText("OpenKaava")).not.toBeNull();
    expect(screen.getByText("wt/flashlight-cone")).not.toBeNull();
  });

  it("upgrades the branch segment with ahead/behind once git lands", () => {
    const env: Environment = {
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/wt/fl",
    };
    render(
      <StatusBar
        project="OpenKaava"
        environment={env}
        git={git({ branch: "wt/flashlight-cone", ahead: 1, behind: 0 })}
        githubOk
        update={null}
      />,
    );

    expect(screen.getByText("wt/flashlight-cone")).not.toBeNull();
    expect(screen.getByText("↑1")).not.toBeNull();
    expect(screen.getByText("↓0")).not.toBeNull();
  });

  it("draws the worktree kind chip, once, with the path as its tooltip", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/repo/wt/x" };
    render(<StatusBar project="OpenKaava" environment={env} git={git()} githubOk update={null} />);

    const chip = screen.getByRole("button", { name: /Local worktree/ });
    expect(chip.textContent).toBe("Local worktree");
    expect(chip.getAttribute("title")).toContain("/repo/wt/x");
    expect(screen.getAllByText("wt/x")).toHaveLength(1);
  });

  it("copies the worktree path when the chip is pressed", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/repo/wt/x" };
    render(<StatusBar project="OpenKaava" environment={env} git={null} githubOk update={null} />);

    screen.getByRole("button", { name: /Local worktree/ }).click();
    expect(writeText).toHaveBeenCalledWith("/repo/wt/x");
  });

  it("draws Review & merge for a worktree and wires it to the handler", () => {
    const onReview = vi.fn();
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    render(
      <StatusBar
        project="OpenKaava"
        environment={env}
        git={null}
        githubOk
        update={null}
        onReviewAndMerge={onReview}
      />,
    );

    screen.getByRole("button", { name: "Review & merge" }).click();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("omits Review & merge on main, where there is nothing to merge", () => {
    render(
      <StatusBar
        project="OpenKaava"
        environment={{ kind: "main" }}
        git={null}
        githubOk
        update={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review & merge" })).toBeNull();
  });

  it("reads main as a bare branch segment with no ahead/behind, plus the trailing read-only label", () => {
    render(
      <StatusBar
        project="OpenKaava"
        environment={{ kind: "main" }}
        git={null}
        githubOk
        update={null}
      />,
    );

    expect(screen.getByText("main")).not.toBeNull();
    expect(screen.getByText("main is read-only")).not.toBeNull();
  });

  it("names the real branch when the repository's default is master", () => {
    render(
      <StatusBar
        project="OpenKaava"
        environment={{ kind: "main" }}
        git={git({ branch: "master" })}
        githubOk
        update={null}
      />,
    );

    expect(screen.getByText("master is read-only")).not.toBeNull();
    expect(screen.queryByText("main is read-only")).toBeNull();
  });

  it("omits the read-only label for a worktree", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    render(<StatusBar project="OpenKaava" environment={env} git={null} githubOk update={null} />);

    expect(screen.queryByText("main is read-only")).toBeNull();
  });

  it("only draws the diff stat once git reports touched files", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    const { rerender } = render(
      <StatusBar project="OpenKaava" environment={env} git={git()} githubOk update={null} />,
    );
    expect(screen.queryByText(/files$/)).toBeNull();

    rerender(
      <StatusBar
        project="OpenKaava"
        environment={env}
        git={git({
          insertions: 3,
          deletions: 1,
          staged: [
            {
              path: "a.ts",
              file: "a.ts",
              dir: "",
              kind: "modified",
              staged: true,
              insertions: 3,
              deletions: 1,
            },
          ],
        })}
        githubOk
        update={null}
      />,
    );
    expect(screen.getByText("1 file", { exact: false })).not.toBeNull();
  });
});
