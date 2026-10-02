import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "native.css"), "utf8");

// Excalidraw 0.18 variables that carry its own purple, greys and sizes.
const MAPPED = [
  "--color-primary",
  "--color-brand-hover",
  "--color-brand-active",
  "--color-selection",
  "--color-slider-track",
  "--color-slider-thumb",
  "--select-highlight-color",
  "--link-color",
  "--icon-fill-color",
  "--keybinding-color",
  "--input-hover-bg-color",
  "--default-border-color",
  "--list-border-color",
  "--color-border-outline",
  "--button-gray-1",
  "--button-gray-2",
  "--button-gray-3",
  "--default-button-size",
  "--lg-button-size",
];

describe("native.css", () => {
  it.each(MAPPED)("maps %s onto an app token", (name) => {
    const m = new RegExp(String.raw`^\s*${name}:\s*var\(--[a-z0-9-]+\);`, "m").exec(css);
    expect(m).not.toBeNull();
  });
});
