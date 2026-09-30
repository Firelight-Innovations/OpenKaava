// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboard, type KeyboardActions } from "./useKeyboard";

/** Every action a no-op, so the two cluster ones can be watched. */
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
    toggleSourceControl: noop,
    toggleTerminal: noop,
    toggleFullscreen: noop,
    zoomIn: noop,
    zoomOut: noop,
    newTerminal: noop,
    splitTerminal: noop,
    switchProject: noop,
    openApp: noop,
    copilotKey: () => false,
    ...over,
  };
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

afterEach(cleanup);

describe("cluster chords", () => {
  it("Ctrl+Tab goes to the next cluster and Ctrl+Shift+Tab to the previous, and the shell keeps the key", () => {
    const cycleCluster = vi.fn();
    renderHook(() => useKeyboard(actions({ cycleCluster })));

    expect(press({ key: "Tab", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "Tab", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(cycleCluster.mock.calls).toEqual([[1], [-1]]);
  });

  it("leaves a plain Tab to focus navigation", () => {
    const cycleCluster = vi.fn();
    renderHook(() => useKeyboard(actions({ cycleCluster })));

    expect(press({ key: "Tab" }).defaultPrevented).toBe(false);
    expect(press({ key: "Tab", shiftKey: true }).defaultPrevented).toBe(false);
    expect(cycleCluster).not.toHaveBeenCalled();
  });

  it("Ctrl+1…9 still picks the nth cluster, zero-based", () => {
    const selectToolByIndex = vi.fn();
    renderHook(() => useKeyboard(actions({ selectToolByIndex })));

    press({ key: "1", ctrlKey: true });
    press({ key: "9", ctrlKey: true });
    expect(selectToolByIndex.mock.calls).toEqual([[0], [8]]);
  });
});
