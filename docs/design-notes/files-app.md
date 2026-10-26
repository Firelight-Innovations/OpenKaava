# File Explorer

Design rationale moved out of `apps/files/ui/src/` to keep comment concentration
under the caps in STANDARDS.md §10. The source files point back here.

## apps/files/ui/src/topics.ts

**Restated from `apps/viewer/ui/src/topics.ts`, deliberately.** See that
file's header for the argument; the short version is that an app's only
coupling to anything outside itself is `@veistra/bridge` and the shape of what
crosses it, and a module the two apps shared would let one app's refactor
break the other's build.

This copy carries only what the Explorer actually uses, which is why it is
shorter than the Viewer's: this app publishes `TREE_CHANGE` and subscribes to
all three, but it has no active path and no dirty buffers of its own to
announce.

`isAtOrUnder` is a third copy of the same predicate — the Viewer's
`tabs/useOpenFiles.ts` has one and so does the backend. It travels with the code
that needs it rather than being lifted somewhere both apps import, for the reason
above.

## apps/files/ui/src/commands.ts

### Two apps, two declarations, and no coordination between them

There is a second copy of this file in `apps/viewer/ui/src/`, answering the
commands that act on an open buffer — Save, Save As, Duplicate, Undo. This
one answers the two that act on the *tree*.

Nothing had to be built for that to work, and nothing in the title bar knows
the split happened. The shell aims a command at whichever surface is active
and greys out everything that surface has not declared, so the menu is simply
the union of what the active frame offered. Click into the tree and New File
lights up; click into an editor and Save does. That falls out of
`veistra/commands` being a declaration rather than a registry, which is the
property its design note in `docs/tool-protocol.md` argues for.

### The one thing this app gave up

`file/delete` is declared by the Viewer, not here, and so a menu-bar Delete
acts on the open file rather than on the tree's cursor. That is a real
narrowing from the single-app version, and it is deliberate rather than
missed: the tree's cursor is `explorer/Explorer.tsx`'s own state and reaching
it would mean a third method on `ExplorerHandle`. Right-click > Delete on a
row is unaffected and is how a folder gets deleted either way.

## apps/files/ui/src/ContextMenu.tsx

### Why Delete is here now, when this file used to argue it should not be

The original note said that half of {rename, delete, new} is worse than none,
because a menu with Delete in it teaches people the menu is where you manage
files — and then set the bar Delete had to clear: it "needs a confirmation and
an undo story before it is worth having".

Both of those now exist, which is what changed rather than anyone's taste.
The confirmation is `useDelete` + `NoticeBar`: it names the file, counts a
folder's contents before asking, names any unsaved work that would be lost,
puts Cancel first and focuses it, and answers Escape. The undo story is the
**Recycle Bin** — `files/delete` goes through the `trash` crate and refuses
rather than falling back to a permanent unlink, so a delete taken through this
menu is recoverable by the OS.

So the objection was met on its own terms. What is still absent is any
*unconfirmed* destructive action: nothing in this menu destroys anything on a
single click, and that is the line, rather than the length of the list.
