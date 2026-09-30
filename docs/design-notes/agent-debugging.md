# Agent debugging

Why OpenKaava can be asked what it is doing, and by whom.

An agent working on this repo can read every file in it and still not know
whether the window it just changed drew two panes or four, which cluster is in
front, or that a store failed to write forty seconds ago. None of that is on
disk. This is the surface that answers those questions, and the record of what
it cost.

## src-tauri/src/diagnostics.rs

Every failure path in this crate writes a line and moves on. That is the right
shape — none of them are worth stopping for — but it means the record of a
failure is a line of stderr, and stderr is where OpenKaava's diagnostics go to die.
`main.rs` sets the `windows` subsystem in release, so a shipped build has no
console attached and every one of those lines goes to a handle nobody holds. The
frontend's `console.error` calls are worse off still: they reach a webview
console that is only open if someone opened it.

So a failure that a user or an agent could describe in a sentence is, today,
unrecoverable ten seconds later. This is the ring buffer that fixes that: the
same lines, kept in memory, readable afterwards.

### Shape

A process-wide static rather than Tauri managed state, which is the one choice
here worth defending. Managed state is reached through an `AppHandle`, and
roughly half the call sites this has to cover — `presets::store`,
`settings::store`, the parse arms in `mcp::config` — sit in functions that took a
path and an error and have no handle to reach for. Threading one into them to
record a message they already print would be a wide change in service of a
narrow feature.

A logger is also the textbook case for process-wide state: there is exactly one,
it outlives every subsystem, and nothing about it is per-app-instance.

It is bounded and lossy on purpose. A buffer that grew would turn a failure loop
— a store retrying a write to a full disk — into a memory leak on top of the
original fault. Dropping the oldest keeps the most recent failures, which are the
ones being asked about, and `Snapshot::dropped` says how many went over the side
so a reader is never quietly shown a partial history as a complete one.

### Why the stderr half is kept

`kaava_log!` prints *and* records. A debug build with a console attached is still
the fastest way to watch OpenKaava fail, and this is meant to add a second reader,
not to take the first one away.

## src/shell/diagnostics.ts

The shell reports its failures with `console.error("kaava: …", err)` in seventeen
places, and the browser reports the ones nobody caught through `error` and
`unhandledrejection`. All of it lands in a devtools console that is only open if
somebody opened it, which means the answer to "what just went wrong" is gone by
the time anyone thinks to ask. This forwards all three into `diagnostics`'s ring
buffer in Rust, which outlives the console and can be read back over MCP.

### Console output is kept, not replaced

`console.error` is wrapped rather than swapped: the original still runs first, so
devtools looks exactly as it did. A developer watching the console loses nothing,
and an agent that cannot open a console gains everything.

### What this does not see

Apps mount as iframes with their own JS context, their own `window`, and their
own console. None of their errors reach these handlers — an exception inside
Files is invisible here. Closing that gap means the same installer running inside
each app frame and forwarding over the bridge's postMessage protocol, which is a
change to a contract four apps depend on and belongs in its own pass. Until then,
treat this as covering the shell and say so, rather than reading an empty error
list as "nothing went wrong anywhere".

That caveat is repeated in the `covers` field of every `recent_errors` answer,
because the place it actually matters is in front of the model reading the list.

## src-tauri/src/mcp/servers/debug.rs

### Why this earns a server

`servers`'s rule is that a server has to answer something no harness could answer
for itself. `layout.json` is the closest thing on disk to a shell snapshot and it
is a lagging copy — written on mutation, holding what survives a restart rather
than what is on screen, and silent about every failure.

So the questions here are the ones the filesystem genuinely cannot take: what is
mounted right now, what went wrong recently, and how far boot got.

### Read-only, and staying that way

Every tool is a read. Nothing here opens, closes, moves or writes, and that is a
boundary worth keeping rather than an accident of what got built first. The
endpoint is reachable by anything on the machine holding the token, so the blast
radius of that token leaking should stay "someone learned your window layout"
rather than "someone rearranged it".

An agent that wants to *change* OpenKaava has the commands the frontend uses and a
user sitting in front of it. This is for finding out what happened.

### Why it ships in release

`debug` is registered in every build but is `dev_only`: it is served only with
`developer.mode` on and its own switch on, like `ui` and `agent`. A `cfg` would
have removed it from release entirely, which is the wrong trade:
the builds worth debugging include the release one. A shipped OpenKaava that
misbehaves on a machine none of us have is exactly the case where reading its
layout and its failures is worth the most, and a server compiled out of that
build cannot answer.

## src-tauri/src/mcp/handoff.rs

`Endpoint::env` hands the port and token to every terminal OpenKaava opens, which
covers the agent working *inside* OpenKaava and nothing else. An agent in Windows
Terminal, in an editor, or in a Claude Code session started before OpenKaava was,
inherits neither variable and has no way to ask — the values live in one
process's memory and are never written down.

That gap is the difference between "agents can debug OpenKaava" and "agents launched
a particular way can debug OpenKaava", so this writes them down.

### What this costs, stated plainly

The token is a bearer credential and this puts it in a file. Anything running as
this user can read it and call the endpoint. That is a real widening of who can
reach the MCP surface, and it is only a reasonable trade while that surface stays
read-only — which is why `servers::debug` says so in its own module doc and why a
server that mutates anything should reopen this decision rather than inherit it.

`servers::design` is the first that did. It writes, ships ungated, and the case
for that rests on what its writes can reach — a comment thread the user can read
and undo in the app, and nothing outside the comment store — rather than on
anything inherited from here. `docs/design-notes/design-comments.md` has it.

Two things bound the damage. The file goes in the app config directory, under the
user's profile, which on Windows is not readable by other standard users. And the
token is minted fresh on every launch, so a copy of this file is worthless the
moment OpenKaava restarts.

### Staleness, and why nothing deletes this

OpenKaava has no exit hook to clean up in, and adding one would mean rebuilding the
Tauri builder chain around `RunEvent` for a file that does not need it. `pid` is
the answer instead: a reader checks the process is alive before trusting the
port, exactly as `echo`'s `ping` returns a pid so a green response can be told
apart from a stale listener. A file whose pid is gone is unambiguously dead, and
its token was invalidated by the same event that killed the process.
