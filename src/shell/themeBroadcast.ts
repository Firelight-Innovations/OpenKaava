/**
 * The shell-side half of the live theme broadcast (`kaava:theme-changed`).
 * The app-side half — `onThemeChanged`, and the helper that applies a payload
 * to an app's own document — is `packages/bridge/src/theme.ts`.
 *
 * A leaf module directly under `src/shell/`, not inside any region — ESLint's
 * region isolation (`REGIONS` in `eslint.config.js`) lets every region import
 * exactly these, and this one exists because `src/shell/settings/appearance.ts`
 * (where the resolved theme and accent are computed) and
 * `src/shell/toolwindow/ToolWindow.tsx` (the only thing that can reach every
 * app iframe) are two different regions that otherwise could not see each
 * other at all.
 *
 * A tiny module-level pub/sub rather than React context, because `ToolWindow`
 * needs to read the *current* value the instant a frame says hello — not just
 * hear about a future change — which is the same "ask for what's current,
 * then subscribe" shape `kaava/publish`'s retained topics already use one
 * level up, across the postMessage boundary.
 *
 * Scoped to one window. Each OS window Tauri opens is its own WebView2
 * instance with its own JS globals, so this module's state is never shared
 * across windows — and does not need to be: `useAppearance` runs once per
 * window (see its own doc comment) and only ever has to reach the app frames
 * mounted in that same window's `ToolWindow`.
 */

/** The five accent options `docs/design/kaava-ds/tokens.json` defines. */
export type AccentName = "amber" | "blue" | "green" | "violet" | "coral";

/** What travels on `kaava:theme-changed`. Never carries "system" — that is a
 *  setting, not a colour, and is resolved to one of these two before this is
 *  built. */
export interface ThemeChangedPayload {
  theme: "dark" | "light";
  accent: AccentName;
}

type Listener = (payload: ThemeChangedPayload) => void;

let current: ThemeChangedPayload | null = null;
const listeners = new Set<Listener>();

/**
 * Record the resolved theme and accent, and tell every current subscriber.
 * Called once, from `useAppearance`, whenever either changes.
 */
export function setTheme(payload: ThemeChangedPayload): void {
  current = payload;
  listeners.forEach((cb) => cb(payload));
}

/**
 * The last value `setTheme` was called with, or `null` before the first
 * settings read in this window has landed. `ToolWindow` reads this once when
 * a frame says hello, so a late-mounting app is caught up immediately rather
 * than left waiting for the next change — the same reason `kaava/publish`'s
 * topics are replayed on handshake.
 */
export function currentTheme(): ThemeChangedPayload | null {
  return current;
}

/**
 * Hear every future change. Does not replay the current value — a caller that
 * needs it too reads `currentTheme()` once, before or after subscribing.
 */
export function onThemeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
