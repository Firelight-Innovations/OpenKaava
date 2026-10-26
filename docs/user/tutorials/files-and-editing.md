# Browsing and editing

*Projects and files · 8 min · after [Your first project](first-project.md)*

Move around a project in the Explorer and edit it in the Viewer.

---

Two apps, deliberately. **File Explorer** is the shape of the project —
folders, and what is in them. **File Viewer** is the contents. The Explorer
never draws a file; clicking a row asks the shell for a Viewer in the same
cluster instead.

> They share one Rust half: one filesystem, one reader. A second copy of
> "read this file" would be a second chance for the two to disagree about the
> guard that keeps two writers from clobbering each other.

## Browsing

<!-- SCREENSHOT: the file explorer tree with a modified file and an added file colour-coded, 480x800 -->

_`main.rs` shown **modified**, `icon.png` shown **added** — the tree's git
colouring, no setup needed._

1. Open a **File Explorer** from the `+` in the switcher bar. It roots itself
   at the cluster's project.
2. Single-click a file. It opens in a File Viewer beside you, in a
   **preview** tab.
3. Single-click another. The preview tab is **taken over** rather than a
   second tab appearing.

That is VS Code's rule — the reason browsing a folder leaves you with one tab
instead of forty. **Double-click** the row to keep the tab, or type into it.
Either promotes it, and the next click then opens a new tab beside it rather
than throwing your work away.

<!-- SCREENSHOT: the file viewer's tab strip with three tabs open, one selected, 1440x60 -->

_Three tabs open, `main.rs` selected. A promoted preview tab joins this strip
the same way — one entry, not a growing pile._

> Middle-click a tab to close it. A file deleted from underneath an open tab
> keeps the tab — the buffer may be the last copy of it — and marks it
> **missing**.

## Changing the shape of a project

Right-click a row in the Explorer. The menu holds:

| Menu item                     | What                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| New File                      | And **New Folder**, both created inside the folder you clicked. |
| Rename                        | Edits the name in place.                                    |
| Delete                        | Moves to the system trash — see below.                      |
| Copy path                     | And **Copy relative path**, relative to the project root.   |
| Reveal in File Explorer       | Opens the OS file manager at that item.                     |
| Open with the default app     | Hands the file to whatever the OS uses for it.               |

**Delete moves to the system trash rather than removing anything**, which is
why it can be confirmed once and then trusted. Settings → **File Explorer** →
**Ask before deleting** turns the confirmation off.

> Turning that off still leaves one prompt in place: if the thing you are
> deleting has **unsaved** edits under it, Veistra asks anyway. The trash can
> give back the last _saved_ version of a file — the typing you have not
> saved is the one thing it cannot return.

If the volume has no Recycle Bin at all — some network shares and removable
drives — the delete is **refused** rather than quietly becoming permanent.

## Getting something back

The bin icon in the Explorer's header swaps the tree for a **Recycle Bin**
view, scoped to this project. It lists only things whose original location
was under the project root, not everything Windows has.

Each row names the file, the folder it came from, its size, and how long ago
it went. **Restore** puts it back where it was. **Delete** purges it for
good, behind a harder confirmation that says so — nothing in Veistra or Windows
can recover it afterwards.

> The list is a snapshot with a "Read {time}" stamp, not a live feed — a
> refresh sits beside it. Something can vanish between the listing and your
> click; Veistra says so rather than pretending it worked.

## Editing

The Viewer holds files in tabs. `Ctrl+S` saves, `Ctrl+Shift+S` saves as,
`Ctrl+D` duplicates into `name copy.ext` without ever overwriting. Undo,
redo, cut, copy, find and replace are the editor's own and work as they do
everywhere. Closing a tab with unsaved work asks **Save**, **Discard** or
**Cancel**.

> **Paste is not in the Edit menu**, deliberately — the webview refuses the
> programmatic version, so an item that only sometimes worked would be worse
> than none. `Ctrl+V` is the browser's own and is unaffected.

## When a file changes underneath you

The Viewer re-checks a file when you come back to its tab and when the window
regains focus — it has no filesystem watcher. If you had not edited it, it
quietly reloads. If you had, it asks: **Keep mine** or **Reload from disk**.

Saving over a file that changed since you opened it is **refused** rather
than done. The banner names it and offers **Reload from disk** or
**Overwrite**, so clobbering somebody else's work is a thing you choose
rather than a thing that happens.

Every `editor.*` setting — font size, tab width, wrapping, the minimap, line
numbers, whitespace — is read when an editor is **created**. Changing one
does nothing to a file already open; open another and it is there. The
setting says so under the control.

## Not everything is text

The Viewer picks how to draw a file from its extension:

Open a file → extension checked against the list → matched — image, SVG, PDF, or Mermaid → not matched — tried as text, falling back to **Unsupported** if not UTF-8

| Kind          | What                                                                    |
| -------------- | ---------------------------------------------------------------------------- |
| Images        | `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `avif` — drawn, not editable. |
| SVG           | Rendered, and it can toggle to its own source — an SVG is genuinely both.     |
| PDF           | Rendered.                                                                     |
| Mermaid       | `mmd` and `mermaid` are drawn as diagrams.                                    |
| Everything else | Tried as text, because a name cannot say whether bytes decode.             |

A file that turns out not to be valid UTF-8 falls through to an
**Unsupported** panel rather than filling the editor with replacement
characters.

> Text reads are capped — 256 KB by default, at Settings → **File Explorer**
> → **Open at most**. Past it you get the first chunk and the editor turns
> **read-only**, saying so: saving a truncated buffer would delete everything
> after the seam. Images and PDFs are not truncated at all; past a much
> larger limit they are simply refused, because truncation is only honest
> when you can see where it happened.

## Git decoration

If the project is a git repository, changed files are marked in the tree and
ignored files are dimmed, without you asking for it. The Viewer can show what
changed within a file against `HEAD`. [Git, and a worktree per
branch](git-and-worktrees.md) goes further.

---

**Takeaway:** You can move around a project without leaving forty tabs
behind, and you know which files the Viewer will not open as text.
