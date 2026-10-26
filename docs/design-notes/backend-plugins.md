# Backend plugins design notes

Design rationale moved out of `src-tauri/src/plugins` to keep comment
concentration under the caps in STANDARDS.md §10. Each source file below points
back at its section here.

## src-tauri/src/plugins/mod.rs

### Why this is not `discovery.rs`

That module answers a neighbouring question and answers it about different
things. It joins the `[[tool]]` pins in `veistra.toml` against the disk and reports
health — "the stack says engine 0.1.0, is it here, is it that version". Those
pins are checked into the repository and describe the *stack*. What a person has
installed is neither: it is per-user, mutable at runtime, and has no pinned
version to disagree with. Putting the two in one list would mean a health column
that is meaningless for half the rows.

### The manifest is re-read, never cached

`Registry` holds records — an id and where it came from — and resolves each one's
manifest off disk on demand. That is the property the reload loop is built on:
rebuild a plugin, and the next resolve sees the new surfaces with nothing to
invalidate.

The tempting version caches the resolved surfaces so the switcher can be drawn
without touching the disk. What it actually buys is a second source of truth that
goes stale the first time somebody rebuilds a plugin.

## src-tauri/src/plugins/broker.rs

### What the broker is

`docs/tool-protocol.md` describes two transports around one `method` and one
`params` — window messages up to the shell, standard streams down to a child
process — and the broker is the relay between them. It is a relay and not a
translator: nothing in it inspects a payload or enumerates a method, because the
vocabulary belongs to the plugin, not to the protocol.

Until this module existed that path had never run. `ToolWindow.tsx` refused a
plugin frame's `invoke` outright, naming the gap, and every host-side piece it
needed was already written and called by nothing: `veistra_rpc::ToolProcess` spawns
the child, drains its stderr, routes responses by id and reaps it on drop. So the
file is mostly lifecycle — when a core starts, when it stops, and what happens to
a call that arrives while it is neither.

### What it deliberately does not do yet

**Cross-plugin calls.** A frame reaches its *own* package's core and nothing
else. `route` takes the package id from the frame's identity — resolved by the
shell from `event.source` against its map of mounted iframes — so a plugin cannot
name another plugin's core even by trying. Widening that is where `[permissions]`
stops being reserved space, and it belongs to the pass that gives it a schema
rather than to this one.

**Notifications from a core.** `ToolProcess` collects them and nothing drains the
channel. A core that pushes an event today is talking to a queue nobody reads;
wiring that to the frontend needs an event name per plugin and a subscription in
`ToolWindow`, which is its own decision.

### Why `pty.rs` was not reused

`pty.rs` is pty-shaped throughout — `openpty`, `resize`, `TERM`, UTF-8 chunking,
a 512 KiB xterm backlog — has no `Stdio::piped` path at all, and its header
forbids anything else talking to a pty directly. `ToolProcess` already implements
the same one-thread-per-child, kill-and-wait lifecycle for the byte stream a
JSON-RPC core actually needs.

## src-tauri/src/plugins/watch.rs

### Only folder installs are watched, and that is not a limitation

A `Source::Folder` install *is* the development path: it points at a working tree
the person has open in an editor, which is exactly the case where the files
change under a running shell. Phase two's downloaded copy is a fixed set of bytes
this application extracted, and nothing but an update will touch it — so watching
one would spend a thread and a handle observing a directory that cannot change.

### What is watched, and why not the checkout

Two narrow things: `veistra-tool.toml`, and the directory holding the resolved
`core.bin`. **Not the checkout recursively** — that would put a watch over
`target/` and `node_modules/`, which between them produce thousands of events per
build, and the shell would spend a rebuild reloading a plugin over and over while
the files were still moving.

A directory watch filtered to one filename, rather than a watch on the binary
itself, because a linker does not modify a binary in place: it writes a new file
and renames it over the old one. A watch held on the old inode sees the rename
and then nothing ever again.
