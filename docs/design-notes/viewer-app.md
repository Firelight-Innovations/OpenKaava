# File Viewer — design notes

Design rationale moved out of `apps/viewer/ui/src/` to keep comment concentration under the caps in
STANDARDS.md §10. The source files point back here.

## apps/viewer/ui/src/commands.ts

### Declaring is half the feature, and the more important half

A menu that offers Save when nothing is dirty is a menu that lies. The shell cannot know when that
is, and must not learn — a shell holding a list of Files' capabilities is a shell the next app
breaks. So the direction is reversed: this app says what it can do _right now_ through
`declareCommands`, and the shell greys out everything else. `useMenuCommands` re-declares whenever
any of that changes, and the bridge drops a declaration identical to the last one so the common
re-render costs nothing.

### Why the ids are spelled out here rather than imported

They also exist in `src/shell/titlebar/TitleBar.tsx` as `APP_COMMAND`. This is the same restatement
`rpc.ts`'s header argues for and for the same reason: an app's only coupling to its host is
`@veistra/bridge` and the shape of what crosses it, and the day this becomes a tool repository of its
own, nothing in `apps/viewer/` may be reaching into `src/`. Two copies of a ten-line table is the
price of that boundary being real.

### Cut and Copy use the async clipboard, not `execCommand`

Monaco's own `editor.action.clipboardCopyAction` is a wrapper around `document.execCommand("copy")`,
which browsers only honour during a transient user activation. This command arrives by
`postMessage` from another document, which is not one — so the built-in actions would resolve and do
nothing, silently.

`navigator.clipboard.writeText` has no such requirement for a focused document, and this app already
depends on it for the context menu's "Copy path". Cut is that plus an edit that removes the text,
pushed through `executeEdits` so it lands on the undo stack as one reversible step.

With no selection, both act on the whole current line — VS Code's behaviour, and the reason these
two are worth offering without tracking the selection.

## apps/viewer/ui/src/ContextMenu.tsx

### Why Delete is here now, when this file used to argue it should not be

The original note said that half of {rename, delete, new} is worse than none, because a menu with
Delete in it teaches people the menu is where you manage files — and then set the bar Delete had to
clear: it "needs a confirmation and an undo story before it is worth having".

Both of those now exist, which is what changed rather than anyone's taste. The confirmation is
`useDelete` + `NoticeBar`: it names the file, counts a folder's contents before asking, names any
unsaved work that would be lost, puts Cancel first and focuses it, and answers Escape. The undo
story is the **Recycle Bin** — `files/delete` goes through the `trash` crate and refuses rather than
falling back to a permanent unlink, so a delete taken through this menu is recoverable by the OS.

So the objection was met on its own terms. What is still absent is any _unconfirmed_ destructive
action: nothing in this menu destroys anything on a single click, and that is the line, rather than
the length of the list.

## apps/viewer/ui/src/rpc.ts

Every call this app makes to its host, in one file.

### Why the shapes are restated rather than imported

The shapes there mirror `src-tauri/src/apps/files.rs` and are _restated_ rather than imported from
the shell's source. That is not duplication for its own sake: an app knows its host only through
`@veistra/bridge`, and the day this one is extracted into a tool repository of its own, nothing in
`apps/files/` may be reaching into `src/`. The restatement is what makes that true, and `pnpm build`
is not what catches a drift between the two — a Rust test is.

Wrapping `invoke` also means the method-name strings appear exactly once. Nothing outside that
module spells `"files/read-bytes"`.

### `write`

`baseMtime` is the mtime that came back with the read this text was edited from — pass it through
unchanged. A `null` means "the file had no readable mtime", and the backend treats that as "write
anyway", because refusing a save on a filesystem that cannot report times would make the app
unusable there rather than safer.

### `createFile` and `createDir`

`name` is one path component, and the backend refuses anything else — a separator, `..`, a character
Windows cannot store, a trailing dot it would silently drop, a name already taken. All of those come
back as rejections with a message worth showing; none of them is checked here, for the reason
`rpc.ts`'s header gives about path semantics living on one side.

### `rename`

Files and folders alike. `name` is validated exactly as a create's is, so this cannot move anything
out of its folder — a rename changes what something is called, and moving it is a different call
that does not exist yet.

Refuses rather than overwriting when the name is taken. That refusal is hand-written in the backend
rather than free, because `std::fs::rename` replaces its destination silently; see `rename_at` in
`files.rs`.

### `duplicate`

Files and folders alike; a folder takes everything under it, and a copy that fails part-way leaves
nothing behind rather than a half-filled folder with a name that says it is a duplicate. Never
overwrites: the backend reserves the destination with the same one-syscall check-and-create that
`files/create-file` uses, so there is no window in which a name that looked free stops being one.

### `saveAs`

`name` is only the dialog's suggestion — the user renames it there, and where it lands is entirely
theirs. Resolves `null` when they cancel, which is not a failure and must not be drawn as one.

No `baseMtime`, unlike `write`: there is nothing to conflict with. The user has just seen the
folder's contents, and if they chose an existing file the system dialog already asked them about
replacing it.

The default timeout does not apply. A native dialog sits open for as long as the person in front of
it takes, and `invoke`'s thirty seconds would reject a call that is going to succeed — leaving a
write in flight that nothing is waiting for. `0` is not an option (the bridge would fire
immediately), so this passes an hour, which is past any real decision and still bounded.

### `remove`

Recoverable, and the backend refuses rather than falling back to a permanent unlink when the volume
has no Recycle Bin — so `trashed` is always true today and the caller is expected to read it rather
than assume. See `delete_at` in `files.rs` for why a silent fallback would be the one outcome a
confirmation exists to prevent.

### The Recycle Bin calls

The other half of `files/delete`. Every one of these is **scoped to the open project** by the
backend: `trash/list` returns only items whose original location was inside the project root, and
restore and purge look their id up in that same scoped set. The system Recycle Bin holds everything
the user has ever deleted anywhere, and none of it but this project's is reachable from here — see
`src-tauri/src/apps/trash.rs` for why that ordering matters.

### `isNotText`

Matched on the message because the backend answers `INVALID_PARAMS` here as it does for several
other things, and a dedicated code would be a protocol change for one caller. If this ever needs to
be reliable rather than merely right, it becomes a `data.kind` like `staleWrite`.

### `toBytes`

`atob` gives a binary string — one character per byte — which is the only decoder available without
pulling in a dependency, and is fast enough for the 32 MiB the backend will hand over.

### `baseName`

Both separators are checked because a Windows path can contain either and the backend returns
whatever `Display` produced. Nothing here parses paths beyond this — the backend owns path
semantics, and a frontend that started joining them would be the second implementation of a thing
that is already hard.

## apps/viewer/ui/src/tabs/useOpenFiles.ts

### The Monaco import must stay `import type`

The numbers, so the warning is not just a warning: the Files entry chunk is 175 kB and contains no
Monaco at all (`grep -c monaco dist/assets/files-*.js` returns 0). Monaco is 3.86 MB, in a chunk
fetched only when a text file is first opened. Dropping the word `type` from line 35 moves that
3.86 MB into the 175 kB — a twenty-fold entry chunk, paid on every Files launch including the ones
that only ever look at a PNG. Nothing would fail; `tsc` and the build would both stay green. That is
exactly why it is written down here.

## apps/viewer/ui/src/topics.ts

What this app says to the File Explorer, and what it listens for back.

Three strings and two shapes. They are **restated** in `apps/files/ui/src/topics.ts` rather than
imported from one place, which is the same trade `commands.ts` makes for the menu ids and `rpc.ts`
makes for the backend's reply shapes: an app's only coupling to anything outside itself is
`@veistra/bridge` and the shape of what crosses it. A module the two apps shared would be a third
thing that has to move with either of them, and it would make one app's refactor able to break the
other's build — the failure this boundary exists to prevent.

What catches a drift is not `tsc`, then. It is that both files are short, both name the other in
this comment, and a mismatch shows up the first time anyone clicks a file.

### `ACTIVE_PATH`

Which file this app is showing. Published by File Viewer, read by File Explorer to put the "open"
treatment on a row.

`null` is a real value and is published as one — a Viewer with no tab open is saying something true,
and leaving the last path retained instead would leave a row highlighted under a closed editor.

### `DIRTY_PATHS`

Which open files have unsaved work, by path. Published by File Viewer, read by File Explorer so a
delete confirmation can still name what is about to be lost.

This is the one piece of the old single-app Files that the split genuinely took away: `App.tsx` used
to be able to ask the tab model directly. Now the question crosses a process-shaped boundary, and
the answer is a fact one app has to volunteer. Retained and replayed, so an Explorer that mounts
second is not briefly willing to delete unsaved work without saying so.

### `TREE_CHANGE`

The last thing that happened to the tree on disk. Published by whichever app did it, read by both.

A rename started in the Explorer has to move this app's tabs; a delete confirmed in this app has to
make the Explorer re-list. Both directions, one topic.

**Retained like any other topic, and that is safe here because both operations are idempotent.** A
rename replayed to a frame that has already applied it finds no tab at the old path and does
nothing; a delete replayed finds no tab under the path and does nothing. So a late-mounting Viewer
being told about a rename that happened before it existed costs a no-op, where the alternative — a
transient broadcast the shell does not retain — would have meant a third verb on the protocol for
the sake of it.

### `FILE_SAVED`

A file was written to disk.

Separate from `TREE_CHANGE` because it is not one: saving a file leaves the tree's _shape_ exactly
as it was, and the Explorer would be re-listing every open folder to learn something none of them
can tell it. What it does change is what git says about that path, which is the one thing the
Explorer refetches on this.

### `FileSaved` — what `FILE_SAVED` carries, and why it carries a counter

`publish` does not re-send a value equal to the last one it sent on that topic (`client.test.ts`
pins this: "sends a publish, and does not re-send an unchanged value"). That is right for the topics
it was built for, which are _state_ — which file is active, which buffers are dirty — where
re-announcing an unchanged answer is pure noise.

This one is an _event_, and saving the same file twice in a row is the most ordinary thing a person
does in an editor. With the path alone the second save would be silently dropped and the tree would
stop keeping up. The counter is what makes each save a distinct value, so the dedup that is correct
for state cannot swallow an event.
