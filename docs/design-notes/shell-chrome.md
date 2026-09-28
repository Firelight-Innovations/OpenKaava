# Shell chrome design notes

Design rationale moved out of the source files under `src/shell/titlebar/` and
`src/shell/switcher/` to keep comment concentration under the caps in
STANDARDS.md §10. Nothing here is a summary — each section is the prose as it
stood in the file, moved verbatim, and the source points back at this page.

## src/shell/switcher/ClusterBar.tsx

### Why every tab is here and nowhere else

Panes used to draw their own tab strips and the panel drew one for terminals,
which meant the same handful of surfaces were listed in up to three rows at
once. They are all in this row now, and those two strips are gone rather than
duplicated — a tab in two places is two things that can disagree about which
one is active, and it is twice as much bar for the same information.

What is lost with the pane strips is being able to read a split's contents off
its own header, and what replaces it is `showing`: a member that is on screen
draws lifted. With a split, that is more than one member at once, which is
honest — there really is more than one surface visible.

### Pane groups, which are not the pane strips coming back

A pane holding several surfaces draws as one grouped region here — a raised
tray with thin dividers between its members, so pane membership is something
you read rather than something you have to click to find out. It is worth
being explicit that this does **not** undo the paragraph above, because it
looks at a glance like it might.

It is also the only thing in the window that says two surfaces share a pane,
which is why the first attempt at it being too faint to see was not a
cosmetic miss: with nothing marking the pane, clicking from one of its
members to the other reads as one app replacing another rather than as a
pane showing its other tab. `switcher.css` has what changed and why.

The lesson from the pane strips was not "never show which pane a tab is in".
It was that the same surface must not be *listed twice*, because two listings
are two things that can disagree about which one is active. This is still
exactly one row, and every surface still appears in it exactly once; the row
has gained grouping that mirrors the pane tree, not a second copy of anything.
There is nothing here that can disagree with anything else, because there is
nothing else.

A pane group must also not be mistakable for a *cluster* group, which is the
outer box this one nests in. Both are drawn in the same visual language on
purpose — a region marked by a fill spanning the tabs that belong to it — and
they differ in every variable of it at once: the cluster's fill is darker
than the bar, square, full height, banded in accent along its top, and always
introduced by a named chip; a pane's is lighter, rounded, inset from the bar's
edges, unbanded, and never named. They nest rather than overlap. See
`switcher.css`.

The terminal panel keeps its `+`, its worktree toggle and its collapse
chevron. Those operate the *region*; they are not tabs, and none of them names
a session.

### Page chips, which are not clusters

The OpenKaava Cloud screens — Agents and Cost Tracker today, Projects later —
are *pages*: each one gets its own cluster, separate from every real cluster,
rather than being an app you add to a pane. Braden's brief was that they must
not be separate apps and must keep their buttons small. So they sit as a
group of chips at the left of this row, set off from the cluster chips by a
divider. Each chip shows only its icon at rest. It widens to icon and label on
hover or keyboard focus, and stays wide while its page is on screen.
`PageChips.tsx` draws them.

**Rust owns the rules, not this row.** `src-tauri/src/pages.rs` declares
which pages exist and which app draws each one. `Cluster.page` names the
page a cluster *is*. `shell_state.rs` refuses everything that would make a
page cluster anything other than one pane holding one instance of its app:
close, rename, move to another window, split, dropping a tab in, and dragging
its tab out. Each of those refusals has its own test. The chips therefore
offer none of a cluster chip's furniture: no count, no ×, no rename, no drag
handle, and no members expanding beside them. That keeps the chips honest; it
is not what enforces the rules.

**The width animates in CSS, not framer.** Hover causes no React render, so
there is nothing for a `layout` animation to hang off. The label is a
one-column grid whose track goes from `0fr` to `1fr`, which is how CSS reaches
an intrinsic width without a guessed `max-width`. The label only grows in
place, so nothing in this scroll row travels sideways. That is the row's
standing rule — see the `fade` comment in `ClusterBar.tsx`.

**While a page is in front, the window reads as having no cluster to work
in.** `WindowRoot` keeps two names apart:

- `shownCluster` is what the tool window draws.
- `activeCluster` is `null` for a page.

The band, search, the Apps menu, presets and File > Open all see `null`.
Rust's `active_cluster_of` agrees, so a new terminal has nowhere to go. The
Home takeover does not apply either: a page has no Home, and its open chip
does not toggle one.

Closing the last real cluster never lands on a page. The window shows
`NoClustersState`, with the page chips still there to click.

## src/shell/titlebar/useEditTarget.ts

### Paste is disabled on both branches

**Paste is disabled on both branches**, and this is the one item where that
is a decision rather than a consequence:

- `document.execCommand("paste")` has been refused in web content by every
  Chromium-based engine for years — it resolves `false` and does nothing.
  WebView2 is Chromium. So the field branch has no mechanism at all.
- `navigator.clipboard.readText()` is the replacement, and it is gated on the
  `clipboard-read` permission. What a Tauri v2 WebView2 window does with that
  request is not something this work could establish without running the app,
  and browser verification is unavailable in this environment.

The handoff's own instruction for exactly this case is to disable it and say
why rather than ship a Paste that silently does nothing — so it is disabled,
and the hint names Ctrl+V, which works, because it is the *browser's* paste
and never goes through this code at all. Clipboard **write** is not affected:
Cut and Copy go through `navigator.clipboard.writeText` on the app side,
which this repo already relies on in the Files context menu's "Copy path".

The shell's right-click menu takes the same decision for the same reasons, and
states it once — `contextMenu.ts`'s `PASTE_HINT` is the sentence this section
is about, and it points back here.

## src-tauri/src/webview.rs

### Why the default context menu is turned off in Rust

Right-clicking anywhere in OpenKaava used to raise Chromium's own menu: Back,
Forward, Refresh, Print, Save as, View source. None of the six is an operation
this application has. There is nothing to go back to, "Save as" offers to save
the shell's own HTML, and printing a workspace is not a thing anybody wants.

It cannot be turned off from `tauri.conf.json`. Tauri v2 has no configuration
key for it and no builder method either — WebView2 exposes it only as
`ICoreWebView2Settings::AreDefaultContextMenusEnabled`, a property on the
settings object, so reaching it means reaching the COM object. `devtools.rs`
already holds that interface for the UI-driving server, and this borrows the
same route. It is applied from a page-load hook, which is the one place that
sees the main window, the splash, and a window `windows::create` builds long
after setup has run, without any of them remembering to ask.

The alternative considered and rejected was a global `contextmenu` handler in
the shell calling `preventDefault` unconditionally. It would not have reached
inside an app's iframe — the shell's JavaScript cannot install a listener in a
document it does not own, which is the same same-origin wall
`devtools::install_script` exists to get around — so every app and plugin
surface would have kept the browser's menu. The setting belongs to the whole
WebView2 environment and so covers child frames as well.

### It suppresses the menu, not the event

`contextmenu` still fires on every element exactly as before. That is what
lets `ContextMenuHost` open at all, and it is why the Files and Viewer apps'
own right-click menus are unaffected. What changes is that a surface which
ignores the event now shows nothing rather than the browser's menu.

### A failure is logged, not fatal

A webview that will not hand over its settings object is not a reason to
refuse to start. The cost is one window where a right-click shows the
browser's menu — and `ContextMenuHost` calls `preventDefault` itself when it
opens, which covers that case for everything the shell draws. On a non-Windows
build the whole function is a no-op, for the reason `devtools.rs` keeps its
non-Windows half: a function that is absent on one platform is harder to
account for than one that does nothing there.
