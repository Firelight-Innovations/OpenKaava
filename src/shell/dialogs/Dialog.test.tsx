// @vitest-environment jsdom
/**
 * `Dialog` is the shared frame the New Cluster and Switch Project dialogs
 * are both built from — see the file's own header. Its whole job is
 * mechanical: put focus inside on open, keep Tab from leaving, and treat
 * Escape or a scrim click as cancel. This file pins each of those, since a
 * regression here would silently break every dialog built on top of it
 * rather than announce itself in whichever one happened to be open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Dialog from "./Dialog";

afterEach(cleanup);

function renderDialog(onCancel: () => void) {
  return render(
    <Dialog label="Test dialog" onCancel={onCancel}>
      <button type="button">First</button>
      <input type="text" />
      <button type="button">Last</button>
    </Dialog>,
  );
}

describe("Dialog", () => {
  it("renders as a labelled modal dialog", () => {
    renderDialog(vi.fn());
    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("focuses the first focusable element on open", () => {
    renderDialog(vi.fn());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("calls onCancel on Escape", () => {
    const onCancel = vi.fn();
    renderDialog(onCancel);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on a pointerdown against the scrim, not the panel", () => {
    const onCancel = vi.fn();
    const { container } = renderDialog(onCancel);

    const panel = screen.getByRole("dialog");
    fireEvent.pointerDown(panel);
    expect(onCancel).not.toHaveBeenCalled();

    const scrim = container.querySelector(".dialogs__scrim");
    expect(scrim).not.toBeNull();
    fireEvent.pointerDown(scrim as Element);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last focusable element back to the first", () => {
    renderDialog(vi.fn());
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("wraps Shift+Tab from the first focusable element back to the last", () => {
    renderDialog(vi.fn());
    const first = screen.getByRole("button", { name: "First" });
    first.focus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });

  it("leaves an ordinary Tab in the middle of the panel alone", () => {
    renderDialog(vi.fn());
    const input = screen.getByRole("textbox");
    input.focus();

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
