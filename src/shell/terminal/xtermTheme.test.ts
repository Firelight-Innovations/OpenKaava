// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildTheme } from "./XTermView";

describe("xterm theme", () => {
  afterEach(() => {
    const root = document.documentElement;
    for (const name of ["--surface", "--text", "--text-dim"]) root.style.removeProperty(name);
  });

  it("is rebuilt from the live tokens, so light gives a light terminal", () => {
    const root = document.documentElement;
    root.style.setProperty("--surface", "#141415");
    root.style.setProperty("--text", "#e4e6e6");
    expect(buildTheme().background).toBe("#141415");

    root.style.setProperty("--surface", "#ffffff");
    root.style.setProperty("--text", "#0f0f10");
    const light = buildTheme();
    expect(light.background).toBe("#ffffff");
    expect(light.foreground).toBe("#0f0f10");
  });
});
