// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboard, type KeyboardActions } from "./useKeyboard";

/** Every action a no-op, with the Copilot one under test. */
function actions(copilotKey: () => boolean): KeyboardActions {
  const noop = () => {};
  return {
    selectToolByIndex: noop,
    rescan: noop,
    cancelBoot: noop,
    newFile: noop,
    newCluster: noop,
    openProject: noop,
    save: noop,
    saveAs: noop,
    duplicate: noop,
    closeWindow: noop,
    commandPalette: noop,
    togglePanel: noop,
    toggleTerminal: noop,
    toggleFullscreen: noop,
    zoomIn: noop,
    zoomOut: noop,
    newTerminal: noop,
    splitTerminal: noop,
    switchProject: noop,
    openApp: noop,
    copilotKey,
  };
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

afterEach(cleanup);

describe("the Copilot key in the keyboard listener", () => {
  it("runs the action for Win+Shift+F23 and takes the key", () => {
    const run = vi.fn(() => true);
    renderHook(() => useKeyboard(actions(run)));
    const event = press({ key: "F23", shiftKey: true, metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("also fires for a bare F23", () => {
    const run = vi.fn(() => true);
    renderHook(() => useKeyboard(actions(run)));
    press({ key: "F23" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves the key alone when the action declines it", () => {
    const run = vi.fn(() => false);
    renderHook(() => useKeyboard(actions(run)));
    const event = press({ key: "F23", shiftKey: true, metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores F23 with Ctrl held", () => {
    const run = vi.fn(() => true);
    renderHook(() => useKeyboard(actions(run)));
    press({ key: "F23", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});
