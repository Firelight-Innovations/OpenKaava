// @vitest-environment jsdom
/**
 * The three covering screens share one z-index, so the shell keeps one up at a
 * time. These pin that Ctrl+,'s path raises Settings over the other two rather
 * than beneath them, and that the status bar's path takes all three down.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { closeCoveringScreens, openSettingsOnTop } from "./coveringScreens";
import { openLibrary, useLibrarySurface } from "./librarySurface";
import { useSettingsSurface } from "./settingsSurface";
import { openShortcuts, useShortcutsSurface } from "./shortcutsSurface";

function screens() {
  return renderHook(() => ({
    settings: useSettingsSurface(),
    library: useLibrarySurface().open,
    shortcuts: useShortcutsSurface().open,
  }));
}

afterEach(() => {
  act(() => closeCoveringScreens());
});

describe("openSettingsOnTop", () => {
  it("takes Shortcuts down, so Settings is not opened beneath it", () => {
    const { result } = screens();
    act(() => openShortcuts());
    act(() => openSettingsOnTop());
    expect(result.current.shortcuts).toBe(false);
    expect(result.current.settings.open).toBe(true);
  });

  it("takes the library down too, and keeps the requested section", () => {
    const { result } = screens();
    act(() => openLibrary());
    act(() => openSettingsOnTop("mcp"));
    expect(result.current.library).toBe(false);
    expect(result.current.settings).toEqual({ open: true, section: "mcp" });
  });
});

describe("closeCoveringScreens", () => {
  it("takes every covering screen down", () => {
    const { result } = screens();
    act(() => {
      openSettingsOnTop();
      openLibrary();
      openShortcuts();
    });
    act(() => closeCoveringScreens());
    expect(result.current).toEqual({
      settings: { open: false, section: null },
      library: false,
      shortcuts: false,
    });
  });
});
