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
  return { theme: theme as ThemeChangedPayload["theme"], accent: accent as ThemeChangedPayload["accent"] };
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
