/**
 * Every colour and font a chart draws with, read once from the page's own CSS
 * tokens rather than written as literals — canvas cannot read `var(--…)`, so
 * this is the one place a colour change (a new token value, a light theme)
 * reaches the charts (`docs/design/COST-TRACKER-CHARTS.md` §4.2).
 *
 * Reads the design-system names directly (`--chart-1`…`--chart-6`,
 * `--success`, `--warning`, `--danger`, `--txt-*`) — the tokens workstream
 * (#143) has landed, so there is no older name left to fall back to.
 */

export interface ChartTheme {
  /** Six series colours, in order. Series 1 always tracks `--accent`. */
  series: [string, string, string, string, string, string];
  tones: { ok: string; warn: string; err: string };
  grid: string;
  text: string;
  textDim: string;
  sans: string;
  mono: string;
  tooltipBg: string;
  tooltipBorder: string;
}

function readVar(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

/** Reads the theme fresh — call again after `kaava:theme-changed`, never cache it. */
export function readChartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  return {
    series: [
      readVar(style, "--chart-1"),
      readVar(style, "--chart-2"),
      readVar(style, "--chart-3"),
      readVar(style, "--chart-4"),
      readVar(style, "--chart-5"),
      readVar(style, "--chart-6"),
    ],
    tones: {
      ok: readVar(style, "--success"),
      warn: readVar(style, "--warning"),
      err: readVar(style, "--danger"),
    },
    grid: readVar(style, "--chart-grid"),
    text: readVar(style, "--txt-secondary"),
    textDim: readVar(style, "--txt-tertiary"),
    sans: readVar(style, "--sans") || "sans-serif",
    mono: readVar(style, "--mono") || "monospace",
    tooltipBg: readVar(style, "--bg-surface-1"),
    tooltipBorder: readVar(style, "--border-subtle-1"),
  };
}
