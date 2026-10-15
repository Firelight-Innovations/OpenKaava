// @vitest-environment jsdom
/**
 * The composer footer's settings button and meters: what each shows at a
 * glance, what its popup lists, and how it opens and closes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defaultSlots } from "./registry";
import type { PickerProps } from "./types";

const { ModelMenu, UsageRing, ContextMeter } = defaultSlots;

afterEach(cleanup);

function sections(onModel = vi.fn()): PickerProps[] {
  return [
    { label: "Agent", value: "claude", choices: [{ value: "claude", name: "Claude" }] },
    {
      label: "Model",
      value: "opus",
      choices: [
        { value: "opus", name: "Opus 5.5" },
        { value: "sonnet", name: "Sonnet 5.5", description: "Faster" },
      ],
      onChange: onModel,
    },
    { label: "Effort", value: "high", choices: [] },
    { label: "Mode", value: null, choices: [] },
  ];
}

describe("the model menu", () => {
  it("reads every setting that is set, in order", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    expect(screen.getByRole("button", { name: /Agent settings/ }).textContent).toBe(
      "Claude · Opus 5.5 · high",
    );
  });

  it("lists a section per setting, and changes one when it is picked", () => {
    const onModel = vi.fn();
    render(<ModelMenu label="Agent settings" sections={sections(onModel)} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));

    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    // A section with nothing to list (Mode, unset) is left out.
    expect(groups).toEqual(["Agent", "Model", "Effort"]);
    expect(
      (screen.getByRole("menuitemradio", { name: "Claude" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("menuitemradio", { name: "Opus 5.5" }).getAttribute("aria-checked"),
    ).toBe("true");
    // The checked item takes focus, so the arrows start from it.
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Opus 5.5" }));

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet 5.5/ }));
    expect(onModel).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves with the arrows and closes on Esc, back on its button", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    const button = screen.getByRole("button", { name: /Agent settings/ });
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Sonnet 5.5");

    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(menu, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    // Esc in the menu does not reach the composer, where it would stop the turn.
    expect(outer).not.toHaveBeenCalled();
  });

  it("closes when the pointer goes down outside it", () => {
    render(<ModelMenu label="Agent settings" sections={sections()} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the usage ring", () => {
  const limits = [
    { id: "session", label: "Session limit", share: 0.86, resets: "Resets in 22 min" },
    { id: "week", label: "Weekly", share: 0.45, resets: "Resets Fri 7:00 AM" },
  ];

  it("draws nothing until there is a limit", () => {
    const { container } = render(<UsageRing limits={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("fills to the tightest limit, and lists each one on hover", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<UsageRing limits={limits} />);
      const button = screen.getByRole("button", { name: "Usage: 86% of the tightest limit used" });
      expect(container.querySelector(".at-ring")?.getAttribute("data-tone")).toBe("high");

      const card = screen.getByRole("tooltip", { hidden: true });
      expect(card.hasAttribute("data-open")).toBe(false);
      fireEvent.pointerEnter(button.parentElement!);
      expect(card.hasAttribute("data-open")).toBe(true);
      expect(card.textContent).toContain("Session limit86% used");
      expect(card.textContent).toContain("Resets Fri 7:00 AM");
      expect([...card.querySelectorAll(".at-bar")].map((b) => b.getAttribute("data-tone"))).toEqual(
        ["high", "low"],
      );

      // It lingers long enough for the pointer to reach the card.
      fireEvent.pointerLeave(button.parentElement!);
      expect(card.hasAttribute("data-open")).toBe(true);
      act(() => void vi.advanceTimersByTime(200));
      expect(card.hasAttribute("data-open")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on focus and closes on Esc", () => {
    render(<UsageRing limits={limits} />);
    const button = screen.getByRole("button");
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip", { hidden: true }).hasAttribute("data-open")).toBe(true);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.getByRole("tooltip", { hidden: true }).hasAttribute("data-open")).toBe(false);
  });
});

describe("the context meter", () => {
  it("draws nothing before the first usage report", () => {
    const { container } = render(<ContextMeter used={null} size={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows how full the window is, and what is used and free", () => {
    render(<ContextMeter used={124_600} size={300_000} />);
    expect(screen.getByRole("button", { name: "Context window 42% full" }).textContent).toBe("42%");
    const card = screen.getByRole("tooltip", { hidden: true });
    expect(card.querySelector(".at-card__head")?.textContent).toBe(
      "Context window124.6k / 300k (42%)",
    );
    const rows = [...card.querySelectorAll(".at-rows__row")].map((r) => r.textContent);
    expect(rows).toEqual(["Used124.6k42%", "Free space175.4k58%"]);
  });

  it("breaks the used tokens down when the agent says what they are", () => {
    render(
      <ContextMeter
        used={30_000}
        size={100_000}
        categories={[
          { id: "messages", label: "Messages", tokens: 20_000 },
          { id: "tools", label: "System tools", tokens: 10_000 },
        ]}
      />,
    );
    const card = screen.getByRole("tooltip", { hidden: true });
    expect([...card.querySelectorAll(".at-rows__row dt")].map((r) => r.textContent)).toEqual([
      "Messages",
      "System tools",
      "Free space",
    ]);
    expect(card.querySelectorAll(".at-stack__part")).toHaveLength(2);
  });
});
