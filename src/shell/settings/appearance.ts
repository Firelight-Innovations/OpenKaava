/**
 * The appearance settings, applied to the live document.
 *
 * A layer *over* `src/tokens.css`, never an edit to it. That file carries the
 * design system's own values; theme and accent are choices, so they belong in
 * a layer above rather than as an edit to the tokens' own definitions.
 */
import { useEffect } from "react";
import type { SettingsSession } from "./useSettings";
import { setTheme, type AccentName, type ThemeChangedPayload } from "../themeBroadcast";

const THEME_KEY = "appearance.theme";
const ACCENT_KEY = "appearance.accentColor";
const SANS_KEY = "appearance.interfaceFontFamily";
const MONO_KEY = "appearance.monoFontFamily";

/** What stays behind whatever the user names. Mirrors `tokens.css`. */
const SANS_FALLBACK = `system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO_FALLBACK = `ui-monospace, "Cascadia Mono", Consolas, monospace`;

const ACCENT_NAMES: readonly AccentName[] = ["amber", "blue", "green", "violet", "coral"];
const DEFAULT_ACCENT: AccentName = "amber";

/**
 * A value read off the accent setting, narrowed to a name `tokens.css`
 * actually defines a trio for.
 *
 * Anything else — the setting unset, a pre-rework hex the backend migration
 * in `schema::migrate_legacy_accent` did not recognise, a hand-edited
 * `settings.json` — falls back to Amber rather than being written into
 * `--accent` unchecked, which would point the whole interface at a custom
 * property that resolves to nothing.
 */
function narrowAccent(value: string | null): AccentName {
  return (ACCENT_NAMES as readonly string[]).includes(value ?? "")
    ? (value as AccentName)
    : DEFAULT_ACCENT;
}

/**
 * Keep the document in step with the appearance settings.
 *
 * Called once, from `App.tsx`, above the window — not from the settings screen.
 * The screen is where these are *changed*, but a window whose settings screen
 * has never been opened still has to be drawn in the theme and accent the
 * person chose.
 *
 * Also the source of the shell's own resolved theme and accent for
 * `src/shell/themeBroadcast.ts`, which is how every app iframe learns to
 * follow along — see `ToolWindow.tsx`'s relay of `kaava:theme-changed`.
 */
export function useAppearance(session: SettingsSession): void {
  useEffect(() => {
    if (!session.ready) return;
    const root = document.documentElement;
    const settings = session.groups.flatMap((group) => group.settings);
    const read = (key: string): string | null => {
      const setting = settings.find((s) => s.key === key);
      if (setting === undefined) return null;
      const value = session.valueOf(setting);
      return typeof value === "string" ? value : null;
    };

    const accent = narrowAccent(read(ACCENT_KEY));
    // Every one of `tokens.css`'s five accent trios is defined in both
    // themes; pointing these three live properties at `var(--accent-<name>)`
    // is a one-time indirection, not a value to keep in step by hand — a
    // theme switch re-resolves it for free because `--accent-<name>` itself
    // moves under `:root[data-theme="light"]`.
    root.style.setProperty("--accent", `var(--accent-${accent})`);
    root.style.setProperty("--accent-hover", `var(--accent-${accent}-hover)`);
    root.style.setProperty("--accent-subtle", `var(--accent-${accent}-subtle)`);

    const sans = read(SANS_KEY);
    if (sans !== null) root.style.setProperty("--sans", `"${sans}", ${SANS_FALLBACK}`);

    const mono = read(MONO_KEY);
    if (mono !== null) root.style.setProperty("--mono", `"${mono}", ${MONO_FALLBACK}`);

    const theme = resolveTheme(read(THEME_KEY));
    root.dataset.theme = theme;

    const payload: ThemeChangedPayload = { theme, accent };
    setTheme(payload);

    // "System" tracks `prefers-color-scheme` for as long as it is selected,
    // and stops the instant something else runs this effect again — the
    // listener is torn down on every dependency change, same as any other
    // effect subscription, so a later theme choice can never be fought by a
    // stale one still watching the OS.
    if (read(THEME_KEY) !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      const resolved: "dark" | "light" = media.matches ? "light" : "dark";
      root.dataset.theme = resolved;
      setTheme({ theme: resolved, accent });
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [session]);
}

/** "System" resolved against the OS's current preference; "dark"/"light" (or
 *  anything else unrecognised, including the setting being unset) pass
 *  through as literally "dark". Dark is the default theme, both here and in
 *  `schema.rs`'s own default. */
function resolveTheme(value: string | null): "dark" | "light" {
  if (value === "light") return "light";
  if (value === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}
