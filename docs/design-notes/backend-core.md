# Backend core design notes

Design rationale moved out of `src-tauri/src` to keep comment concentration under the caps in
STANDARDS.md §10. Each source file below points back at its section here.

## src-tauri/src/windows.rs

### Labels are opaque

They used to be `tool-<id>`, which made "one window per tool" true by
construction — there was no second label a second Files could have had, and
`detach` had to focus the existing window instead of building one. Labels
are now `win-<n>`, minted by `ShellState`, and carry no meaning at all.

That change has a consequence worth stating where it will be read: Tauri
scopes capabilities per window label, and `capabilities/default.json` globs
on those labels. A window whose label matches nothing there gets *no*
permissions — including `core:default`, which is what carries
`event:allow-listen`. It would mount, render, and then never receive
`shell:state`, `project:changed`, or a single byte of `pty:data:*`, with
nothing in any console to say why. The glob and this function have to be
changed together.

### Why the rectangle is applied after the build and not in the builder

`WebviewWindowBuilder::position` and `::inner_size` take **logical** pixels —
`tauri-runtime-wry` wraps both in `TaoLogicalPosition`/`TaoLogicalSize` — and
every rectangle this module deals in is physical: `geometry_of` reads
`outer_position`/`outer_size`, and `shell_store` compares against
`available_monitors`, all three of which report physical. Feeding one to the
other silently multiplied every restored window's position and size by the
display's scale factor, so on Braden's scaled monitor a window saved at
2714x1628 came back asking for something half again as large as the screen.
`set_position`/`set_size` take a `PhysicalPosition`/`PhysicalSize` and mean
it, which is why `lib.rs` already used them for `main`; this is the same
route for every other window.

The window is therefore always built hidden and shown at the end, so that
nothing is ever on screen at the wrong place for the frame between the build
and the move.

### Where a window torn off by a drag appears (`at_drop_point`)

Without this, both detach paths passed `None` and the answer was "wherever
Windows would put it". That answer is not neutral and it is not near the
cursor: tao falls back to `CW_USEDEFAULT` for a window created with no
position (`platform_impl/windows/window.rs`), and Windows cascades those from
the top-left of the **primary** monitor. So the one gesture this whole
feature exists for — drag a cluster onto the second screen — opened the new
window on the first one, every time, several hundred pixels from anything the
user was looking at. On a two-monitor desk that is indistinguishable from the
drop having done nothing at all.

Physical pixels throughout, which is why the scale factor is taken from the
monitor under the cursor rather than assumed: `DEFAULT_SIZE` is a logical
figure and `cursor_position` is physical, and the drop monitor is exactly the
one whose scaling decides how large 900x620 is in the space they have to
share. Reading it from the *primary* monitor is how a window torn off onto a
100% second screen comes out half-size on a 200% laptop panel.

### Why every close goes through `request_close`

Of the four routes a close can arrive by — the titlebar's ×, Alt+F4, the taskbar's "Close window",
and a graceful OS shutdown:

Before this lived here, only the first of those went
through bookkeeping at all; the other three reached `WindowEvent::
Destroyed` with the label never marked closing, so `reclaim_window` bailed
and the window was never removed from `ShellState` — the exact
resurrection bug `reclaim` (below) exists to prevent, reachable by a route
`close_window` could not see.

### Why `reclaim` still checks the marker

This does nothing unless the close was announced through `mark_closing` —
and even then, usually nothing at all, since `request_close` now reclaims
from `CloseRequested`, before the window actually closes, so the marker
this checks is already consumed by the time `Destroyed` lands here. What is
left is a fallback for a window the OS destroys directly, without asking it
to close first — which is also exactly why this still has to check the
marker rather than reclaim unconditionally: `WindowEvent::Destroyed` fires
for *every* window when a shutdown tears them all down that way, and a
reclaim that trusted it would collapse a three-window session into one on
the way out, and persist that as the layout to restore. See
`ShellState::closing`.

## src-tauri/src/shell_state.rs

### Why a terminal names a cluster and not a window (`TerminalSession::cluster_id`)

It named a **window** while the terminal panel was the window's
furniture: a shell opened while looking at `auth` stayed put when you
switched to `billing`, so it could watch one worktree while the layout in
front of it was about another. That was sound for the panel it was
written about — a strip down the right-hand side, beside the work.

The panel is gone. Terminals live in a band under the tool window, drawn
*inside* the cluster's half of the window, and a band showing the
window's terminals under a cluster's layout would claim the two belong
together while the state said they did not. The visible cost is the old
arrangement's own argument inverted: opening a terminal to work on `auth`
and finding it still there — same cwd, same history — under `billing` is
a shell pointed at the wrong worktree with nothing on screen to say so.

So the scope follows the drawing. A terminal belongs to the cluster whose
band holds it, spawns in that cluster's project, and is killed with it.
The cross-cluster shell the old rule protected is still expressible — put
the cluster on its own monitor, or drag the terminal into a pane — it is
no longer what every terminal gets whether it wanted it or not.

### Why the last cluster in a window may be moved out (`move_cluster_pure`)

**The last cluster in a window may be moved out**, and that is a change. It
used to be the second refusal, on the reasoning that emptying the source
window was a side effect of a gesture that had only named a destination. That
reasoning does not survive contact with the machine this feature exists for.
A window with no clusters is a legal state — `close_cluster` makes one,
`NoClustersState` draws it, and the terminal panel beside it is the window's
own and keeps working — so there was no invariant left to defend, only a
preference about what a gesture should imply. Against that preference: the
whole point of dragging a cluster onto another monitor is that the cluster
should be *there* and not *here*, and someone with one cluster open wants
that at least as much as someone with four. Refusing them meant the interface
had to hide the drag handle to avoid offering a gesture it would not honour,
so the feature simply vanished from the window where it was most obviously
wanted, with nothing on screen to say why. An empty source window is one +
away from useful; a gesture that is not offered is not discoverable at all.

### The `window_label` fixup a cluster move no longer needs (`move_cluster_pure`)

This used to rewrite a `window_label` on every
terminal held in the tree, because that field said which window's panel would
draw one, and a terminal on screen in window B claiming to belong to A's
panel landed in the wrong window the moment it was dragged out of the tree.
There is no such field now and so no such fixup.

## src-tauri/src/layout.rs

### Why the split direction has to come from the caller (`PaneNode::open_into`)

`split` carries the direction the caller measured, plus the two ids a
split needs. **The direction has to come from the caller**, and that is
the load-bearing part of this signature. The rule is "split the focused
pane along its longer axis", so a wide pane gains a right-hand column and
a tall one gains a bottom row, which keeps repeated opening from slicing
one axis into slivers. Longer *in pixels*, though: `sizes` here are
fractions of a parent, deliberately (the window is resizable and a layout
in pixels would restore wrongly onto another monitor), so a tree of
fractions cannot say which way a pane is currently drawn. Nothing in this
module may guess at it. The frontend measures the rendered pane at the
moment of the gesture and passes the answer in; `None` means it had
nothing to measure and asks for the old tab behaviour.


## src-tauri/src/review/mod.rs

### Anchored to line numbers, not to content

A note records the line range it was written against and nothing about the text
there. Edit the file and the anchor is stale: the note still lists, still
sends, and still names its original line.

The alternative is re-anchoring — keeping a snippet of the commented text and
re-finding it after each change, which is what a code-review host does because
its comments have to outlive dozens of pushes. These are meant to be written,
sent, and cleared inside one review pass, usually within a minute of the diff
being read. Over that span the anchor is almost always still right, and when it
is not, a line number the person can see is wrong is a better failure than a
note that silently moved somewhere plausible.

The cost is worth stating plainly rather than hiding: if an agent rewrites a
file while notes are open against it, those notes now point at whatever is on
those lines instead. Nothing detects that. What limits the damage is that the
note carries its own prose, so a reader can tell.

### Why the scope is part of a note's identity

`ReviewScope` is not a filter applied to a flat list. The same path at the same
line is different code in the staged view than in the unstaged one, and
different again in a worktree's divergence from its fork point. A note written
against one must not surface against another, because the line number it
carries was measured against text the other two do not have.

### Why there is no author and no thread

There are exactly two parties: the person at the keyboard, and whatever agent
they hand the note to. A name on every note would say the same thing every
time. A reply from the agent arrives as a new diff rather than as a message, so
there is nothing for a thread to hold — the second round of the conversation is
the code changing, and it shows up in the same panel.

This is the one place the model departs from the review host it is adapted
from, and it is a decision rather than an unfinished port. If Veistra ever grows
an agent surface that can talk back, a thread becomes worth having and the
model gains a parent id; nothing here forecloses that.

### Why `.veistra/` inside the checkout, and not the config directory

`project::store` puts the Recent list in the OS config directory because it is
a fact about *this machine's* history with projects. A note on a line of a diff
is the opposite: it is about that code, it travels with the branch, and a
person reviewing an agent's worktree wants the notes to be there when they open
that worktree somewhere else.

The root is resolved to the **repository** root, through the same
`git::repo_root` every other source-control command uses, and that has a second
consequence worth knowing. A cluster working in a git worktree resolves to the
worktree, so its notes stay with the branch under review rather than leaking
into the main checkout — which is exactly the per-worktree scoping the feature
wants, obtained for free from a rule that was there for a different reason.

The paths inside the file are repo-relative, so the file and the paths it holds
share one base. Resolving anywhere else would file notes against a base their
paths were never measured from.

### Why writing reports its failure when reading does not

`load` degrades to an empty list, the way `project::store::load` does: the
worst honest outcome of an unreadable file is no notes, and that is far better
than a source-control panel that refuses to draw.

`save` returns a `Result` instead, and that asymmetry is deliberate. The
Recent list losing an entry costs somebody one click. This file holds prose
somebody just typed, and a save that failed silently would leave a note on
screen that is not on disk — so every caller is a command that can put the
failure in front of them.

### One lock for the process

Veistra is single-instance but not single-*window*. Two windows can have the same
project open, so two commands can land on the same file at once, and the loser
of that read-modify-write would silently drop whichever note the winner had
just added.

A map keyed by checkout path would be the precise answer. A single lock is the
same answer for the load this actually sees, which is one file write per
sentence a person types, and it is a great deal less machinery to get wrong.
