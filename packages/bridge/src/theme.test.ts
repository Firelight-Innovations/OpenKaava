// @vitest-environment jsdom
//
// `applyTheme` reads and writes `document.documentElement` — this package's
// `vitest.config.ts` defaults to the `node` environment (see it for why: the
// bridge is otherwise pure protocol code with no DOM), so this file opts in
// alone, the same convention the root `vitest.config.ts` documents.
import { afterEach, describe, expect, it } from "vitest";
import { accentThemeColors, applyTheme, hexWithAlpha, parseThemePayload } from "./theme.js";
import type { ThemeChangedPayload } from "./protocol.js";

describe("parseThemePayload", () => {
  it("accepts a well-formed kaava:theme-changed payload", () => {
    const payload: ThemeChangedPayload = { theme: "light", accent: "violet" };
    expect(parseThemePayload(payload)).toEqual(payload);
  });

  it.each([
    null,
    undefined,
    "dark",
    {},
    { theme: "dark" }, // no accent
    { accent: "amber" }, // no theme
    { theme: "system", accent: "amber" }, // "system" is a setting, never a wire value
    { theme: "dark", accent: "teal" }, // not one of the five options
    { theme: 1, accent: "amber" },
  ])("rejects %j", (data) => {
    expect(parseThemePayload(data)).toBeNull();
  });
});

describe("applyTheme", () => {
  afterEach(() => {
    const root = document.documentElement;
    delete root.dataset.theme;
    for (const prop of ["--accent", "--accent-hover", "--accent-subtle"]) {
      root.style.removeProperty(prop);
    }
  });

  it("stamps data-theme on <html>", () => {
    applyTheme({ theme: "light", accent: "amber" });
    expect(document.documentElement.dataset.theme).toBe("light");

    applyTheme({ theme: "dark", accent: "amber" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("points the three accent properties at the chosen option's trio, by var() indirection", () => {
    applyTheme({ theme: "dark", accent: "blue" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--accent")).toBe("var(--accent-blue)");
    expect(root.style.getPropertyValue("--accent-hover")).toBe("var(--accent-blue-hover)");
    expect(root.style.getPropertyValue("--accent-subtle")).toBe("var(--accent-blue-subtle)");
  });

  it("moves cleanly between options — nothing from the old accent survives", () => {
    applyTheme({ theme: "dark", accent: "coral" });
    applyTheme({ theme: "dark", accent: "green" });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("var(--accent-green)");
  });
});

describe("hexWithAlpha", () => {
  it("writes 8-digit hex, never rgba()", () => {
    expect(hexWithAlpha("#3f76ff", 0.25)).toBe("#3f76ff40");
    expect(hexWithAlpha("#3f76ff", 1)).toBe("#3f76ffff");
  });

  it("reads short hex and rgb() the way a computed style may hand them back", () => {
    expect(hexWithAlpha("#fff", 0)).toBe("#ffffff00");
    expect(hexWithAlpha("rgb(76, 184, 99)", 0.08)).toBe("#4cb86314");
  });

  it("falls back to the default accent, not to red, when it cannot parse", () => {
    expect(hexWithAlpha("", 1)).toBe("#3f76ffff");
    expect(hexWithAlpha("var(--nope)", 1)).toBe("#3f76ffff");
  });
});

describe("accentThemeColors", () => {
  afterEach(() => document.documentElement.style.removeProperty("--accent"));

  it("follows the live --accent rather than a fixed amber", () => {
    document.documentElement.style.setProperty("--accent", "#a585f0");
    const colors = accentThemeColors();
    expect(colors.focusBorder).toBe("#a585f0ff");
    expect(colors["editor.selectionBackground"]).toBe("#a585f040");
    expect(Object.values(colors).join(" ")).not.toContain("d98a3f");
  });
});
