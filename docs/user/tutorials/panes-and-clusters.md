# Panes, tabs and clusters

*Working in the shell · 8 min · after [Your first project](first-project.md)*

Split the window, move a tab, and work on two projects at once.

---

Two layers, and the difference between them is the thing to get. **Panes**
divide what you are looking at. **Clusters** divide what you are working on.

One window → **Clusters** — separate work → **Panes** inside each — separate views

## Panes

The tool window starts as one pane holding one app. Open a second app and it
gets a **pane of its own** rather than a tab in the one you were looking at.

1. Click the `+` in the switcher bar and pick **File Explorer**.
2. Click `+` again and pick **File Viewer**. The window now holds two panes.
3. Drag the line between them to change the split. Drag a pane's tab onto
   another pane to move it there.

The split direction is not a setting and is not random: **the focused pane
splits along its longer axis**. A pane wider than tall gains a right-hand
column; one taller than wide gains a bottom row.

<!-- SCREENSHOT: before/after — a pane wider than tall splitting into a right-hand column, 1440x900 -->

_Before and after: a pane wider than tall splits into a right-hand column._

> That rule is what stops a layout turning into slivers. Always splitting the
> same axis narrows every pane a little more each time; always splitting the
> long side keeps every pane as close to square as the arrangement allows.

Pane sizes are stored as fractions of their parent rather than in pixels, so a
layout restores correctly onto a different monitor instead of arriving with
everything the wrong size.

## Clusters

A **cluster** is an independent workspace inside one window. It owns its
project, its arrangement of panes, its terminals, and the branch or worktree
it operates on.

The tabs on the left of the switcher bar are clusters. Switching between them
swaps the entire layout underneath — the panes, and the terminal band with
them.

<!-- SCREENSHOT: the switcher bar with cluster tabs on the left and app tabs beside them, 1440x60 -->

_Cluster tabs on the left; this cluster's own app tabs beside them._

1. Make a second cluster from the switcher bar. It opens on Home, with no
   project.
2. Open a **different** folder in it.
3. Switch back and forth. Each cluster's File Explorer is rooted in its own
   project, and each one's terminals opened in its own folder.

That is the whole point. The project belongs to the cluster and not to the
process, so two clusters are two genuinely separate pieces of work. That
separation is what makes reviewing one branch while building on another
possible without two copies of OpenKaava.

> Closing the last cluster is allowed. The app area draws its own empty state
> rather than a window being guaranteed to hold one.

## Presets

An arrangement you keep rebuilding can be saved. The `+` menu has a
**Presets** section, and **Save Current Layout…** at the end of it records
this cluster's panes and which app is in each.

Opening a preset lays that arrangement out again. A preset holding a terminal
opens it already in the folder that cluster has open, rather than wherever
OpenKaava happened to start.

## What survives a restart

The layout does. OpenKaava reopens the clusters you had, their panes, their apps
and their projects — so a restart puts you back where you were rather than on
an empty Home.

| Chord            | What                                                          |
| ----------------- | --------------------------------------------------------------- |
| `Ctrl+1`          | …through `Ctrl+9`, select the nth tab in this window's bar.     |
| `Ctrl+B`          | Open or close the Git page, which holds source control.         |
| `Ctrl+Shift+W`    | Close the window.                                                |

## A second window

Drag a tab out of the bar and drop it on the desktop, and it becomes its own
window — the way tearing off a browser tab works. **New Window** in the File
menu opens an empty one.

A detached window is not a reduced build. It mounts the same shell, with the
same bands and the same menus — the same application, not a viewer that came
off it.

> **New Window** has no accelerator. `Ctrl+Shift+N` is deliberately left
> unbound. Every browser binds it to a private window, and a menu item drawn
> with an accelerator it does not perform is worse than one drawn with none.

---

**Takeaway:** You can split a window into panes, and keep two projects open
side by side in separate clusters without them touching.
