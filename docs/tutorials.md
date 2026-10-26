# Tutorials

How the Tutorials app is put together, and how to add to it.

This is the companion to `docs/settings.md`. The two features are shaped alike
on purpose — a registry of `&'static` data in Rust, a frontend generated from it
— and the one place they deliberately differ is where the *content* lives. §2 is
that difference and its reasoning.

---

## 1. The two halves

| Half | Lives in | Holds |
|---|---|---|
| Catalog | `src-tauri/src/apps/tutorial.rs` | Which tutorials exist: id, section, title, blurb, minutes, reading order |
| Prose | `apps/tutorial/ui/src/content/` | The words, as typed block data |
| Progress | `tutorials.json`, OS config dir | Which ids have been marked done |

The catalog is in Rust because **Home draws it too**. The right-hand column of
the first screen anybody sees is the first few unfinished tutorials, and a second
copy of the list over there would be a second place to add a tutorial and a first
place to forget to. Home asks `home/tutorials`; the app asks `tutorial/catalog`.
One list, two readers.

The seam between the halves is an id. A catalog entry with no body in `content/`
renders an honest "not written yet" panel rather than failing, and a body with no
catalog entry is simply never reached. Neither is an error, which is what lets
the two be edited in either order.

## 2. Why the prose is not in Rust

`settings::schema` put its descriptors in Rust and this puts its words in
TypeScript, and those are the same decision rather than two.

A setting's descriptor is *data about a control*: a default, a range, a list of
options that Rust has to validate a write against. Rust is the only place that
can own it, because Rust is the side that has to refuse a bad value.

A tutorial's body is a paragraph, a numbered step, and a key chord drawn as a
`<kbd>`. That is a view. Holding it in Rust would mean:

- six thousand words in string literals, with `rustfmt` reflowing prose it
  cannot read;
- a markup language invented in `tutorial.rs` so the frontend could tell a step
  from a note, with a parser to maintain and no error message when somebody
  gets it wrong;
- every word crossing the IPC boundary on every catalog read, to be rendered by
  a component that could have imported it.

The catalog crosses the wire. The words never need to.

## 3. The block format

`apps/tutorial/ui/src/content/blocks.ts` declares a closed set of block kinds. A
tutorial is an array of them plus a one-sentence `takeaway`.

| Kind | Draws as | Use for |
|---|---|---|
| `text` | A paragraph | Most of any tutorial |
| `heading` | A sub-heading | Sections inside one tutorial |
| `step` | A numbered row, optionally with a chord | One thing to do |
| `note` | An indented aside | True and useful, but not a step |
| `soon` | An aside tagged **Not yet** | Something Veistra does not do |
| `code` | A monospace block | A command, or a file's contents |
| `keys` | A two-column table | Chords, or any short glossary |
| `mock` | A static picture of Veistra's UI, with an optional caption | Showing a part of the interface instead of describing it |
| `flow` | Steps in a row, joined by `→` | A short path, where numbering would overstate the ceremony |

Steps are numbered by position at render time, not by hand, so inserting one in
the middle does not mean renumbering the rest.

### Markdown was considered and rejected

A tutorial in an IDE is mostly *instructions*, and instructions want to look
different from prose. Markdown can express none of that without conventions
layered on top of it — and once a heading level means "this is a step", the
format is no longer Markdown, it is a dialect with a parser to maintain. Here a
malformed tutorial is a type error.

Two things are still borrowed from Markdown, inside a block's own text:
`**bold**` and `` `code` ``. `Inline.tsx` is the whole of that parser. Nothing
else is supported, deliberately — a nesting rule is the point at which this would
have to become a real one.

**Backticks do not nest and are not escaped.** A paragraph mentioning the
backquote key cannot wrap it in backticks; say "the key under Escape", or put the
chord in a `step`'s `chord` field, where `Keys` renders it properly.

### The `soon` block is load-bearing

It is its own kind rather than a `note` with different words, because it is the
block a tutorial is most likely to be **wrong** about later. One that looks
distinct is one somebody notices when it stops being true.

Every use of it names what is missing rather than promising when it arrives. A
tutorial that says "coming in the next release" is a tutorial that has to be
edited on a schedule; one that says "this is not built" only has to be edited
when it is.

### `mock` draws from one set of primitives, and nothing else

A tutorial that tells you to click **Open Project** is easier to follow if you
have also *seen* where that button is. `mock` is for exactly that: a small,
static, deliberately inert picture of a piece of Veistra's UI — a bar, a panel,
a tree — sitting inline in the prose the way a screenshot would, without being
one.

Not a screenshot, on purpose. A captured pixel grid goes stale the moment the
interface it was taken from changes, silently, with nothing to fail — the
tutorial would keep shipping a picture of a Veistra that no longer exists. A
mock is source: `apps/tutorial/ui/src/mocks/chrome.tsx` declares a small set
of primitives — a window frame, a band, a labelled arrow, a chip, a tab, a
tree row — built only from `src/tokens.css`'s own colours, and every one of
the sixteen mocks in `mocks/registry.ts` composes those and nothing else. A
mock cannot invent a colour the product does not have, because there is
nowhere in the file to put one.

That constraint is the whole reason sixteen mockups, drawn over several
sessions, still read as one product instead of sixteen guesses at it. `view`
takes a `MockName` — a string-literal union — rather than a bare string, so a
typo'd name fails at the tutorial that made it rather than rendering a blank
figure nobody notices until a reader reports it.

Every mock is inert: no button, no click handler, nothing a keyboard can land
on. A tutorial's prose is what tells you to click something; a mock only
shows you where.

## 4. Adding a tutorial

Two files, in either order.

### 1. A catalog entry

In `src-tauri/src/apps/tutorial.rs`, add to `TUTORIALS`:

```rust
Tutorial {
    id: "presets",
    section: "shell",
    title: "Saving a layout",
    blurb: "Keep an arrangement of panes and open it again in one click.",
    minutes: 4,
    after: Some("panes-and-clusters"),
},
```

- `id` must be unique and match `^[a-z][a-z0-9-]*$`. It is a key in
  `tutorials.json` and the payload Home sends to open the tutorial.
- `section` must name an entry in `SECTIONS`. Adding a section means adding it
  there too, with an `order` no other section uses.
- `blurb` is one sentence, second person, saying what the reader will be able to
  do. It is drawn under the title on the card, so it must not repeat it — there
  is a test.
- `minutes` is an honest figure for somebody who has not seen Veistra before.
- `after` names the tutorial this one reads best *after*, and drives the "Next"
  button at the foot of the page. `None` for one that stands alone.

Six tests in that file hold the shape: unique url-safe ids, every section
resolving, no empty sections, `after` naming something real and not itself, no
blurb repeating its title, distinct section orders.

### 2. A body

Create `apps/tutorial/ui/src/content/presets.ts`:

```ts
import type { Body } from "./blocks";

export const presets: Body = {
  takeaway: "You can save a pane arrangement and reopen it in one click.",
  blocks: [
    { kind: "text", body: "..." },
    { kind: "step", body: "Open the `+` menu in the switcher bar." },
  ],
};
```

Then add one line to `content/index.ts`:

```ts
"presets": presets,
```

That is all. Nothing in `App.tsx`, `Contents.tsx`, `Index.tsx` or `Reader.tsx`
knows how many tutorials there are.

## 5. Writing one

The rules the existing ten follow. They are conventions, not enforced.

1. **Say what is not built.** A `soon` block is not an apology; it is the
   difference between a reader who stops looking and one who files a bug. Every
   tutorial that touches an unfinished area has at least one.
2. **Quote the literal label.** "Click **Open Project**", not "click the open
   button". A label quoted wrong is a tutorial that cannot be followed.
3. **Explain the rule, not just the gesture.** "Panes split along the longer
   axis" is worth more than "drag here", because it predicts the next case.
4. **The takeaway is a capability, not a summary.** "You can open a folder as a
   project, and you know which two things Veistra wrote into it" — something the
   reader can check.
5. **Steps are things to do.** If a block is not an action, it is `text`.

## 6. Progress

`tutorials.json`, beside `settings.json` and `projects.json` in the OS config
directory. It holds a set of ids and nothing else.

There is no resume position, deliberately. Resuming mid-tutorial would need the
frontend to have a notion of "where you are" that it does not have, and a stored
scroll offset would go stale the moment the prose was edited — leaving the reader
somewhere that meant something in a previous build.

The store is read on `tutorial/catalog` and written on `tutorial/complete`, with
no managed state and no `Mutex`. That is a deliberate difference from
`settings::Registry`: settings are read on hot paths by the pty, by search and by
every editor mount, and tutorial progress is read when somebody opens a tab.

`completed` is filtered against the catalog on the way out, so an id left behind
by a build that dropped a tutorial cannot make Home count to eleven out of ten.

## 7. How Home opens one

Home calls `openIn("tutorial", { tutorialId })` from `@veistra/bridge` — the same
`veistra/open` path the File Explorer uses to put a file in the File Viewer.

Home names a **kind** of app, never a particular surface. Which Tutorials pane
answers is a fact about the layout that only the shell can see, and the shell
resolves who is *asking* from `event.source` against its own map of mounted
iframes rather than from anything in the message. See `docs/tool-protocol.md` §3.

An unknown id is ignored rather than shown as an error: it can only arrive from a
build mismatch, and dropping the reader on the index is a better answer than a
page saying the link was wrong.

## 8. How it is displayed: a takeover surface

Tutorials **covers** the cluster rather than taking a pane beside it. Home
already worked this way and the mechanism is shared: `TAKEOVER_APPS` in
`src/shell/WindowRoot.tsx`, `is_takeover_app` in `src-tauri/src/shell_state.rs`,
and `ToolWindow`'s `soloInstanceId`, which draws one instance over the pane tree
without disturbing it.

It went in because opening a tutorial into a pane put a page of prose in a
quarter of the window beside three apps. A tutorial squeezed into a sliver is
not a smaller version of reading; it is a different and worse thing.

Three consequences, all of them shared with Home:

- **No tab in the switcher bar,** and no place in a collapsed chip's count.
- **No close button,** because there is no tab to put one on. It goes away when
  you choose anything else — an app, a tab, a chip, another cluster. Uncovering
  is the same act as choosing what to look at, so it is not a second gesture.
- **The layout underneath is untouched.** Every app stays mounted at the size it
  had, and is exactly there again when the cover comes down.

### One takeover surface covers another rather than evicting it

This is the one rule that is not Home's. `open_instance` dismisses whatever
takeover surface is in the pane it is opening into — that is what stops an
unreachable instance being left behind — but it skips that when the *arriving*
app is itself a takeover surface.

Without the exception, opening a tutorial from a card on Home would evict the
Home underneath it. On a cluster holding nothing else that leaves an empty pane
when the tutorial closes, so the reader who followed a card from Home cannot get
back to Home. Covering keeps it there to return to.

`one_takeover_surface_does_not_evict_another` and
`dismiss_takeover_closes_a_tutorial_too` in `shell_state.rs` hold both halves.

### Where the two differ

Only in the door. Home's is the chip of the cluster you are already on, and it
has no other; a cluster that already had a Home keeps it when uncovered, because
that door costs nothing to take again.

Tutorials' door is Home's right-hand column: a card opens one tutorial, and the
link under them opens the index. Both go through `veistra/open`.

Neither surface appears in the title bar's Apps menu or the switcher's `+`.
`appsHandlers.available` in `WindowRoot.tsx` filters both out of the one list
that feeds both menus. A menu row would be a second door doing the same "find
it, or open one" job as the first, and two doors agree only by luck.

**Rust still registers Tutorials as an ordinary app**, and `apps::openables`
still lists it. That is what makes `veistra/open` resolve a frontend for it — the
filtering is a fact about which menus offer it, not about what it is. Dropping
it from the registry would take the app with it.

Being *open* is what makes Tutorials cover, so it needs no "wanted" flag: nothing
opens it except somebody asking to read it. It is therefore **closed** rather
than merely uncovered — a live instance with no tab and no menu row would be a
pane nobody can reach.

## 9. What is deliberately absent

- **No search within the tutorials.** Ten pages with a contents rail beside them
  is not a corpus. This becomes worth building somewhere around thirty.
- **No interactive checkpoints.** "Mark as done" is the reader's assertion, not
  Veistra's observation. Checking whether somebody really opened a project would
  mean the tutorial app watching the rest of the application, which is a
  surveillance surface bought for a tick.
- **No ordering enforcement.** `after` is a suggestion and nothing is locked. A
  reader who wants the MCP tutorial first should get it.
- **No per-app tutorial registration.** Settings lets an app declare a group
  (`apps::settings_groups`); this has no equivalent, because every app that
  ships today is documented by a tutorial in the shell's own catalog. The
  mechanism is worth copying when a tool — not an app — needs to document
  itself, and not before.
- **Help ▸ Documentation does not open this.** The menu item is inert. Wiring it
  would mean a callback threaded through `WindowRoot.tsx`, which was another
  session's file when this landed.
