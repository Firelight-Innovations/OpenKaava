# Terminals

*Working in the shell · 5 min · after [Panes, tabs and clusters](panes-and-clusters.md)*

Open a shell that already knows which project you are in.

---

Terminals live in the **band** under the tool window — wide and short, across
the bottom of the work rather than beside it.

## Open one

1. Show the band. Ctrl and the key under Escape toggles it (`` Ctrl+` ``).
2. Make a new terminal, either from the band's `+` or with the chord
   (`` Ctrl+Shift+` ``).
3. Split it, so two shells share the band side by side (`Ctrl+\`).

<!-- SCREENSHOT: the terminal band with a rail of sessions on the left and a split pair, 1440x300 -->

_The rail of sessions on the left; a split pair folds into one entry with a
count._

The **Terminal** menu holds the same three, plus **Kill Terminal** and
**Clear**. All five grey out with no terminal to act on.

> **Clear** calls the emulator's own clear rather than writing `cls` or
> `clear` into the shell. That is the only honest version: a full-screen
> program reads its own terminal state from the emulator. A command typed
> into the stream would either do nothing to it, or get typed into whatever
> prompt is showing.

## It starts where your project is

A new terminal opens in the folder the **cluster** has open, not in whatever
directory Veistra was launched from.

A project is open → the cluster owns the band → a new terminal inherits its folder

Two clusters with two projects give you two terminals in two different
folders.

The band belongs to the cluster for the same reason:

Switch clusters → the band swaps to that cluster's terminals → the panes above it swap too

Terminals do not pile up from work you are no longer looking at.

## A terminal in a pane

The `+` in the switcher bar also offers **Terminal**, and that one is
different: it puts a shell in a **pane** of the tool window rather than in the
band. Useful when you want a terminal tall rather than wide — watching a long
build beside the code, instead of under it.

## Which shell you get

Settings → **Terminal** → **Shell** picks it. The default works it out from
the machine; you can pin it to PowerShell, `cmd`, bash or zsh instead.

**Open a terminal at launch** in the same section starts one with Veistra. That
one is read while Veistra is starting, so changing it needs a restart to show —
the setting says so under the control.

## Why a Veistra terminal is not the same as yours

Veistra spawns these shells, so it puts things in their environment —
including the port and token an MCP client needs to reach Veistra's own tools.

A shell you opened yourself, outside Veistra, inherits none of that. That shell
works fine; it simply cannot reach back into the running application — the
correct answer, rather than a limitation.

> That single fact is behind almost every "my agent cannot see the Veistra
> tools" report. Run the agent from a terminal inside Veistra. See
> [Give your agent Veistra's tools](mcp-servers.md).

## Resizing the band

Drag the line above it. Push down past a point and it snaps shut; lift past
the tool window's floor and it takes the whole column. Both have a deliberate
dead zone, so a hand resting near the line does not flap it open and shut.

| Chord         | What                            |
| -------------- | ---------------------------------- |
| `` Ctrl+` ``  | Show or hide the band.             |
| `` Ctrl+Shift+` `` | New terminal.                  |
| `Ctrl+\`      | Split the active terminal.         |

> Those two chords use the _physical_ key under Escape rather than the
> character it produces, so they work on a keyboard layout that does not put
> a backtick there.

---

**Takeaway:** You can open a terminal that starts in the right folder, split
it, and know why it differs from a shell you opened yourself.
