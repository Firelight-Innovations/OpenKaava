/**
 * Every colour and font a chart draws with, read once from the page's own CSS
 * tokens rather than written as literals — canvas cannot read `var(--…)`, so
 * this is the one place a colour change (a new token value, a light theme)
 * reaches the charts (`docs/design/COST-TRACKER-CHARTS.md` §4.2).
 *
 * Reads the new design-system names (`--chart-1`…`--chart-6`, `--success`,
 * `--warning`, `--danger`, `--txt-*`) with the pre-rework names as a fallback,
 * since the tokens workstream lands them in a separate PR and this app must
 * draw something sensible either side of that merge. `readVar` tries each
 * name in order and takes the first non-empty value.
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

function readVar(style: CSSStyleDeclaration, ...names: string[]): string {
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value) return value;
  }
  return "";
}

/** Reads the theme fresh — call again after `kaava:theme-changed`, never cache it. */
export function readChartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  return {
    series: [
      readVar(style, "--chart-1", "--accent"),
      readVar(style, "--chart-2", "--graph-blue"),
      readVar(style, "--chart-3", "--graph-teal"),
      readVar(style, "--chart-4", "--graph-violet"),
      readVar(style, "--chart-5", "--graph-pink"),
      readVar(style, "--chart-6", "--warning", "--warn"),
    ],
    tones: {
      ok: readVar(style, "--success", "--ok"),
      warn: readVar(style, "--warning", "--warn"),
      err: readVar(style, "--danger", "--err"),
    },
    grid: readVar(style, "--chart-grid", "--line"),
    text: readVar(style, "--txt-secondary", "--text"),
    textDim: readVar(style, "--txt-tertiary", "--text-dim"),
    sans: readVar(style, "--sans") || "sans-serif",
    mono: readVar(style, "--mono") || "monospace",
    tooltipBg: readVar(style, "--bg-surface-1", "--surface-2", "--surface"),
    tooltipBorder: readVar(style, "--border-subtle-1", "--line-2"),
  };
}
