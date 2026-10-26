# File icons — design notes

Design rationale moved out of `packages/file-icons/src/` to keep comment concentration under the
caps in STANDARDS.md §10. The source files point back here.

## packages/file-icons/src/index.ts

File-type icons from VS Code's Material Icon Theme, shared by the Files app and the shell.

### This is a deliberate carve-out from the icon rule

`src/ui/Icon.tsx` says every glyph in the shell is hand-authored inline JSX, strokes
`currentColor`, and hardcodes no hex. These do the opposite: they are external, multi-colour, flat
SVG files loaded over a URL.

The reason is that for these icons the colour _is_ the information. A tree of fifty rows is
scanned, not read — the orange of a `.rs` against the blue-grey of a `.toml` against the yellow of
a `.json` is what lets you find the file you want without reading a single filename. Recolouring
them to `currentColor` would delete the entire point and leave fifty identical grey shapes. That is
a different argument from "an icon package is convenient", and it applies to nothing else in either
app.

So the carve-out is bounded: **file-type icons wherever a filename is listed for someone to scan,
and nowhere else.** That today means the Files tree and the search overlay's locator pane, which
lists filenames the same way. Chrome — expand chevrons, toolbar glyphs, anything that is furniture
rather than content — stays hand-authored inline SVG at `currentColor` under the existing rule.

`material-icon-theme` is MIT, and its LICENSE travels with the dependency in `node_modules`. This
app is internal and is not redistributed.

### Mechanics

The SVGs and the lookup tables are both generated at build time by `scripts/generate-file-icons.mjs`
and are not in git. Icons live in `public/icons/material/` at the repo root — the shell's public
directory, which both the shell and the Files app (mounted as an iframe under the shell) are served
from — so they resolve at `/icons/material/...` under either. Render the result as
`<img src={fileIconUrl(name)} alt="" />`.

### The Veistra icons, and why they are not in that directory

`.veistra` folders and `<project>.veistra` files are ours, and the theme has never heard of them. Their
three SVGs are hand-drawn from `assets/`, live in `public/icons/veistra/`, and are **in git** — which
is the whole point of the separate directory rather than the convenience of one.
`generate-file-icons.mjs` opens with an `rmSync` on `public/icons/material/`, so anything dropped in
there is deleted by the next `pnpm build` and, being gitignored, does not come back. A drawing
nobody can recover is a bad place to put a drawing.

They are looked up _before_ the generated tables, so an upstream theme that one day ships a `veistra`
key cannot quietly take these over.

### The mark is black, and that is deliberate

Every themed folder in the material set is a coloured body with a _lighter tint_ of the same colour
as its motive — `#4caf50` under `#c8e6c9`, and so on. These three break that convention: the body
is `--accent` `#d98a3f` and the H on it is `#000000`.

The convention does not survive this particular colour. Measured as WCAG contrast against the
`#d98a3f` the mark actually sits on:

```
#f4dcc5  a light tint, the theme's own convention   2.08:1
#ffffff  pure white                                 2.74:1
#000000  black                                      7.66:1
```

3.0:1 is the floor for a graphical object, so both light treatments are _below_ the minimum and the
black is past AAA. That is not a rounding argument — at the 16px these draw at, the light mark
disappears into the amber and the icon reads as a plain orange folder.

The amber body against what is behind it is unaffected and was never the problem: 6.09:1 on
`--surface`, 5.53:1 on the `--surface-2` a hovered or cursored row switches to.

The file icon draws the mark as its own filled path rather than knocking it out of the square, which
is the other half of the same fix. A knockout shows whatever is behind the icon, so the mark's
contrast changed with the row state — 6.09:1 at rest, 5.53:1 on hover — and would have inverted to
white on amber under any light surface. A painted mark is the same mark everywhere.

This app has one theme (there is no `prefers-color-scheme` or `data-theme` anywhere in
`src/tokens.css`), so dark is the only case there is to check. If a light theme is ever added, none
of these numbers move: the mark's background is the icon's own amber, not the page.

### `fileIconUrl` — why the extension pass walks the dots

The theme's own order: an exact filename beats an extension, and a longer extension beats a shorter
one.

The extension pass walks the dots left to right, so `component.spec.ts` tries `spec.ts` before `ts`
and lands on the test glyph. A `split(".").pop()` would only ever see `ts` — the theme's extension
keys are frequently multi-part (`spec.ts`, `d.ts`, `test.js`, `sln.dotsettings.user`) and that is
the whole reason the walk exists.

Dots at index 0 are skipped: a leading dot begins a _name_. `.gitignore` is resolved by `fileNames`,
and must never fall through to an extension lookup for `gitignore`.

### `veistraFileIcon` — a suffix test rather than a table

A suffix test rather than a table, because the basename is the _project's_ name and there is no list
of those — `Torn Apart.veistra` and `aurora.veistra` are both the same kind of file.

The dot must have something before it. `.veistra` on its own is a name, not a file with a `veistra`
extension, and it is a name the theme has no icon for either; leaving it to the generic file glyph
is the honest answer, and it is the same rule `extensionOf` in `apps/files/ui/src/rpc.ts` already
applies.

### `bareFolderName` — the decoration strip, and the 320 KB it saves

Strip the decoration a folder name may be wearing, in this order:

1. **surrounding** double underscores — `__tests__` -> `tests`. Only when the name both opens and
   closes with them, and only the one pair.
2. **leading** `.`, `_` or `-`, any number of them — `.github` -> `github`, `_shared` -> `shared`,
   `-legacy` -> `legacy`.

Order matters, and step 1 is not a special case of step 2: stripping leading characters first would
take `__tests__` to `tests__`, which is nothing. Nothing is ever stripped from the end except as the
closing half of step 1.

This exists because the theme ships every folder name in all five decorated spellings — `dev`,
`.dev`, `_dev`, `-dev`, `__dev__` — and emitting them all costs 320 KB of object literal parsed at
startup to say what these two `replace`s say. `scripts/generate-file-icons.mjs` emits only the bare
keys and holds the identical rule; the two must move together, and the script fails the build if an
alias ever disagrees with its bare form.

### `folderIconUrl` — exact before bare

Folders match on the whole name — there is no suffix rule for them.

The exact lookup runs first so a name that _is_ its own key still wins. The generator keeps any
alias whose stripped form is missing from the table (`__pycache__` with no bare `pycache`, say), and
normalising before looking up would turn those into a silent fallback to the plain folder icon.

The `.veistra` check runs before the theme, and before the decoration strip — which is the reason it
sits in the function rather than folded into the exact lookup. `.veistra` bares to `veistra`, so a theme
that ever gains a `veistra` folder would win on the second pass and this folder would stop being ours.

### `rootFolderIconUrl` — the theme ships no root overrides

The tree's root row, if it draws one. The theme has `rootFolderNames` for per-name overrides but
ships it empty in 5.37.0, so this is the plain root glyph and takes no name.
