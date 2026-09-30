/**
 * The theme and accent, handed to the splash window.
 *
 * `splash.html` is standalone and paints before any settings have loaded, so
 * it cannot ask for them. It shares an origin with the shell instead, which
 * means a value written to `localStorage` here is readable there
 * synchronously, before first paint. The shell writes it every time
 * `useAppearance` applies the settings; the splash reads it in its `<head>`.
 */
import type { AccentName } from "../themeBroadcast";

/** Read by the inline script in `splash.html` under this exact name. */
export const SPLASH_APPEARANCE_KEY = "kaava.splash-appearance";

/** `system` is kept as itself: the splash resolves it against the OS on its own. */
export type SplashTheme = "dark" | "light" | "system";

/** Anything other than light or system is dark, matching `resolveTheme`. */
export function narrowSplashTheme(value: string | null): SplashTheme {
  return value === "light" || value === "system" ? value : "dark";
}

/** The value stored under `SPLASH_APPEARANCE_KEY`. */
export function serializeSplashAppearance(themeSetting: string | null, accent: AccentName): string {
  return JSON.stringify({ theme: narrowSplashTheme(themeSetting), accent });
}

/** Best effort: storage can be unavailable, and a splash without it is merely neutral. */
export function mirrorSplashAppearance(themeSetting: string | null, accent: AccentName): void {
  try {
    localStorage.setItem(SPLASH_APPEARANCE_KEY, serializeSplashAppearance(themeSetting, accent));
  } catch {
    // Nothing to recover: the next launch simply starts neutral.
  }
}
