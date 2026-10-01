// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Cluster } from "../contract";
import ClusterIconDialog from "./ClusterIconDialog";

afterEach(cleanup);

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: "a",
    name: "auth",
    tree: { kind: "leaf", tabs: [], active: null } as unknown as Cluster["tree"],
    project: null,
    worktree: null,
    activeTerminal: null,
    bandHeight: null,
    pinned: false,
    ...over,
  };
}

function setup(over: Partial<Cluster> = {}) {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  render(<ClusterIconDialog cluster={cluster(over)} onPick={onPick} onCancel={onCancel} />);
  return { onPick, onCancel };
}

const grid = () => screen.getByRole("group", { name: "Emoji" });
const tiles = () => Array.from(grid().querySelectorAll<HTMLElement>("[data-emoji]"));

describe("ClusterIconDialog", () => {
  it("shows the current icon and focuses the search field", () => {
    setup({ icon: { emoji: "🚀", color: "blue" } });
    expect(screen.getByRole("dialog", { name: "Change icon for auth" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Search or enter an emoji"));
    expect(document.querySelector(".icon-dialog__preview-chip")?.textContent).toBe("🚀");
  });

  it("picks a grid emoji with its tint", () => {
    const { onPick } = setup();
    fireEvent.click(tiles()[0]);
    expect(onPick).toHaveBeenCalledWith({ emoji: "🚀", color: "blue" });
  });

  it("offers the initials on each palette tint as suggestions", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Initials on violet" }));
    expect(onPick).toHaveBeenCalledWith({ emoji: "", color: "violet" });
  });

  it("resets to the initials, and disables that when there is nothing to reset", () => {
    const { onPick } = setup({ icon: { emoji: "🔥", color: null } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to initials" }));
    expect(onPick).toHaveBeenCalledWith(null);
    cleanup();
    setup();
    expect(
      (screen.getByRole("button", { name: "Reset to initials" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("uses an emoji typed into the field on Enter, and filters the grid by a word", () => {
    const { onPick } = setup();
    const field = screen.getByLabelText("Search or enter an emoji");
    fireEvent.change(field, { target: { value: "rust" } });
    expect(tiles().map((t) => t.textContent)).toEqual(["🦀"]);
    fireEvent.change(field, { target: { value: "🍕" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ emoji: "🍕", color: null });
  });

  it("moves through the grid with the arrow keys, by a row for up and down", () => {
    setup();
    const [first] = tiles();
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles()[1]);
    fireEvent.keyDown(tiles()[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(tiles()[9]);
    fireEvent.keyDown(tiles()[9], { key: "ArrowUp" });
    expect(document.activeElement).toBe(tiles()[1]);
    fireEvent.keyDown(tiles()[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tiles()[0]);
    fireEvent.keyDown(tiles()[0], { key: "End" });
    expect(document.activeElement).toBe(tiles()[tiles().length - 1]);
  });

  it("keeps the grid to one tab stop", () => {
    setup();
    expect(tiles().filter((t) => t.tabIndex === 0)).toHaveLength(1);
  });

  it("closes on Escape without picking", () => {
    const { onPick, onCancel } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});
