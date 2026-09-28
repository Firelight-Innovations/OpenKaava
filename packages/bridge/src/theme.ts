/**
 * The app-side half of the live theme broadcast. The shell-side half —
 * `src/shell/themeBroadcast.ts` and the relay in
 * `src/shell/toolwindow/ToolWindow.tsx` — posts a `kaava:theme-changed` event
 * into this frame once on hello and again on every later change; this module
 * is what an app's bootstrap calls to hear it.
 *
 * A separate subpath (`@openkaava/bridge/theme`) rather than folded into the
 * root entry, for the reason `./protocol.js` and `./errors.js` already are:
 * a tool that has no use for it should not pay for it.
 */
import { on } from "./index.js";
import { THEME_CHANGED_EVENT, type ThemeChangedPayload } from "./protocol.js";

export type { ThemeChangedPayload } from "./protocol.js";

const THEMES = new Set(["dark", "light"]);
const ACCENTS = new Set(["amber", "blue", "green", "violet", "coral"]);

/**
 * Narrow an event payload to a `ThemeChangedPayload`, or `null` for anything
 * that is not one.
 *
 * Defensive for the reason every `kaava:*` payload in this codebase is (see
 * the validators at the bottom of `ToolWindow.tsx`): this crosses a
 * `postMessage` boundary as `unknown`, and a malformed event should leave the
 * document exactly as it was rather than write a bogus value into a custom
 * property that every component on the page reads.
 */
export function parseThemePayload(data: unknown): ThemeChangedPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const { theme, accent } = data as { theme?: unknown; accent?: unknown };
  if (typeof theme !== "string" || !THEMES.has(theme)) return null;
  if (typeof accent !== "string" || !ACCENTS.has(accent)) return null;
  return { theme: theme as ThemeChangedPayload["theme"], accent: accent as ThemeChangedPayload["accent"] };
}

/**
 * Apply a theme and accent to *this* document: `data-theme` on `<html>`,
 * plus the three accent custom properties `--accent`, `--accent-hover` and
 * `--accent-subtle` are read from everywhere else in `tokens.css`.
 *
 * Every app already loads `/src/tokens.css` (see any first-party app's `main.tsx`),
 * which declares `--accent-<name>` and `--accent-<name>-hover`/`-subtle` for
 * all five options in both themes. Pointing the three live properties at
 * `var(--accent-<name>)` is therefore enough on its own — no colour math
 * here, the same indirection `src/shell/settings/appearance.ts` uses on the
 * shell's own document.
 */
export function applyTheme(payload: ThemeChangedPayload): void {
  const root = document.documentElement;
  root.dataset.theme = payload.theme;
  root.style.setProperty("--accent", `var(--accent-${payload.accent})`);
  root.style.setProperty("--accent-hover", `var(--accent-${payload.accent}-hover)`);
  root.style.setProperty("--accent-subtle", `var(--accent-${payload.accent}-subtle)`);
}

/**
 * Hear the shell's theme and accent, applied to this document as each one
 * arrives — the first one the moment this frame connects (`ToolWindow` sends
 * one right after `ready`), and again on every later change.
 *
 * `cb` is for an app that needs to react itself — Costs re-initialising an
 * ECharts instance with the new series colours, say. `applyTheme` runs
 * whether or not one is given. Call once from an app's bootstrap
 * (`main.tsx`, alongside the `tokens.css` import). Returns the unsubscribe,
 * mainly for tests — a bootstrap module has nothing of its own to clean up.
 */
export function onThemeChanged(cb?: (payload: ThemeChangedPayload) => void): () => void {
  return on(THEME_CHANGED_EVENT, (data) => {
    const payload = parseThemePayload(data);
    if (!payload) return;
    applyTheme(payload);
    cb?.(payload);
  });
}
