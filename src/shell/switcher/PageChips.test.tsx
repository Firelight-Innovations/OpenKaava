// @vitest-environment jsdom
/**
 * The page chips' resting and open states.
 *
 * jsdom has no layout and applies no stylesheet, so the hover expansion itself —
 * a CSS grid track animating `0fr` to `1fr` — cannot be observed here. What is
 * pinned instead is everything that expansion hangs off: the label is in the
 * DOM to be revealed, the chip carries its name for the icon-only state, and the
 * open page is marked so the CSS holds it expanded without a pointer over it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PageInfo } from "../contract";
import PageChips from "./PageChips";

afterEach(cleanup);

const PAGES: PageInfo[] = [
  { id: "agents", name: "Agents", icon: "robot", mode: "expanded", key: 2, disabled: false },
  { id: "costs", name: "Cost Tracker", icon: "receipt", mode: "docked", key: 4, disabled: false },
];

describe("PageChips", () => {
  it("draws each page as an icon at rest, named for assistive tech and on hover", () => {
    render(<PageChips pages={PAGES} activePageId={null} onSelect={() => {}} />);

    const chip = screen.getByRole("button", { name: "Cost Tracker" });
    expect(chip.getAttribute("title")).toBe("Cost Tracker");
    expect(chip.getAttribute("data-expanded")).toBe("false");
    expect(chip.classList.contains("switcher__page--active")).toBe(false);
    expect(chip.querySelector("svg"), "the icon").not.toBeNull();

    // The label is there for the hover rule to reveal, hidden from the
    // accessibility tree because `aria-label` already says it.
    const label = chip.querySelector(".switcher__page-label");
    expect(label?.textContent).toBe("Cost Tracker");
    expect(label?.getAttribute("aria-hidden")).toBe("true");
  });

  it("holds the open page expanded, with its label, whatever the pointer does", () => {
    render(<PageChips pages={PAGES} activePageId="agents" onSelect={() => {}} />);

    const open = screen.getByRole("button", { name: "Agents" });
    expect(open.getAttribute("data-expanded")).toBe("true");
    expect(open.getAttribute("aria-pressed")).toBe("true");
    expect(open.classList.contains("switcher__page--active")).toBe(true);
    expect(open.querySelector(".switcher__page-label")?.textContent).toBe("Agents");

    const other = screen.getByRole("button", { name: "Cost Tracker" });
    expect(other.getAttribute("data-expanded")).toBe("false");
  });

  it("has none of a cluster chip's furniture", () => {
    render(<PageChips pages={PAGES} activePageId="agents" onSelect={() => {}} />);

    const open = screen.getByRole("button", { name: "Agents" });
    expect(open.querySelector(".switcher__tab-close"), "no close").toBeNull();
    expect(open.querySelector(".switcher__tab-count"), "no count").toBeNull();
    expect(open.querySelector("input"), "no rename").toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(PAGES.length);
  });

  it("reports which page was picked", () => {
    const onSelect = vi.fn();
    render(<PageChips pages={PAGES} activePageId={null} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));

    expect(onSelect).toHaveBeenCalledWith("agents");
  });

  it("draws nothing when this build offers no pages", () => {
    const { container } = render(<PageChips pages={[]} activePageId={null} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
