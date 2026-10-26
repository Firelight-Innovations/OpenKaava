/**
 * The settings screen's data.
 *
 * Fetched once, then subscribed — the same shape `useLayoutPresets` uses and for
 * the same reason: Tauri events have no replay buffer, so a window that only
 * subscribed would sit on an empty screen until somebody changed something.
 * Subscribe first, then fetch, and discard the fetch if an event beat it home.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  onSettingsChanged,
  resetSetting,
  resetSettingsGroup,
  setSetting,
  settingsSnapshot,
  type Setting,
  type SettingValue,
  type SettingsGroup,
  type SettingsSnapshot,
} from "../../bindings";

export interface SettingsSession {
  groups: SettingsGroup[];
  /**
   * What every setting currently holds, defaults filled in.
   *
   * **The only correct reader.** The values map is sparse — a setting at its
   * default is absent rather than present at that value, which is what lets a
   * later build change a default and have it reach everyone who never disagreed
   * with the old one. A miss means "at its default", never "off".
   */
  valueOf: (setting: Setting) => SettingValue;
  /** Whether a setting has been moved off its default — what draws the dot. */
  isChanged: (key: string) => boolean;
  /** How many settings in one group have been changed. Zero disables its reset. */
  changedIn: (group: SettingsGroup) => number;
  set: (setting: Setting, value: SettingValue) => void;
  reset: (setting: Setting) => void;
  resetGroup: (group: SettingsGroup) => void;
  /**
   * The last refusal, as a sentence to show. Cleared by the next successful
   * write. Non-null means the value on screen has already been rolled back.
   */
  error: string | null;
  /** False until the first snapshot lands, so the screen can hold its frame. */
  ready: boolean;
}

export function useSettings(): SettingsSession {
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [values, setValues] = useState<Record<string, SettingValue>>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the backend last confirmed, which is what an optimistic write rolls
  // back to. Held in a ref rather than in state because nothing renders from it
  // — it only has to be correct at the moment a write fails, and a re-render on
  // every confirmation would be a re-render for no visible reason.
  const confirmed = useRef<Record<string, SettingValue>>({});

  useEffect(() => {
    let live = true;
    let settled = false;
    let unlisten: (() => void) | undefined;

    const adopt = (next: Record<string, SettingValue>) => {
      confirmed.current = next;
      setValues(next);
    };

    void (async () => {
      unlisten = await onSettingsChanged((next) => {
        if (!live) return;
        settled = true;
        adopt(next);
      });

      try {
        const snapshot: SettingsSnapshot = await settingsSnapshot();
        if (!live) return;
        setGroups(snapshot.groups);
        setReady(true);
        // An event arrived while that round trip was in flight, and it is newer
        // than what we asked for. Dropping it is the whole point of the flag —
        // but only for the *values*: the groups are this build's schema and
        // cannot have changed under us.
        if (!settled) adopt(snapshot.values);
      } catch (err: unknown) {
        // Reaching here means the *call* failed rather than the store being
        // unreadable — Rust degrades a broken `settings.json` to the defaults
        // on its own. Worth seeing: the symptom is a screen that never fills
        // in, which looks like a feature nobody wired up.
        console.error("veistra: could not load the settings:", err);
      }
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  const valueOf = useCallback(
    (setting: Setting): SettingValue => values[setting.key] ?? setting.control.default,
    [values],
  );

  const isChanged = useCallback((key: string) => key in values, [values]);

  const changedIn = useCallback(
    (group: SettingsGroup) => group.settings.filter((s) => s.key in values).length,
    [values],
  );

  const set = useCallback((setting: Setting, value: SettingValue) => {
    // Optimistic, because a round trip per keystroke makes a text field lag the
    // typing. The backend's answer replaces this a moment later — with the same
    // value, or a clamped one, so the reconcile is a real step — and a refusal
    // rolls back to what was last confirmed rather than to the descriptor's
    // default, which would discard an earlier change the user made and kept.
    setValues((current) => ({ ...current, [setting.key]: value }));

    void setSetting(setting.key, value)
      .then((stored) => {
        setError(null);
        setValues((current) => ({ ...current, [setting.key]: stored }));
      })
      .catch((err: unknown) => {
        setError(String(err));
        setValues((current) => {
          const rolled = { ...current };
          const was = confirmed.current[setting.key];
          if (was === undefined) delete rolled[setting.key];
          else rolled[setting.key] = was;
          return rolled;
        });
      });
  }, []);

  const reset = useCallback((setting: Setting) => {
    setValues((current) => {
      const cleared = { ...current };
      delete cleared[setting.key];
      return cleared;
    });
    void resetSetting(setting.key).catch((err: unknown) => setError(String(err)));
  }, []);

  const resetGroup = useCallback((group: SettingsGroup) => {
    setValues((current) => {
      const cleared = { ...current };
      for (const setting of group.settings) delete cleared[setting.key];
      return cleared;
    });
    void resetSettingsGroup(group.id).catch((err: unknown) => setError(String(err)));
  }, []);

  return useMemo(
    () => ({ groups, valueOf, isChanged, changedIn, set, reset, resetGroup, error, ready }),
    [groups, valueOf, isChanged, changedIn, set, reset, resetGroup, error, ready],
  );
}
