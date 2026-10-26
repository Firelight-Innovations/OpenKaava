// @vitest-environment jsdom
/**
 * The components no default tree renders yet: each branch they take, so the
 * work that builds on them starts from checked behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMeter } from "./ContextMeter";
import { Menu } from "./Menu";
import { Picker } from "./Picker";
import { SessionList } from "./SessionList";

afterEach(cleanup);

describe("ContextMeter", () => {
  // The ring's filled arc as a share of its circumference, in whole percent.
  const fill = (el: HTMLElement) => {
    const dash = el.querySelector(".at-ring__fill")!.getAttribute("stroke-dasharray")!;
    return `${Math.round((Number(dash.split(" ")[0]) / (2 * Math.PI * 6)) * 100)}%`;
  };

  it("draws nothing until usage and a window size are known", () => {
    expect(render(<ContextMeter used={null} size={100} />).container.firstChild).toBeNull();
    expect(render(<ContextMeter used={10} size={null} />).container.firstChild).toBeNull();
    expect(render(<ContextMeter used={10} size={0} />).container.firstChild).toBeNull();
  });

  it("fills in proportion, and never past either end", () => {
    const meter = (used: number) => {
      const { container } = render(<ContextMeter used={used} size={100} />);
      const width = fill(container);
      cleanup();
      return width;
    };
    expect(meter(0)).toBe("0%");
    expect(meter(50)).toBe("50%");
    expect(meter(250)).toBe("100%");
    expect(meter(-5)).toBe("0%");
  });

  it("names how full the window is for assistive technology, capped at full", () => {
    render(<ContextMeter used={250} size={100} />);
    expect(screen.getByRole("button", { name: "Context window 100% full" })).toBeTruthy();
  });
});

describe("Picker", () => {
  const choices = [
    { value: "a", name: "Alpha", description: "first" },
    { value: "b", name: "" },
  ];

  it("shows its value as text, named by its label, when nothing can be chosen", () => {
    render(<Picker label="Mode" value="default" choices={[]} />);
    expect(screen.getByRole("group", { name: "Mode" }).textContent).toBe("default");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("falls back to the value when a choice has no name", () => {
    render(<Picker label="Model" value="a" choices={choices} onChange={vi.fn()} />);
    expect([...screen.getAllByRole("option")].map((o) => o.textContent)).toEqual(["Alpha", "b"]);
  });

  it("keeps showing a value it was not offered, instead of the first choice", () => {
    render(<Picker label="Model" value="zzz" choices={choices} onChange={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
    expect(select.value).toBe("zzz");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("reports the chosen value", () => {
    const onChange = vi.fn();
    render(<Picker label="Model" value="a" choices={choices} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Menu", () => {
  const items = [
    { id: "x", label: "/review", detail: "a file" },
    { id: "y", label: "/clear" },
  ];

  it("draws nothing without items", () => {
    expect(
      render(<Menu label="Commands" items={[]} activeId={null} onPick={vi.fn()} />).container
        .firstChild,
    ).toBeNull();
  });

  it("marks the active item, and gives each an id the input can point at", () => {
    render(<Menu label="Commands" items={items} activeId="y" onPick={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.id)).toEqual(["menu-item-x", "menu-item-y"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(options[0].textContent).toContain("a file");
  });

  it("picks on click without taking focus from the input", () => {
    const onPick = vi.fn();
    render(<Menu label="Commands" items={items} activeId={null} onPick={onPick} />);
    const option = screen.getByText("/clear");
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith("y");
  });
});

describe("SessionList", () => {
  const sessions = [
    { id: "s1", title: "Fix the test", state: "working" as const, when: "now" },
    { id: "s2", title: "Older", state: null, when: "Mon" },
  ];

  it("marks the active row, and shows a state badge only where there is a state", () => {
    const { container } = render(
      <SessionList sessions={sessions} activeId="s1" onOpen={vi.fn()} />,
    );
    const rows = screen.getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(container.querySelectorAll(".at-status")).toHaveLength(1);
  });

  it("opens the row clicked", () => {
    const onOpen = vi.fn();
    render(<SessionList sessions={sessions} activeId={null} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Older/ }));
    expect(onOpen).toHaveBeenCalledWith("s2");
  });
});
