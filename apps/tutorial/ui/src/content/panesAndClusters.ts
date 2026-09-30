import type { Body } from "./blocks";

/**
 * The one genuinely unfamiliar idea in OpenKaava.
 *
 * Panes are VS Code's splits and need no defending. Clusters do: nothing else a
 * developer uses has them, "cluster" is not a word anybody guesses, and the
 * payoff — two projects open at once, each with its own everything — is
 * invisible until somebody tells you it is there.
 */
export const panesAndClusters: Body = {
  takeaway:
    "You can split a window into panes, and keep two projects open side by side in separate clusters without them touching.",
  blocks: [
    {
      kind: "text",
      body: "Two layers, and the difference between them is the thing to get. **Panes** divide what you are looking at. **Clusters** divide what you are working on.",
    },
    {
      kind: "flow",
      steps: [
        "One window",
        "**Clusters** — separate work",
        "**Panes** inside each — separate views",
      ],
    },

    { kind: "heading", body: "Panes" },
    {
      kind: "text",
      body: "The tool window starts as one pane holding one app. Open a second app and it gets a **pane of its own** rather than a tab in the one you were looking at.",
    },
    {
      kind: "step",
      body: "Open the **Apps** menu and pick **File Explorer**.",
    },
    {
      kind: "step",
      body: "Open **Apps** again and pick **File Viewer**. The window now holds two panes.",
    },
    {
      kind: "step",
      body: "Drag the line between them to change the split. Drag a pane's tab onto another pane to move it there.",
    },
    {
      kind: "text",
      body: "The split direction is not a setting and is not random: **the focused pane splits along its longer axis**. A pane wider than tall gains a right-hand column; one taller than wide gains a bottom row.",
    },
    {
      kind: "mock",
      view: "pane-split",
      caption: "Before and after: a pane wider than tall splits into a right-hand column.",
    },
    {
      kind: "note",
      body: "That rule is what stops a layout turning into slivers. Always splitting the same axis narrows every pane a little more each time; always splitting the long side keeps every pane as close to square as the arrangement allows.",
    },
    {
      kind: "text",
      body: "Pane sizes are stored as fractions of their parent rather than in pixels, so a layout restores correctly onto a different monitor instead of arriving with everything the wrong size.",
    },

    { kind: "heading", body: "Clusters" },
    {
      kind: "text",
      body: "A **cluster** is an independent workspace inside one window. It owns its project, its arrangement of panes, its terminals, and the branch or worktree it operates on.",
    },
    {
      kind: "text",
      body: "The badges at the top of the rail, and the list under the title bar's pill, are clusters. Switching between them swaps the entire layout underneath — the panes, and the terminal band with them.",
    },
    {
      kind: "mock",
      view: "switcher-bar",
      caption: "The pill lists the clusters; each has a badge in the rail.",
    },
    {
      kind: "step",
      body: "Make a second cluster with the `+` above the rail's page icons. It opens on Home, with no project.",
    },
    {
      kind: "step",
      body: "Open a **different** folder in it.",
    },
    {
      kind: "step",
      body: "Switch back and forth. Each cluster's File Explorer is rooted in its own project, and each one's terminals opened in its own folder.",
    },
    {
      kind: "text",
      body: "That is the whole point. The project belongs to the cluster and not to the process, so two clusters are two genuinely separate pieces of work. That separation is what makes reviewing one branch while building on another possible without two copies of OpenKaava.",
    },
    {
      kind: "note",
      body: "Closing the last cluster is allowed. The app area draws its own empty state rather than a window being guaranteed to hold one.",
    },

    { kind: "heading", body: "Presets" },
    {
      kind: "text",
      body: "An arrangement you keep rebuilding can be saved. The `+` menu has a **Presets** section, and **Save Current Layout…** at the end of it records this cluster's panes and which app is in each.",
    },
    {
      kind: "text",
      body: "Opening a preset lays that arrangement out again. A preset holding a terminal opens it already in the folder that cluster has open, rather than wherever OpenKaava happened to start.",
    },

    { kind: "heading", body: "What survives a restart" },
    {
      kind: "text",
      body: "The layout does. OpenKaava reopens the clusters you had, their panes, their apps and their projects — so a restart puts you back where you were rather than on an empty Home.",
    },
    {
      kind: "keys",
      rows: [
        { chord: "Ctrl+1", what: "…through `Ctrl+9`, select the nth tab in this window's bar." },
        { chord: "Ctrl+B", what: "Collapse the secondary panel to a strip, and bring it back." },
        { chord: "Ctrl+Shift+W", what: "Close the window." },
      ],
    },

    { kind: "heading", body: "A second window" },
    {
      kind: "text",
      body: "Drag a tab out of the bar and drop it on the desktop, and it becomes its own window — the way tearing off a browser tab works. **New Window** in the File menu opens an empty one.",
    },
    {
      kind: "text",
      body: "A detached window is not a reduced build. It mounts the same shell, with the same bands and the same menus — the same application, not a viewer that came off it.",
    },
    {
      kind: "note",
      body: "**New Window** has no accelerator. `Ctrl+Shift+N` is deliberately left unbound. Every browser binds it to a private window, and a menu item drawn with an accelerator it does not perform is worse than one drawn with none.",
    },
  ],
};
