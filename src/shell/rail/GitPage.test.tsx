// @vitest-environment jsdom
/**
 * The Git page's two tabs, which replaced the secondary panel's view list.
 *
 * `GitPage` only arranges slots, so plain elements stand in for the source
 * control and GitHub views.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GitPage from "./GitPage";

afterEach(cleanup);

const worktree = <div>worktree body</div>;
const github = <div>github body</div>;

describe("GitPage", () => {
  it("draws Source Control and GitHub as tabs, with the selected one marked", () => {
    render(
      <GitPage
        worktreeView={worktree}
        githubView={github}
        view="worktree"
        onSelectView={vi.fn()}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Source Control", "GitHub"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].className).toBe("k-git-page__tab");
    expect(tabs[0].hasAttribute("data-active")).toBe(true);
    expect(tabs[1].hasAttribute("data-active")).toBe(false);
  });

  it("keeps both views mounted and hides the one not selected", () => {
    render(
      <GitPage worktreeView={worktree} githubView={github} view="github" onSelectView={vi.fn()} />,
    );
    const worktreeBody = screen.getByText("worktree body").parentElement!;
    const githubBody = screen.getByText("github body").parentElement!;
    expect(worktreeBody.hidden).toBe(true);
    expect(githubBody.hidden).toBe(false);
  });

  it("reports a tab click rather than switching by itself", () => {
    const onSelectView = vi.fn();
    render(
      <GitPage
        worktreeView={worktree}
        githubView={github}
        view="worktree"
        onSelectView={onSelectView}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    expect(onSelectView).toHaveBeenCalledWith("github");
  });

  it("leaves out a tab with no view and falls back to the one it has", () => {
    render(<GitPage worktreeView={worktree} view="github" onSelectView={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Source Control"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("worktree body").parentElement!.hidden).toBe(false);
  });
});
