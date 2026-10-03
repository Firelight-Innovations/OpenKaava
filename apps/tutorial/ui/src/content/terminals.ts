import type { Body } from "./blocks";

/**
 * Terminals, and the two facts that are not obvious: a terminal belongs to a
 * cluster rather than a window, and an OpenKaava terminal carries environment a shell
 * opened outside it does not — which is what makes the MCP tutorial work.
 */
export const terminals: Body = {
  takeaway:
    "You can open a terminal that starts in the right folder, split it, and know why it differs from a shell you opened yourself.",
  blocks: [
    {
      kind: "text",
      body: "Terminals live in the **band** under the tool window — wide and short, across the bottom of the work rather than beside it.",
    },

    { kind: "heading", body: "Open one" },
    {
      kind: "step",
      body: "Show the band. Ctrl and the key under Escape toggles it.",
      chord: "Ctrl+`",
    },
    {
      kind: "step",
      body: "Make a new terminal, either from the band's `+` or with the chord.",
      chord: "Ctrl+Shift+`",
    },
    {
      kind: "step",
      body: "Split it, so two shells share the band side by side.",
      chord: "Ctrl+\\",
    },
    {
      kind: "mock",
      view: "terminal-band",
      caption: "The rail of sessions on the left; a split pair folds into one entry with a count.",
    },
    {
      kind: "text",
      body: "The **Terminal** menu holds the same three, plus **Kill Terminal** and **Clear**. All five grey out with no terminal to act on.",
    },
    {
      kind: "note",
      body: "**Clear** calls the emulator's own clear rather than writing `cls` or `clear` into the shell. That is the only honest version: a full-screen program reads its own terminal state from the emulator. A command typed into the stream would either do nothing to it, or get typed into whatever prompt is showing.",
    },

    { kind: "heading", body: "It starts where your project is" },
    {
      kind: "text",
      body: "A new terminal opens in the folder the **cluster** has open, not in whatever directory OpenKaava was launched from.",
    },
    {
      kind: "flow",
      steps: [
        "A project is open",
        "the cluster owns the band",
        "a new terminal inherits its folder",
      ],
    },
    {
      kind: "text",
      body: "Two clusters with two projects give you two terminals in two different folders.",
    },
    {
      kind: "text",
      body: "The band belongs to the cluster for the same reason:",
    },
    {
      kind: "flow",
      steps: [
        "Switch clusters",
        "the band swaps to that cluster's terminals",
        "the panes above it swap too",
      ],
    },
    {
      kind: "text",
      body: "Terminals do not pile up from work you are no longer looking at.",
    },

    { kind: "heading", body: "A terminal in a pane" },
    {
      kind: "text",
      body: "The **Apps** menu also offers **Terminal**, and that one is different: it puts a shell in a **pane** of the tool window rather than in the band. Useful when you want a terminal tall rather than wide — watching a long build beside the code, instead of under it.",
    },

    { kind: "heading", body: "Which shell you get" },
    {
      kind: "text",
      body: "Settings → **Terminal** → **Shell** picks it. The default works it out from the machine; you can pin it to PowerShell, `cmd`, bash or zsh instead.",
    },
    {
      kind: "text",
      body: "**Open a terminal at launch** in the same section starts one with OpenKaava. That one is read while OpenKaava is starting, so changing it needs a restart to show — the setting says so under the control.",
    },

    { kind: "heading", body: "Why an OpenKaava terminal is not the same as yours" },
    {
      kind: "text",
      body: "OpenKaava spawns these shells, so it puts things in their environment — including the port and token an MCP client needs to reach OpenKaava's own tools.",
    },
    {
      kind: "text",
      body: "A shell you opened yourself, outside OpenKaava, inherits none of that. That shell works fine; it simply cannot reach back into the running application — the correct answer, rather than a limitation.",
    },
    {
      kind: "note",
      body: 'That single fact is behind almost every "my agent cannot see the OpenKaava tools" report. Run the agent from a terminal inside OpenKaava. See **Give your agent OpenKaava\'s tools**.',
    },

    { kind: "heading", body: "Resizing the band" },
    {
      kind: "text",
      body: "Drag the line above it. Push down past a point and it snaps shut; lift past the tool window's floor and it takes the whole column. Both have a deliberate dead zone, so a hand resting near the line does not flap it open and shut.",
    },
    {
      kind: "keys",
      rows: [
        { chord: "Ctrl+`", what: "Show or hide the band." },
        { chord: "Ctrl+Shift+`", what: "New terminal." },
        { chord: "Ctrl+\\", what: "Split the active terminal." },
      ],
    },
    {
      kind: "note",
      body: "Those two chords use the *physical* key under Escape rather than the character it produces, so they work on a keyboard layout that does not put a backtick there.",
    },
  ],
};
