/**
 * Shell-side half of the live theme broadcast (`kaava:theme-changed`). App
 * side is `packages/bridge/src/theme.ts`.
 *
 * A leaf module directly under `src/shell/`, not inside any region, so both
 * `settings/appearance.ts` (computes the theme) and `toolwindow/ToolWindow.tsx`
 * (reaches every app iframe) can import it under ESLint's region isolation.
 *
 * Module-level pub/sub, not React context: `ToolWindow` needs the *current*
 * value the instant a frame says hello, the same "ask, then subscribe" shape
 * `kaava/publish`'s retained topics use. Scoped to one window — each Tauri
 * window is its own WebView2 with its own JS globals.
 */

/** The five accent options `docs/design/kaava-ds/tokens.json` defines. */
export type AccentName = "amber" | "blue" | "green" | "violet" | "coral";

/** What travels on `kaava:theme-changed`. Never "system" — resolved first. */
export interface ThemeChangedPayload {
  theme: "dark" | "light";
  accent: AccentName;
}

type Listener = (payload: ThemeChangedPayload) => void;

let current: ThemeChangedPayload | null = null;
const listeners = new Set<Listener>();

/** Record the resolved theme and accent, and tell every subscriber. */
export function setTheme(payload: ThemeChangedPayload): void {
  current = payload;
  listeners.forEach((cb) => cb(payload));
}

/** The last value `setTheme` saw, or `null` before the first settings read.
 *  `ToolWindow` reads this on hello, so a late-mounting app is caught up
 *  immediately rather than left waiting for the next change. */
export function currentTheme(): ThemeChangedPayload | null {
  return current;
}

/** Hear every future change; does not replay the current value. */
export function onThemeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
