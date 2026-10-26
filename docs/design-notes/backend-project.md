# Projects, in the backend — design notes

Design rationale moved out of `src-tauri/src/project/` to keep comment concentration under the caps
in STANDARDS.md §10. The source files point back here.

## src-tauri/src/project/mod.rs

### A project belongs to a cluster, not to the process

This module used to own "the open project" as a single global, stored beside the Recent list in
`projects.json`. It does not any more, and the change is the reason most of the module reads the
way it does.

**`crate::shell_state::Cluster::project` is the authority.** A cluster is one thing being worked
on, so the folder that work is in is a fact about the cluster — which means two windows on two
monitors can show two projects at the same time, and a project switch in one of them touches
nothing in the other. A global made that unexpressible rather than merely awkward: whichever window
opened something last would have re-rooted every Files in the process and retitled every window.

What is left in the module is everything that was never per-cluster. The Recent list _is_ global —
it is this machine's history with projects, not a property of any one place you are working — so it
stays in `store::Stored` and stays in `projects.json`. So does the filesystem knowledge: what makes
a folder a project, what its manifest says, whether it is still there. Opening one is still this
module's verb; it now takes the cluster it is opening _into_.

### The broadcast

Every mutator returns the whole new `ProjectSnapshot`, and Home renders the answer it got back —
Home reaches Rust over transport B, which carries request/response, and a surface that asked the
question can just read the reply.

Home is not the only surface that draws this, and the second one cannot work that way. Files
renders a tree rooted at its cluster's project and has to redraw when that changes, with no request
of its own to hang the answer off — nothing asked it anything. So `open` and `close` also emit
`PROJECT_CHANGED_EVENT`, exactly the way `ShellState` emits `shell:state`. The shell window listens
for it and forwards it into app frames as a transport-B `event` message
(`src/shell/toolwindow/ToolWindow.tsx`).

**The event names its cluster, and the relay is filtered by it.** That is not an optimisation. An
unfiltered relay would wake every Files in the process when one cluster's project changed, and each
of them would re-root itself at a project it is not in — which is precisely the bug the per-cluster
model exists to prevent, reintroduced on the way out. `ProjectChanged` therefore carries
`clusterId` alongside the snapshot, and `ToolWindow` posts it only into frames whose instance is in
that cluster.

The payload is the whole snapshot rather than a delta, for `shell:state`'s reasons: it is small, it
changes only on deliberate user action, and a subscriber can never apply half of it. A delta would
additionally oblige an app that mounted late to have heard every earlier one, which nothing here
can promise — Tauri events have no replay.

What this is not is a filesystem watcher. It fires when _which project a cluster is pointed at_
changes, and never because something inside one did. An app that needs to notice a file appearing
still has to ask again.

### Three ways to ask where a cluster is pointed

`cluster_path`, `cluster_pointer` and `cluster_root_pointer` differ on two axes: whether a worktree
outranks the project, and whether the answer is filtered by what is still on disk.

A worktree wins over the project whenever the cluster has one — see `ShellState::cluster_root` for
why. `cluster_path` returns `None` when that root is no longer on disk, on top of the plain "no
cluster, no root" cases — a caller wanting a directory to work in should not be handed a path that
was true last week.

That disk filter is why `cluster_pointer` exists beside it. The two differ on exactly one case and
it is a case that has to be drawn rather than hidden: a project whose folder has been deleted or
unplugged. `cluster_path` says "nowhere to work", which is what a terminal and a file tree need to
hear; `cluster_pointer` says "still pointed there", which is what Home needs in order to draw the
row as unavailable instead of claiming nothing is open.

`cluster_pointer` is the _project_, never the worktree — deliberately, and unlike `cluster_path`
and `cluster_root_pointer`, which follow a worktree when one is set. Home draws a deleted project's
row as unavailable rather than as closed, and the title bar names the project a cluster is _about_;
both would misreport if it followed the worktree instead. Nothing in it touches the disk, which is
also what makes it the right thing for the window title to read: retitling should not cost a `stat`
on a network share every time somebody clicks a chip.

### Why the window title is per window

The shell draws its own title bar, so `retitle` is not what the user reads inside the app — it is
what the taskbar, the alt-tab switcher, and a screen reader announce. Those are the places where
"which Veistra window is this" is a real question, and the only ones that can answer it are outside
the webview.

It used to hardcode `main`, which was correct while there was one project in the process and
silently wrong the moment there were several: two windows working on two projects would have shown
one name in the taskbar, or two entries with the same one. A window showing a cluster with no
project — or showing no cluster at all — falls back to plain "Veistra" rather than inheriting a
neighbour's name, which would be the same lie in a quieter form.
