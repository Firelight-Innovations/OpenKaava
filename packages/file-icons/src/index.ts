/**
 * File-type icons from VS Code's Material Icon Theme, shared by the Files app and the shell.
 * Resolves a name to a URL; render as `<img src={fileIconUrl(name)} alt="" />`. It is a bounded
 * carve-out from `src/ui/Icon.tsx`'s rule that every glyph is hand-authored inline JSX at
 * `currentColor`, because here the colour *is* the information: file-type icons wherever a
 * filename is listed to be scanned, and nowhere else — chrome stays inline SVG at `currentColor`.
 * The colour argument in full, the MIT licence, the generated `public/icons/material/` against
 * the hand-drawn `public/icons/veistra/`, and the contrast measurements behind the black Veistra
 * mark are in `docs/design-notes/file-icons.md`.
 */

import {
  defaultIcons,
  fileExtensions,
  fileNames,
  folderNames,
  folderNamesExpanded,
} from "./manifest.generated.js";

/** Root-relative, so it resolves the same under Vite and under Tauri's asset host. */
const BASE = "/icons/material/";

/** The hand-drawn half. Tracked in git, unlike `BASE`; the docs page says why. */
const VEISTRA_BASE = "/icons/veistra/";

/** Veistra's own directory inside a project. Matched exactly, dot and all. */
const VEISTRA_FOLDER = ".veistra";

/** The project file's extension, with its dot, ready to test a name's tail. */
const VEISTRA_EXTENSION = ".veistra";

/**
 * The Veistra glyph for a file, or `null` to let the theme answer. A suffix test rather than a
 * table, because the basename is the *project's* name and there is no list of those. The dot
 * must have something before it: bare `.veistra` is a name, not a `veistra` extension, and falls
 * through to the generic file glyph — the rule `extensionOf` in `apps/files/ui/src/rpc.ts` uses.
 */
function veistraFileIcon(lower: string): string | null {
  if (lower.length <= VEISTRA_EXTENSION.length) return null;
  if (!lower.endsWith(VEISTRA_EXTENSION)) return null;
  return `${VEISTRA_BASE}veistra.svg`;
}

/**
 * The theme's order: an exact filename beats an extension, a longer extension beats a shorter one.
 * The pass walks the dots left to right, so `component.spec.ts` tries `spec.ts` before `ts`;
 * `split(".").pop()` would see only `ts`, and the theme's extension keys are often multi-part
 * (`spec.ts`, `d.ts`, `sln.dotsettings.user`). Dots at index 0 are skipped: a leading dot begins
 * a *name*, so `.gitignore` is resolved by `fileNames`, never by an extension lookup for it.
 */
export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const veistra = veistraFileIcon(lower);
  if (veistra) return veistra;

  const exact = fileNames[lower];
  if (exact) return BASE + exact;

  for (let i = lower.indexOf(".", 1); i !== -1; i = lower.indexOf(".", i + 1)) {
    const byExtension = fileExtensions[lower.slice(i + 1)];
    if (byExtension) return BASE + byExtension;
  }

  return BASE + defaultIcons.file;
}

/**
 * Strip a folder name's decoration: surrounding double underscores (`__tests__` -> `tests`, one
 * pair, both ends required), then any run of leading `.`, `_` or `-`. Nothing else comes off the
 * end. Order matters — leading-first would take `__tests__` to `tests__`, which is nothing. The
 * alternative, emitting the theme's five decorated spellings of every name, costs 320 KB of
 * object literal parsed at startup; `scripts/generate-file-icons.mjs` holds the identical rule,
 * must move with this one, and fails the build if an alias disagrees with its bare form.
 */
function bareFolderName(name: string): string {
  return name.replace(/^__(.+)__$/, "$1").replace(/^[._-]+/, "");
}

/**
 * Folders match on the whole name — there is no suffix rule for them. The exact lookup runs
 * first so a name that *is* its own key still wins: the generator keeps any alias whose stripped
 * form is missing from the table (`__pycache__` with no bare `pycache`), and normalising first
 * would turn those into a silent fallback to the plain folder icon.
 */
export function folderIconUrl(name: string, expanded: boolean): string {
  const table = expanded ? folderNamesExpanded : folderNames;
  const lower = name.toLowerCase();

  // Before the theme and before the decoration strip below, which is why it is here rather than
  // folded into the exact lookup: `.veistra` bares to `veistra`, so a theme that ever gains a `veistra`
  // folder would win the second pass and this folder would stop being ours.
  if (lower === VEISTRA_FOLDER) {
    return `${VEISTRA_BASE}folder-veistra${expanded ? "-open" : ""}.svg`;
  }

  const exact = table[lower];
  if (exact) return BASE + exact;

  const bare = bareFolderName(lower);
  if (bare && bare !== lower) {
    const stripped = table[bare];
    if (stripped) return BASE + stripped;
  }

  return BASE + (expanded ? defaultIcons.folderExpanded : defaultIcons.folder);
}

/**
 * The tree's root row, if it draws one. The theme has `rootFolderNames` for per-name overrides
 * but ships it empty in 5.37.0, so this is the plain root glyph and takes no name.
 */
export function rootFolderIconUrl(expanded: boolean): string {
  return BASE + (expanded ? defaultIcons.rootFolderExpanded : defaultIcons.rootFolder);
}
