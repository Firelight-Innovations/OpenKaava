import type { Body } from "./blocks";

/**
 * Settings, and the one idea in it worth explaining: a change has a *moment* it
 * takes effect, and most of them are read when something is created rather than
 * watched while it is open.
 */
export const settings: Body = {
  takeaway:
    "You can change any setting and know, before you close the screen, whether you need to reopen anything for it to show.",
  blocks: [
    {
      kind: "step",
      body: "Press `Ctrl+,`. It works from inside an app too, this one included.",
    },
    {
      kind: "step",
      body: "The screen opens on its first section. Pick another from the list down its left side, or type in the search field in the title bar to search every section at once.",
    },
    {
      kind: "text",
      body: "The screen covers everything between the title bar and the status bar. Press `Escape` to close it; nothing needs saving, because every change is written the moment you make it.",
    },

    { kind: "heading", body: "When a change takes effect" },
    {
      kind: "text",
      body: "This is the part worth reading. Under each control is a line saying when it applies — not decoration, but a fact worth trusting. Most of these are read at the moment something is **created**, not watched for the lifetime of what is already open.",
    },
    {
      kind: "flow",
      steps: [
        "Change a control",
        "written to `settings.json`",
        "takes effect — now, or the next time something reads it",
      ],
    },
    {
      kind: "keys",
      rows: [
        { chord: "Now", what: "Takes effect as you change it. The appearance settings are these." },
        {
          chord: "Next…",
          what: "Read when the next one of something opens — an editor, a terminal, a search.",
        },
        { chord: "Restart", what: "Read once, while Veistra is starting." },
      ],
    },
    {
      kind: "note",
      body: "So changing **Font size** under Editor does nothing to a file you already have open. Open another file and the new size shows. That is why the line says so under the control rather than leaving you to conclude the setting is broken.",
    },

    { kind: "heading", body: "What is in there today" },
    {
      kind: "mock",
      view: "settings-screen",
      caption: "The sections rail, with **MCP servers** picked.",
    },
    {
      kind: "text",
      body: "Six sections. Five are the shell's own; the sixth is declared by the File Explorer, which is the interesting one. An app can add a settings section of its own, and it appears here with no change to the settings screen at all.",
    },
    {
      kind: "keys",
      rows: [
        {
          chord: "Appearance",
          what: "**Accent colour**, **Interface font**, **Monospace font**. All apply immediately.",
        },
        {
          chord: "Editor",
          what: "**Font size**, **Font**, **Tab width**, **Wrap long lines**, **Show the minimap**, **Line numbers**, **Show whitespace**.",
        },
        { chord: "Terminal", what: "**Shell**, and **Open a terminal at launch**." },
        {
          chord: "Search",
          what: "**Match limit**, **File limit**, **Skip files larger than** — the three caps that keep a search on a huge checkout from running away.",
        },
        {
          chord: "MCP servers",
          what: "The server list, and whether to write `.mcp.json` into projects.",
        },
        {
          chord: "File Explorer",
          what: "**Open at most**, and **Ask before deleting**.",
        },
      ],
    },

    { kind: "heading", body: "Changed settings are marked" },
    {
      kind: "text",
      body: "A setting you have moved off its default carries a dot, and each section has a reset that puts only that section back. Everything else is left alone.",
    },
    {
      kind: "flow",
      steps: [
        "Move a setting off its default",
        "a dot marks it",
        "that section's **Reset** clears only the dot",
      ],
    },
    {
      kind: "text",
      body: "That is not cosmetic. Only the settings you changed are written to disk — a `settings.json` on a machine nobody has touched this screen on does not exist. Which means a later version of Veistra can improve a default and have the new one reach everybody who never disagreed with the old one. Your choices stay where you put them.",
    },

    { kind: "heading", body: "Where it lives" },
    {
      kind: "text",
      body: "`settings.json`, in the OS config directory, beside the file that remembers your recent projects. Per-machine, and deliberately outside any checkout — one contributor's font size arriving in everybody else's editor is exactly what a settings file committed into a repository does.",
    },
    {
      kind: "soon",
      body: "No keyboard-shortcut editor, no import or export, and no way to sync settings between machines. The chords in these tutorials are fixed.",
    },
  ],
};
