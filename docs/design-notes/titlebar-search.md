# The title bar search field

There is one search bar on screen. By default it searches project files (Ctrl+K opens the
search dialog). A surface with a filter of its own does not draw a second bar: it claims the
title bar's field, and the field becomes that surface's filter for as long as the claim shows.

## The claim stack

`src/shell/titlebarSearch.ts` holds a stack of claims, in the order they were made.

- **The most recent claim wins.** Its placeholder is shown, its `value` is the text, and typing,
  Enter and Escape go to it. Ctrl+K focuses the field instead of opening the dialog.
- **Releasing hands the field back** to the claim beneath it. An empty stack reverts to project
  file search.
- **Updating never reorders.** A keystroke changes `value` in place. Only a fresh claim goes on top.
- **Claims made in one commit land children first** (effect order), so a surface that wants to
  sit above another claims after it has mounted, from a later user action.

The field itself is `SearchSlot` (`src/shell/search/SearchSlot.tsx`), which reads the winning
claim and draws either the trigger button or a real input.

## Claiming from the shell

Call `useTitlebarSearch(claim | null)` from a component. Pass `null` to hold off; the claim is
made when the argument becomes non-null and released when it goes back or the component unmounts.

| Surface | Placeholder | When it claims |
|---|---|---|
| Settings | Search settings | While Settings is open |
| Settings, MCP section | Filter tools | While any server's tool list is open, above Settings |
| GitHub panel | the filter syntax | After the user's last press or focus was inside the panel; released on a press elsewhere |

## Claiming from an app frame

Apps live in iframes and cannot reach the shell's store, so the bridge carries it
(`docs/tool-protocol.md` section 3):

- `kaava/search-claim` `{placeholder, value}` records the claim. Sending it again updates it.
- `kaava/search-release` gives it up.
- The shell delivers what the user does in the field as a `kaava:search` event,
  `{kind: "query" | "submit" | "escape", value}`.

App side, `claimSearch({placeholder, value, onChange, onSubmit?, onEscape?})` from
`@openkaava/bridge` returns a handle with `update` and `release`. A frame holds one claim.

**Only an active surface's claim is shown.** The shell records every frame's claim but puts it on
the stack only while that frame is the focused pane's visible tab, a takeover surface, or the
rail page (`src/shell/toolwindow/frameSearch.ts`). A frame therefore claims when its filter
exists and never tracks focus; the shell shows it when the user is in that pane and hides it
when they are not. Typing is echoed back only if the app changed the text itself.

Under a standalone host there is no shell, `host() !== "kaava"`, and the claim is refused. The
app draws its own input in that case, as File Explorer does.

| App | Placeholder | State |
|---|---|---|
| Files, Explorer | Filter files | Claims while the file view (not the Recycle Bin) is showing |
| Schematify | n/a | Its node search was an inert disabled field, so it was removed rather than claimed; node search claims the field when it exists |

## Special circumstances: when a local search bar may stay

The rule is one search bar per screen. A local bar is fine only when the title bar cannot serve it.

1. **Find within a document or terminal**: find-in-file in an editor or viewer, terminal search.
   It is a different scope from the surface's own filter and sits on the thing it searches.
2. **Dialogs and pickers that are the search**: the project search dialog, command palette, app
   picker, switch-project dialog. They are transient and their input is the whole point.
3. **A frame that cannot reach the shell**: a tool built without the bridge, or a standalone app.
4. **Inputs that are not searches**: commit messages, tokens, names.

Anything else with its own filter should claim the field.
