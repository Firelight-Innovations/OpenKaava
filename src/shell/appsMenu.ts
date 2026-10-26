/**
 * The Apps menu and its Presets branch — the single definition of both. Only the
 * list is here; where it is drawn stays with each region. Directly under
 * `src/shell/` rather than inside `titlebar/` because two regions draw it, and
 * STANDARDS.md §1.2 lets a region import nothing but `contract.ts` — a shared
 * menu kept inside either one would make the other reach across.
 */
import type { Openable } from "../bindings";
import type { LayoutPreset, Menu, MenuItem } from "./contract";
// Called, not passed in as a handler like everything else here: the library is
// a module-scope surface so that anything may raise it without a prop threaded
// down. `settingsSurface.ts` is its twin, raised the same way.
import { openLibrary } from "./librarySurface";

/**
 * The Apps menu: what this build ships, as things you can open another of.
 * `available` comes from Rust, so an app added in `apps::REGISTRY` appears
 * without a second edit in a file whose author would have no reason to look.
 *
 * **A terminal is one of the rows, and it is not an app** — it comes from
 * `apps::openables`, not the app list, and `open` routes on `Openable.kind`,
 * which is why the whole entry is handed back rather than its id. Full account
 * in `docs/design-notes/shell-core.md`.
 */
export interface AppsMenuHandlers {
  available: Openable[];
  /** Opens a new one. There is no "already open" to disable it for. */
  open: (entry: Openable) => void;
  /**
   * Why nothing here can be opened right now, or `undefined` when it can.
   *
   * One reason exists, and it is not about any app: a surface opens into a
   * *pane*, and a window whose clusters have all been closed has none. The
   * backend refuses such an open, so without this every entry would silently do
   * nothing — the one thing the menu may not do (see `MenuItem.disabled`). One
   * string for the whole list, because the obstacle is the window's and every
   * app hits it identically; it disables the presets too, and correctly, since a
   * window with no cluster has nothing to rearrange or capture.
   */
  blocked?: string;
  /** The presets branch. See [`PresetsMenuHandlers`]. */
  presets: PresetsMenuHandlers;
}

/**
 * The Presets submenu: apply one, or save the arrangement you are looking at.
 *
 * Carried on `AppsMenuHandlers` rather than as a menu of its own — the argument
 * for that, and what it saves `ClusterBar`, is in `docs/design-notes/shell-core.md`.
 */
export interface PresetsMenuHandlers {
  /** The merged list from Rust: the built-ins, then the user's own. */
  available: LayoutPreset[];
  /** Rearranges the active cluster. Never closes anything — see `presets::plan`. */
  apply: (presetId: string) => void;
  /** Capture the active cluster under this name. Rejects with a sentence to show
   *  under the field — a blank name, or one of the built-ins'. The menu shows it
   *  and stays open; see `MenuPrompt`. */
  save: (name: string) => Promise<void>;
  /** What the name field starts with. The cluster's own name. */
  suggestedName: string;
}

/**
 * The Apps menu — **the** definition of it, and the only one. Two hand-built
 * lists would agree today and disagree the first time an app is added to the
 * registry — one surface would show it, the other would not, and nothing would
 * fail. `switcher/AddAppButton.tsx` hands the same items to the same
 * `MenuItemList` the menu bar does, because one function builds the list.
 *
 * Where Apps sits, why the apps are a flat list, and why presets are the
 * exception that gave `MenuItem` its `submenu`: `docs/design-notes/shell-core.md`.
 */
export function appsMenu(apps: AppsMenuHandlers): Menu {
  return {
    label: "Apps",
    items: [
      ...apps.available.map((entry) => ({
        label: entry.name,
        onSelect: () => apps.open(entry),
        disabled: apps.blocked !== undefined,
        // The registry's description says nothing the label does not, except on
        // the Terminal row: the panel below has a `+` that makes a terminal too.
        hint: apps.blocked ?? entry.description,
      })),
      {
        label: "Presets",
        separatorBefore: true,
        submenu: presetItems(apps.presets, apps.blocked),
        disabled: apps.blocked !== undefined,
        hint:
          apps.blocked ??
          "Arrangements you can drop onto this cluster: which panes, and what goes in each.",
      },
      // The way to get *more* rows in this list, so it sits under them. No
      // `disabled: apps.blocked` — that is deliberate, not an omission: this
      // one opens nothing into a cluster. Both points in
      // `docs/design-notes/shell-core.md`.
      {
        label: "App Library…",
        separatorBefore: true,
        onSelect: openLibrary,
        hint: "Install apps from the library, from a GitHub repository, or from a folder.",
      },
    ],
  };
}

/**
 * The rows inside Presets: every preset, then the one that makes another.
 *
 * Built-ins first because Rust merges them first, and the separator before the
 * user's own is drawn only when there *are* any — a separator with nothing under
 * it promises a section. Save is last and behind its own separator, the only row
 * that does not rearrange anything; it carries the prompt rather than raising a
 * dialog (see `MenuPrompt` for why not `window.prompt`).
 */
function presetItems(presets: PresetsMenuHandlers, blocked?: string): MenuItem[] {
  const firstUser = presets.available.findIndex((preset) => !preset.builtin);

  return [
    ...presets.available.map((preset, i) => ({
      label: preset.name,
      onSelect: () => presets.apply(preset.id),
      separatorBefore: i === firstUser && i > 0,
      disabled: blocked !== undefined,
      hint:
        blocked ??
        (preset.builtin
          ? undefined
          : // Worth saying on a user's own rows, not the built-ins': someone who
            // saved this knows what is in it, not that applying it keeps the rest.
            "Rearranges this cluster. Nothing open is closed — anything the preset does not mention moves to the last pane."),
    })),
    {
      label: "Save Current Layout…",
      separatorBefore: true,
      disabled: blocked !== undefined,
      hint: blocked ?? "Captures this cluster's panes and which app is in each.",
      prompt: {
        label: "Save this cluster's panes, and which app is in each, as a preset.",
        placeholder: "Preset name",
        initialValue: presets.suggestedName,
        confirmLabel: "Save",
        onSubmit: presets.save,
      },
    },
  ];
}
