// @vitest-environment jsdom
//
// `useAppearance` reads and writes `document.documentElement` — this file
// opts into a DOM per `vitest.config.ts`'s docblock convention.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppearance } from "./appearance";
import { SPLASH_APPEARANCE_KEY } from "./splashAppearance";
import { currentTheme, onThemeChange } from "../themeBroadcast";
import type { Setting, SettingsGroup, SettingValue } from "../../bindings";
import type { SettingsSession } from "./useSettings";

/** A `Setting` with just enough of the shape `read()` in appearance.ts needs. */
function select(key: string, def: string): Setting {
  return {
    key,
    title: key,
    description: "",
    control: { kind: "select", default: def, options: [] },
    applies: { kind: "now" },
  } as unknown as Setting;
}

/** A ready session holding one group with the two appearance settings this
 *  hook reads, whose values are exactly what `values` says — no defaults are
 *  filled in, so a test can leave a key out to exercise the unset case. */
function fakeSession(values: Record<string, SettingValue>): SettingsSession {
  const settings = [select("appearance.theme", "dark"), select("appearance.accentColor", "blue")];
  const group: SettingsGroup = {
    id: "appearance",
    title: "Appearance",
    description: "",
    settings,
  } as unknown as SettingsGroup;

  return {
    groups: [group],
    valueOf: (setting) => values[setting.key] ?? setting.control.default,
    isChanged: () => false,
    changedIn: () => 0,
    set: vi.fn(),
    reset: vi.fn(),
    resetGroup: vi.fn(),
    error: null,
    ready: true,
  };
}

/** jsdom does not implement `matchMedia` — stub it so `prefers-color-scheme`
 *  can be driven from the test, with a real listener list so `useAppearance`'s
 *  cleanup (`removeEventListener`) is exercised rather than a no-op. */
function fakeMatchMedia(prefersLight: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: prefersLight,
    media: "(prefers-color-scheme: light)",
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    setMatches: (value: boolean) => {
      mql.matches = value;
    },
    fire: () => listeners.forEach((cb) => cb()),
  };
}

describe("useAppearance", () => {
  afterEach(() => {
    const root = document.documentElement;
    delete root.dataset.theme;
    for (const prop of ["--accent", "--accent-hover", "--accent-subtle"]) {
      root.style.removeProperty(prop);
    }
    vi.restoreAllMocks();
  });

  it("does nothing before the session is ready — a window without settings yet keeps its defaults", () => {
    fakeMatchMedia(false);
    renderHook(() => useAppearance({ ...fakeSession({}), ready: false }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("stamps data-theme and points the accent trio at the chosen option", () => {
    fakeMatchMedia(false);
    renderHook(() =>
      useAppearance(
        fakeSession({ "appearance.theme": "light", "appearance.accentColor": "violet" }),
      ),
    );
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--accent")).toBe("var(--accent-violet)");
    expect(root.style.getPropertyValue("--accent-hover")).toBe("var(--accent-violet-hover)");
    expect(root.style.getPropertyValue("--accent-subtle")).toBe("var(--accent-violet-subtle)");
  });

  it("falls back to blue for an accent value tokens.css has no trio for", () => {
    fakeMatchMedia(false);
    renderHook(() => useAppearance(fakeSession({ "appearance.accentColor": "#d98a3f" })));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("var(--accent-blue)");
  });

  it("keeps an accent the person chose explicitly, amber included", () => {
    fakeMatchMedia(false);
    renderHook(() => useAppearance(fakeSession({ "appearance.accentColor": "amber" })));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("var(--accent-amber)");
  });

  it("mirrors the raw theme setting and the accent for the splash window", () => {
    fakeMatchMedia(true);
    localStorage.removeItem(SPLASH_APPEARANCE_KEY);
    renderHook(() =>
      useAppearance(
        fakeSession({ "appearance.theme": "system", "appearance.accentColor": "coral" }),
      ),
    );
    expect(JSON.parse(localStorage.getItem(SPLASH_APPEARANCE_KEY) ?? "null")).toEqual({
      theme: "system",
      accent: "coral",
    });
  });

  it("resolves 'system' against the OS preference, and follows it live", () => {
    const media = fakeMatchMedia(true); // OS prefers light
    renderHook(() => useAppearance(fakeSession({ "appearance.theme": "system" })));
    expect(document.documentElement.dataset.theme).toBe("light");

    media.setMatches(false); // the OS switches to dark
    act(() => media.fire());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("publishes the resolved theme and accent onto themeBroadcast, for ToolWindow to relay", () => {
    fakeMatchMedia(false);
    const seen: unknown[] = [];
    const unsubscribe = onThemeChange((payload) => seen.push(payload));
    renderHook(() =>
      useAppearance(fakeSession({ "appearance.theme": "dark", "appearance.accentColor": "green" })),
    );
    expect(currentTheme()).toEqual({ theme: "dark", accent: "green" });
    expect(seen).toEqual([{ theme: "dark", accent: "green" }]);
    unsubscribe();
  });

  it("tears down its 'system' listener when the theme changes away from it", () => {
    const media = fakeMatchMedia(false);
    const { rerender } = renderHook(({ session }) => useAppearance(session), {
      initialProps: { session: fakeSession({ "appearance.theme": "system" }) },
    });
    rerender({ session: fakeSession({ "appearance.theme": "dark" }) });
    // No assertion beyond "this does not throw": the real regression this
    // guards is a listener from an earlier render firing after a later one
    // set a different theme, overwriting it back — see the effect's own
    // comment in appearance.ts.
    act(() => media.fire());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
