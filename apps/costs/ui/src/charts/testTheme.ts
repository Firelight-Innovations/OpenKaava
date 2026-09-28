/**
 * A `ChartTheme` fixture for the option-builder tests, standing in for
 * `readChartTheme()` — those tests run in plain vitest, with no DOM to read
 * `getComputedStyle` from. Arbitrary but distinct values, so a mixed-up
 * argument (series colour where a tone belongs) would show up as a wrong
 * string rather than a coincidentally-matching one.
 */
import type { ChartTheme } from "./theme";

export const TEST_THEME: ChartTheme = {
  series: ["#5b8def", "#3fb6a8", "#8b7ef0", "#e07ad0", "#e0a83f", "#e0d23f"],
  tones: { ok: "#3fb67a", warn: "#e0a83f", err: "#e0503f" },
  grid: "#333333",
  text: "#e6e6e6",
  textDim: "#999999",
  sans: "Inter",
  mono: "IBM Plex Mono",
  tooltipBg: "#1a1a1a",
  tooltipBorder: "#444444",
};
