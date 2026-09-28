// @vitest-environment jsdom
//
// `applyTheme` reads and writes `document.documentElement` — this package's
// `vitest.config.ts` defaults to the `node` environment (see it for why: the
// bridge is otherwise pure protocol code with no DOM), so this file opts in
// alone, the same convention the root `vitest.config.ts` documents.
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, parseThemePayload } from "./theme.js";
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
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      "var(--accent-green)",
    );
  });
});
