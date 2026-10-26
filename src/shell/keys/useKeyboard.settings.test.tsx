// @vitest-environment jsdom
/**
 * Ctrl+, opens Settings. The status bar has no settings button any more and the
 * menus have no Settings item yet, so this chord is the shell's way in.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboard, type KeyboardActions } from "./useKeyboard";

/** Every action a no-op, so `openSettings` can be watched. */
function actions(over: Partial<KeyboardActions>): KeyboardActions {
  const noop = () => {};
  return {
    selectToolByIndex: noop,
    cycleCluster: noop,
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
    toggleClusters: noop,
    toggleTerminal: noop,
    toggleFullscreen: noop,
    zoomIn: noop,
    zoomOut: noop,
    openSettings: noop,
    newTerminal: noop,
    splitTerminal: noop,
    switchProject: noop,
    openApp: noop,
    copilotKey: () => false,
    ...over,
  };
}

function press(init: KeyboardEventInit, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Ctrl+,", () => {
  it("opens Settings, and the shell keeps the key", () => {
    const openSettings = vi.fn();
    renderHook(() => useKeyboard(actions({ openSettings })));

    expect(press({ key: ",", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("is not bound with Shift, or without Ctrl", () => {
    const openSettings = vi.fn();
    renderHook(() => useKeyboard(actions({ openSettings })));

    expect(press({ key: ",", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "," }).defaultPrevented).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("opens Settings from inside a text field, since nobody types Ctrl+,", () => {
    const openSettings = vi.fn();
    renderHook(() => useKeyboard(actions({ openSettings })));
    const field = document.body.appendChild(document.createElement("input"));

    press({ key: ",", ctrlKey: true }, field);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
