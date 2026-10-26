// @vitest-environment jsdom
/**
 * The rail's resting, active, disabled and dotted states.
 *
 * `Rail` is purely presentational -- everything it draws comes in as props --
 * so these tests never touch `pages.rs` or the backend; a fixed seven-page
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
  { id: "sessions", name: "Agents", icon: "sparkles", mode: "docked", key: 6, disabled: false },
  {
    id: "registry",
    name: "Artifact registry",
    icon: "package",
    mode: "docked",
    key: 7,
    disabled: true,
  },
];

describe("Rail", () => {
  it("draws one button per enabled page, each with its icon", () => {
    render(<Rail pages={PAGES} activePageId={null} onSelect={() => {}} />);

    const drawn = PAGES.filter((p) => !p.disabled && p.id !== "sessions" && p.id !== "git");
    expect(screen.getAllByRole("button")).toHaveLength(drawn.length);
    for (const page of drawn) {
      const button = screen.getByRole("button", { name: page.name });
      expect(button.querySelector("svg"), `${page.name}'s icon`).not.toBeNull();
    }
  });

  it("leaves Agents to the title bar and the agent tab", () => {
    render(<Rail pages={PAGES} activePageId={null} onSelect={() => {}} />);

    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  });

  it("leaves Git to the status bar", () => {
    render(<Rail pages={PAGES} activePageId={null} onSelect={() => {}} />);

    expect(screen.queryByRole("button", { name: "Git" })).toBeNull();
  });

  it("marks the open page active and nothing else", () => {
    render(<Rail pages={PAGES} activePageId="plane" onSelect={() => {}} />);

    const plane = screen.getByRole("button", { name: "Plane" });
    expect(plane.getAttribute("data-active")).toBe("");
    expect(plane.getAttribute("aria-pressed")).toBe("true");

    const hindsight = screen.getByRole("button", { name: "Hindsight" });
    expect(hindsight.getAttribute("data-active")).toBeNull();
    expect(hindsight.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not draw a disabled page, and draws the rest", () => {
    render(<Rail pages={PAGES} activePageId={null} onSelect={() => {}} />);

    expect(screen.queryByRole("button", { name: "Artifact registry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hindsight" })).toBeTruthy();
  });

  it("draws a dot only for a page it was handed one for", () => {
    render(
      <Rail
        pages={PAGES}
        activePageId={null}
        dots={{ hindsight: "#d98a3f" }}
        onSelect={() => {}}
      />,
    );

    const hindsight = screen.getByRole("button", { name: "Hindsight" });
    const dot = hindsight.querySelector(".k-rail__dot");
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
