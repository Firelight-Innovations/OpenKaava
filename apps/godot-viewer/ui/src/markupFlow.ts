/**
 * What happens to a markup once the person presses Done: whether it goes to the
 * agent at once or waits for a click, and the one-time offer to make it
 * automatic. The two settings are the host's (`godot.markupAutoSend`,
 * `godot.markupTip`); this reads them over `settings/all` and flips them over
 * `settings/set`, which the host allows for exactly these two keys.
 */
import { invoke } from "@openkaava/bridge";
import type { MarkupJson } from "@kaava/markup";

export const AUTO_SEND_KEY = "godot.markupAutoSend";
export const TIP_KEY = "godot.markupTip";

export interface MarkupPrefs {
  /** Done sends the markup to the agent straight away. */
  auto: boolean;
  /** Offer to make sending automatic after a manual send. */
  tip: boolean;
}

interface Snapshot {
  groups: Array<{ settings: Array<{ key: string; control: { default: unknown } }> }>;
  values: Record<string, unknown>;
}

/**
 * The two toggles from one `settings/all` answer. `values` is sparse: a key
 * still at its default is absent, so a miss means the shipped default (off for
 * auto-send, on for the tip), never "false".
 */
export function prefsFrom(snapshot: Snapshot): MarkupPrefs {
  const defaults = new Map<string, unknown>();
  for (const group of snapshot.groups) {
    for (const setting of group.settings) defaults.set(setting.key, setting.control.default);
  }
  const toggle = (key: string, fallback: boolean): boolean => {
    const value = snapshot.values[key] ?? defaults.get(key);
    return typeof value === "boolean" ? value : fallback;
  };
  return { auto: toggle(AUTO_SEND_KEY, false), tip: toggle(TIP_KEY, true) };
}

/**
 * Read fresh every time: the person can flip the setting on the settings screen
 * while this pane stays open, and nothing pushes the change into the frame. When
 * the host cannot answer, markup stays manual and the offer stays quiet.
 */
export async function readPrefs(): Promise<MarkupPrefs> {
  try {
    return prefsFrom(await invoke<Snapshot>("settings/all"));
  } catch {
    return { auto: false, tip: false };
  }
}

export const setPref = (key: typeof AUTO_SEND_KEY | typeof TIP_KEY, value: boolean) =>
  invoke("settings/set", { key, value });

/** Done: send now, or keep the markup and wait for the Send button. */
export function afterDone(prefs: MarkupPrefs): "send" | "keep" {
  return prefs.auto ? "send" : "keep";
}

/**
 * Whether a manual send should offer to make sending automatic: only while the
 * setting is off, the person has not said "don't show again", and not twice in
 * one session (`shownThisSession`), so closing it once is enough for now.
 */
export function offerAutomatic(prefs: MarkupPrefs, shownThisSession: boolean): boolean {
  return !prefs.auto && prefs.tip && !shownThisSession;
}

/** What the card and the previous-markup view say the drawing holds. */
export function markupSummary(json: Pick<MarkupJson, "pins" | "annotations">): string {
  const { pins, annotations } = json;
  const parts = [
    pins.length > 0 && `${pins.length} ${pins.length === 1 ? "pin" : "pins"}`,
    annotations.length > 0 &&
      `${annotations.length} ${annotations.length === 1 ? "mark" : "marks"}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "empty";
}
