# Settings

*Working in the shell · 5 min · after [Finding things](search.md)*

Change how Veistra looks and behaves, and know when a change takes effect.

---

1. Click the sliders glyph at the right-hand end of the status bar, along the
   bottom of the window.
2. Pick **All settings**. The other two rows — **MCP servers** and
   **Appearance** — open the same screen on a particular section.

The screen covers everything between the title bar and the status bar. Press
`Escape` to close it; nothing needs saving, because every change is written
the moment you make it.

## When a change takes effect

This is the part worth reading. Under each control is a line saying when it
applies — not decoration, but a fact worth trusting. Most of these are read at
the moment something is **created**, not watched for the lifetime of what is
already open.

Change a control → written to `settings.json` → takes effect — now, or the next time something reads it

| Timing    | What                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| Now       | Takes effect as you change it. The appearance settings are these.             |
| Next…     | Read when the next one of something opens — an editor, a terminal, a search.  |
| Restart   | Read once, while Veistra is starting.                                           |

> So changing **Font size** under Editor does nothing to a file you already
> have open. Open another file and the new size shows. That is why the line
> says so under the control rather than leaving you to conclude the setting
> is broken.

## What is in there today

<!-- SCREENSHOT: the settings screen — sections rail on the left, MCP servers section open, 1440x900 -->

_The sections rail, and the **MCP servers** section it opens to._

Six sections. Five are the shell's own; the sixth is declared by the File
Explorer, which is the interesting one. An app can add a settings section of
its own, and it appears here with no change to the settings screen at all.

| Section       | What                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| Appearance    | **Accent colour**, **Interface font**, **Monospace font**. All apply immediately.          |
| Editor        | **Font size**, **Font**, **Tab width**, **Wrap long lines**, **Show the minimap**, **Line numbers**, **Show whitespace**. |
| Terminal      | **Shell**, and **Open a terminal at launch**.                                              |
| Search        | **Match limit**, **File limit**, **Skip files larger than** — the three caps that keep a search on a huge checkout from running away. |
| MCP servers   | The server list, and whether to write `.mcp.json` into projects.                           |
| File Explorer | **Open at most**, and **Ask before deleting**.                                             |

## Changed settings are marked

A setting you have moved off its default carries a dot, and each section has
a reset that puts only that section back. Everything else is left alone.

Move a setting off its default → a dot marks it → that section's **Reset** clears only the dot

That is not cosmetic. Only the settings you changed are written to disk — a
`settings.json` on a machine nobody has touched this screen on does not
exist. Which means a later version of Veistra can improve a default and have
the new one reach everybody who never disagreed with the old one. Your
choices stay where you put them.

## Where it lives

`settings.json`, in the OS config directory, beside the file that remembers
your recent projects. Per-machine, and deliberately outside any checkout —
one contributor's font size arriving in everybody else's editor is exactly
what a settings file committed into a repository does.

> **Not yet:** No keyboard-shortcut editor, no import or export, and no way
> to sync settings between machines. The chords in these tutorials are
> fixed.

---

**Takeaway:** You can change any setting and know, before you close the
screen, whether you need to reopen anything for it to show.
