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
Change a value there to restyle both surfaces. For one piece, change the stylesheet that holds it.
Each is shared by a group of components:

- `frame.css`: Layout, Header, StatusBadge, Transcript and EmptyState.
- `items.css`: UserMessage, AssistantText, Thinking, ToolCall, Diff, PathList, Approval, Usage,
  ErrorItem, Note and Hint.
- `plan.css`: TodoList, the agent's task list pinned over the composer.
- `composer.css`: Composer, Notice, SendButton, StopButton and Picker.
- `composer-effects.css`: the composer's Ultra surge, context chips and the link picker.
- `meters.css`: the settings button, HoverCard, ContextMeter and UsageRing.
- `preferences.css`: the settings menu and EffortPicker.
- `menu.css`: Menu and SessionList.
- `sidechat.css`, `history.css`, `errors.css`: SideChat, HistoryPanel and the friendly error card.

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
`ModePicker`, `ModelPicker`, `HarnessPicker`, `OptionPicker` and `SessionList`. These pickers default
to `Picker`. `EffortPicker` draws effort as a charge. `SlashMenu` and `MentionMenu` both
default to `Menu` and are rendered by the composer when completing commands or context references.

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
- `Working` shows while the turn runs and has not ended on text: before anything arrives, and after
  a tool call or a thought. It names what the agent is doing (its running tool, else "Working")
  and a clock since the turn began. It does not show while the agent waits on an approval.
- The agent's plan is not drawn in the transcript. `TodoList` pins its latest version over the
  composer: a card that folds, a check per finished step, and a turning ring on the step in
  progress. Usage items are not drawn either; the composer's `ContextMeter` shows them.
- Two or more tool calls in a row fold into one `ActionGroup`: a line such as "Ran 2 commands, read
  a file", with the calls in a card below it. `actions.ts` writes the line. Anything else in
  between, such as text or an approval, breaks the run. A lone call goes through `ActionGroup` too,
  with `grouped` false, and is drawn as a plain `ToolCall` row. Keeping one wrapper means a row the
  user opened stays open when a second call joins it.
- `Thinking`, `ToolCall` and `ActionGroup` fold behind a caret (`.at-disclosure`). Their label and
  `Working` shimmer (`.at-shimmer[data-live]`) while the agent is still at it, between
  `--k-shimmer-base` and `--k-shimmer-glint`. Under reduced motion the label holds still.

assistant-ui ships no CSS, so the look is ours: the tokens above and each component's `.css`.

## The composer's footer

The footer reads like a coding agent's: one settings button on the left, the meters and Send on the
right.

- `ModelMenu` is the settings button. It reads the current settings as one line ("Claude · Opus 5.5
  · High") and opens a menu.
  - Harness buttons select Claude, Codex or Kaava, followed by only that harness's models. The
    latest model in each family and the selected model are featured; More models expands older
    versions and aliases. Names and values come from the adapter. An unavailable harness is locked
    with its reason in the title. Switching a running conversation transfers its context.
  - `EffortPicker` sits beneath models: a capsule with Low, Medium, High, Xhigh and Max stops that
    fills and heats from teal to coral, in veistra.com's palette, with the site's dot grid,
    halftone and glint. The first stop sits at the capsule's left end and the last at its right,
    so Low empties it and Max fills it. Unsupported levels are disabled, and the arrow keys skip
    them. Dragging, or pointing at a stop's name, previews a level in the capsule and applies it
    on release or click; the slider keeps focus throughout. The composer does not change with the
    level. Under reduced motion the glint is still.
  - Claude adds an Ultra stop for deep reasoning and workflow orchestration. It runs the whole
    ramp out to gold. Turning it on plays one surge, in the capsule (a flare and a crackle on the
    thumb) and across the composer (a sweep of the ramp through the dot screen). Then both are
    plain again. It applies to the current conversation.
  - The mode follows. While a session runs its modes are the agent's, and Shift+Tab steps through
    them. Before one starts, and once discovery has asked the agent, they are the modes of the
    harness the next session will run: switching harness switches the list, each harness keeps
    its own pick, and the pick goes with the first prompt. The session starts ask-first and then
    enters it. Claude's Auto is offered; bypass modes and Codex's full access never are.
  - `HistoryPanel` searches conversations across harnesses, exposes archived entries, and lets
    a user reopen with either harness. `Header` exposes new conversation, history, and side chat.
  - `harnesses.ts` builds the harness list. The one in use takes its models from the running
    session. The rest take what the host scanned, read from optional fields until the host sends
    them. A harness the host does not report reads "Coming soon", and one it cannot start reads
    "Not set up". The harness in use is never locked.
- `ContextMeter` is a ring, as Claude Code draws it. On hover or focus it opens a card with the
  window's size, a stacked bar, and a row per category plus the free space. Without `categories`
  the card has one "Used" row.
- `UsageRing` is a ring as full as the tightest usage limit. On hover or focus it opens a card with
  a bar per limit and when it resets. With no limits it draws nothing, which is the case until the
  agent host reports them.
- Both meters open their cards through the `HoverCard` slot and draw rings through `Ring`, so one
  replacement changes both. `meters.ts` holds the thresholds: a meter turns `high` at 80% and
  `full` at 95%, read from `--k-meter-*`. The context categories take `--k-context-1` to `-6`.
