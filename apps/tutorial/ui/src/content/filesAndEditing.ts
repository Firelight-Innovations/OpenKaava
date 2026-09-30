import type { Body } from "./blocks";

/**
 * The two file apps, and the rule between them: the Explorer never draws a
 * file's contents, and the Viewer never browses.
 *
 * The preview-tab rule gets a heading of its own because it is the behaviour
 * most likely to look like a bug — a tab that replaces itself is alarming until
 * you know it is deliberate.
 */
export const filesAndEditing: Body = {
  takeaway:
    "You can move around a project without leaving forty tabs behind, and you know which files the Viewer will not open as text.",
  blocks: [
    {
      kind: "text",
      body: "Two apps, deliberately. **File Explorer** is the shape of the project — folders, and what is in them. **File Viewer** is the contents. The Explorer never draws a file; clicking a row asks the shell for a Viewer in the same cluster instead.",
    },
    {
      kind: "note",
      body: 'They share one Rust half: one filesystem, one reader. A second copy of "read this file" would be a second chance for the two to disagree about the guard that keeps two writers from clobbering each other.',
    },

    { kind: "heading", body: "Browsing" },
    {
      kind: "mock",
      view: "explorer-tree",
      caption:
        "`main.rs` shown **modified**, `icon.png` shown **added** — the tree's git colouring, no setup needed.",
    },
    {
      kind: "step",
      body: "Open a **File Explorer** from the **Apps** menu. It roots itself at the cluster's project.",
    },
    {
      kind: "step",
      body: "Single-click a file. It opens in a File Viewer beside you, in a **preview** tab.",
    },
    {
      kind: "step",
      body: "Single-click another. The preview tab is **taken over** rather than a second tab appearing.",
    },
    {
      kind: "text",
      body: "That is VS Code's rule — the reason browsing a folder leaves you with one tab instead of forty. **Double-click** the row to keep the tab, or type into it. Either promotes it, and the next click then opens a new tab beside it rather than throwing your work away.",
    },
    {
      kind: "mock",
      view: "viewer-tabs",
      caption:
        "Three tabs open, `main.rs` selected. A promoted preview tab joins this strip the same way — one entry, not a growing pile.",
    },
    {
      kind: "note",
      body: "Middle-click a tab to close it. A file deleted from underneath an open tab keeps the tab — the buffer may be the last copy of it — and marks it **missing**.",
    },

    { kind: "heading", body: "Changing the shape of a project" },
    {
      kind: "text",
      body: "Right-click a row in the Explorer. The menu holds:",
    },
    {
      kind: "keys",
      rows: [
        {
          chord: "New File",
          what: "And **New Folder**, both created inside the folder you clicked.",
        },
        { chord: "Rename", what: "Edits the name in place." },
        { chord: "Delete", what: "Moves to the system trash — see below." },
        { chord: "Copy path", what: "And **Copy relative path**, relative to the project root." },
        { chord: "Reveal in File Explorer", what: "Opens the OS file manager at that item." },
        {
          chord: "Open with the default app",
          what: "Hands the file to whatever the OS uses for it.",
        },
      ],
    },
    {
      kind: "text",
      body: "**Delete moves to the system trash rather than removing anything**, which is why it can be confirmed once and then trusted. Settings → **File Explorer** → **Ask before deleting** turns the confirmation off.",
    },
    {
      kind: "note",
      body: "Turning that off still leaves one prompt in place: if the thing you are deleting has **unsaved** edits under it, OpenKaava asks anyway. The trash can give back the last *saved* version of a file — the typing you have not saved is the one thing it cannot return.",
    },
    {
      kind: "text",
      body: "If the volume has no Recycle Bin at all — some network shares and removable drives — the delete is **refused** rather than quietly becoming permanent.",
    },

    { kind: "heading", body: "Getting something back" },
    {
      kind: "text",
      body: "The bin icon in the Explorer's header swaps the tree for a **Recycle Bin** view, scoped to this project. It lists only things whose original location was under the project root, not everything Windows has.",
    },
    {
      kind: "text",
      body: "Each row names the file, the folder it came from, its size, and how long ago it went. **Restore** puts it back where it was. **Delete** purges it for good, behind a harder confirmation that says so — nothing in OpenKaava or Windows can recover it afterwards.",
    },
    {
      kind: "note",
      body: 'The list is a snapshot with a "Read {time}" stamp, not a live feed — a refresh sits beside it. Something can vanish between the listing and your click; OpenKaava says so rather than pretending it worked.',
    },

    { kind: "heading", body: "Editing" },
    {
      kind: "text",
      body: "The Viewer holds files in tabs. `Ctrl+S` saves, `Ctrl+Shift+S` saves as, `Ctrl+D` duplicates into `name copy.ext` without ever overwriting. Undo, redo, cut, copy, find and replace are the editor's own and work as they do everywhere. Closing a tab with unsaved work asks **Save**, **Discard** or **Cancel**.",
    },
    {
      kind: "note",
      body: "**Paste is not in the Edit menu**, deliberately — the webview refuses the programmatic version, so an item that only sometimes worked would be worse than none. `Ctrl+V` is the browser's own and is unaffected.",
    },

    { kind: "heading", body: "When a file changes underneath you" },
    {
      kind: "text",
      body: "The Viewer re-checks a file when you come back to its tab and when the window regains focus — it has no filesystem watcher. If you had not edited it, it quietly reloads. If you had, it asks: **Keep mine** or **Reload from disk**.",
    },
    {
      kind: "text",
      body: "Saving over a file that changed since you opened it is **refused** rather than done. The banner names it and offers **Reload from disk** or **Overwrite**, so clobbering somebody else's work is a thing you choose rather than a thing that happens.",
    },
    {
      kind: "text",
      body: "Every `editor.*` setting — font size, tab width, wrapping, the minimap, line numbers, whitespace — is read when an editor is **created**. Changing one does nothing to a file already open; open another and it is there. The setting says so under the control.",
    },

    { kind: "heading", body: "Not everything is text" },
    {
      kind: "text",
      body: "The Viewer picks how to draw a file from its extension:",
    },
    {
      kind: "flow",
      steps: [
        "Open a file",
        "extension checked against the list",
        "matched — image, SVG, PDF, or Mermaid",
        "not matched — tried as text, falling back to **Unsupported** if not UTF-8",
      ],
    },
    {
      kind: "keys",
      rows: [
        {
          chord: "Images",
          what: "`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `avif` — drawn, not editable.",
        },
        {
          chord: "SVG",
          what: "Rendered, and it can toggle to its own source — an SVG is genuinely both.",
        },
        { chord: "PDF", what: "Rendered." },
        { chord: "Mermaid", what: "`mmd` and `mermaid` are drawn as diagrams." },
        {
          chord: "Everything else",
          what: "Tried as text, because a name cannot say whether bytes decode.",
        },
      ],
    },
    {
      kind: "text",
      body: "A file that turns out not to be valid UTF-8 falls through to an **Unsupported** panel rather than filling the editor with replacement characters.",
    },
    {
      kind: "note",
      body: "Text reads are capped — 256 KB by default, at Settings → **File Explorer** → **Open at most**. Past it you get the first chunk and the editor turns **read-only**, saying so: saving a truncated buffer would delete everything after the seam. Images and PDFs are not truncated at all; past a much larger limit they are simply refused, because truncation is only honest when you can see where it happened.",
    },

    { kind: "heading", body: "Git decoration" },
    {
      kind: "text",
      body: "If the project is a git repository, changed files are marked in the tree and ignored files are dimmed, without you asking for it. The Viewer can show what changed within a file against `HEAD`. **Git, and a worktree per branch** goes further.",
    },
  ],
};
