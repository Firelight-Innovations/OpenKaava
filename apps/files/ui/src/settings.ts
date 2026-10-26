/**
 * The settings this app reads, and the one call that fetches them.
 *
 * **Restated from `apps/viewer/ui/src/settings.ts`, deliberately.** See that
 * file's header for the argument, which is the one `./topics.ts` already makes
 * for itself: an app's only coupling to anything outside itself is
 * `@veistra/bridge` and the shape of what crosses it, and a module the two apps
 * shared would let one app's refactor break the other's build.
 *
 * Unlike `./topics.ts`, this copy is not shorter than the Viewer's. What
 * differs between the two apps is which *keys* they name — this one names
 * `files.confirmDelete` and nothing else — and the reader below is the generic
 * mechanism underneath that, which has no per-app half to trim.
 */
import { invoke } from "@veistra/bridge";

/** What a setting can hold. The three shapes the four controls produce. */
export type SettingValue = boolean | number | string;

/** Mirrors `settings::Control`, minus everything but the shipped default. */
export interface SettingControl {
  default: SettingValue;
}

/** Mirrors `settings::Setting`. */
export interface Setting {
  key: string;
  control: SettingControl;
}

/** Mirrors `settings::Group`. Only the rows in it are read here. */
export interface SettingsGroup {
  settings: Setting[];
}

/** Mirrors `settings::Snapshot`. `values` is sparse — see {@link readerFor}. */
export interface SettingsSnapshot {
  groups: SettingsGroup[];
  values: Record<string, SettingValue>;
}

/**
 * One setting's value, by key, in the type its control produces.
 *
 * Every accessor takes the value this app used before the setting existed, and
 * hands it back when the snapshot could not be fetched at all or when no group
 * on this host declares the key.
 */
export interface SettingsReader {
  toggle(key: string, fallback: boolean): boolean;
  number(key: string, fallback: number): number;
  /** Text and select alike: both cross the bridge as a plain string. */
  choice(key: string, fallback: string): string;
}

/**
 * Answered by the host itself, before any app dispatch runs — which is why
 * this is the one method here that is not `files/…`. See `apps::SETTINGS_METHOD`.
 */
const METHOD = "settings/all";

/** The in-flight or already-settled fetch. See {@link loadSettings}. */
let pending: Promise<SettingsReader> | null = null;

/**
 * Every setting this host has, read once per frame.
 *
 * Memoised rather than re-fetched. Nothing pushes `settings:changed` into a
 * mounted app frame today, so a second call would be a second round trip for
 * an answer that this frame has no way to learn has moved.
 */
export function loadSettings(): Promise<SettingsReader> {
  pending ??= invoke<SettingsSnapshot>(METHOD)
    .then(readerFor)
    .catch((err: unknown) => {
      // Once, not once per read: the memoised promise keeps the degraded
      // reader, so an app whose host cannot answer still deletes and lists
      // instead of filling the console.
      console.warn("veistra: could not read settings; falling back to this build's own", err);
      return DEGRADED;
    });
  return pending;
}

/** Every accessor answers with what its caller passed. See the `catch` above. */
const DEGRADED: SettingsReader = {
  toggle: (_key, fallback) => fallback,
  number: (_key, fallback) => fallback,
  choice: (_key, fallback) => fallback,
};

/** A reader over one fetched snapshot. The whole of what this module decides. */
function readerFor(snapshot: SettingsSnapshot): SettingsReader {
  const defaults = new Map<string, SettingValue>();
  for (const group of snapshot.groups) {
    for (const setting of group.settings) defaults.set(setting.key, setting.control.default);
  }

  /**
   * `values` is **sparse**. A setting still at its default is *absent* from the
   * map rather than present at that value, because that is what lets a later
   * build change a default and have the new one reach everyone who never
   * disagreed with the old one.
   *
   * So a missing key means "whatever the descriptor ships with", never "unset,
   * therefore false or zero". Reading it the second way is the bug this comment
   * exists to prevent, and it would be a silent one: `files.confirmDelete`
   * ships `true`, and a reader that treated its absence as `false` would delete
   * without asking for every user who never opened the settings screen.
   */
  const resolve = (key: string): SettingValue | undefined =>
    snapshot.values[key] ?? defaults.get(key);

  return {
    toggle: (key, fallback) => {
      const value = resolve(key);
      return typeof value === "boolean" ? value : fallback;
    },
    number: (key, fallback) => {
      const value = resolve(key);
      return typeof value === "number" ? value : fallback;
    },
    choice: (key, fallback) => {
      const value = resolve(key);
      return typeof value === "string" ? value : fallback;
    },
  };
}
