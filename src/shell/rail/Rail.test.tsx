// @vitest-environment jsdom
/**
 * The rail's resting, active, disabled and dotted states.
 *
 * `Rail` is purely presentational -- everything it draws comes in as props --
 * so these tests never touch `pages.rs` or the backend; a fixed six-page
 * fixture stands in for `pages::rail()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PageInfo } from "../../bindings";
import Rail from "./Rail";

afterEach(cleanup);

const PAGES: PageInfo[] = [
  { id: "git", name: "Git", icon: "git-branch", mode: "docked", key: 1, disabled: false },
  { id: "plane", name: "Plane", icon: "kanban", mode: "expanded", key: 2, disabled: false },
  {
    id: "agents",
    name: "Cloud agents",
    icon: "bot",
    mode: "expanded",
    key: 3,
    disabled: false,
  },
  { id: "hindsight", name: "Hindsight", icon: "brain", mode: "docked", key: 4, disabled: false },
  { id: "costs", name: "Cost", icon: "receipt", mode: "docked", key: 5, disabled: false },
  {
    id: "registry",
    name: "Artifact registry",
    icon: "package",
    mode: "docked",
    key: 6,
    disabled: true,
  },
];

describe("Rail", () => {
  it("draws one button per page, each with its icon", () => {
    render(<Rail pages={PAGES} activePageId={null} onSelect={() => {}} />);

    expect(screen.getAllByRole("button")).toHaveLength(PAGES.length);
    const git = screen.getByRole("button", { name: "Git" });
    expect(git.querySelector("svg"), "the icon").not.toBeNull();
  });

  it("marks the open page active and nothing else", () => {
    render(<Rail pages={PAGES} activePageId="plane" onSelect={() => {}} />);

    const plane = screen.getByRole("button", { name: "Plane" });
    expect(plane.getAttribute("data-active")).toBe("");
    expect(plane.getAttribute("aria-pressed")).toBe("true");

    const git = screen.getByRole("button", { name: "Git" });
    expect(git.getAttribute("data-active")).toBeNull();
    expect(git.getAttribute("aria-pressed")).toBe("false");
  });

  it("disables the artifact registry and nothing else", () => {
    render(<Rail pages={PAGES} activePageId={null} onSelect={() => {}} />);

    const registry = screen.getByRole("button", { name: "Artifact registry" }) as HTMLButtonElement;
    expect(registry.disabled).toBe(true);
    const git = screen.getByRole("button", { name: "Git" }) as HTMLButtonElement;
    expect(git.disabled).toBe(false);
  });

  it("draws a dot only for a page it was handed one for", () => {
    render(
      <Rail pages={PAGES} activePageId={null} dots={{ git: "#d98a3f" }} onSelect={() => {}} />,
    );

    const git = screen.getByRole("button", { name: "Git" });
    const dot = git.querySelector(".k-rail__dot");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("style")).toContain("background: rgb(217, 138, 63)");

    const plane = screen.getByRole("button", { name: "Plane" });
    expect(plane.querySelector(".k-rail__dot")).toBeNull();
  });

  it("reports which page was picked", () => {
    const onSelect = vi.fn();
    render(<Rail pages={PAGES} activePageId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Cost" }));

    expect(onSelect).toHaveBeenCalledWith("costs");
  });
});
