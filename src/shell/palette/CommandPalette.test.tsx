// @vitest-environment jsdom
/**
 * The palette as a person uses it: one dialog with a commands page and an apps
 * page, a scrim behind both, and keys that move between them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Openable } from "../../bindings";
import CommandPalette, { type CommandPaletteProps } from "./CommandPalette";
import { withOpenAppCommands, type Command } from "./registry";

Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const app = (id: string, name: string): Openable => ({ id, name, description: "", kind: "app" });
const APPS = [app("files", "File Explorer"), app("godot-viewer", "Godot Viewer")];

const save: Command = {
  category: "File",
  title: "New File",
  label: "File: New File",
  accelerator: "Ctrl+N",
  disabled: false,
  onSelect: vi.fn(),
};

function setup(over: Partial<CommandPaletteProps> = {}) {
  const props: CommandPaletteProps = {
    open: true,
    commands: withOpenAppCommands([save], {
      apps: APPS,
      open: vi.fn(),
      accelerator: "Ctrl+Shift+A",
    }),
    apps: APPS,
    onPickApp: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<CommandPalette {...props} />);
  return props;
}

const field = () => screen.getByRole("combobox");

describe("CommandPalette", () => {
  it("renders the backdrop behind the dialog", () => {
    setup();
    const backdrop = screen.getByTestId("palette-backdrop");
    expect(backdrop.contains(screen.getByRole("dialog"))).toBe(true);
  });

  it("draws a chevron on 'Open app…' and shortcuts on command rows", () => {
    setup();
    const opener = screen.getByText("Open app…").closest("li");
    expect(opener?.querySelector("[data-testid='picker-chevron']")).not.toBeNull();
    const file = screen.getByText(/New File/).closest("li");
    expect(file?.querySelector("[data-testid='picker-chevron']")).toBeNull();
    expect(screen.getByText("Ctrl+N")).toBeTruthy();
  });

  it("shows the apps page in the same dialog on Enter", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByRole("combobox", { name: "Filter apps" })).toBeTruthy();
    expect(screen.getByText("Godot Viewer")).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("shows the apps page in the same dialog on ArrowRight", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(field(), { key: "ArrowRight" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByRole("combobox", { name: "Filter apps" })).toBeTruthy();
  });

  it("shows the apps page on a click of the row", () => {
    setup();
    fireEvent.click(screen.getByText("Open app…"));
    expect(screen.getByRole("combobox", { name: "Filter apps" })).toBeTruthy();
  });

  it("returns to the commands on ArrowLeft and on Backspace in an empty field", () => {
    setup({ page: "apps" });
    fireEvent.keyDown(field(), { key: "ArrowLeft" });
    expect(screen.getByRole("combobox", { name: "Run a command" })).toBeTruthy();

    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(screen.getByRole("combobox", { name: "Run a command" })).toBeTruthy();
  });

  it("keeps Backspace as an edit while the apps field has text", () => {
    setup({ page: "apps" });
    fireEvent.change(field(), { target: { value: "god" } });
    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(screen.getByRole("combobox", { name: "Filter apps" })).toBeTruthy();
  });

  it("opens straight on the apps page when asked to", () => {
    setup({ page: "apps" });
    expect(screen.getByRole("combobox", { name: "Filter apps" })).toBeTruthy();
    expect(screen.getByTestId("palette-backdrop")).toBeTruthy();
  });

  it("opens the chosen app and closes", () => {
    const props = setup({ page: "apps" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(props.onPickApp).toHaveBeenCalledWith(APPS[0]);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("closes on Escape from either page", () => {
    const props = setup();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
