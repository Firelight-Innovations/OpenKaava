# Kaava

Kaava is Veistra's agentic development environment: a desktop IDE shell (Tauri + React) that hosts clusters of panes, terminals running coding agents, and project-wide pages such as Plane, Git, cost and cloud agents. This system keeps Kaava's own layout and uses **Plane CE's visual language**: Plane's neutrals, its canvas → surface → layer model and its 28px control ladder. Kaava's own additions are the amber accent and the kaava-fruit mark. Kaava embeds Plane in a webview, so the neutrals match Plane exactly, and the seam between the two disappears.

Dark is the primary theme. Light is a full second theme with the same token names.

## Content fundamentals

- **Plain and exact.** Labels say what a thing is: "Source control", "Commit 2 files", "Plane asleep". Status words beat colour: every badge carries a word.
- **Sentence case** for titles, tabs and buttons. Uppercase is reserved for the `label` style (11px section labels such as STAGED CHANGES).
- **Descriptions tell you what happens**, in one sentence. For example: "What Kaava offers the coding agents running in its terminals." "Switching this off leaves the servers running and unreachable."
- **Numbers get units and context**: "3 changes", "+39 −6 · 3 files", "Waking plane-vm · 42 s".
- **Name the product "Kaava"** everywhere in the UI. The product name lives in `branding.toml`. The wire names (`kaava.toml`, `@openkaava/*`, `kaava-<id>`) never change.

## Visual foundations

**The window is five bands:** title bar (38px), app switcher (40px), the workspace, an optional bottom panel, and the status bar (26px). The title bar, switcher and status bar sit directly on `bg-canvas`. Every workspace region (tool window, editor, terminals, right panel) is a `bg-surface-1` block with a 1px `border-subtle` edge and `radius-region` (10px), separated by a 6px canvas gutter (`space-1-5`). Regions are siblings and never nest.

**Depth by layers, not shadows.** Inside a region, rows and inputs use `bg-layer-1`, hover uses `bg-layer-1-hover` and selection uses `bg-layer-1-selected`. Selection is a fill only: no coloured side bars or edge stripes on rows, cards or list items. Menus and the active switcher tab use `bg-layer-2`. Shadows appear only on raised things (`shadow-raised`: the active switcher tab, a dragged tab) and overlays (`shadow-overlay`: menus, palette, toasts, dialogs).

**Accent is a user setting.** Amber (`accent`) is the default, with Blue, Green, Violet and Coral as options. The accent draws the active editor tab's 2px underline, focus rings (2px at 45% alpha, offset 2), drop targets and the primary button. It never fills large areas. Text on an accent fill is `txt-on-accent`: dark in the dark theme, white in the light theme.

**Status colours** (`success`, `warning`, `danger`, `info`, `state-idle`) appear as a 6px dot plus a tinted `*-subtle` fill with `txt-*` text. Git status uses the same four as 18px letter chips (M warning, A success, D danger, U info). File names are never coloured by status.

**Type.** Inter for the interface, IBM Plex Mono for code, paths, hashes and ports. 13px is the workhorse (`body`, `body-strong`). Settings titles use `h1` (24px), setting names `h2` (16px), descriptions `caption` (12px).

**Controls** follow Plane's ladder: `control-md` (28px) is the default, with `control-sm` 24, `control-lg` 32, `control-xl` 36 and `control-2xl` 40. Horizontal padding is (height − 8) / 2. Controls use `radius-md` (6px), menus and switcher tabs `radius-lg` (8px), the palette and dialogs `radius-xl` (12px).

**Motion** is short and functional: 120–160ms opacity or transform. Nothing animates in its steady state. Everything respects `prefers-reduced-motion`. React Bits components may be used only on the splash, Home, onboarding and toasts; never in trees, editors, terminals or diffs.

## Iconography

Lucide icons at 16px with a 1.5px stroke, drawn in `txt-tertiary` (the current colour of the control). Use 14px inside dense pills and 20px only at the `control-2xl` rung. Icon-only buttons always carry an `aria-label`. File-type icons stay as the existing `packages/file-icons` set.

## The mark

The kaava fruit: `mark-skin` outer body, `mark-flesh` inner body and `mark-seed` seed, with the inner shapes stroked in the ground colour at 0.9. Its colours are brand colours and never appear in the interface. On light grounds use the `-light` values. Files are in the Logos group. The monochrome `kaava-mark.svg` draws the seed as a hole, so it survives greyscale and a 15px title bar.

## Rules

1. `bg-canvas` once per window. Regions are `bg-surface-1`, and siblings.
2. surface → layer-1 → layer-2 → layer-3. Hover matches its base layer.
3. Never hardcode a hex in a component: every value is a token.
4. Borders separate regions. Shadows are only for raised and overlay elements.
5. Text is `txt-tertiary` or stronger on every surface. `txt-disabled` is only for things that are truly disabled.
6. Colour is never the only signal: dots come with words, and git letters come with the chip shape.
