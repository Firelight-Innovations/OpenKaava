# Kaava agent context: images, video and text from any panel into any harness

Owner: Braden Seaborn. Date: 2026-09-29. State: DRAFT FOR REVIEW (v0.2, spec only, no code; updated 2026-09-29 with Braden's answers to the open questions). Builds on `docs/KAAVA-UX-REWORK.md` (environments, viewers, Play, comments) and `docs/design/KAAVA-UX-SPEC.md`.

Facts about the three harnesses come from public docs and issue trackers read on 2026-09-29 (sources in section 12). Each fact carries a confidence tag: **V** means read in the vendor's own docs or repo this pass, **R** means reported in an issue, PR or third-party write-up, **U** means unverified or inferred. Nothing tagged **U** is a reason to skip the phase-1 spikes in section 10; they exist to turn those tags into **V**.

## Friday scope (ships by 2026-10-02)

Given Braden's decisions below, the cut for Friday is the smallest slice that gives a working loop: put context in, see it, see what Claude Code read.

| Ships Friday | From | Notes |
|---|---|---|
| Phase 0 spikes, trimmed to Claude Code | 10 | Only the Claude rows: `Alt+V` and `Ctrl+V`, bare path versus `@path`, forward slashes, process-tree shape on Windows. |
| File transport: drop and paste into `.kaava/context/` | Phase 1 | OS file drops and clipboard images, materialised by a minimal Rust `context.put`. Claude Code adapter plus the plain-shell fallback. |
| The Context strip beside the main terminal | Phase 2, reduced | A strip of what was put in, with send, undo and remove. No producer API, no capture providers, no streams. |
| Hooks-based "agent saw" for Claude Code | Phase 4, reduced | Consent-gated `<env>/.claude/settings.local.json` write, `PostToolUse` on `Read`, and the strip shows the images Claude opened. |

Not Friday: the Codex and Gemini adapters (they follow the same pattern and wait on their spikes), the `ContextItem` bridge API for other apps, the `kaava-context` MCP server, transcript watchers, Play and canvas providers, video, cloud, and scroll-anchoring. The reduced strip should still be built on the `ContextItem` record from section 6 so phase 2 grows into it rather than replacing it.

## 0. Summary and decisions asked for

Three goals, one mechanism.

1. **Drop context into an agent.** Drag an image, a Play capture, a canvas selection or a log from any panel onto a terminal, and the agent receives it.
2. **See what the agent saw.** Images the agent opens appear in Kaava next to its terminal.
3. **One contract.** Every tool gives context to agents the same way, so a future tool needs no new agent plumbing.

The mechanism: **every harness can read a file by path, so a file under `.kaava/context/` is the universal transport.** Everything else (per-harness syntax, MCP, hooks) is an optimisation on top of that floor. The floor works today for all three harnesses with no server, which is why phases 1 and 2 are client-side only.

Decisions this spec makes, each explained in the section named:

| # | Decision | Section |
|---|---|---|
| D1 | Materialise every context item to a file in the environment, then insert a reference at the prompt. Never write image bytes into the pty. | 3, 4 |
| D2 | Per-harness adapters decide the reference syntax. Harness detection is by process tree, with a per-tab override. | 4.3 |
| D3 | Internal drags extend the existing `kaava/drag` gesture with context ids. The `application/x-kaava-context` MIME covers HTML5 drags only. | 4.1 |
| D4 | A `ContextItem` is a small record plus a file. Bytes travel once, into Rust, and everything after that passes ids. | 6 |
| D5 | Output path is a sidecar: hooks first (Claude Code, Gemini), transcript watcher for Codex on Windows. No inline terminal image protocol for now. | 5 |
| D6 | `kaava-context` is a new MCP server so agents can pull context and ask for a capture themselves. | 7 |
| D7 | Video degrades to keyframes plus metadata for every harness in this pass, because none of the three is confirmed to take video from a terminal session. Deferred: no v1 work (open question 4). | 8 |
| D8 | Cloud sessions are out of v1. Claude Code's own cloud sessions cover that case. | 13 |
| D9 | Hook and MCP config writes into `<env>/.claude`, `.codex` and `.gemini` are approved, and always ask before writing. | 5.3, 7.3 |
| D10 | Clipboard images are written to `.kaava/context/` and shown in the Context strip beside the main terminal. Native harness paste is not the default. | 4.2 |

## 1. What exists today

Read from the tree on `ux/rework`, so this spec builds on these rather than beside them.

| Piece | Where | What it gives us |
|---|---|---|
| File drop onto a terminal | `docs/design-notes/drag-files-to-terminal.md`, `src/shell/drag/useFileDrag.tsx`, `src/shell/dropZones.ts` | Every emulator registers a `terminal` drop zone. OS drops arrive as Tauri `tauri://drag-*` events. Files-app drags arrive as `kaava/drag` begin/end with paths. A drop calls the transport's insert-paths method, which never sends a newline. |
| Shell-aware quoting | `src-tauri/src/quoting.rs`, `pty.rs` (`PtySessions::insert_paths`) | Rust knows which shell a session spawned (`pwsh`, `cmd`, POSIX) and quotes paths for it. It does not know that a coding harness is running inside that shell. |
| Terminal clipboard | `src/shell/terminal/clipboard.ts` | `Ctrl+V` is claimed by the shell and turned into one `term.paste(text)`. It reads `text/plain` only. An image on the clipboard falls through with nothing sent. |
| xterm setup | `src/shell/terminal/XTermView.tsx` | xterm 6 with `addon-fit` and `addon-webgl`. No image addon. |
| App to shell bridge | `packages/bridge` | Request/response (`invoke`), shell events (`on`), menu commands, `openIn`, retained `publish`/`subscribe` topics per cluster, `kaava/drag`. No shell-to-app request. |
| Comments with screenshots | `apps/shared/comments.ts`, `src-tauri/src/comments.rs` | Godot Viewer, Blender Viewer and Play already send `screenshotBase64` into Rust, which writes a PNG under `.kaava/comments/` in the environment. This is the closest existing precedent for materialising bytes. |
| Hosted MCP servers | `src-tauri/src/mcp/servers/` (`echo`, `debug`, `design`, `ui`, `agent`) | One module each with a `pub static SERVER`, a shared axum listener on `127.0.0.1` with a bearer token, `${KAAVA_MCP_PORT}` and `${KAAVA_MCP_TOKEN}` injected into every pty's environment, and a `.mcp.json` written into projects. |
| `servers/mod.rs` rule | header comment | "If the harness can already do it, it does not get a server." `kaava-context` must pass this test. Section 7.1 argues that it does. |

Two gaps found while reading, both to be confirmed by spike (section 10):

1. **`Ctrl+V` image paste is probably dead in an OpenKaava terminal.** `handleKey` returns `false` for `Ctrl+V`, so xterm never sends `0x16` to the pty. Claude Code reads the OS clipboard itself when it sees that keypress [S1]. It never gets the keypress. **U**, and cheap to verify.
2. **Drop quoting is wrong inside a harness.** A path quoted for PowerShell (`'C:\a b\x.png'`) is right at a prompt and wrong inside a TUI that reads it as prose or as an `@` mention. Detection of the running harness (section 4.3) fixes this.

## 2. Harness capability matrix

Claude Code, Codex CLI and Gemini CLI, as of 2026-09-29. Rows are grouped by the goal they serve.

### 2.1 Getting an image in

| Capability | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Path typed in the prompt | Yes. "Analyze this image: /path/to/your/image.png" is a documented method **V** [S1] | Reported to attach local images when a path is pasted. **U** | Not documented for a bare path. `@path` is the documented form. **R** [S9] |
| `@path` mention | Yes for files. `@` opens a path menu. Directories give a listing, not content. Image behaviour not stated. **V** [S1] | `@` fuzzy file search exists in the composer. Image behaviour **U**. | Yes. "@assets/error-screenshot.png" style mentions pass images to the model. **R** [S9] |
| Clipboard paste | `Ctrl+V`, or `Alt+V` on Windows and WSL. Shown as `[Image #1]`. **V** [S1] | `Ctrl+V` on Linux and Windows, `Cmd+V` on macOS. Image shows inline in the composer. **R** [S4] | `Ctrl+V` or `Shift+Insert`. Windows uses `Alt+V`. The image is saved as `clipboard-<timestamp>.png` under a temp folder and the prompt gets a path. Where that folder is differs between the PR (`.gemini-clipboard/`) and a user report (`.gemini/tmp/<workspace>/images/`). **R** [S10] [S11] |
| Drag and drop | "Drag and drop an image into the Claude Code window" **V** [S1]. In a real terminal the emulator turns the drop into typed path text. | Reported to work in emulators that forward drops, again as text. **R** [S4] | Not documented. **U** |
| CLI flag at launch | Positional prompt only. No image flag confirmed. **U** | `--image` or `-i`, comma separated, PNG JPEG GIF WebP. **R** [S4] | `-i` means prompt-interactive in Gemini, not image. Use `@path` in the prompt. **U** |
| Image formats | PNG, JPEG, GIF, WebP for MCP results **V** [S3]. Same set for input **U**. | PNG, JPEG, GIF, WebP **R** [S4] | png, jpg, webp named. **R** [S9] |

### 2.2 Other files, MCP, and what the agent can tell us

| Capability | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Other files | `@path` includes the file. Directories list. `CLAUDE.md` in the file's directories rides along. **V** [S1] | Reads by tool call from the sandboxed workspace. `@` search. | `@path` and directories. `read_file`, `read_many_files` tools. **V** [S6] |
| MCP transports | HTTP with `headers`, `${VAR}` expansion in `.mcp.json`. **V** [S3] | Local and remote servers via `config.toml`. **V** [S5] | `mcp_<server>_<tool>` naming, settings.json config. **V** [S6] |
| MCP tool result with an image block | Yes. PNG, JPEG, GIF, WebP. Shown inline to the model. Original bytes are also saved under `~/.claude/projects/<project>/tool-results/` and the path is given to the model. Needs v2.1.283 or later. **V** [S3] | Partly. The request for image responses (issue 4819) is closed with a fix PR **R** [S7], but a later report says `content[]` blocks are dropped when `structuredContent` is present [S8]. Return image blocks with no `structuredContent`. **R** | Yes. Text is merged into one `functionResponse` and the image becomes a separate `inlineData` part. **R** [S12] |
| MCP resources | `@server:protocol://path` mentions, fetched as attachments. Blob and image resources are not confirmed to reach the model. **V/U** [S3] | Not confirmed. **U** | Reported as interpretable in tool results. Resource mentions **U**. |
| MCP output limit | Warns at 10,000 tokens, truncates to a file at 25,000, per-tool override up to 500,000 characters through `_meta["anthropic/maxResultSizeChars"]`. **V** [S3] | **U** | **U** |
| Hooks | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `Stop` and about 25 more. `PostToolUse` gets `tool_name`, `tool_input`, `tool_response`, `tool_use_id` and the common fields. A `matcher` of `Read` works, and `if` takes patterns like `Read(*.png)`. Project config in `.claude/settings.json` or `.claude/settings.local.json`. **V** [S2] | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop` and more. `PostToolUse` sees Bash, `apply_patch`, MCP tools and local function tools. Hosted tools such as web search are not seen. `transcript_path` is in the payload. Project config in `<repo>/.codex/hooks.json` or `config.toml`. `command_windows` override exists. Whether the `view_image` tool is observable is **U**. **V** [S13] | `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `SessionStart` and others. `AfterTool` gets `tool_name`, `tool_input`, `tool_response` (`llmContent`, `returnDisplay`), `mcp_context`. Matchers include `read_file` and `read_many_files`. Project config in `.gemini/settings.json`. **V** [S14] |
| Hook cost | Low. **U** | One report of 17 to 25 seconds added per `exec_command` on Windows with lifecycle hooks on CLI 0.150.1. Treat hooks on Codex-for-Windows as a risk until measured. **R** [S15] | **U** |
| Transcript files | `~/.claude/projects/<project>/<session>.jsonl`, one JSON object per line. Subagent reads of images have been reported stored as base64 inside meta files. **V/R** [S16] | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. **R** [S13] | Chat files under `~/.gemini/tmp/…`. Format **U**. |
| Video | No video input path found in the docs. Treat as none. **U** | None found. **U** | The Gemini API takes video (MP4, MOV, WEBM and others) [S17]. The CLI took video only after being told to try, per an issue [S18]. Treat as unreliable. **R** |

### 2.3 What the matrix means for the design

1. **Path in the prompt is the only input that works for all three.** It needs no flags, no MCP and no hooks. It is the floor (D1).
2. **Clipboard paste is the only input that needs the keystroke to reach the harness.** Fixing our `Ctrl+V` handling (section 4.2) gets Claude Code's and Codex's native paste for free, and is a nicer experience than a path. Gemini's paste writes a file, which is what we would do anyway.
3. **MCP image results reach the model on Claude Code and Gemini, and probably on Codex.** That makes `kaava-context` a real second channel (section 7). It cannot be the only one because it needs the agent to choose to call a tool.
4. **Hooks tell us what the agent read on Claude Code and Gemini, and are unproven for images on Codex.** The transcript is the fallback for all three.
5. **No video anywhere in the terminal harnesses.** Keyframes it is, until that changes (section 8).

## 3. Design overview

```
   producer panels                    shell (React)                 Rust core                     harness in a pty
 ┌────────────────┐  put(bytes|uri) ┌───────────────────┐  context/put ┌──────────────────┐
 │ Play, canvas,  │───────────────► │ ContextStore      │────────────► │ writes file      │
 │ viewers, Files │◄─ capture req ─ │ (ids, thumbs)     │◄─ item+path ─│ .kaava/context/  │
 └────────────────┘                 │        │          │              │ sniffs, resizes  │
                                    │   tray (staging)  │              │ prunes           │
       drag / paste / OS drop ────► │        │          │              └──────────────────┘
                                    │  terminal drop    │  insert reference (no newline)
                                    │  + harness adapter│────────────────────────────────► claude | codex | gemini
                                    └───────────────────┘
                                                              ▲ hooks / transcript watcher
   consumers: terminal drop │ kaava-context MCP │ Files app    │ "agent saw" events ► gallery strip on the terminal pane
```

Principles, in the order they win a conflict:

1. **Nothing in the pty stream except text the user could have typed.** No image bytes, no escape sequences (section 5.2).
2. **Files are the truth.** A `ContextItem` is a record about a file. If the record is lost the file still works.
3. **Ids over bytes.** Bytes cross the bridge once. Drags, the tray, MCP and the gallery pass ids.
4. **The shell decides provenance.** An app says what it is publishing, the shell stamps who published it (section 9.4).
5. **Nothing runs.** No reference ever carries a newline, and no drop submits a prompt.
6. **Local only.** No Kaava-side network call. The harness's own upload to its model provider is outside our control and the UI says so (section 8.3).

## 4. Input path (goal 1)

### 4.1 The drag, and the shell-wide MIME

Two kinds of drag already exist and neither is HTML5 drag and drop (`docs/design-notes/drag-files-to-terminal.md`): an OS file drag reported by Tauri, and a pointer gesture split at the iframe edge with `kaava/drag`. HTML5 `dragstart` inside an iframe is a poor fit for the same reason the Files app avoided it: the shell must hear the press and the release, and an iframe swallows pointer events.

Decision D3:

1. **Internal drags extend `kaava/drag`.** The message today is `{phase: "begin" | "end", paths?: string[]}`. Add `items?: string[]`, a list of `ContextItem` ids already registered with the shell through `context/put` (section 6.2). The shell keeps drawing the ghost and hit-testing `terminalAt`. A frame that drags an item it owns has to register it first, which is one bridge call and is what makes a drag cheap: the drop moves an id, never bytes.
2. **`application/x-kaava-context` is the HTML5 carrier.** Payload is JSON, `{"v":1,"ids":["ctx_01J…"]}` and nothing else, with a `text/plain` fallback of the item titles so an accidental drop into a text box is harmless. It exists for three cases the pointer gesture cannot serve: dragging an `<img>` or canvas selection that a web-based app renders itself, dragging a tray item out to another application, and accepting a drop from another Kaava window. The terminal drop zone listens for both.
3. **The terminal drop zone becomes the single receiver.** Today `terminalAt` answers for file drags. It answers for context drags too, and the drop handler branches on payload kind: OS paths, context ids.
4. **Refusal is visible.** Dropping onto a cluster in another environment, or onto a terminal that has no harness detected and is not a plain shell, shows the same hint pattern as a refused tab move (`KAAVA-UX-REWORK.md` section 2.6), not a silent no-op.

What a drop onto a terminal does, in order:

1. Resolve the ids to `ContextItem`s, each with an on-disk path inside this terminal's environment. An item from another environment is copied in first (section 9.2).
2. Ask the harness adapter (4.3) for the reference text for each item.
3. Insert the joined text through the existing insert path, with control characters stripped and no newline (section 9.3).
4. Flash a chip "3 items sent to claude" on the pane, with Undo (see 4.5).

### 4.2 Clipboard images and pasted files

Change `clipboard.ts` so that `handlePaste` looks at `clipboardData.files` as well as `text/plain`. Order of rules:

1. Text present: unchanged behaviour. Text always wins, because a copied spreadsheet range carries both text and a bitmap and the text is what the user meant.
2. No text, an image file present: hand the image bytes to `context/put` (kind `image`, source `clipboard`), and insert the adapter's reference. This replaces the dead `Ctrl+V` for image clipboards.
3. Also let `Alt+V` through to the pty untouched. Claude Code and Gemini use it on Windows [S1] [S11], and `isPasteKey` already excludes `Alt` deliberately.
4. **Decided (D10): Kaava owns the paste.** The image is written to `.kaava/context/`, the agent is pointed at the path, and the item shows in the Context strip beside the main terminal (4.4). Passing `Ctrl+V` through to the harness's native paste is not offered in v1, because the harness's own copy would be invisible to the strip and to retention.

### 4.3 Harness detection and adapters

**Detection.** Rust owns the pty child. Extend `PtySessions` with `foreground_harness(id) -> Option<Harness>`:

1. **Explicit.** A tab opened from an OpenKaava preset ("claude", "codex", "gemini") is tagged at spawn. The user can also set it from the tab's context menu ("This terminal is running: Auto, Claude Code, Codex, Gemini, Plain shell"). An explicit tag always wins.
2. **Process tree.** Walk the descendants of the shell pid and match executable and first argument: `claude`, `claude.exe`, `codex`, `gemini`, and `node`/`bun` whose script path contains `claude-code`, `@openai/codex` or `gemini-cli`. Sample on a drop, not on a timer. **U** on how each installs on Windows (native binary, npm shim, or a `node` child), which is a phase-1 spike.
3. **Title.** Harnesses set their terminal title through OSC. Weak, since a title is the program's to change, but xterm already parses it. Tie-breaker only.
4. **Fallback.** Detected nothing: treat as a plain shell and use today's shell-quoted paths.

The result is a small enum, `Harness = Claude | Codex | Gemini | Shell | Unknown`, carried on the terminal session in `shell:state` so the tray can label its target ("Send to claude").

**Adapters.** One pure function per harness, in Rust beside `quoting.rs` so quoting stays in one place and is unit-testable:

```
fn reference(harness: Harness, item: &ContextItem, shell: ShellFamily) -> Reference
struct Reference { text: String, needs_trailing_space: bool, prompt_hint: Option<String> }
```

| Harness | Image | Text, log, file | Notes |
|---|---|---|---|
| Claude Code | relative path, forward slashes, no quotes, then a space | `@relative/path ` | Both forms are documented **V** [S1]. Whether `@` on an image attaches it is **U** and decides the image form. Paths are generated without spaces so no quoting exists to get wrong. |
| Codex | relative path, then a space | `@relative/path ` | Image attach from a path is **U**. Fallback if the spike fails: a launch-time `-i` for staged items, and for a running session a `prompt_hint` "read this image: path". |
| Gemini | `@relative/path ` | `@relative/path ` | `@` is the documented image route **R** [S9]. |
| Shell or unknown | shell-quoted absolute path (today's behaviour) | same | Unchanged. |

Rules common to every adapter:

1. **Relative to the terminal's cwd** when the item is under it, absolute otherwise. Relative is shorter, survives a moved worktree and reads well in the transcript.
2. **Forward slashes.** All three harnesses run on Windows and accept them. **U** for Codex, part of the spike.
3. **Filenames come from us**: `<yyyymmdd-hhmmss>-<slug>.<ext>` with the slug limited to `[a-z0-9-]`, so no adapter ever has to quote. This is why quoting is not the adapter's problem.
4. **A lead-in is optional and off by default.** Some users want "See attached: " before the paths. The tray has a caption field (4.4) for that. Adapters never invent prose.
5. **Video and other unsupported kinds never reach an adapter as themselves.** They are degraded first (section 8), and the adapter sees the keyframes.

### 4.4 The context tray

A staging strip so several items can be gathered, looked at and sent as one.

| Aspect | Behaviour |
|---|---|
| Where | A collapsible strip docked to the bottom edge of a terminal pane, above the prompt row. One tray per terminal, remembered per cluster. Empty and collapsed by default, so nothing changes for people who never use it. |
| What lands in it | Anything dropped on the strip itself, the "Add to tray" action on every producer (section 6.4), and a paste while the tray has focus. Dropping on the terminal body still sends immediately. The two gestures are different on purpose. |
| Chip | 56 px thumbnail (image, video poster, or a kind icon for text and logs), title, source app glyph, size, remove `×`. Hover shows provenance and age. A chip whose file is gone is greyed with a reason. |
| Actions | **Send** (inserts all references, in tray order, no newline, then keeps or clears per a setting), **Send one** (per chip), **Caption** (a one-line text inserted before the references), **Clear**. Drag a chip onto any terminal to send just that one there. |
| Multi-select | Shift and Ctrl click select. Send acts on the selection, or all when none. |
| Target label | "claude", "codex", "gemini", "shell" from detection. If the label is "shell", the Send button reads "Paste paths" so nobody expects an attachment. |
| Limits | Twenty items. Over that, the strip asks to send or clear. A per-message cap is a harness matter, so the tray warns at the limits in section 6.5 rather than blocking. |
| Keyboard | `Ctrl+Shift+A` opens the tray for the focused terminal. `Enter` on a focused chip sends it. All controls are reachable without a mouse. |

### 4.5 Undo

The insertion is text at a prompt, so undo is real for a moment: a "3 items sent" chip with **Undo** sends the same number of backspaces. Backspace count equals the inserted character count, and Undo disappears the moment the user types anything, because after that the count is a guess. Undo does not delete files.

### 4.6 OS file drops

Already routed by Tauri drag events to the terminal zone. New behaviour:

1. **Inside the environment root**: reference in place. No copy.
2. **Outside it** (Downloads, Desktop): copy into `.kaava/context/`, with a size cap (section 6.5), so the agent's sandbox can read it and the environment stays self-contained. The original is never moved or modified.
3. **Kind is sniffed from bytes**, not trusted from the extension (section 9.1). A `.png` that is really an executable is refused with a message.
4. A directory drop sends the directory path as a plain reference and does not recurse. Claude Code lists a directory on `@dir` [S1], and a recursive copy is exactly the surprise we want to avoid.

## 5. Output path (goal 2): what the agent saw

### 5.1 Two ways to show an image next to a terminal

| | Inline in the terminal | Sidecar |
|---|---|---|
| How | Add `@xterm/addon-image`. It renders Sixel, iTerm's inline image protocol (IIP, sent as `OSC 1337`) and a work-in-progress Kitty protocol, and needs the harness (or us) to emit those sequences [S19]. | A strip or gallery in Kaava's own UI, beside the terminal pane, fed by hooks or a transcript watcher. |
| Does it need the harness to cooperate | Yes. None of the three harnesses is confirmed to emit inline image sequences. Codex has an open request to add them [S20]. | No. It reads what the harness already records or reports. |
| Effect on the harness UI | Interferes (5.2). | None. It is outside the pty. |
| Resize and scrollback | Images are erased by characters written over them, fragment on reflow, and vanish when the alternate buffer is switched [S19]. | Independent of terminal state. |
| Work | Small to enable, unbounded to make reliable. | Moderate, and it is where the extra value is (provenance, click to open, comments). |
| Verdict | Not now. | **Recommended.** |

### 5.2 Why injecting images into the pty breaks full-screen TUIs

The tempting shortcut is "when the agent reads `a.png`, write a Sixel of it into the terminal". It fails, for reasons that compound:

1. **Claude Code, Codex and Gemini draw with a TUI framework** (Claude Code's UI is built on Ink, per the brief for this spec; the other two are **U**). These redraw their live region by moving the cursor up a counted number of rows and erasing lines, then repainting. An image occupies cell rows the framework did not count. On the next repaint the cursor arithmetic is off by the image height, and the frame tears: stale rows, a duplicated prompt, a status line drawn on top of the picture.
2. **Characters written over an image erase it** [S19]. The harness repaints its live region continuously, spinner and token counter included, and any repaint that crosses the image cells wipes those cells.
3. **We do not control the write position.** The harness owns the cursor. If we write our bytes into xterm at an arbitrary moment we land in the middle of its escape sequence or its repaint. Buffering until the harness is idle is a guess we cannot check.
4. **Resize and scrollback.** Text wrap fragments an image over several cells on resize [S19]. The harness handles resize by repainting from its own state, which knows nothing about our image.
5. **The alternate screen** discards images on a buffer switch [S19]. A harness that uses it loses every image on exit and entry.
6. **Sending bytes to the pty stdin instead is worse.** That is keystrokes: the harness would read the escape sequence as input text.

So the pty stays text. The image is shown by Kaava, in Kaava's own DOM, where nothing repaints it.

### 5.3 Recommended: an "agent saw" strip fed by hooks, with a transcript fallback

**Event model.** One normalised event, produced by whichever source is available:

```
AgentSeen {
  terminalId, harness, sessionId?,
  kind: "image" | "text" | "file",
  path: string,            // absolute, inside or outside the environment
  via: "read" | "view_image" | "mcp" | "user_paste" | "unknown",
  at: number,              // epoch ms
  bytesRef?: string,       // optional: a ContextItem id when the file was ours
}
```

Sources, in priority order per harness:

| Harness | Primary | Fallback | Why |
|---|---|---|---|
| Claude Code | `PostToolUse` hook, `matcher: "Read"`, filtered to image extensions by `if: "Read(*.png)"` and siblings. Payload gives `tool_input.file_path` [S2]. Second hook on `mcp__.*` to catch MCP image results. | Transcript watcher on `~/.claude/projects/<project>/*.jsonl`. | Documented, cheap, and the hook payload carries `transcript_path`, which lets the watcher find the right file with no guessing. |
| Gemini CLI | `AfterTool` with matcher `read_file\|read_many_files` [S14]. | Chat file watcher. Format **U**. | Same shape as Claude Code. |
| Codex | Transcript watcher on `~/.codex/sessions/**/rollout-*.jsonl`. | `PostToolUse` if measured cheap on Windows. | The 17 to 25 second hook penalty on Windows [S15] is unacceptable on the hot path, and observing `view_image` through hooks is unconfirmed [S13]. **R/U** |

**Hooks call home through a tiny sidecar, not `curl`.** Hook commands run under whatever shell the harness uses, and Windows quoting there is a trap. Ship `kaava-hook` as a Tauri sidecar binary. It reads the hook JSON on stdin, reads `KAAVA_MCP_PORT`, `KAAVA_MCP_TOKEN` and the new `KAAVA_TERMINAL_ID` from its environment (the pty already carries the first two, `pty.rs` is where the third is added), and posts to a new listener route `/hook/<harness>` with the same bearer guard as `/mcp/*`. Outside an OpenKaava terminal the variables are absent and it exits 0 at once, so a hook file committed by accident does nothing.

**Filter early.** The sidecar drops everything except image reads and MCP results before any network call. The Rust route re-checks. On a slow hook system every avoided event is worth having, Codex on Windows above all.

**Where hooks are installed.** Per environment, never the user's home:

| Harness | File written | Trust |
|---|---|---|
| Claude Code | `<env>/.claude/settings.local.json`, the gitignored one [S2] | One confirm per project, showing the JSON that will be written. |
| Codex | `<env>/.codex/hooks.json` [S13] | Same. Whether Codex asks the user to trust project hooks is **U**. |
| Gemini | `<env>/.gemini/settings.json` [S14] | Same. |

Editing a harness's config is a standing rule change, which this workspace treats as needing consent (same as the `.mcp.json` write today). **Approved by Braden (D9), on the condition that Kaava always asks before writing.** Kaava shows the diff, writes once, and offers **Remove** in the same place. Nothing is written until the user says yes.

**Transcript watcher.** A Rust task using the `notify` crate on the harness's session directory, tailing appended lines. It parses only the fields it needs. Two cautions from the sources: transcripts can hold images inline as base64 [S16], so it must never copy a line into an event, only a path or a hash; and the session file for a terminal is identified by cwd and start time, or by `transcript_path` when a hook has supplied it.

**The strip.** A row along the top edge of the terminal pane, hidden until the first event.

| Aspect | Behaviour |
|---|---|
| Content | Thumbnails of the last eight images the agent read, newest at the right, with a count when there are more. |
| Chip | Thumbnail, file name, how it was read (`Read`, `view_image`, `mcp`), age. A chip for a file that changed since is marked "changed". |
| Click | Opens the image in a lightbox with **Open in Files viewer**, **Copy path**, **Comment** (creates a comment in `.kaava/comments/` anchored to the image, the same store as `apps/shared/comments.ts`), and **Add to tray**. |
| Gallery | An expand control turns the strip into a grid over the pane. Filters: this session, all sessions in this cluster. |
| Privacy | Thumbnails are generated from the file on disk in Rust and never leave the machine. Files outside the environment root show a name and a lock and no thumbnail until clicked, so a stray read of a personal image is not painted on screen by surprise. |
| What it does not claim | It shows what the agent **opened**, which is not proof the model looked at it or that the harness passed it at full size. The label says "opened by the agent". |

**Known limits, stated plainly.** An agent that writes an image (a screenshot from a script it ran) is not a read and will not appear. A later "agent made" feed from a file watcher on the environment is possible and noisy; it is an open question (section 11), not in scope. Images pasted by the user are visible through the transcript as `user_paste`, which is useful for the gallery to show both directions.

## 6. The standard context contract (goal 3)

### 6.1 `ContextItem`

A record in TypeScript, mirrored by a serde struct in a new `src-tauri/src/context.rs`.

```ts
type ContextKind =
  | "image" | "video" | "text" | "file"
  | "selection"   // a highlighted region: text range, node, mesh part, canvas frame
  | "log"         // terminal or build output, tail-oriented
  | "audio";      // reserved, not handled in v1

interface ContextItem {
  id: string;                       // "ctx_" + ULID, minted by Rust, never by an app
  v: 1;
  kind: ContextKind;
  mime: string;                     // sniffed from bytes by Rust, not taken on trust
  title: string;                    // short, human, shown in the tray. 120 chars max
  description?: string;             // one sentence for the model and the tooltip. 500 max
  source: {
    appId: string;                  // stamped by the shell from the frame, not by the app
    instanceId: string;
    clusterId: string;
    environmentId: string;
    label?: string;                 // "Play - scene hospital_wing.tscn"
  };
  provenance: {
    method: "provider" | "capture" | "stream" | "drop" | "clipboard" | "agent";
    origin?: string;                // path, URL or anchor the content came from
    anchor?: unknown;               // same shape as comments.ts Anchor when there is one
    untrusted: boolean;             // true for text scraped from the web or from another agent
  };
  createdAt: number;                // epoch ms
  expiresAt?: number;               // epoch ms, absent means default retention
  pinned: boolean;
  size: number;                     // bytes of the stored file
  file: { path: string; relPath: string };   // set once materialised
  image?: { width: number; height: number; downscaledFrom?: [number, number] };
  video?: { durationMs: number; width: number; height: number;
            keyframes?: string[];   // ids of derived image items
            poster?: string };
  text?: { chars: number; lines: number; truncated: boolean };
  derivatives?: string[];           // ids of items made from this one (keyframes, sheet)
}
```

### 6.2 How a tool publishes

Three modes, all through `@openkaava/bridge`. All three end in the same call, so the store has one entry point.

**Mode A, provider (push).** The app has something now and hands it over.

```ts
context.put({ kind: "image", title: "Play frame 00:12", bytes: pngArrayBuffer,
              mime: "image/png", anchor })
  // -> Promise<ContextItem>
context.put({ kind: "video", title: "Play recording", uri: "recordings/run-3.webm" })
  // uri is project-relative and already on disk. No bytes cross the bridge.
```

`bytes` is transferred, not copied (`postMessage` with a transfer list). Above 16 MB the app passes a `uri` for a file it wrote itself, because a structured clone of 200 MB into the shell is the wrong shape.

**Mode B, capture on demand (pull).** A tool declares that it *can* produce context, and the shell or an agent asks. This is what makes "snapshot Play mode" and "render canvas selection" work without the app knowing who is asking.

```ts
context.registerProvider({
  id: "play.frame",
  kinds: ["image"],
  title: "Snapshot the running scene",
  available: () => running,          // false disables the tray action and the MCP tool
  capture: async (opts) => ({ kind: "image", bytes, mime: "image/png", anchor }),
});
```

The shell asks a provider by sending a `kaava:context/capture` event `{requestId, providerId, opts}` and awaits the app's `kaava/context/put` reply carrying that `requestId`. That reuses the existing primitives (a shell event down, a request up) because the bridge has no shell-to-app request today, and adding one for this alone would be a second RPC direction to maintain. A capture has a 10 second timeout, after which the requester sees "Play did not answer".

Providers are listed by `context/providers` (shell) and are what the tray's **+** menu and the MCP `context_capture` tool (section 7) both enumerate. Naming: `<appId>.<what>`, lowercase.

**Mode C, continuous stream.** A source that changes constantly (Play's live frame, a log tail).

```ts
const stream = context.openStream({ kind: "image", title: "Play live" });
stream.update({ bytes });     // replaces the current frame, cheap, not persisted
stream.freeze();              // -> Promise<ContextItem>  materialises the current frame
stream.close();
```

A stream is **not** an item. It is a source with a "current frame" the tray can show live, and only `freeze()` (the user clicks, an agent asks, a drag begins) creates a real `ContextItem`. Frames are never written to disk on update, so a 60 fps producer costs nothing on disk. Streams ride the existing retained `publish` topic for their latest frame metadata (`context/stream/<appId>/<id>`), so a tray mounted late is told the current state, as the bridge already guarantees for topics.

### 6.3 What Rust does on `context/put`

The single implementation of the contract, in `context.rs`. This is the only code that touches the disk for context.

1. Validate: `kind` known, byte or uri length within limits (6.5), caller identified by the shell (9.4).
2. Sniff the content type from the first bytes. Reject a mismatch with a declared `mime` for image and video, and reject anything executable-looking.
3. Mint the id, build the filename (`<yyyymmdd-hhmmss>-<slug>.<ext>`), resolve the environment's context root, canonicalise, check containment (section 9.1), write with create-new semantics.
4. Post-process by kind. Image: read dimensions, downscale if past the long-edge limit (keeping the original as `<name>.orig.png` only when the user's setting keeps originals), generate a 256 px thumbnail into `.kaava/context/.thumbs/`. Text: count, truncate to the limit and record `truncated`. Video: probe duration, then degrade (section 8).
5. Append to `.kaava/context/index.jsonl` (one line per item) so a restart can rebuild the store, and emit `context:added` to the shell.
6. Return the `ContextItem`.

`.kaava/context/` carries its own `.gitignore` containing `*`, so context files never enter a commit. `.kaava/comments/` is the opposite on purpose: comments should travel with the branch, context should not.

### 6.4 Consumers

| Consumer | How it receives | Notes |
|---|---|---|
| Terminal drop and paste | Ids through the drag, adapters build text (section 4) | Phase 1 for files and clipboard, phase 2 for producer items. |
| Context tray | Store subscription, `context:added` | Section 4.4. |
| `kaava-context` MCP server | Reads the store through Rust and returns MCP content | Section 7. Phase 3. |
| Files app | A new "Context" virtual folder in the explorer, listing `.kaava/context/` newest first with thumbnails, and the standard viewer to open one. Reuses `kaava/open`. | It is the human's inspector for what has been staged or sent. |
| Comments | An item can be attached as the screenshot of a comment | Reuses the comments store, no new path. |
| Another cluster | Same environment: shared store. Different environment: a copy, never a link (9.2). | |

Every producer gets one shared UI affordance so nothing is bespoke per app: a **"Send to agent"** split button (`Add to tray` and `Send to terminal`) in the app's header, provided as a component in `apps/shared/`, next to `CommentPanel.tsx`. Apps that already offer "Capture & comment" (Play, `Ctrl+Shift+C`) add this beside it.

### 6.5 Size limits

Defaults, all overridable in settings and enforced in Rust.

| Kind | Stored limit | Notes |
|---|---|---|
| image | 8 MB after downscale, long edge 2048 px | Anthropic's vision guidance resizes past a long edge of about 1568 px, so more pixels than that are wasted on Claude. **U** for the exact figure in current docs. Codex and Gemini limits **U**. |
| video | 200 MB stored | Never sent as a video. See section 8. |
| text | 256 KB per item | Larger is truncated at a line boundary with a marker line, and the full text kept in the file. |
| log | 1 MB stored, last 200 lines shown as the preview | Tail-oriented by default. |
| file | 25 MB copy limit for OS drops | Over it, reference in place only if inside the environment, else refuse. |
| MCP result | Under 20,000 tokens of text per call, images one per block, at most 4 blocks | Below Claude Code's 25,000 token cut-off [S3] so nothing spills to a file unexpectedly. |
| per environment | 500 MB total, 500 items | Oldest unpinned pruned first (section 8.4). |

## 7. `kaava-context`: the agent pulls (phase 3)

### 7.1 Why this earns a server

`servers/mod.rs` says a server exists only if "the harness can already do it" is false. Three things the harness cannot do:

1. **Capture.** An agent cannot make Play take a frame or ask the canvas to render a selection. Only Kaava can. This is `debug` and `ui` territory, and the strongest reason.
2. **Discover what the human staged.** The tray, the current Play frame and the canvas selection are live state, not files (until frozen).
3. **Return an image the model actually sees.** A file path needs the model to spend a `Read`. An MCP image block reaches the model directly on Claude Code and Gemini [S3] [S12].

What it does not do: read or list project files. `Read` and `@` do that already. It never becomes a second file server.

### 7.2 Surface

Registered in `servers/mod.rs` after `agent`, ordinary (no `dev_only` gate) because its reads are the user's own context and its one action is guarded by the confirm in 7.4.

| Tool | Input | Returns |
|---|---|---|
| `context_list` | `{kind?, limit?, staged?: bool}` | Text table of items: id, kind, title, source, age, size, relPath. `staged: true` limits to the tray. |
| `context_get` | `{id, as?: "image" \| "path" \| "text"}` | For an image: an image content block plus a text block with `relPath`, so the file is reachable if a client drops the image block. For text: the text, truncated at limits. For video: the keyframes and metadata (section 8). No `structuredContent` on image results, because of the Codex report [S8]. |
| `context_capture` | `{provider, opts?}` | Runs a registered provider (6.2 mode B) and returns the same as `context_get` for the new item. |
| `context_providers` | `{}` | The providers currently available and their option schemas. Empty list when nothing is running. |
| `context_publish` | `{title, text \| path, kind?}` | Lets an agent put something into the tray for the human, such as a generated diagram. Path must resolve inside the environment. Provenance is `agent`, and it is never sent anywhere on its own. |

**Resources.** `kaava-context://item/<id>` for each non-expired item, and `kaava-context://tray` for the staged list, with `notifications/resources/list_changed` on change. This makes `@kaava-context:kaava-context://item/…` work in Claude Code [S3]. Whether an image or blob resource reaches the model there is **U**, so the tools above are the contract and resources are a convenience.

### 7.3 Wiring

1. `.mcp.json` written into projects gains a `kaava-context` entry using the same `Bearer ${KAAVA_MCP_TOKEN}` and `${KAAVA_MCP_PORT}` shape as `kaava-debug`. Nothing new to learn.
2. The server needs to know **which environment** the caller is in. The existing listener is one port for the whole app, so the route carries it: `/mcp/context`, with the terminal id in an `X-Kaava-Terminal` header set from `${KAAVA_TERMINAL_ID}` (new pty env var) in the `.mcp.json` `headers` block. Env expansion in headers is supported by Claude Code [S3]. Support in Codex and Gemini configs is **U**, so the server also accepts a token-derived binding: the bearer token could be per-terminal. Which of the two is an open question (section 11), and per-terminal tokens are the sturdier answer.
3. Codex and Gemini get the same server through their own config files, written on the same consent as hook installation (5.3).

### 7.4 What the agent may and may not do

1. `context_capture` performs an action in a visible app. It shows a toast in that app ("claude asked for a Play snapshot") and is rate limited to one per provider per two seconds. A setting **Ask before an agent captures** turns it into a prompt. Default: on for the first use per session, then quiet.
2. Text an agent receives from `context_get` is data. The tool result labels items with `provenance.untrusted` and prefixes untrusted text with a fixed header, so a scraped web page in a log does not present itself as an instruction. This lowers the risk, it does not remove it.
3. Nothing here can write outside `.kaava/context/`, execute anything, or reach another environment's items.

## 8. Capability negotiation, degradation and lifecycle

### 8.1 Negotiation

The shell holds a static table of harness capabilities, seeded from section 2 and overridable per harness in settings, because these facts move.

```ts
interface HarnessCaps {
  image: "attach" | "path" | "none";     // how an image reaches the model
  video: "native" | "none";
  mcpImageResult: "yes" | "partial" | "no";
  maxImagePx: number; maxImagesPerMessage: number;
}
```

A producer never asks about harnesses. It publishes a `ContextItem` and the **consumer** asks `degrade(item, caps)`. That keeps the knowledge in one function and lets a producer ship before any harness is known.

### 8.2 Degradation rules

| Item | Harness cannot take it | Result |
|---|---|---|
| video | all three today (video **none**) | Keyframes plus metadata. Rust extracts N frames (default 6, evenly spaced, plus the first and last), makes a contact sheet image of them, and writes `<name>.frames.json` with duration, size, fps and timestamps. Sent as the contact sheet and the frame paths. Each keyframe is a derived `image` item linked through `derivatives`. |
| video from Play with a known event list | same | Producer may supply its own keyframes (`derivatives` passed to `put`), since it knows which frames matter (a crash, a comment marker). Preferred over evenly spaced. |
| image too large | any | Downscaled copy, original kept under the retention rules. |
| many images | over `maxImagesPerMessage` | Contact sheet plus individual paths, and a tray warning. |
| log or text | over 256 KB | Truncated with a marker, and the full file path in the reference. |
| selection | none | It is already a text or image item made by the provider. |
| audio | all | Not handled in v1. The tray refuses with a clear message. |

**Deferred (open question 4): no video work in v1.** The rest of this subsection records the intended design so it is not lost. Frame extraction needs a decoder. **ffmpeg is the obvious tool and a heavy dependency to bundle** (size, licence review, Windows packaging). Options are in section 11. Providers that already render frames themselves (Play, the canvas) avoid the dependency, which is the argument for making derivatives a provider field.

### 8.3 Privacy

1. Kaava sends nothing anywhere. The listener binds `127.0.0.1` only and the hook route and MCP route both need the bearer token (section 9.5).
2. **Once an item reaches a harness, that harness may send it to its model provider.** Kaava cannot prevent that and does not pretend to. The first send of each session shows one line under the tray: "This goes to Claude Code and from there to its model provider." A setting removes it.
3. Thumbnails, keyframes and the index are local files under the environment. Nothing is uploaded to the cloud services, and cloud sessions are out of scope for v1 (section 13).
4. A **"do not capture"** flag on a provider (for example the design canvas holding a private board) makes its `capture` refuse for `context_capture` calls while still allowing the human to drag.

### 8.4 Retention and cleanup

| Rule | Value |
|---|---|
| Default lifetime | 7 days from `createdAt`, refreshed when an item is sent or pinned |
| Pinned | Kept until unpinned |
| Per environment cap | 500 MB and 500 items, oldest unpinned first |
| When | At app start, when an environment opens, and every hour while it is open |
| Environment removed | The worktree goes and takes `.kaava/context/` with it. Nothing else to clean. |
| Derived items | Pruned with their parent |
| Index | `index.jsonl` compacted on prune |
| User control | **Clear context** on the tray, and in the Files app on the Context folder |

A pruned file that a harness session still refers to leaves a dead path in that conversation. The reference is a snapshot of a moment, so this is acceptable, and the 7 day default is long enough to make it rare.

## 9. Security

### 9.1 Path handling

The rules for every path Kaava creates, accepts or inserts.

1. **The context root is fixed**: `<environment root>/.kaava/context/`. Nothing else is writable by this feature.
2. **Rust mints every filename.** An app supplies a `title`, never a path. The slug is `[a-z0-9-]{1,48}` and the extension comes from a sniffed-type allowlist (`png`, `jpg`, `webp`, `gif`, `webm`, `mp4`, `txt`, `md`, `json`, `log`), never from an input string.
3. **Canonicalise, then check containment** (`starts_with` on the canonical root) before every write, read and insert. Refuse `..`, absolute paths in a `uri`, drive changes, UNC paths, and any component that is a reparse point or symlink. A worktree junction escaping the root is the classic Windows failure, so the check is on the resolved path, not the string.
4. **Windows names**: reject reserved device names (`CON`, `NUL`, `COM1`), trailing dots and spaces, alternate data stream syntax (`:`), and paths beyond the long-path limit, with a specific error.
5. **`uri` inputs** (a producer pointing at a file it already wrote) must resolve inside the environment root and are copied, not linked, unless the user set "reference in place" for that source.
6. **The environment must be writable.** `main` is read-only in Kaava (`KAAVA-UX-REWORK.md` section 2.3), and a terminal there is browse-only, so there is nothing to materialise for. The tray shows "Read-only environment" and refuses.
7. **Inserted paths never leave the environment** unless the user dropped an in-place file from outside (4.6 chose to copy for exactly this reason).

### 9.2 Cross-environment moves

Environments are isolated on purpose. An item dragged to a terminal in another environment is **copied** into that environment's context root and its provenance says so. It is never referenced through a path into a sibling worktree, because the agent there is sandboxed to its own tree and a reference outside it would either fail or, worse, widen access.

### 9.3 No auto-execution

1. **Never a newline.** The insertion is text only, with `\r`, `\n` and every C0 and C1 control character stripped, `ESC` included. This matters beyond newlines: a filename containing the bracketed-paste end marker `ESC [ 201 ~` would let a crafted path end the paste early and type the rest as commands. We control filenames, and the strip covers the OS-drop path where we do not.
2. **The existing "nothing is executed" property is kept and tested.** `docs/design-notes/drag-files-to-terminal.md` says it is enforced rather than assumed, and the new adapters get the same test: every adapter output, for every kind, contains no control character and no line break. A property test over generated titles.
3. **A drop never submits.** The user presses Enter themselves. Undo is there if the reference was wrong.
4. **Hook and MCP installs are consent-gated** (5.3, 7.3), show the exact content, and are reversible.
5. **Hooks Kaava installs only read.** The `kaava-hook` sidecar never returns a decision, never blocks a tool and never rewrites tool input, so it cannot change what the agent does. It emits events and exits 0.

### 9.4 Who published this?

An iframe app is not trusted to name itself. The shell receives bridge messages and already resolves `event.source` to an instance (`client.ts` ignores anything else), so **the shell writes `source.appId`, `instanceId` and `clusterId`**, and drops those fields if the app sends them. An app cannot claim to be Files to get a file-typed reference, and cannot publish into another cluster.

### 9.5 The local server

The same posture as `debug`, `ui` and `agent`, and no weaker:

1. Binds `127.0.0.1` only.
2. Every request, `/mcp/context` and `/hook/*`, needs `Authorization: Bearer <token>` compared in `require_token`.
3. The token is minted per launch and handed to the pty environment only, so a process outside an OpenKaava terminal has to read the handoff file, which is the situation `pnpm probe` already accepts.
4. **Verify the `Origin` header is rejected** on both routes, to stop a web page in any browser talking to `127.0.0.1` (DNS rebinding and cross-site requests). I did not read `listener.rs` closely enough to say it does this today. **U**, and a one-line check to add if it does not.
5. Request body limit on `/hook/*` (64 KB) and on MCP calls, so a hook cannot be used to stream the disk into memory.
6. Rate limits on `context_capture` (7.4) and `context_publish` (10 per minute).

## 10. Phased plan

Client-side phases first. "Client-side" means no MCP work and no listener change; Rust changes are limited to the pty layer and one context module.

### Phase 0: spikes (about a day, before phase 1 commits)

Each spike turns a **U** into a **V**. Results go into section 2 of this file.

1. Does `Ctrl+V` (unhandled) and `Alt+V` paste an image into Claude Code and Codex inside an OpenKaava terminal?
2. What does a bare relative path, and `@path`, do for an image in each harness, typed through the existing insert path?
3. How does each harness appear in the process tree on Windows (native binary, npm shim, node child)?
4. Do forward slashes work in all three on Windows?
5. Does `PostToolUse` fire for Codex `view_image`, and what does a hook cost on this machine?

### Phase 1: terminal drop of images and files, three adapters

Scope: OS file drops, clipboard images, Files-app drags; harness detection; the adapters; no producer changes, no tray, no server.

- `context.rs` minimal `put` for files and clipboard images (materialise, sniff, name, prune stub).
- `PtySessions::foreground_harness` and the `Harness` enum on the session.
- Adapters for Claude, Codex, Gemini and shell in Rust beside `quoting.rs`.
- `clipboard.ts` image paste rule (4.2) and the tab context-menu override.
- Drop handler branches on harness; unknown falls back to today's behaviour.

Acceptance:

1. Dropping a PNG from Explorer onto a terminal running each harness inserts the adapter's reference, with no newline, and the harness treats it as an image (per the phase-0 findings).
2. Pasting a screenshot with `Ctrl+V` into a Kaava terminal produces a file under `.kaava/context/` and a reference; pasting text is unchanged.
3. A path containing spaces, a quote, `[201~` or a control character can never reach the prompt as more than one inert token. Property test over adapters, plus a unit test per known bad name.
4. A plain shell still gets shell-quoted paths, exactly as today; an existing test proves it.
5. `main` refuses with a message. Nothing is written outside `.kaava/context/`.
6. `pnpm verify` passes, and the new Rust code has tests for detection matching, adapter output and path containment.

### Phase 2: the ContextItem bridge API and the tray

Scope: the contract, producers, the tray, and drags between panels. Still no MCP.

- `@openkaava/bridge`: `context.put`, `registerProvider`, `openStream`, `kaava/drag` `items`, the `kaava:context/capture` event.
- `application/x-kaava-context` on the terminal zone.
- Tray UI, undo, degrade for video and oversize images.
- Shared "Send to agent" component in `apps/shared/`.
- Files app "Context" folder.

Acceptance:

1. From the Godot Viewer, a "Send to agent" click adds an item to the tray of the focused terminal and drag from the chip onto a second terminal sends it there.
2. An app can only publish under its own `appId`; a forged `source` is dropped, proved by a bridge test.
3. A 30 second video item produces a contact sheet and six keyframes, and the tray sends the keyframes, not the video.
4. Tray, chips, Undo and Send are fully keyboard reachable, and pass the existing accessibility checks.
5. Killing and restarting the app rebuilds the tray from `index.jsonl` with no orphaned entries.
6. `bridge` tests cover the round trip of `put`, the capture request and its timeout.

### Phase 3: the `kaava-context` MCP server

Scope: server wiring, the last thing to need the listener.

- `servers/context.rs`, registered after `agent`; `/mcp/context` route; per-terminal binding; `KAAVA_TERMINAL_ID` in the pty env.
- Tools and resources of section 7.2, consent-gated `.mcp.json`, `.codex` and `.gemini` writes.
- `Origin` check and body limits (9.5).

Acceptance:

1. In Claude Code and Gemini, `context_get` on an image returns something the model can describe. In Codex, the phase-0 finding on image results decides whether the acceptance is "describes it" or "receives the path and reads it".
2. `context_capture` on the `play.frame` provider produces an item and a visible toast, and refuses with a clear error when Play is not running.
3. A request without the token, or with a foreign `Origin`, is rejected with the same status as `debug` does.
4. `servers/mod.rs` test lists the new id, and the "no file reading tool" rule holds: no tool here reads an arbitrary path.
5. Untrusted text carries its header.

### Phase 4: the "agent saw" gallery

Scope: the output path.

- `kaava-hook` sidecar, `/hook/*` route, `AgentSeen` events.
- Hook install and remove flow, per harness, with diffs.
- Transcript watcher (`notify`), Codex first.
- The strip, lightbox and gallery, comments from a chip.

Acceptance:

1. With Claude Code reading `docs/a.png`, a chip appears within one second, with the right name and `Read` label, and clicking opens it.
2. With hooks removed, the watcher path shows the same chip with a slower but working result for Claude and Codex.
3. Hooks fire only inside OpenKaava terminals; run outside one, the sidecar exits 0 and does nothing.
4. A transcript containing inline base64 does not put base64 into an event, a log or memory beyond one line's parse.
5. Files outside the environment show no thumbnail until clicked.
6. Measured hook overhead on Windows is recorded, and Codex uses the watcher unless hooks come in under an agreed budget.

### Phase 5: Play and design-canvas providers

Scope: real producers, on top of the contract.

- Play: `play.frame` (capture), `play.live` (stream), `play.clip` (a recording with the provider's own keyframes at comment markers). This needs Play to have a real running build, which `apps/play/ui/src/rpc.ts` says it does not yet (`build` is always `null`), so this phase is gated by the Play run decision in `KAAVA-UX-REWORK.md` section 9.2.
- Design canvas: `design.selection` (render a selection to PNG), `design.frame`, and the selection's text spec as a `selection` item.
- Viewers: `godot.viewport`, `blender.render` from their last renders, with the anchor from `comments.ts`.
- Each provider declares `available()`, `do not capture` where relevant, and its option schema.

Acceptance:

1. From a running Play, an agent calls `context_capture {provider: "play.frame"}` and receives the frame with the scene path in the anchor.
2. Selecting a mesh part in the Blender Viewer and clicking Send to agent yields one image item carrying the same anchor a comment would have.
3. A Play clip of 20 seconds with two comment markers is sent as at least those two frames plus the contact sheet.
4. No producer contains any harness-specific code, checked by a lint or grep test in CI.

## 11. Open questions for Braden

Answered on PR #153 and now closed: cloud sessions (out of v1, section 13), hook and MCP config writes (approved, consent-gated, D9), and the `Ctrl+V` policy (Kaava writes the file, D10). What remains, ordered by how much it changes the work.

1. **`kaava-hook` sidecar.** Still open, and Braden asked what it is for. Short answer: the harness runs a hook as a command and pipes it JSON. That command has to reach Kaava's local server with the token. On Windows the harness's hook shell is unpredictable, so the command has to work without quoting tricks and without needing `node` or `curl`. A small bundled binary is that command. The alternative is a hook written as a `curl.exe` line with the token in an environment variable, which works in Git Bash and is fragile elsewhere. Decide after the Friday spike shows how Claude Code's hook shell behaves on this machine. The cost of the sidecar is a second binary to sign and update.
2. **Per-terminal tokens.** Still open. Should the bearer token become per terminal, so the MCP and hook routes learn which environment a call belongs to without a header, at the cost of reworking `mcp::listener` and `handoff`? Not needed for Friday, where a hook can carry `KAAVA_TERMINAL_ID`.
3. **The gallery's promise.** "Opened by the agent" is what hooks can prove. Do you also want an "agent made" feed from a file watcher on new images in the worktree? It catches screenshots the agent produced, and it is noisy.
4. **Video and ffmpeg (deferred).** Revisit when a real need arrives. Options then: bundle ffmpeg (size, licence), rely on an optional install, or make keyframes a provider duty only (Play and canvas render their own frames, arbitrary dropped videos are refused). The last is the lightest.
5. **Default retention.** Seven days and 500 MB per environment. Fine, or should context be session-scoped and cleared when the terminal closes?
6. **Where the strip lives.** Beside the main terminal (decided, D10). Open: one strip per terminal, or one per cluster shared by all its terminals? Per cluster is simpler when two agents run side by side, and worse when they should not share.
7. **A fourth harness.** Adapters-as-data (a small TOML rule per harness) from the start, or Rust only? It costs a parser now and saves a release later.
8. **Naming.** "Context" collides with model context in an agent conversation. Candidates: Context, Attachments, Handoff, Bundle. Add the winner to `core/terminology.csv`. The UI label in D10 is "Context" for now.
9. **Privacy line.** The first-send notice says the harness may pass the item to its model provider. Is that the right level of warning, or do you want a per-project allow list?

## 13. Later

Captured, not in v1.

### 13.1 Cloud sessions

**Out of v1 (D8).** A streamed cloud terminal runs on a VM that cannot see local `.kaava/context/`. Claude Code's own cloud sessions already cover the case where an agent needs an image, so Kaava does not duplicate it. If it returns, the sketch is an upload of the item to the VM over the channel the explorer already uses, with the reference pointing at the VM path. That needs a decision on whether "nothing leaves the machine" extends to your own VM. Until then the tray and Context strip show "Not available for cloud sessions" on a cloud cluster.

### 13.2 Context strip that scrolls with the conversation (stretch)

**A like, not a want.** The strip would move in step with the terminal's chat content, so each item sits next to the point in the conversation where it appeared, the way an inline image would in a chat app.

**Likely hard.** The pty scrollback has no stable anchors. Claude Code, Codex and Gemini redraw their live region with cursor moves and line erases, so a row number recorded now points at different text after the next repaint. A resize reflows every line, and the harness may clear and rewrite history (a compact, a resume). The terminal buffer is a picture of the screen, not a list of messages.

**The most plausible approach: anchor to the transcript, not to the terminal.** The harness's transcript (section 5.3) is an ordered list of turns with stable ids. Every context event already has a transcript position: a drop is recorded against the last turn id at send time, and an "agent saw" event carries the turn where the `Read` happened. The strip then renders its own ordered timeline keyed by turn id, and keeps it aligned to the terminal only roughly. When the user scrolls the terminal, Kaava estimates which turn is at the top of the viewport by matching visible text (a distinctive prompt line or the harness's turn markers, read from xterm's buffer with `buffer.active.getLine`) against the transcript's turns, and scrolls the strip to that turn. Where the match fails the strip does nothing rather than jumping. A cheaper first step keeps most of the value: a "jump to context" link on each terminal turn marker and a "jump to turn" link on each strip item, with no continuous sync. Both depend on the transcript watcher from phase 4 existing for that harness.

### 13.3 Also later

- Codex and Gemini adapters, hooks and transcript watchers (Friday scope covers Claude Code only).
- The `kaava-context` MCP server (phase 3) and the producer API (phase 2 in full).
- Play and design-canvas providers (phase 5).
- Video and ffmpeg (open question 4).

## 12. Sources

Read 2026-09-29. Tags in the matrix refer to these.

- **S1** Claude Code, Common workflows (images, `@` mentions, `Ctrl+V`, `Alt+V` on Windows and WSL): https://code.claude.com/docs/en/common-workflows
- **S2** Claude Code, Hooks reference (events, `PostToolUse` fields, `Read` matcher, settings locations): https://code.claude.com/docs/en/hooks
- **S3** Claude Code, MCP (image results, saved copies, output limits, `headers`, env expansion, resources): https://code.claude.com/docs/en/mcp
- **S4** Codex CLI image input write-ups: https://inventivehq.com/knowledge-base/openai/how-to-use-image-input and https://codex.danielvaughan.com/2026/03/28/codex-cli-image-workflows/
- **S5** Codex CLI overview (`-i`, paste, drag and drop, MCP): https://learn.chatgpt.com/docs/codex/cli
- **S6** Gemini CLI MCP server docs: https://geminicli.com/docs/tools/mcp-server/
- **S7** Codex issue 4819, image responses from MCP tool calls, closed with PR 5600: https://github.com/openai/codex/issues/4819
- **S8** Codex issue 10334, `content[]` dropped when `structuredContent` is present: https://github.com/openai/codex/issues/10334
- **S9** Gemini CLI multimodal `@` image mentions: https://github.com/google-gemini/gemini-cli/issues/15532
- **S10** Gemini CLI clipboard image PR 13645: https://github.com/google-gemini/gemini-cli/pull/13645
- **S11** Gemini CLI Windows clipboard and `Alt+V` PR 13997: https://github.com/google-gemini/gemini-cli/pull/13997 and discussion 15043: https://github.com/google-gemini/gemini-cli/discussions/15043
- **S12** Gemini CLI multimodal MCP tool results, issue 2136: https://github.com/google-gemini/gemini-cli/issues/2136
- **S13** Codex hooks: https://learn.chatgpt.com/docs/hooks and configuration reference https://developers.openai.com/codex/config-reference
- **S14** Gemini CLI hooks reference: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
- **S15** Codex issue 41942, hook latency on Windows: https://github.com/openai/codex/issues/41942
- **S16** Claude Code transcript and image-in-transcript reports: https://github.com/anthropics/claude-code/issues/14150 and https://code.claude.com/docs/en/claude-directory
- **S17** Gemini API video understanding: https://ai.google.dev/gemini-api/docs/video-understanding
- **S18** Gemini CLI video recognition issue 3379: https://github.com/google-gemini/gemini-cli/issues/3379
- **S19** `@xterm/addon-image` (Sixel, IIP, Kitty WIP, erase and alternate-buffer behaviour, limits): https://github.com/xtermjs/xterm.js/tree/master/addons/addon-image
- **S20** Codex issue 29451, show image artifacts inline in the TUI: https://github.com/openai/codex/issues/29451

Not verified in this pass: how each harness installs and appears as a process on Windows; whether Codex asks the user to trust project hooks; the current documented image size limits for each model provider; Gemini chat-file format; and whether any of the three accepts video input from a terminal session. These are the spike list in phase 0.
