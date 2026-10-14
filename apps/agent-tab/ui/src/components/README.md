# Agent tab components

Every visual piece of the agent tab is a **slot**: a name in `registry.tsx` mapped to a component.
`App.tsx` and `Items.tsx` hold the state and the logic. They render only through `useSlots()` and
emit no DOM of their own. The agent bar in the shell follows the same pattern in
`src/shell/agentbar/slots.tsx`, because the shell may not import an app's source.

## Swap a component

Change one line in `defaultSlots` in `registry.tsx`:

```ts
ToolCall: MyToolCall,
```

To swap a component for one subtree only, without editing the default, wrap it:

```tsx
<SlotsProvider slots={{ ToolCall: MyToolCall }}>…</SlotsProvider>
```

The replacement takes the props interface in `types.ts`. The test in `registry.test.tsx` swaps
every slot for a stub and fails if any DOM is left outside a slot. It renders only the slots the tab
uses today, so the reserved slots below are not covered until something renders them.

## Restyle

Colour, type, spacing, radius, size and motion are `--k-*` custom properties in
`src/agent-tokens.css`. The tab and the agent bar both load that file. Its values point at the
shell's tokens in `src/tokens.css`, so light and dark follow the shell. Components read only `--k-*`.
Change a value there to restyle both surfaces. For one piece, change the stylesheet that holds it. There are four, each
shared by a group of components:

- `frame.css`: Layout, Header, StatusBadge, Transcript and EmptyState.
- `items.css`: UserMessage, AssistantText, Thinking, ToolCall, Diff, PathList, Approval, TodoList,
  Usage, ErrorItem, Note and Hint.
- `composer.css`: Composer, Notice, SendButton, StopButton, ContextMeter and Picker.
- `menu.css`: Menu and SessionList.

## Rules for a component

- Plain data and callbacks in. Keep only UI-local state, such as open or closed.
- Reach another piece through `useSlots()`, never by importing a sibling file. `seam.test.ts`
  enforces this, and it checks that no component imports the bridge, `rpc` or `model`.
- User-facing text comes from `strings.ts`.
- A new component file needs an entry in `Slots` and `defaultSlots`. `seam.test.ts` fails if the file
  is not imported by `registry.tsx` or no slot maps to it, and the type check fails if `Slots` and
  `defaultSlots` disagree.

## Reserved slots

These slots are defined but not rendered yet. Their features are still being built:
`ContextMeter`, `ModelPicker`, `EffortPicker`, `HarnessPicker`, `OptionPicker`, `SlashMenu`,
`MentionMenu` and `SessionList`. Every picker defaults to `Picker`, and both menus default to `Menu`.

## The thread and assistant-ui

The tab runs on `@assistant-ui/react` (pinned in `package.json`) with its external-store runtime.
Our own state stays the source of truth, and assistant-ui draws the thread around it:

- `thread.ts` groups the items into turns. Each prompt is a user turn. Everything the agent does
  until the next prompt is one agent turn, with one part per item.
- `Turns.tsx` draws each turn through the `UserTurn` or `AssistantTurn` slot. It draws each part by
  looking its item up and handing it to the item's own slot, so `ToolCall`, `Diff` and the rest are
  unchanged.
- The default `Transcript`, `UserTurn`, `AssistantTurn` and `TurnActions` use assistant-ui's
  primitives for scrolling, turns and the copy action. A replacement may use them too. Everything is
  rendered inside `AssistantRuntimeProvider`. A replacement that draws plain DOM also works.
- `Working` shows in an agent turn that has nothing in it yet.

assistant-ui ships no CSS, so the look is ours: the tokens above and each component's `.css`.
