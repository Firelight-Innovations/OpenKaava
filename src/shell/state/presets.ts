/**
 * The frontend half of the layout presets.
 *
 * Mirrors `src-tauri/src/presets/mod.rs`. A preset is a named arrangement (the
 * split shape, which app in each pane) and it is *user data*: it lives in
 * `presets.json`, outlives its layout, and belongs to no cluster and no project.
 * Deliberately not a store, and it subscribes before it fetches — both, with
 * their full reasoning, are in docs/design-notes/shell-state.md.
 */
import { useEffect, useState } from "react";
import { applyLayoutPreset, listPresets, onPresetsChanged, saveLayoutPreset } from "../../bindings";
import type { LayoutPreset } from "../contract";

/**
 * Every preset: built-ins first, then what survives of `presets.json`. Starts
 * empty rather than `null`, like `useApps` and for its reason; a built-in can
 * never be missing, so the empty list lasts one render and never recurs.
 */
export function useLayoutPresets(): LayoutPreset[] {
  const [presets, setPresets] = useState<LayoutPreset[]>([]);

  useEffect(() => {
    let live = true;
    let settled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      unlisten = await onPresetsChanged((next) => {
        if (!live) return;
        settled = true;
        setPresets(next);
      });

      try {
        const initial = await listPresets();
        // An event arrived while that round trip was in flight, and it is newer
        // than what we asked for. Dropping it is the whole point of the flag.
        if (live && !settled) setPresets(initial);
      } catch (err: unknown) {
        // Rust degrades a broken `presets.json` to the built-ins, so reaching
        // this means the *call* failed — and an empty submenu reads as unwired.
        console.error("veistra: could not list layout presets:", err);
      }
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  return presets;
}

/**
 * Rearrange this window's active cluster to match a preset. Takes no cluster
 * id: that is the contract, not an omission — see `commands::apply_preset` and
 * docs/design-notes/shell-state.md.
 *
 * **Nothing open is closed.** Matching surfaces move into the preset's slots,
 * missing ones get fresh surfaces, the rest lands in the last pane; the rule
 * and its reasoning are in `presets::plan`.
 */
export function applyPreset(label: string, presetId: string): Promise<void> {
  return applyLayoutPreset(label, presetId);
}

/**
 * Capture the active cluster's arrangement under `name`. Resolves with nothing;
 * the new list arrives on the broadcast. Rejects with a sentence meant to be
 * *shown* — a blank name, or one the built-ins already hold — which is why the
 * caller is a field rather than a `.catch`.
 */
export async function savePreset(label: string, name: string): Promise<void> {
  await saveLayoutPreset(label, name);
}
