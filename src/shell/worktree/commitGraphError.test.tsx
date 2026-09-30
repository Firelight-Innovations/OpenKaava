// @vitest-environment jsdom
/**
 * A failed history read must say so. It used to be drawn as "No commits",
 * which told the user a repository with thousands of commits was empty.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CommitGraph from "./CommitGraph";

afterEach(cleanup);

describe("CommitGraph error state", () => {
  it("shows the failure message instead of No commits", () => {
    render(
      <CommitGraph commits={[]} worktrees={[]} activeBranch={null} error="fatal: bad object" />,
    );
    expect(screen.getByRole("alert").textContent).toContain("fatal: bad object");
    expect(screen.queryByText("No commits")).toBeNull();
  });

  it("still says No commits when the history is honestly empty", () => {
    render(<CommitGraph commits={[]} worktrees={[]} activeBranch={null} error={null} />);
    expect(screen.getByText("No commits")).toBeTruthy();
  });
});
