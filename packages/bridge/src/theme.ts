/**
 * App-side half of the live theme broadcast. The shell side —
 * `src/shell/themeBroadcast.ts` plus the relay in `ToolWindow.tsx` — posts a
 * `kaava:theme-changed` event into this frame on hello and on every later
 * change; this module is what an app's bootstrap calls to hear it.
 *
 * A separate subpath (`@openkaava/bridge/theme`), like `./protocol.js` and
 * `./errors.js`: a tool with no use for it should not pay for it.
 */
import { on } from "./index.js";
import { THEME_CHANGED_EVENT, type ThemeChangedPayload } from "./protocol.js";

export type { ThemeChangedPayload } from "./protocol.js";

const THEMES = new Set(["dark", "light"]);
const ACCENTS = new Set(["amber", "blue", "green", "violet", "coral"]);

/** Narrow an event payload to a `ThemeChangedPayload`, or `null`. Defensive
 *  like every `kaava:*` validator: this crosses `postMessage` as `unknown`,
 *  and a malformed event should leave the document untouched. */
export function parseThemePayload(data: unknown): ThemeChangedPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const { theme, accent } = data as { theme?: unknown; accent?: unknown };
  if (typeof theme !== "string" || !THEMES.has(theme)) return null;
  if (typeof accent !== "string" || !ACCENTS.has(accent)) return null;
  return {
    theme: theme as ThemeChangedPayload["theme"],
    accent: accent as ThemeChangedPayload["accent"],
  };
}

/** Apply a theme and accent to *this* document: `data-theme` on `<html>`,
 *  plus `--accent`/`--accent-hover`/`--accent-subtle` pointed at
 *  `var(--accent-<name>)` — no colour math, since `tokens.css` (already
 *  loaded) declares those for all five options in both themes. */
export function applyTheme(payload: ThemeChangedPayload): void {
  const root = document.documentElement;
  root.dataset.theme = payload.theme;
  root.style.setProperty("--accent", `var(--accent-${payload.accent})`);
  root.style.setProperty("--accent-hover", `var(--accent-${payload.accent}-hover)`);
  root.style.setProperty("--accent-subtle", `var(--accent-${payload.accent}-subtle)`);
}

/** Hear the shell's theme and accent, applied to this document as each one
 *  arrives (once on connect, then on every change). `cb` is for an app that
 *  needs to react itself, e.g. Costs re-initialising ECharts; `applyTheme`
 *  runs regardless. Call once from a bootstrap; the return is mainly for
 *  tests. */
export function onThemeChanged(cb?: (payload: ThemeChangedPayload) => void): () => void {
  return on(THEME_CHANGED_EVENT, (data) => {
    const payload = parseThemePayload(data);
    if (!payload) return;
    applyTheme(payload);
    cb?.(payload);
  });
}

/** The blue accent's dark-theme value, used only when `--accent` cannot be read
 *  as a colour (no stylesheet loaded, an unresolved `var()`). Blue is the
 *  default accent, so this is what an untouched settings file would resolve to. */
const FALLBACK_ACCENT = "#3f76ff";

/** Parse `#rgb`, `#rrggbb` or `rgb(r, g, b)` into channels, or `null`. */
function channelsOf(css: string): [number, number, number] | null {
  const value = css.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return short.slice(1, 4).map((h) => parseInt(h + h, 16)) as [number, number, number];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(value);
  if (long) return long.slice(1, 4).map((h) => parseInt(h, 16)) as [number, number, number];
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

/**
 * `css` as the 8-digit `#RRGGBBAA` Monaco wants, at `alpha` (0 to 1).
 *
 * Never `rgba()`: Monaco parses a theme colour with `parseHex(hex) || Color.red`,
 * so a valid CSS `rgba()` string silently becomes opaque red. An unparseable
 * `css` falls back to the default accent rather than to red.
 */
export function hexWithAlpha(css: string, alpha: number): string {
  const [r, g, b] = channelsOf(css) ?? (channelsOf(FALLBACK_ACCENT) as [number, number, number]);
  const byte = (n: number) => n.toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${byte(Math.round(alpha * 255))}`;
}

/**
 * The Monaco theme colours that follow the accent, read from the live `--accent`
 * so a Monaco theme built from them tracks the setting.
 *
 * Monaco takes colour strings, not `var()`, so the resolved value has to be read
 * here and the theme redefined whenever the accent changes — `onThemeChanged`'s
 * callback (apps) and `themeBroadcast.onThemeChange` (shell) are the two hooks.
 * The alphas are the ones `tokens.css` uses for `--accent-wash` (0.08) and
 * `--accent-line` (0.45).
 */
export function accentThemeColors(): Record<string, string> {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  return {
    "editor.selectionBackground": hexWithAlpha(raw, 0.25),
    "editor.inactiveSelectionBackground": hexWithAlpha(raw, 0.12),
    "editor.selectionHighlightBackground": hexWithAlpha(raw, 0.08),
    "editorCursor.foreground": hexWithAlpha(raw, 1),
    "editorBracketMatch.border": hexWithAlpha(raw, 0.45),
    "editorSuggestWidget.highlightForeground": hexWithAlpha(raw, 1),
    focusBorder: hexWithAlpha(raw, 1),
  };
}

/** The Monaco base theme for a resolved shell theme: dark gets `vs-dark`,
 *  light gets `vs`, so syntax token colours flip along with the chrome. */
export function monacoBase(theme: "dark" | "light"): "vs" | "vs-dark" {
  return theme === "light" ? "vs" : "vs-dark";
}

/** The theme this document is showing, read from `<html data-theme>`. Dark is
 *  the default, as in `tokens.css`. */
export function currentDocumentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Which Excalidraw/xterm/Monaco-style theme name a shell theme maps to. */
export function surfaceTheme(theme: "dark" | "light"): "dark" | "light" {
  return theme === "light" ? "light" : "dark";
}

/** One live token as `#RRGGBBAA`, at `alpha`. */
function tokenHex(name: string, alpha = 1): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return hexWithAlpha(raw, alpha);
}

/**
 * Every Monaco colour that is not the accent, built from the live `tokens.css`
 * values so a theme switch only has to call this again. Replaces three
 * hand-copied dark-only hex tables; the alphas are the ones those tables used.
 */
export function monacoBaseColors(): Record<string, string> {
  const t = (name: string, alpha = 1) => tokenHex(name, alpha);
  return {
    "editor.background": t("--surface"),
    "editor.foreground": t("--text"),
    "editorGutter.background": t("--surface"),
    "editorLineNumber.foreground": t("--text-faint"),
    "editorLineNumber.activeForeground": t("--text-dim"),
    "editor.lineHighlightBackground": t("--bg-layer-1"),
    "editor.lineHighlightBorder": t("--bg-layer-1"),

    "editor.findMatchBackground": t("--warn", 0.35),
    "editor.findMatchHighlightBackground": t("--warn", 0.18),
    "editor.findRangeHighlightBackground": t("--warn", 0.08),

    "editorBracketMatch.background": t("--bg-layer-2"),
    "editorIndentGuide.background1": t("--line"),
    "editorIndentGuide.activeBackground1": t("--line-2"),
    "editorWhitespace.foreground": t("--line-2"),
    "editorRuler.foreground": t("--line"),
    "editorOverviewRuler.border": t("--line"),

    "scrollbarSlider.background": t("--line-2", 0.5),
    "scrollbarSlider.hoverBackground": t("--line-2", 0.7),
    "scrollbarSlider.activeBackground": t("--line-2"),

    "minimap.background": t("--surface"),
    "minimapSlider.background": t("--line-2", 0.3),
    "minimapSlider.hoverBackground": t("--line-2", 0.5),
    "minimapSlider.activeBackground": t("--line-2", 0.7),

    "editorWidget.background": t("--bg-layer-2"),
    "editorWidget.foreground": t("--text"),
    "editorWidget.border": t("--line"),
    "editorHoverWidget.background": t("--bg-layer-2"),
    "editorHoverWidget.border": t("--line"),
    "editorSuggestWidget.background": t("--bg-layer-2"),
    "editorSuggestWidget.border": t("--line"),
    "editorSuggestWidget.foreground": t("--text"),
    "editorSuggestWidget.selectedBackground": t("--bg-layer-1-selected"),
    "menu.background": t("--bg-layer-2"),
    "menu.foreground": t("--text-dim"),
    "menu.border": t("--line"),
    "menu.selectionBackground": t("--bg-layer-1-selected"),
    "menu.selectionForeground": t("--text"),
    "list.hoverBackground": t("--bg-layer-1-hover"),
    "input.background": t("--surface"),
    "input.foreground": t("--text"),
    "input.border": t("--line-2"),

    "editorError.foreground": t("--err"),
    "editorWarning.foreground": t("--warn"),
    "editorInfo.foreground": t("--text-dim"),
  };
}

/** The full Monaco theme body (base plus colours) for the current document. */
export function monacoThemeData(): {
  base: "vs" | "vs-dark";
  colors: Record<string, string>;
} {
  return {
    base: monacoBase(currentDocumentTheme()),
    colors: { ...monacoBaseColors(), ...accentThemeColors() },
  };
}
