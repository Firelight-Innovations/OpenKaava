/**
 * The three screens that cover the page area between the title bar and the
 * status bar: Settings, the app library and the keyboard shortcuts.
 *
 * All three sit at the same z-index, so one opened under another is drawn out
 * of sight while it still listens for Escape and claims the title-bar search.
 * The status bar and the shell's shortcuts stay live under a cover, so what
 * they open goes through here and leaves one screen up at a time.
 */
import { closeLibrary } from "./librarySurface";
import { closeSettings, openSettings } from "./settingsSurface";
import { closeShortcuts } from "./shortcutsSurface";

/** Takes down whichever covering screen is up. Safe when none is. */
export function closeCoveringScreens(): void {
  closeSettings();
  closeLibrary();
  closeShortcuts();
}

/** Opens Settings, taking the other two down first so it is not drawn beneath them. */
export function openSettingsOnTop(section?: string): void {
  closeLibrary();
  closeShortcuts();
  openSettings(section);
}
