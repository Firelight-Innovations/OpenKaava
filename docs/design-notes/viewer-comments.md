# Comments on the Godot Viewer, the Blender Viewer and Play

`src-tauri/src/comments.rs` is the shared store behind the three new viewer
apps' comment panels. This is the rationale that didn't fit in its module doc
comment.

## Why files, one per comment

`docs/KAAVA-UX-REWORK.md` §3.4 sets the shape: a comment anchors to a node
path in the Godot Viewer, a mesh part and material in the Blender Viewer, or a
scene, a playhead time and a screenshot in Play — then it is a file in
`.kaava/comments/` *inside the environment*, so it travels with that
environment's branch and is visible to an agent as an ordinary tracked file,
the same way [`crate::design_comments`] is visible to the Design Mode MCP
server.

Two environments are two branches and rarely collide, but two comments left in
the same environment at nearly the same moment must not: a shared
array-plus-counter file makes that a merge conflict on every concurrent write,
where a directory of independently-named files makes it nothing at all.
`new_id` (hex milliseconds plus two random bytes) is why an id never has to be
reserved from a shared counter first.

Resolving a comment *does* rewrite its one file in place, which is the one
kind of collision this format still allows — two sides resolving the same
comment at once. That is accepted rather than designed around: it is rare (one
comment, one resolution, usually by whoever is at the keyboard) and unlike a
status field on a shared index it cannot happen on every build.

## Why no cache, unlike `design_comments`

This module is simpler than `design_comments` on purpose: that one holds one
book, cached in memory and hydrated once at launch, because it lives under the
app's own config directory and nothing else ever touches it between launches.
A `.kaava/comments/` file can change from outside this process at any moment —
a `git checkout`, another clone of the same worktree, an agent editing it
directly — so there is no cache here to go stale. Every call reads or writes
the file it needs and nothing else.

## What's not wired up yet

Only `Author::User` is reachable today — nothing yet reads `.kaava/comments/`
into an agent's turn, which is why every comment panel's "Send to agent now"
is visibly disabled with a tooltip saying so, rather than removed. `Author` has
an `Agent` variant anyway, because the file format is the one thing that must
not need to change shape the day that reading does exist — the same argument
`design_comments::Author` was written under.

`Anchor::Scene.screenshot` is likewise always `false` in this build: none of
the three viewers has a real frame to capture from yet (see each app's own
honest-empty-state notes), so nothing ever calls `create` with screenshot
bytes attached.
