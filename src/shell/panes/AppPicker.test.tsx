// @vitest-environment jsdom
/**
 * The picker as a person uses it: type to filter, arrows and Enter to choose,
 * and the strip's `+` opening the chosen app into *its own* pane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Openable } from "../../bindings";
import AppPicker from "./AppPicker";
import PaneTabStrip from "./PaneTabStrip";

// jsdom does not implement it, and the picker scrolls the highlight into view.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const app = (id: string, name: string): Openable => ({ id, name, description: "", kind: "app" });
const APPS = [app("files", "Files"), app("godot-viewer", "Godot Viewer"), app("home", "Home")];

describe("AppPicker", () => {
  it("filters as you type and opens the highlighted app on Enter", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<AppPicker apps={APPS} onPick={onPick} onClose={onClose} />);

    const field = screen.getByRole("combobox", { name: "Filter apps" });
    fireEvent.change(field, { target: { value: "godot" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(APPS[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the highlight with the arrow keys", () => {
    const onPick = vi.fn();
    render(<AppPicker apps={APPS} onPick={onPick} onClose={vi.fn()} />);
    const field = screen.getByRole("combobox", { name: "Filter apps" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(APPS[1]);
  });

  it("closes on Escape without opening anything", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<AppPicker apps={APPS} onPick={onPick} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("opens nothing while blocked", () => {
    const onPick = vi.fn();
    render(<AppPicker apps={APPS} blocked="No cluster." onPick={onPick} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText("No cluster.")).toBeTruthy();
  });
});

describe("the pane strip's + button", () => {
  it("opens the chosen app into that strip's pane", () => {
    const onOpen = vi.fn();
    render(
      <PaneTabStrip
        paneId="pane-2"
        members={[]}
        caret={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        appPicker={{ apps: APPS, onOpen }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open an app in this pane" }));
    fireEvent.click(screen.getByRole("option", { name: /Files/ }));
    expect(onOpen).toHaveBeenCalledWith(APPS[0], "pane-2");
  });
});
