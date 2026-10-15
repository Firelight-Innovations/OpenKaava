# Agent tab: Claude Code feature parity

The gap analysis between the agent tab and Claude's own terminal and editor
clients, and the order the gaps close in. Written against claude-agent-acp
0.90.0. Its file:line references are leads to check, not facts: each PR
re-reads the code it cites before relying on it.

## 0. Working defaults and progress

The owner left these defaults in place for the parity work. Each one stands
until Braden says otherwise; none of them is a decision row.

- **D1, AIR client keys:** not declared. Rename stays a local label. Still an
  open question; check the adapter's README and terms before declaring them.
- **D2:** the agent starts on the first send, as it does today. So the mode
  and model pickers appear only after the first send's handshake.
- **D3:** offer "always allow" the way Claude does, written to the worktree's
  `.claude/settings.local.json`. The outside-worktree guard applies in every
  mode.
- **D4:** no bypass-permissions mode in the tab. The host drops it from the
  mode list and refuses it if asked.
- **D5:** no additional directories.
- **D6:** rewind gets a design note only.
- **D7, D8, D9:** skipped.
- **D10:** the background panel is built, without the AIR parts.
- **D11:** one session list per agent tab, scoped to the cluster's worktree.
- **D12:** thinking is switched by `MAX_THINKING_TOKENS` in the agent's
  environment (0 turns it off). It is read only at spawn, so the toggle says
  "applies next session". Decided as that default; the toggle itself is
  built in the P1 pass, not in PR 3.

Done so far. Each PR adds its entry here and updates the "OpenKaava today"
cells of the rows it closes in section 2.

- **PR 1** (setup): the host reads `modes` and `configOptions` from the
  `session/new` reply and from `config_option_update` into
  `SessionStatus.modes` and `SessionStatus.config`. The mode option is split
  out, so the mode is drawn once. Bypass and Auto are held back in every
  option (`config::NOT_OFFERED`), and so are approval options that enter either. `agentCapabilities` and `authMethods` are
  not stored yet: nothing reads them, so PR 7 (session list) and PR 24
  (auth) read them when they need them.
- **PR 2** (mode switcher): `agent-tab/set-mode` queues a mode change to
  the session's settings thread. It sends one change at a time, through
  `session/set_config_option` (or `session/set_mode` for an agent without
  a mode option), and emits a status after every reply. Each change
  answers with a number, and `SessionStatus.answered` says which changes
  the agent has answered, so the tab holds a choice until its own answer
  rather than until the next status of any kind. The tab draws the mode as
  a section of the composer's settings menu and cycles it on Shift+Tab. A
  reply slower than `setting_timeout` (30s) is reported as not answered
  yet, and still taken in when it comes. That wait, and a refusal, go in
  `SessionStatus.settingTrouble` and are said above the prompt box, not
  drawn as transcript errors, which would offer to retry the last prompt.

Open questions:

- **Auto is held back with Bypass** (`config::NOT_OFFERED`). In Auto a
  classifier approves calls in the user's place; those never reach
  `session/request_permission`, so the outside-worktree guard cannot apply
  as D3 requires. Accept edits stays: Claude allows writes inside the
  working directory unasked, and still asks for any write outside it, so the
  guard sees those. Some shell commands are also allowed unasked in Accept
  edits; which ones was not decoded from the CLI.
- A new process after a stop or a crash starts in Manual again; nothing
  carries the earlier choice over.

Constraints for later PRs, found while reading the adapter:

- The ExitPlanMode request offers `exit-plan-bypass`, `exit-plan-auto` and
  their `exit-plan-clear-*` forms whenever the adapter lists those modes,
  which on Windows includes Bypass. PR 1 drops them, and any approval
  option whose id is a held-back mode or names one as a word, by option id
  (`config::enters_held_back`), whatever the option's kind. PRs 11 and 13
  keep that filter when they lift the `allow_always` one, or one click
  enters a mode D4 rules out. The mode switcher (PR 2) is what refuses a
  held-back mode if asked.
- An Edit or Write "allow all edits during this session" answer switches
  the CLI to Accept edits without any `current_mode_update`, so the status
  would show the old mode. PR 11 must account for that.
- The adapter reports a refused `session/set_config_option` as JSON-RPC
  `-32603 "Internal error"` with the reason in `data.details`; the host now
  folds `details` into the message it draws.

## 1. Summary

- ACP covers most of the Claude Code session core: prompts, cancel, modes, model, effort and fast config options, tool calls, diffs, permission prompts, plans, usage, and list, load, resume and fork (claude-agent-acp 0.90.0).
- The agent tab uses only a small part of that. It sends one text prompt, forces the default mode, reads no config options, drops slash commands, and has no session list or resume.
- P0 gaps: slash menu, model, effort and mode controls, session list and resume, queueing while busy, @ mentions and images, the AskUserQuestion form, and the plan card with plan text.
- Several features need the JetBrains AIR client keys (rename, archive, goal panel, async tasks, file-change audit). Declaring them is owner decision D1.
- Some CLI-only features have no ACP path (rewind, hook and plugin editors, /memory, /btw, /export). They need native GUI work, settings-file reads, or a CLI subcommand.

## 2. Feature matrix

**Legend.** ACP status: `exposed`, `partial`, `not-exposed`, `unknown`, `n/a` (same meaning as the sweep). Priority: P0 parity-critical; P1 needed after P0; P2 later; Skip (reason given); Shell (covered by OpenKaava's shell, wiring noted).

**Sources.** `acp-agent.js`, `session-*.js`, `normalize.rs` and similar names are in the claude-agent-acp `dist/` folder or the OpenKaava crates and UI folders (`crates/kaava-agent-host/src`, `apps/agent-tab/ui/src`). Doc pages are under `https://code.claude.com/docs/en/`, named in each row. A cite into OpenKaava's own code names the file and the function, not a line: the parity PRs keep moving those lines. A `.js` cite is a line in claude-agent-acp 0.90.0.

**Sweep conflicts resolved in this revision.**

| Item | Sweep said | Resolved as | Source |
|---|---|---|---|
| /rename | exposed | partial, AIR-gated | session-index/connection.js:43-45 |
| /review | exposed | alias; the advertised command is /code-review | acp-agent.js:9035-9038 |
| /goal | exposed; AIR-gated | typed text not blocked; the structured panel is AIR-only | acp-agent.js:2301-2303 |
| /context | exposed vs local-only | local-only text, no model call | acp-agent.js:677 |
| /reload-skills | exposed (SDK) vs not advertised | unknown until the menu is checked | sdk.d.ts:3123; PR 5 |
| /output-style | exposed | listed; no settings wiring in the adapter | acp-agent.js:9011 |
| Prompt suggestions | partial (flag) vs not-exposed | not-exposed until forwarded | acp-agent.js:5653-5654 |
| Tab key | task said it toggles thinking | it does not; Option+T (Alt+T) does | keybindings doc |
| /status | local-jsx vs text | unknown | acp-agent.js:686 |
| Third-party providers | none | exposed | acp-agent.js:1398-1400 |
| Subagent client key | unverified | `clientCapabilities.subagents` | acp-subagents.js:9-13 |
| Plan file path | unknown | AIR-only `planFilePath`; plan text via `plan_update` | exit-plan.js:85-110 |

### 2.1 Session and models

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Start a session in a worktree | CLI `--worktree`; Desktop worktree option | exposed: `session/new` `cwd` (acp-agent.js:441-451) | done: worktree cwd, `mcpServers: []` (session.rs, `Shared::handshake`) | Shell | Only a local worktree may run an agent (agent_tab.rs, `worktree`). |
| New conversation | `/clear`, `/new`, `/reset`; VS Code New Conversation; Desktop Cmd+N | partial: `/clear` filtered from the menu (acp-agent.js:9006); new conversation is `session/new` (acp-agent.js:1433) | done: New session kills the agent and clears the transcript (host.rs, `Host::reset`) | P0 | Map typed `/clear` and the button to `session/new`. Typed `/clear` behaviour is unknown (acp-agent.js:677 vs 2084). |
| Model picker | `/model`; Option+P; Desktop Cmd+Shift+I | exposed: config option `model`, category model, set by `session/set_config_option` (session-model.js:2, 163-208; acp-agent.js:6273-6297) | partial since PR 1: the host reads the `model` option; no picker yet | P0 | PR 1 and PR 3. Show the list the adapter sends. Do not hardcode names. |
| Model aliases and `[1m]` variants | default, best, fable, sonnet, opus, haiku, sonnet[1m], opus[1m], opusplan (model-config doc) | exposed through the model option values (session-model.js) | partial since PR 1: read with the option; no picker yet | P0 | Part of the picker. Aliases come from docs and may change. |
| Session-only or saved default | Enter saves as default; `s` applies to this session (interactive-mode doc) | unknown: `set_config_option` changes the session; saving a default needs a settings write | not implemented | P1 | Owner decision on whether the picker saves defaults. A save writes settings, so it needs confirmation (Section 4 J). |
| Model allowlist and denylist | `availableModels` in settings; managed `deniedModels` | partial: applied when the option list is built (session-model.js:241-253; settings.js:94-97) | partial since PR 1: the host takes the list as built; no picker yet | P0 | Comes free with PR 1. |
| Model fallback notice | falls back when a model refuses or is unavailable (model-config doc) | exposed: notice or fallback text (acp-agent.js:4344, 4397, 4412; session-notices.js:1-69) | notices dropped (normalize.rs, the last arm of `Normalizer::update`) | P1 | Without notice support the adapter sends a bold agent message, so it already shows as text. PR 19. |
| Effort level | `/effort` slider; Desktop Cmd+Shift+E; `--effort` | exposed: config option `effort`, category thought_level (session-effort.js:72-90; session-config-ids.js:4) | partial since PR 1: read; no picker yet | P0 | Levels depend on the model. No `xhigh` on Opus 4.6 or Sonnet 4.6 (model-config doc). PR 3. |
| Ultracode tier | Tab in the effort slider; `/effort ultracode on` or `off` | partial: ultracode carried with effort (session-effort.js:11-16); no toggle option found | not implemented | P1 | Check whether the effort list includes ultracode (unknown). |
| Extended thinking on or off | Option+T (Alt+T, Meta+T). Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable always think (keybindings doc) | not-exposed: no toggle option; only `MAX_THINKING_TOKENS` env (acp-agent.js:9933-9945) | not implemented; thinking blocks render (components/Thinking.tsx) | P1 | Needs a settings or env path (D12). Tab is not the toggle. |
| Ultrathink keyword | prompt keyword for deeper reasoning | unknown: no adapter match, no doc line found | not implemented | P2 | Typed text reaches the CLI unchanged, so it may already work. Verify. |
| Fast mode | `/fast`; Option+O; VS Code toggle (fast-mode doc) | exposed: config option `fast` (acp-agent.js:8849; applied at 6242, 7552-7620) | partial since PR 1: read; no switch yet | P1 | Show disabled reasons: free, extra_usage_disabled, model_not_allowed, not_first_party, disabled_by_env, network_error (acp-agent.js:8872-8879). |
| Third-party providers | CLI env and settings; VS Code provider switch (vs-code doc) | exposed: `providers/list`, `providers/set`, `providers/disable`; advertised unconditionally (acp-agent.js:1398-1400; handlers 1848-1904) | not implemented | P2 | Corrected. Owner decision on which provider UI to show. A provider change alters billing. |
| Sign in and sign out | `/login`, `/logout`; VS Code Sign out | partial: `authenticate` takes gateway methods only (acp-agent.js:1610-1629); logout runs `claude auth logout` (acp-agent.js:1937-1970); authStatus pushed (auth-status.js) | hint text only (strings.ts, `harnessMissing`) | P1 | Never enter credentials in the tab. Sign-in opens a terminal pane for `claude auth login`. Sign-out is a confirmed button (PR 24). |
| Add working directory | `--add-dir`; `/add-dir`; `permissions.additionalDirectories` | partial: `additionalDirectories` on `session/new` (acp-agent.js:7832-7834); advertised (acp-agent.js:1365-1373) | not implemented; guard refuses outside paths (guard.rs, its module comment) | P1 | Owner decision D5. |
| Session title shown | name on prompt bar; terminal title; Desktop title | exposed: `session_info_update` title, capped at 256 (session-titles.js:7-8, 217) | dropped (normalize.rs, the last arm of `Normalizer::update`); header fixed as "Agent" (App.tsx, `at-header`) | P1 | One normaliser change (PR 8). |
| Rename session | `/rename`; Ctrl+R in picker; VS Code Rename Session Tab | partial: `_session/rename` needs the sessionIndex capability, AIR-gated (session-index/connection.js:43-45) | not implemented | P1 | Local label until D1 is decided. |

### 2.2 Permission modes

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Manual (default) | Mode dropdown "Manual"; Shift+Tab; `--permission-mode default` (permission-modes doc) | exposed: id `default` (session-mode.js:226-261) | partial: forced to `default` at handshake and fails closed (session.rs, `Shared::handshake`, with harness.rs `Policy::ask_first`) | P0 | Show the label "Manual", not the id. |
| Accept edits | "Edit automatically" (VS Code); `acceptEdits` | exposed: id `acceptEdits` (session-mode.js:226-261) | done in PR 2 | P0 | PR 2. |
| Plan | "Plan"; `/plan` | exposed: id `plan` (session-mode.js:247); EnterPlanMode switches to plan (acp-agent.js:7962-7963) | done in PR 2: selectable; the plan card is PR 13 | P0 | PR 2 and PR 13. |
| Auto | "Auto"; classifier approves calls | exposed: id `auto`; falls back to acceptEdits with a warning on unsupported models (session-mode.js:6-14, 46-54) | held back with Bypass (`config::NOT_OFFERED`); see section 0 | P1 | Show "Auto mode unavailable" as a notice (PR 19). |
| Bypass permissions | "Bypass permissions"; needs a settings gate (permission-modes doc) | partial: offered only when allowed (permissions/modes.js:3; session-mode.js:261); root or IS_SANDBOX gate (modes.js:18-20) | not implemented | P2 | Owner decision D4. Keep off until the guard is checked in this mode. |
| dontAsk | CLI only; not in Desktop or VS Code selectors (permission-modes doc) | not-exposed: parser accepts it; catalog omits it; `set_mode` throws (session-mode.js:213-225) | not implemented | Skip | CLI-only per docs. |
| Mode switcher | mode dropdown (VS Code); Desktop Cmd+Shift+M | exposed: `session/set_mode` and config option `mode` (session-mode.js:5, 66-81, 135-166) | done in PR 2: a section of the composer's settings menu | P0 | PR 2. |
| Shift+Tab cycle | cycles default, acceptEdits, plan, bypass (if offered), auto; Alt+M on Windows without VT (interactive-mode doc) | exposed as the mode option; the key is client-owned | done in PR 2, in the prompt box | P0 | Cycle order is the adapter's. |
| Mode label in footer | label, not raw id | exposed: `current_mode_update` (normalize.rs, the `current_mode_update` arm of `Normalizer::update`) | done in PR 2: the adapter's own names | P0 | Labels: Manual, Accept edits, Plan, Auto, Bypass permissions. |
| Auto-mode classifier rules | `autoMode` settings; `claude auto-mode config`, `defaults`, `reset` | partial: `autoMode` settings read (acp-agent.js, autoMode references) | not implemented | P2 | Read-only view first. |
| Permission rules editor | `/permissions`; allow, ask, deny rules (permissions doc) | partial: rules honored in the SDK (acp-agent.js:7042); no editor method | not implemented | P1 | PR 20. See Section 4 J. |

### 2.3 Prompt input

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Send text prompt | type and send | exposed: `session/prompt` text block (session.rs, `Shared::turn`) | done | P0 | Done. |
| Enter sends; Shift+Enter newline | chat:submit; Shift+Enter (interactive-mode doc) | n/a: client key | done (App.tsx, `submit`) | P0 | Done. |
| Ctrl+J or backslash+Enter newline | chat:newline; backslash then Enter | n/a | not implemented | P2 | Shift+Enter covers most cases. |
| Escape stops a turn | chat:cancel | exposed: `session/cancel` (acp-agent.js:5778-5800) | done (App.tsx, `onKeyDown`) | P0 | Done. |
| Enter while busy queues | Enter during a turn queues the message | partial: adapter queues prompts (acp-agent.js:2032-2126; promptQueueing at 1376-1380) | refused as busy (session.rs, `Session::prompt`) | P0 | PR 9. Host-side queue lets Up take messages back. |
| Take back queued messages | Up on first line | not-exposed: no take-back request among registered methods (acp-agent.js:9790-9809) | not implemented | P1 | Possible with a host queue. |
| Send queued now | Ctrl+Enter; Ctrl+X Ctrl+S (chat:sendNow) | partial: steering (acp-agent.js:2380-2452) | not implemented; `steer` false (harness/claude.rs, `CLAUDE.capabilities`) | P1 | PR 10. Owner decides interrupt or background. |
| Queue without sending | Ctrl+X Enter (chat:queueSubmit) | partial: adapter queue | not implemented | P2 | — |
| Steering a running turn | follow-up injected into the turn | partial: vendor extension `_session/steering`, advertised to all clients (acp-agent.js:1415-1427; handler 2380-2452); v1 only (README:90) | not implemented | P1 | Core ACP has no steer method. |
| @ file mention | @ opens fuzzy search; Option+K inserts `@file#L-L` (vs-code doc) | exposed: resource_link text (formatUriAsLink); text resource as context (acp-agent.js:9067-9148) | not implemented | P0 | PR 6. Needs a file picker over the worktree. |
| @ session mention | live sessions on the machine (v2.1.232+) | unknown | not implemented | P2 | — |
| @terminal:name | terminal output as context (vs-code doc) | unknown | not implemented | P2 | — |
| @browser | browser context via Chrome (vs-code doc) | unknown | not implemented | P2 | Depends on D9. |
| Image paste | Ctrl+V chip `[Image #N]` (chat:imagePaste) | exposed: image blocks (acp-agent.js:9106-9122); promptCapabilities image (acp-agent.js:1387-1390) | not implemented: text only (session.rs, `Shared::turn`) | P0 | PR 6. Chip is client UI; send base64. |
| Image drag and drop | Desktop and VS Code drop | unknown for CLI; image blocks can carry it | not implemented | P1 | — |
| File attach (+ button, drag, PDF) | Desktop attach; VS Code Shift+drag | partial: resource_link and text resource (acp-agent.js:9067-9148); audio and blob dropped (same range) | not implemented | P1 | PDF handling unknown. |
| Open file and selection context | selection sent automatically; attachOpenFile setting | n/a: host adds it inside the prompt | not implemented | P1 | Use the shell's open file. Chip with remove. |
| ! shell mode | `!cmd` runs in shell, output added to session (interactive-mode doc) | not-exposed: no shell-run method (acp-agent.js:9790-9809) | not implemented | P1 | The shell pane covers direct commands. Adding output to the session needs a text prompt. |
| # memory prefix | not confirmed in docs | unknown | not implemented | P2 | Do not build until confirmed. |
| Prompt history Up and Down | per working directory, includes past sessions (interactive-mode doc) | n/a: client | not implemented | P1 | Keep a per-tab history (PR 23). |
| Ctrl+R history search | history:search | n/a | not implemented | P2 | — |
| Stash prompt | Ctrl+S (chat:stash) | n/a | not implemented | P2 | — |
| External editor | Ctrl+G; Ctrl+X Ctrl+E | n/a | not implemented | P2 | — |
| Line editing and undo | Ctrl+A, E, K, U, W, Y; Alt+B, F, D; Ctrl+_ | n/a | native textarea | Skip | Browser textarea covers most of it. |
| Vim editor mode | `editorMode: vim` (vim docs) | n/a | not implemented | P2 | — |
| Spell check | `spellcheck.enabled`; aspell or hunspell | n/a | not implemented | P2 | Webview spellcheck may already run. Check. |
| Emoji shortcodes | `:name:` completion | n/a | not implemented | P2 | — |
| Invisible character warning | removes invisible characters on Enter | unknown whether ACP prompts are sanitised | not implemented | P2 | Verify. |
| Large paste collapse | `[Pasted text #N]` | n/a | native textarea shows all | P2 | — |
| Voice dictation | hold Space or tap; needs claude.ai (voice-dictation doc) | not-exposed; no voice handling in adapter | not implemented | P2 | Audio is client-side. Owner decision D9-style scope. |
| Prompt suggestions (ghost text) | Tab or Right to accept | not-exposed: `prompt_suggestion` dropped (acp-agent.js:5653-5654) | not implemented | P2 | Upstream change (U) or skip. |
| Busy placeholder | placeholder changes while busy | n/a | done (App.tsx, the prompt's `placeholder`) | P0 | Done. |
| Help with `?` | `?` on empty prompt shows shortcuts | n/a | not implemented | P1 | PR 22. |
| Enter-to-send setting | `useCtrlEnterToSend` (vs-code settings) | n/a | not implemented | P2 | — |
| Focus last message | VS Code command | n/a | not implemented | P2 | — |

### 2.4 Slash commands

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Command menu from advertised list | `/` menu, filters as you type | exposed: `available_commands_update` (acp-agent.js:7262-7291; list built 8987-9048) | dropped (normalize.rs, the last arm of `Normalizer::update`) | P0 | PR 5. Commands run only at message start. |
| Argument hints | argument hint shown | exposed: `input.hint` from argumentHint (acp-agent.js:9005-9046) | not implemented | P1 | — |
| Typed command sent as text | any typed `/name` | exposed: promptToClaude passes text through (acp-agent.js:9067) | works: sent as text (session.rs, `Shared::turn`) | P0 | Done for typed text. Each command still needs checking. |
| Aliases | `/cost`, `/stats`, `/review`, `/reset`, `/new`, `/quit`, `/tp`, `/rc`, `/bg`, `/settings`, `/continue`, `/undo`, `/checkpoint`, `/bashes` | not-exposed in menu: adapter drops aliases (sdk.d.ts:9431+); typed aliases still run | not implemented | P2 | Map the common ones in the GUI. |
| Skill chains | `/skill-a /skill-b text` (up to six) | unknown | not implemented | P2 | — |
| Filtered built-ins | — | filtered: clear, cost, keybindings-help, login, logout, output-style:new, release-notes, todos (acp-agent.js:9005-9014, applied 9046) | — | P0 | Each filtered command maps to a native control or row below. Terminal-tagged commands are also dropped (acp-agent.js:9017-9018). |
| `/compact [instructions]` | summarises the conversation | exposed: replay-hidden text (acp-agent.js:683); compaction updates (context-compaction.js) | sent as text; updates dropped | P1 | PR 18. Works now as text. |
| `/context` | colored grid and suggestions | exposed: local-only text (acp-agent.js:677) | not implemented | P1 | Text panel first. |
| `/cost`, `/stats`, `/usage` | session cost and plan limits | `/usage` exposed structured (acp-agent.js:1987-2003; usage-markdown.js:65-66); `/cost` filtered (acp-agent.js:9007) | not implemented | P1 | Only exact `/usage` is structured. PR 18. |
| `/model` | model picker | exposed through config option; replay-hidden text | not implemented | P0 | Via the picker (PR 3). |
| `/effort` | effort slider | exposed through config option | not implemented | P0 | PR 3. |
| `/fast` | fast mode | exposed through config option | not implemented | P1 | PR 4. |
| `/plan` | plan mode | exposed as mode `plan` (session-mode.js:247); typed `/plan` not checked | not implemented | P0 | Via the mode switcher. |
| `/goal` | keep working until a condition is met | exposed as typed text (goal-extension.js:6; acp-agent.js:2318-2330); structured panel AIR-only (acp-agent.js:2301-2303) | not implemented | P1 | Typed `/goal` works now. Panel after D1 (Section 4 E). |
| `/config`, `/settings` | settings dialog | partial: no ACP dialog; SDK `updateSettings` and `applyFlagSettings` exist (sdk.d.ts:2970-2985) but only the adapter holds the SDK | not implemented | P1 | Native settings panel (PR 20). Section 4 J. |
| `/permissions`, `/allowed-tools` | rule editor | partial (see Permission modes) | not implemented | P1 | PR 20. |
| `/theme` | colour theme | not-exposed | OpenKaava theming | Shell | — |
| `/help` | help and command list | not-exposed (local-jsx) | not implemented | P1 | Native help panel lists advertised commands and shortcuts (PR 22). |
| `/status` | account, version, model, connectivity | unknown: local-jsx variant; adapter treats as replay-hidden text (acp-agent.js:686) | not implemented | P1 | Build a native status panel from auth status, mode, model and capabilities (PR 24). |
| `/doctor`, `/checkup` | install and settings health | not-exposed: terminal-tagged | not implemented | Shell | Run `claude doctor` in a terminal pane. |
| `/memory` | edit CLAUDE.md and auto memory | not-exposed (local-jsx; thin-client) | not implemented | P1 | List memory files natively; the shell file viewer edits them (PR 22). |
| `/hooks` | view hook configuration | not-exposed (local-jsx) | not implemented | P2 | Read-only list first (PR 21). |
| `/skills` | list and set visibility | not-exposed (control-request); visibility in `skillOverrides` settings | not implemented | P1 | PR 21. |
| `/reload-skills` | pick up changed skills | conflict (see table above) | not implemented | P2 | — |
| `/reload-plugins` | activate plugin changes | not-exposed: terminal-tagged; SDK `reloadPlugins` (sdk.d.ts:3115) | not implemented | P1 | Restart the agent with `session/resume` to pick up changes (PR 21). |
| `/plugin`, `/plugins`, `/marketplace` | plugin and marketplace manager | not-exposed (local-jsx) | not implemented | P1 | Native panel with CLI actions (PR 21). Section 4 L. |
| `/export` | export conversation to a file | not-exposed (local-jsx) | not implemented | P1 | Native export with a save dialog (PR 22). |
| `/copy [N]` | copy the Nth response | not-exposed (local-jsx) | code block copy only (markdown.ts, the `fence` rule) | P1 | Add message copy (PR 22). |
| `/diff` | uncommitted and per-turn diffs | not-exposed (interactive) | shell diff views exist (src/shell/diff) | Shell | Link the tab to the shell diff view. |
| `/btw` | side question, no history | not-exposed; no ACP method | not implemented | P2 | Needs a separate side query. Section 4 AE. |
| `/branch` | branch the conversation | partial: `unstable_forkSession` (acp-agent.js:1500; fork-session.js) | not implemented; `fork` false (harness/claude.rs, `CLAUDE.capabilities`) | P1 | PR 25. |
| `/fork [prompt]` | copy into a background session | partial: fork as above; background part has no ACP method | not implemented | P1 | PR 25. |
| `/subtask` | forked subagent with full context | not-exposed | not implemented | P2 | — |
| `/resume`, `/continue` | pick a past session | not text; `session/list` and `session/resume` exposed | not implemented | P0 | PR 7. |
| `/rewind`, `/checkpoint`, `/undo` | restore code and or conversation | partial (Section 4 A) | not implemented | P1 | D6. |
| `/rename` | name the session | partial, AIR-gated (see Session and models) | not implemented | P1 | — |
| `/tasks`, `/bashes` | background shells and subagents | unknown for the CLI view; async tasks AIR-gated (async-tasks.js) | not implemented | P1 | D10 and Section 4 F. |
| `/workflows` | progress view for workflows | not-exposed (local-jsx) | not implemented | P1 | Native progress view (PR 26). |
| `/list-agents`, `/peers` | list subagents and peers | exposed (local, non-interactive) | not implemented | P2 | — |
| `/agents` | removed | agent picker covers custom agents: config option `agent` (acp-agent.js:8848, 8950-8986) | not implemented | Skip | Removed in CLI. Use the agent picker. |
| `/add-dir` | add a working directory | partial (see Session and models) | not implemented | P1 | D5. |
| `/cd` | change directory | not-exposed (local-jsx) | clusters and worktrees choose cwd | Shell | — |
| `/color` | prompt bar colour | not-exposed (terminal-tagged) | not implemented | Skip | Terminal-only. |
| `/vim` | removed | use `/config` | — | Skip | — |
| `/tui`, `/focus`, `/scroll-speed`, `/terminal-setup` | terminal rendering | not-exposed | — | Skip | Focus view is covered in Desktop chrome (P2). |
| `/statusline` | configure status line | not-exposed: prompt, terminal-tagged; no statusLine handling (grep) | not implemented | P2 | See Section 4 AD. |
| `/sandbox` | sandbox toggle | partial: feature flag (acp-agent.js:374); network callback (acp-agent.js:6900) | not implemented | P2 | — |
| `/voice` | voice dictation | not-exposed (non-interactive false) | not implemented | P2 | Section 4 AF. |
| `/login`, `/logout` | sign in and out | partial (see Session and models) | not implemented | P1 | PR 24. |
| `/mcp` | list, reconnect, enable, disable | exposed: adapter command (mcp-command.js:3-37, 263-326; acp-agent.js:9015-9047) | not implemented | P1 | PR 14. |
| `/ide`, `/desktop`, `/app` | IDE and Desktop handoff | not-exposed | — | Skip | Handoff to other apps. |
| `/chrome` | Chrome integration setting | not-exposed (claude-ai) | not implemented | P2 | Depends on D9. |
| `/remote-control`, `/rc`, `/remote-env`, `/session`, `/remote`, `/teleport`, `/tp` | remote and cloud | not-exposed | not implemented | Skip | Owner decision D7 (Section 4 Y). |
| `/schedule`, `/routines` | cloud routines | unknown | not implemented | Skip | Owner decision D7. |
| `/autofix-pr`, `/install-github-app`, `/install-slack-app`, `/design-login`, `/web-setup`, `/upgrade`, `/passes`, `/privacy-settings`, `/radio`, `/stickers`, `/mobile`, `/powerup`, `/release-notes`, `/rate-limit-options` | account, marketing or browser actions | mostly not-exposed; `/release-notes` filtered (acp-agent.js:9012) | not implemented | Skip | Browser or account flows. `/rate-limit-options` becomes a banner (P2). Auth steps stay in the terminal. |
| `/feedback`, `/bug`, `/share` | send feedback or a bug report with consent | not-exposed (local-jsx) | not implemented | P2 | Needs a consent dialog. |
| `/heapdump` | heap snapshot | exposed local-only; hidden (acp-agent.js:677) | — | Skip | The snapshot holds the conversation and credentials. Never offer it in the GUI. |
| `/extra-usage` | hidden old name for `/usage-credits` | exposed local-only (acp-agent.js:677) | — | Skip | Use `/usage-credits`. |
| `/usage-credits` | configure credits | exposed (local, non-interactive true) | not implemented | P2 | Opens billing page; use a link. |
| `/insights` | HTML report on recent sessions | exposed (prompt type) | not implemented | P2 | Writes a file. Privacy note. |
| `/recap` | one-line summary | exposed (local, post-text) | not implemented | P2 | — |
| `/update-config`, `/init`, `/fewer-permission-prompts` | write settings or CLAUDE.md | exposed (skills or prompts) | not implemented | P1 | Confirm file writes before they run. |
| `/import` | import from other agents | exposed (non-interactive list); picker local-jsx | not implemented | P2 | — |
| Bundled: review and debug | `/code-review` (`--fix` edits files; `--comment` posts publicly), `/simplify`, `/security-review`, `/verify`, `/run`, `/debug` | exposed as advertised prompts (acp-agent.js:9032-9043) | not implemented | P1 | Names for some are not literal in the binary scan; status rests on docs and the adapter branch. Confirm side effects. |
| Bundled: build and data | `/batch` (publishes), `/dataviz`, `/design`, `/design-sync`, `/slides`, `/claude-api`, `/claude-in-chrome`, `/artifact-capabilities`, `/artifact-diagramming` | exposed; some conditional on artifacts or claude.ai | not implemented | P2 | `/batch` publishes changes: confirm before it runs. |
| Bundled: automation | `/loop`, `/workflow-authoring`, `/plugin-authoring`, `/run-skill-generator`, `/team-onboarding` (reads history: privacy note) | exposed | not implemented | P2 | — |
| `/deep-research`, `/advisor`, `/skill-doctor`, `/auto-mode-setup`, `/ultrareview` | workflows and gated tools | unknown or gated | not implemented | P2 | Gated by account or flags. |
| Hidden or disabled commands | `/daemon`, `/cloud-plugins`, `/loops`, `/wellbeing`, `/pause-memory`, `/version`, `/setup-bedrock`, `/setup-vertex`, `/design-consent`, `/design-revoke`, `/keybindings-help`, `/todos`, `/output-style:new`, `/pro-trial-expired` | hidden, disabled or filtered | — | Skip | Not for the GUI. |
| Removed | `/pr-comments`, `/ultraplan`, `/vim` | removed | — | Skip | — |
| MCP prompts as commands | `/mcp:server:prompt` | exposed: renamed `mcp:` and rewritten (acp-agent.js:9028-9030, 9074-9078) | not implemented | P1 | Shows in menu after PR 5. |

### 2.5 Skills, commands and subagents

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Skill invocation `/skill args` | skills from user, project, plugin and managed folders | exposed: advertised with `input.hint` (acp-agent.js:8995-9000) | not implemented | P0 | Via the menu (PR 5). |
| Skill frontmatter runtime | `$ARGUMENTS`, `` !`cmd` ``, `context: fork`, `allowed-tools` | partial: runs in the SDK | — | Works automatically | See Section 3. |
| Skill tool row | "Load skill: name" | exposed: tool_call kind other (interaction.js:91-96) | generic row (normalize.rs, `Normalizer::tool`) | P2 | Already renders. |
| Skills dialog (visibility) | On, or Name only; token sort | not-exposed (control-request); `skillOverrides` settings | not implemented | P1 | PR 21. |
| Custom commands | `.claude/commands` Markdown | exposed as advertised commands (acp-agent.js:9005-9046) | not implemented | P0 | Via the menu. |
| Plugin commands | `/plugin:skill` | exposed (acp-agent.js:9005-9046) | not implemented | P1 | — |
| MCP prompt commands | `/mcp:server:prompt` | exposed (see Slash commands) | not implemented | P1 | — |
| Built-in subagents | general-purpose, Explore, Plan, statusline-setup, claude | partial: names in BUILTIN_AGENT_NAMES (acp-agent.js ~8800-8830); delegation runs in SDK | rendered as think rows (reporters/agent.js:10) | Works automatically | — |
| Custom subagents and agent picker | `.claude/agents`, `~/.claude/agents`, plugin and managed agents | exposed: config option `agent`, present only when custom agents exist (acp-agent.js:8848, 8950-8986) | not implemented | P1 | PR 5. |
| `--agents` JSON | define agents at launch | partial: `agents` rebuilds session (acp-agent.js:338-415) | not implemented | P2 | Launch-time only. |
| Subagent child sessions | child rows with title and state | partial: RFD form `subagent_update` (native-subagents.js:635-661) needs `clientCapabilities.subagents` (acp-subagents.js:9-13); AIR form needs AIR | Agent calls are think rows | P1 | PR 16. Decision O. |
| Child control | prompt, cancel or change a child | not-exposed (README:65) | not implemented | P2 | Cannot be built on ACP yet. |
| Subagent history replay | child transcripts restored on load | partial (subagent-replay.js; subagent-history.js) | not implemented | P2 | — |
| Stop background subagents | Ctrl+X Ctrl+K | partial: `_session/async_task/stop` (acp-agent.js:204-205, 9808); subagent stop not exposed | not implemented | P1 | PR 16. |
| Background work (Ctrl+B; run_in_background) | Bash or agent to background | partial: backgrounded Bash tagged (tool-calls/background.js) | not implemented | P1 | PR 26. |
| Agent footer panel | agents, workflows and tasks below prompt | partial: state updates (README:38-69); cannot prompt or cancel child (README:65) | not implemented | P1 | Show state only (PR 26). |
| `/batch` | plan units, run as background subagents in worktrees, publish | exposed skill (acp-agent.js:9032) | — | P2 | Publishing needs confirmation. |
| `/loop` | recurring prompt while session open | exposed skill; lifetime tied to session | — | P2 | Stops when the agent process stops. |
| Workflows and `/workflows` | scripts that run many subagents; progress view | `/workflows` not-exposed; workflow launch is a normal tool call, so it reaches permission requests (partial) | not implemented | P1 | Approval card is generic; progress view native (PR 26). |
| Workflow approval | Run, Always, View script, Deny | partial: generic permission request | generic card | P1 | — |
| Ultracode keyword and `/effort ultracode` | workflow orchestration on | unknown | not implemented | P2 | — |
| Schedule and cloud routines | cron-like cloud agents | unknown | not implemented | Skip | Owner decision D7. |
| Agent teams | experimental multi-agent | not-exposed | not implemented | Skip | Not in Desktop; experimental. |
| Subagent limits and stall windows | env vars | partial: env (SDK) | — | Works automatically | — |

### 2.6 Tool calls, diffs and approvals

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Tool rows (title, kind, status) | Read, Edit, Bash, Grep and others | exposed: `tool_call` and `tool_call_update` by toolCallId (tool-calls/reporters) | done (normalize.rs, `Normalizer::tool` and `merge_tool`) | P0 | Done. |
| Failed Bash output | command output in tool row | partial: success output arrives via toolResult (bash.js:18-40); failed-command output needs `_meta.terminal_output` (client-capabilities.js:41-42; renderer.js:228, 291-296; bash.js:29-31) | text only; terminal blocks dropped (normalize.rs, `merge_tool`) | P0 | Corrected. Verify on a failing command. Declare only if needed (PR 17). |
| Live terminal view | streaming terminal | exposed for display only: terminal content; v2 `terminal_update` (v2/terminal.js:8-51) | dropped | P1 | Needs the terminal capability. |
| Read, Glob, Grep, WebFetch rows | kinds read, search, fetch, with locations (reporters/read.js:16; search.js:12; web.js:10) | exposed | done (generic) | P0 | Done. |
| File edit diffs | diff with path, oldText, newText; null oldText for new files (file-edit.js:13-80) | exposed | done with a 256 KiB cap (normalize.rs, `DIFF_LIMIT` and `diffs`) | P0 | Done. |
| Diff review panel | Changes pane; `/diff`; diff stats | partial: diff content; file-change reports (file-change-audit.js:1-25) | shell diff views exist (src/shell/diff) | Shell | Link the tab to the shell diff view. |
| Per-change Accept and Reject | VS Code buttons; over 100 changes they disappear; Accept and Reject Change at Cursor (vs-code doc) | unknown over ACP | not implemented | P1 | Verify what reject does to the file. |
| Hunk-level accept or reject | per hunk | unknown | not implemented | P2 | — |
| Line comments on diffs | Desktop Changes pane: Enter adds, Cmd+Enter submits (desktop doc) | unknown | not implemented | P2 | Would send as a prompt. |
| Code review card | Walk through, Fix this one, Apply fixes (desktop doc) | not-exposed | not implemented | P2 | Shows after `/code-review`. |
| Allow once | "Yes" | exposed: `allow_once` (permissions/options/shared.js:16-22) | done (session.rs, `Session::answer`) | P0 | Done. |
| Yes and don't ask again | "Always allow" for a matching rule | exposed: `allow_always` with `updatedPermissions` to localSettings (permissions/effects.js:10-40; options/tools.js:6-8, 28-31) | partial: dropped when the request names no file (normalize.rs, `Normalizer::approval`) | P0 | Corrected. The adapter writes the rule. OpenKaava's filter is the blocker (Section 4 I). |
| Yes and switch to auto mode | option on some prompts | exposed: option passes through (options/tools.js:77) | dropped: an option that enters a held-back mode is filtered; the rest are shown with the agent's label (normalize.rs, `Normalizer::approval`) | P1 | Not offered: the host drops options that enter Auto or Bypass (`config::enters_held_back`) until the guard is checked in those modes. |
| Reject | "No" | exposed: `reject_once` (shared.js:16-22) | done | P0 | Done. |
| Comment on an answer | Tab adds a comment (permissions doc) | unknown: no comment path found | not implemented | P2 | Verify whether the comment reaches ACP. |
| Outside-worktree refusal | not in Claude Code | OpenKaava policy (guard.rs, its module comment; session.rs, `Shared::permission`) | done | P0 | Keep. OpenKaava rule. |
| AskUserQuestion | multiple-choice card with Other and notes | exposed when `clientCapabilities.elicitation.form` is declared (acp-agent.js:7030-7040; elicitation.js:170-256); tool disallowed without it (acp-agent.js:7818, 7941) | not implemented; no elicitation declared (session.rs, `Shared::handshake`); -32601 reply (session.rs, `METHOD_NOT_FOUND` in `Shared::on_line`) | P0 | The model cannot ask questions today. PR 12. |
| MCP elicitation | form or URL prompts from servers | exposed: `elicitation/create` form or url (elicitation.js:9-60) | not implemented | P1 | PR 15. |
| Refusal fallback consent | consent dialog on refusal | exposed: form kind `refusal_fallback_prompt` (elicitation.js:276-347) | not implemented | P1 | Needs the form declaration (PR 12). |
| Paths in tool rows | file paths shown | exposed: locations and rawInput paths (guard.rs, `request_paths`) | plain text, not links (components/PathList.tsx) | P1 | Open in the shell file viewer (PR 22). |
| Open a changed file | open in editor | n/a: client action | not implemented | P1 | Shell file viewer. |
| Monitor tool | streams long command output | partial: Monitor tasks not treated as subagents (async-tasks.js isMonitorTask) | think row (reporters/index.js:33) | P2 | — |
| Tool output cap | full output in transcript | OpenKaava policy: 16 KiB (normalize.rs, `OUTPUT_LIMIT`) | capped | P2 | Add a "show all" action. |

### 2.7 Plans and todos

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Plan mode | `/plan`; Shift+Tab | exposed: mode `plan` (session-mode.js:247) | not implemented | P0 | Via the mode switcher (PR 2). |
| Plan approval card | Yes, auto mode; Yes, manual edits; No, keep planning (permission-modes doc) | exposed: ExitPlanMode options (acp-agent.js:4781, 4855) | generic approval card (normalize.rs, `Normalizer::approval`) | P0 | Works as buttons now, except the options that enter Auto or Bypass, which the host drops. PR 13 adds plan text. |
| Plan document text | Markdown plan; VS Code document with comments | exposed: `plan_update` markdown with planId `plan-mode` (exit-plan.js:85-110); needs `clientCapabilities.plan` (acp-agent.js:1216) | not declared; no handler | P0 | Declare `plan` in PR 13. |
| Plan file path | plan file opened in VS Code | AIR-only: `rawInput.planFilePath` (air-extension.js) | n/a | Skip | Use plan text instead (D1). |
| Clear context and implement | fresh context carrying only the plan | partial: restart on approval (exit-plan.js:121-160; clear-context-coordinator.js) | not implemented | P1 | PR 13. |
| Task tools | TaskCreate, TaskUpdate, TaskList, TaskGet; up to five shown | exposed as plan entries (tools.js:78-220; acp-agent.js:2312-2321) | partial: one plan card (normalize.rs, `Normalizer::plan`) | P0 | Done as the plan card. |
| TodoWrite | to-do list | exposed as plan (tools.js:22-29) | partial: plan card | P0 | Done. TodoWrite is off on models the docs do not list; Haiku 5.5 is not named. Verify. |
| Show or hide task list | Ctrl+T (app:toggleTodos) | client-owned | not implemented | P1 | PR 23. |
| Plan entry priority | stored, not drawn in CLI | exposed field (normalize.rs, `Normalizer::plan`) | stored, not drawn | P2 | — |
| Enter and exit plan-mode rows | `switch_mode` tool rows (reporters/interaction.js:22; renderer.js:342-344) | exposed | generic row | P1 | — |
| Task list persistence | `CLAUDE_CODE_TASK_LIST_ID` | env, automatic | nothing | P2 | Works automatically. |

### 2.8 Context, usage and cost

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Context meter | ring beside model; VS Code indicator; CLI token count | exposed: `usage_update` used and size, after each turn (acp-agent.js:4677-4690; 8413-8436) | partial: drawn once at end of turn (components/Usage.tsx) | P1 | Not live during a turn. Verify whether mid-turn updates arrive. |
| Session cost | cost in `/usage` and header | exposed: `usage_update` cost (acp-agent.js:4677-4690) | ignored (normalize.rs, the `usage_update` arm of `Normalizer::update`) | P1 | PR 18. |
| `/usage` panel | cost, limits, activity; Day and Week (VS Code) | exposed: structured `/usage` (acp-agent.js:1987-2003; usage-markdown.js:65-66) | not implemented | P1 | Render the structured data, not only text. |
| `/cost`, `/stats` | aliases of `/usage` | `/cost` filtered (acp-agent.js:9007); typed text gets plain CLI text | not implemented | P2 | Map to the `/usage` panel. |
| Per-model usage | per model in `/usage` | partial: per-model increments in turn outcome (acp-agent.js:2710, 8612-8618) | not implemented | P2 | — |
| Rate-limit info | limit message and reset | exposed: `_meta['_claude/rateLimit']` on `usage_update` (acp-agent.js:5619-5627) | not read | P1 | Corrected. Read the `_meta` in PR 18. |
| Usage-limit wait | auto-continue after reset (interactive-mode doc) | partial: `activeUsageLimitMessage` (acp-agent.js:29) | generic error | P1 | Show the limit and reset time. Auto-continue over ACP is unknown. |
| `/rate-limit-options` | wait, credits or upgrade | not-exposed (local-jsx) | not implemented | P2 | Banner with the same choices. |
| `/usage-credits` | configure credits | exposed (local) | not implemented | P2 | Link to billing. |
| `/context` | grid, suggestions, memory files | exposed: local-only text (acp-agent.js:677) | not implemented | P1 | Text panel first. |
| Compaction | automatic and `/compact`; `/autocompact` sets the window | exposed: `compaction_update`, `compaction_summary_chunk`; fallback tool_call without declaration (context-compaction.js:3-5, 38-123; acp-agent.js:2584-2592) | tool row only; updates dropped | P1 | PR 18. Declare `session.compaction` for a native row. |
| `/autocompact` | window size setting | exposed (CLI settings write) | not implemented | P2 | Settings write (Section 4 J). |
| Prompt-cache clock | minutes left; red when expired (vs-code doc) | unknown: no expiry in `usage_update` | not implemented | P2 | Verify. |
| Session recap | one-line summary after time away | unknown: no adapter handling found | not implemented | P2 | `/recap` exposed as text. |
| Budget limit | `--max-budget-usd` (print mode only) | n/a | n/a | Skip | A tab budget would need its own tracking. |

### 2.9 History, resume and rewind

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Session list | `/resume` picker; VS Code Session history (Local tab) | exposed: `session/list`, page size 1000 (acp-agent.js:525, 1549); `subscribeSessionList` (1583) | not implemented | P0 | PR 7. Web tab is cloud (Skip). |
| Resume by id or picker | `/resume`; `claude --resume` | exposed: `session/resume` (acp-agent.js:1433-1555) | not implemented | P0 | PR 7. |
| Load transcript on open | replay in the session | exposed: `session/load` replay (acp-agent.js:1433-1555; 6696-6704) | not implemented | P0 | PR 7. |
| Continue most recent | `-c`, `--continue` | partial: `session/list` then `session/resume` | not implemented | P1 | — |
| Carry-over after restart | restarted sessions keep their context | not used: fresh `session/new` plus new prompt text only (session.rs, `Shared::turn`; host.rs, `Host::send`; session.rs, `Session::start`) | display only; the new agent sees no earlier turns | P0 | Fixed by PR 7. |
| Continue after reload | sends or replies within 10 minutes continue after a reload (VS Code continueAfterReload) | partial: resume path (acp-agent.js:1518) | not implemented | P1 | — |
| Branch or fork | `/branch`; `/fork`; `--fork-session`; VS Code | partial: `unstable_forkSession` (acp-agent.js:1500; fork-session.js); stable `session/fork` not in schema | not implemented; `fork` false (harness/claude.rs, `CLAUDE.capabilities`) | P1 | PR 25. |
| Fork at a message | VS Code hover "Fork conversation from here" | AIR-only: `_meta.jetbrains.air.fork` (fork-session.js:1-20) | not implemented | P2 | D1. Also needed for edit-and-resend. |
| Rewind code or conversation | `/rewind`; Esc Esc; VS Code hover | partial: checkpoints only for AIR (acp-agent.js:7837, 7903; file-change-audit.js:27-28); rewind keyed by prompt uuid (acp-agent.js:5257) | not implemented | P1 | Section 4 A. D6. |
| Summarise from here | rewind menu option | not-exposed | not implemented | P2 | — |
| Archive and unarchive | VS Code archive; `archiveInactiveSessions` (1, 2, 7, 14 days or never) | AIR-only for index (session-index); `session/close` exposed (acp-agent.js:6209) | not implemented | P1 | D1. Section 4 D. |
| Delete session | agent view; CLI | exposed: `session/delete` for non-AIR clients (session-index/connection.js:229) | not implemented | P2 | Destructive. Confirm first. |
| Close session | tab close | exposed: `session/close` (acp-agent.js:1365-1373) | kill only (session.rs, `Session::kill`) | P1 | Close gracefully, then kill. |
| Session groups and filters | VS Code groups; status and Open or Closed filters; Desktop groups | not-exposed | not implemented | Shell | D11. |
| Reopen closed session; mark unread | VS Code commands | not-exposed | not implemented | P2 | — |
| Edit and resend | fork and resend | Section 4 B | not implemented | P2 | — |
| Conversation search | find in transcript | n/a: client | not implemented | P2 | Filter the transcript. |
| Export conversation | `/export` writes text | not-exposed (local-jsx) | not implemented | P1 | Save dialog (PR 22). |
| Copy message | `/copy N`; Copy response (vs-code) | not-exposed; client | code block copy only (markdown.ts, the `fence` rule) | P1 | Add message copy (PR 22). |
| Transcript view | Ctrl+O: Normal, Thinking, Verbose | n/a: presentation | tool details inline | P1 | PR 22. |
| Bookmarks | bookmark response; panel (v2.1.286) | n/a: client | not implemented | P2 | — |
| `/btw` side question | overlay in CLI; panel in VS Code | not-exposed; no ACP method | not implemented | P2 | Section 4 AE. |
| `/subtask` | forked subagent with full context | not-exposed | not implemented | P2 | — |

### 2.10 MCP, hooks, plugins and settings

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| MCP status list | `/mcp`: failed, needs auth, connecting, connected, disabled | exposed: `/mcp` adapter command (mcp-command.js:263-326; SDK `mcpServerStatus`) | not implemented | P1 | PR 14. Status calls time out at 5 s (mcp-command.js). |
| Reconnect, enable, disable | `/mcp reconnect`, enable, disable | exposed (mcp-command.js; SDK `reconnectMcpServer`, `toggleMcpServer`) | not implemented | P1 | PR 14. |
| Add or remove MCP server | `claude mcp add`, `remove`; `.mcp.json` | not-exposed (CLI or file) | not implemented | P1 | Section 4 M. |
| MCP OAuth | sign in from `/mcp` | exposed: URL elicitation (acp-agent.js:1022-1127; elicitation.js:49-60); needs `clientCapabilities.elicitation.url` (acp-agent.js:1031) | not declared (session.rs, `Shared::handshake`) | P1 | PR 15. |
| Host-supplied MCP servers | — | exposed: `mcpServers` on `session/new` (acp-agent.js:441, 1469) | sends `[]` (session.rs, `Shared::handshake`) | P1 | Pass only host-owned servers (Section 4 M). |
| Project `.mcp.json` | project servers need approval | partial: loaded via settingSources (acp-agent.js:7897); approval in ACP unknown | not implemented | P1 | Verify approval behaviour. |
| claude.ai connectors | account connectors | partial: loaded automatically; authorised in claude.ai | not implemented | P2 | Shows in the MCP list. |
| Deferred MCP tools (ToolSearch) | tools loaded on demand | partial, automatic | — | Works automatically | — |
| Managed MCP policy | admin allow and deny lists | partial: enforced in CLI; adapter sees the result | — | Works automatically | Show blocked servers (P2). |
| MCP status notices | auth needed, failed connection | partial: notices reach model context | not implemented | P1 | Show from the status path (PR 14). |
| Settings-file hooks | run on lifecycle events | partial: run in the SDK; callbacks not possible (acp-agent.js:338-415, `hooks` false) | — | Works automatically | A blocked tool call should show its reason. How ACP reports a block is unknown. |
| `/hooks` view | list and edit hooks | not-exposed (local-jsx) | not implemented | P2 | Read-only list first (PR 21). Section 4 K. |
| Hook events in stream | `--include-hook-events` | partial: `includeHookEvents` option exists (acp-agent.js:356); output unverified | not implemented | P2 | Verify. |
| Adapter-internal hooks | plan, model switch, compaction, task events | exposed; not user-configurable (acp-agent.js:7880-8050) | — | Works automatically | — |
| Plugin list and actions | install, enable, disable, update, uninstall, validate | not-exposed: CLI `claude plugin` subcommands | not implemented | P1 | Section 4 L. |
| `/plugin` manager | Discover, Installed, Marketplaces, Stats, Errors, Flagged | not-exposed | not implemented | P1 | PR 21. |
| Marketplaces | add, list, update, remove | not-exposed (CLI) | not implemented | P2 | — |
| Plugin enablement and precedence | `enabledPlugins` merged by source | partial: settings-driven | — | Works automatically | — |
| Session-only plugins | `--plugin-dir`, `--plugin-url` | unknown: listed in OPTION_REBUILDS_SESSION | not implemented | P2 | — |
| Plugin reload | `/reload-plugins`; update notices | not-exposed (see Slash commands) | not implemented | P1 | Restart with resume (PR 21). |
| Mods (JS plugin modules) | in-process JS modules | not-exposed; documented as unavailable in VS Code chat and `-p` (plugins/mods/overview) | — | Skip | Not available to this host. |
| Settings view and edit | `/config`; settings files | not-exposed; SDK methods exist (sdk.d.ts:2970-2985) but need the adapter | not implemented | P1 | PR 20. Write files with a schema check. Show "applies next session" until live apply is verified. |
| Settings precedence and reload | managed, flag, local, project, user | partial: adapter watches files and re-resolves (settings.js:37-160; unverified live) | — | Works automatically | — |
| Settings source selection | `--setting-sources`, `--settings` | partial: hard-coded user, project, local (acp-agent.js:7897); `--settings` option (acp-agent.js:7904) | — | P2 | — |
| Environment block | `env` in settings | partial: depends on what the host passes; OpenKaava sets only `CLAUDE_CODE_EXECUTABLE` (harness.rs, `spec`) | — | P2 | Verify env reaches the SDK. |
| Output styles | `/output-style`; `outputStyle` setting | partial: listed command; no outputStyle wiring (acp-agent.js:9011) | not implemented | P2 | Section 4 X. |
| Custom output styles | `.md` files in `~/.claude/output-styles` | partial: via settingSources; not verified | — | Works automatically | — |
| Status line | `statusLine` command; `/statusline` | not-exposed: no statusLine handling (grep) | not implemented | P2 | Section 4 AD. |
| CLAUDE.md files | managed, user, project, local, @imports, rules | partial: loaded by the claude_code preset and settings (memory doc) | — | Works automatically | List loaded files (PR 22). |
| Auto memory | MEMORY.md per project | partial, automatic | — | Works automatically | List entries in the memory panel (PR 22). |
| System prompt flags | `--append-system-prompt` and similar | partial: `_meta.systemPrompt` (acp-agent.js:450-451; 7768-7781) | not implemented | P2 | Owner may want worktree context here. |
| Managed settings | admin policy | partial: managed-policy.js:1-31 | — | Works automatically | Show a managed tag in the settings panel (P2). |
| Auth via ACP | authMethods; authStatus | partial (see Session and models) | hint only | P1 | PR 24. |
| Launch-only flags | `--bare`, `--safe-mode`, `--restricted` | not-exposed: adapter starts with no arguments (harness.rs, `spec`) | — | Skip | Use env equivalents if needed. |

### 2.11 Keyboard shortcuts

Ctrl+C is copy in a webview, so the tab keeps Escape as the stop key. Tab is not the thinking toggle; Option+T (Alt+T) is.

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Enter sends; Shift+Enter newline | chat:submit | n/a | done (App.tsx, `submit`) | P0 | Done. |
| Escape stops a turn | chat:cancel | exposed: `session/cancel` (acp-agent.js:5778-5800) | done (App.tsx, `onKeyDown`) | P0 | Done. |
| Ctrl+C | interrupts; twice exits | partial: cancel only | not handled | Skip | Ctrl+C is copy in a webview. |
| Ctrl+D | exit confirmation | n/a | — | Skip | Tab close covers it. |
| Shift+Tab mode cycle | chat:cycleMode | exposed as mode option | not implemented | P0 | See Permission modes. |
| Option+P model picker | chat:modelPicker | partial: model option; key client-owned | not implemented | P1 | — |
| Option+T thinking toggle | chat:thinkingToggle | not-exposed | not implemented | P1 | D12. |
| Option+O fast mode | chat:fastMode | exposed: fast option; key client-owned | not implemented | P1 | — |
| Desktop Cmd+Shift+M, I, E | mode, model, effort | exposed options; keys client-owned | not implemented | P1 | Map to the shell's shortcut scheme. |
| Desktop Cmd+N | new session | exposed: `session/new` | button only | P1 | — |
| Ctrl+B background | task:background (tmux: press twice) | partial: backgrounded tool calls (tool-calls/background.js) | not implemented | P1 | PR 26. |
| Ctrl+X Ctrl+K stop subagents | chat:killAgents | partial: `_session/async_task/stop` (acp-agent.js:204-205, 9808) | not implemented | P1 | PR 16. |
| Ctrl+T task list | app:toggleTodos | client-owned; plan card exists | not implemented | P1 | PR 23. |
| Ctrl+O transcript view | app:toggleTranscript | client-owned | not implemented | P1 | PR 22. |
| Esc Esc | clears draft or opens rewind | partial (Section 4 A) | not implemented | P1 | — |
| Up and Ctrl+P history | history:previous | client | not implemented | P1 | PR 23. |
| Ctrl+R history search | history:search | client | not implemented | P2 | — |
| Ctrl+X Enter queue | chat:queueSubmit | partial: adapter queue | not implemented | P2 | — |
| Ctrl+Enter or Ctrl+X Ctrl+S send now | chat:sendNow | partial: steering (acp-agent.js:2380-2452) | not implemented | P1 | PR 10. |
| Ctrl+X chords for bands and panes | above-prompt band; pane keys | not-exposed | not implemented | Skip | No band in the tab. |
| Ctrl+G, Ctrl+S | external editor; stash | n/a | not implemented | P2 | — |
| Ctrl+L, Ctrl+Z | redraw; suspend | n/a | — | Skip | Terminal behaviour. |
| `?` help | help panel | n/a | not implemented | P1 | PR 22. |
| keybindings.json | CLI keymap file | n/a | none | Skip | OpenKaava keeps its own map; show the tab map in help. |
| Vim mode | `editorMode: vim` | n/a | not implemented | P2 | — |
| Desktop Cmd+; side chat | not saved to disk | not-exposed | not implemented | P2 | — |
| Desktop Cmd+Shift+D; Ctrl+`; Cmd+\; Ctrl+Tab | diff, terminal, close pane, cycle sessions | n/a | shell | Shell | — |
| Desktop Cmd+Shift+B, Cmd+Shift+S | browser pane and element picker | n/a | no browser pane | Skip | Desktop-only. |
| VS Code Cmd+Esc, Cmd+Shift+Esc, Option+K | focus input; new tab; @ reference | n/a | shell; PR 6 | P1 | Option+K ties to PR 6. |
| Cmd+Shift+T | reopen closed session (VS Code) | n/a | — | P2 | — |

### 2.12 Desktop and VS Code chrome

| Feature | In Claude Code | ACP path | OpenKaava today | Priority | Notes |
|---|---|---|---|---|---|
| Session sidebar layout | sidebar with filters, groups, archive | exposed: `listSessions`, `subscribeSessionList` (acp-agent.js:1549, 1583) | shell tab and cluster model | Shell | Owner decision D11. |
| Environment selector | Local, Cloud, SSH, WSL | not-exposed: host-level | clusters and environments | Shell | — |
| PR status and CI actions | CI bar; auto-fix; address comments; auto-merge | not-exposed | not implemented | P2 | Owner decision D8. |
| Changes pane | changed files, diff stats | partial (see Tool calls) | shell diff | Shell | — |
| Files and terminal panes | pane per session directory | n/a | shell panes | Shell | — |
| Browser pane and element picker | Desktop | n/a | none | Skip | Desktop-only. |
| Background tasks pane | running agents and tasks | partial: AIR-gated async tasks | not implemented | P1 | PR 26 after D10. |
| Side chat | not saved | not-exposed | not implemented | P2 | — |
| OS notification when unseen | session finishes; permission pending | partial: turn-end and permission events (turn-events.js) | not implemented | P1 | Shell provides the OS notice (PR 27). |
| VS Code tab dot | blue for permission pending; orange when finished | n/a | shell badge | P1 | PR 27. |
| Remote Control | switch; push notifications | unknown: no adapter handling | not implemented | Skip | D7. Settings route exists (remoteControlAtStartup). |
| Cloud sessions and teleport | Web tab; resume cloud session | not-exposed | not implemented | Skip | D7. |
| Launch by URI | `vscode://anthropic.claude-code/open`; `claude://code/new` | n/a | shell (OS registration) | Shell | Later. |
| Focus view | focus mode in VS Code (focusView) | n/a | not implemented | P2 | — |
| Timestamps | showMessageTimestamps | not in ACP payloads as far as checked | not implemented | P2 | Check payload first. |
| Copy response | Copy button | n/a | code block copy only | P1 | PR 22. |
| Report a problem; show logs | VS Code commands | n/a | shell logs (unknown) | P2 | — |
| Screen reader support | announcements; focus keys | n/a | not audited | P2 | Second UI pass. |
| Permission option focus | Left and Right between options (v2.1.268) | n/a | button row | P2 | — |
| Command menu groups | Customize, Context, Settings groups | exposed command list; grouping is UI | not implemented | P1 | Palette in PR 5. |
| Account and usage dialog | Account and usage (VS Code) | exposed `/usage` data | not implemented | P1 | PR 18. |
| Connectors | claude.ai connectors (Desktop) | partial: `mcpServers` on session/new | not implemented | P2 | — |
| Desktop settings pane | Claude Code section; computer use | n/a | — | P2 | — |
| Scheduled tasks | Routines list and schedule | not-exposed | not implemented | Skip | D7. |
| Computer use | screen control (macOS, Windows; Pro or Max) | not-exposed: default-off MCP server (mcp.md) | not implemented | Skip | D9. |
| Chrome integration | `/chrome`; browser actions | partial: standard permissions; no `/chrome` in adapter | not implemented | P2 | D9. |
| VS Code settings | useTerminal, initialPermissionMode, attachOpenFile, focusView and others (vs-code doc) | n/a | tab settings not built | P2 | Map initialPermissionMode and allowDangerouslySkipPermissions to owner decisions (D4). |
| Bookmarks and export | bookmark response; export | n/a | not implemented | P2 | Export is P1 (see History). |
| Feedback and bug reports | `/bug`, `/feedback`; SendFeedback drafts | not-exposed | not implemented | P2 | Consent dialog. |
| Local code review | `/code-review`; escalate to ultrareview | exposed as advertised prompt | not implemented | P1 | PR 5. |
| Cloud ultrareview | `/code-review ultra` | exposed when cloud allowed (gated) | not implemented | P2 | — |
| Enterprise section | managed policy display | partial | — | P2 | — |

## 3. Works automatically

These need no new OpenKaava work. The UI still shows what is listed in the last column.

| Item | What the binary or adapter does | What the UI should still show | Source |
|---|---|---|---|
| CLAUDE.md and rules | Loaded from managed, user, project, local and @imports through settingSources | Which memory files loaded (PR 22) | acp-agent.js:7897; memory doc |
| Settings files and precedence | SDK resolves user, project, local and managed. Adapter re-resolves on file change | "Applies next session" note on edits until live apply is verified | settings.js:37-160 (unverified live) |
| Settings-file hooks | Run inside the SDK subprocess. Callbacks cannot cross JSON-RPC | A blocked tool call should show its reason (how ACP reports a block is unknown) | acp-agent.js:338-415 |
| Adapter-internal hooks | Plan mode, model switch, compaction, task events, file previews | Nothing; they feed existing rows | acp-agent.js:7880-8050 |
| Skills from disk | Skill folders and frontmatter run in the SDK | Invocable skills appear in the menu (PR 5) | skills doc |
| Custom subagents | Discovered with supportedAgents(); delegated by the model | Agent picker (PR 5); child rows (PR 16) | acp-agent.js:8848, 8950-8986 |
| MCP servers from files | Project `.mcp.json` and user config load through settingSources; host servers merge on top | Status list (PR 14); approval needs checking | acp-agent.js:7897, 7910-7912 |
| Plugins enabled in settings | Cache, precedence and dependency install | Plugin list (PR 21); reload by resume | plugins/loading doc |
| Managed policy | Env and settings applied at adapter start | Managed tag in settings (P2) | managed-policy.js:1-31 |
| Permission rules | allow, ask and deny checked in the SDK before prompts | Rule list (PR 20) | permissions doc |
| Tool rows, text and diffs | Sent as tool_call and tool_call_update | Already rendered (normalize.rs, `Normalizer::tool` and `merge_tool`). Failed Bash output is the gap (Section 4 Q) | reporters/ |
| Usage line | `usage_update` after each turn | Already drawn (components/Usage.tsx). PR 18 adds cost and rate limit | acp-agent.js:4677-4690 |
| Plan card | Plan updates for TodoWrite and Task tools | Already drawn (components/TodoList.tsx). PR 13 adds plan text and clear-context | tools.js:22-29, 78-220 |
| Retry on error | Kaava-side | Already done (components/ErrorItem.tsx) | — |
| Auto-mode fallback | Mode drops to acceptEdits with a warning | Warning arrives as text today; PR 19 shows a notice | session-mode.js:6-14, 46-54 |
| Session titles | Generated after first prompt | Show the title (PR 8) | session-titles.js:217 |
| Background Bash | Backgrounded calls tagged | Background state (PR 26) | tool-calls/background.js |
| Compaction | SDK compacts; without the capability the adapter sends a tool_call | Native row after PR 18 | acp-agent.js:2584-2592 |
| Model allowlist | Filters the option list | Nothing extra | session-model.js:241-253 |
| Fast mode auto-off | Switching to an unsupported model turns fast off | Show fast state after each model change | fast-mode doc |
| Adapter queue | Prompts queue in the turn queue | Only if the host sends while busy (PR 9 decides) | acp-agent.js:2032-2126 |
| Cancel | `session/cancel` ends the turn | Done | acp-agent.js:5778-5800 |
| Auth status | `authStatus` pushed when it changes | The kind is read; the account label is not | auth-status.js; session.rs, the `_auth/status_update` arm of `Shared::on_line` |
| Process tree cleanup | Host kills the tree on stop, reset and exit | Done | job.rs; session.rs, `Session::kill` |
| Usage-limit wait | CLI-side wait in interactive sessions | Not verified over ACP. Show the limit message (PR 18) | interactive-mode doc |
| Prompt cache | Automatic | Cache clock unknown (P2) | prompt-caching doc |
| Transcript persistence | SDK saves transcripts on disk | Needed for the PR 7 list and resume | sessions doc |

## 4. Not reachable through ACP

Options: **R** read or write files directly; **C** run a `claude` CLI subcommand; **P** send as a prompt; **D** declare a client capability; **U** upstream adapter change. Some items are reachable after a fix. They stay here until the fix is in place.

| Gap | Why not reachable | Options | Recommendation |
|---|---|---|---|
| A. Rewind to an earlier turn | No ACP rewind method. Checkpoints only for AIR file-change reports (acp-agent.js:7837, 7903; file-change-audit.js:27-28). Message-id map only at acp-agent.js:5257 | U; or a per-turn git snapshot in a private ref (own design) | Owner design note first (D6). Restore files only from a private ref; never touch the user's index. |
| B. Edit and resend an earlier prompt | `session/fork` is unstable (acp-agent.js:1500). Fork-at-message is AIR-only (fork-session.js:1-20) | D1 (fork at message); P (replay prompts, which re-runs tools) | Defer. Replaying prompts re-runs tools and changes results. Use fork-at-message only after D1. |
| C. Rename | `_session/rename` needs the sessionIndex capability, AIR-gated (session-index/connection.js:43-45) | D (AIR, D1) | Local label now. |
| D. Archive | Session index is AIR-gated | D (AIR, D1) | Hide locally until D1. |
| E. Goal status panel | Structured panel is AIR-only (acp-agent.js:2301-2303). Typed `/goal` is not blocked | P now; D after D1 | Typed `/goal` now. Panel after D1. |
| F. Async tasks and `/tasks` view | AIR-gated (async-tasks.js; acp-agent.js:204-205). `/tasks` status unknown | D (D1); show tool-level state now | Show background state on tool rows only. |
| G. File-change audit | AIR-only report (file-change-audit.js:1-25) | Derive locally from diff content | Derive changed files from tool diffs. |
| H. Plan file path | AIR-only `planFilePath` (air-extension.js). Plan text works without AIR (exit-plan.js:85-110, with `clientCapabilities.plan`) | D (plan) | Use plan text. Skip the file path. |
| I. "Don't ask again" scope and storage | Adapter writes `localSettings` for `allow_always` (permissions/effects.js:10-40; options/shared.js:19). OpenKaava drops `allow_always` when the request names no file (normalize.rs, `Normalizer::approval`) | Stop the filter (D3); R (read `settings.local.json` to list rules) | Owner sets the scope first (D3). Then stop the filter. Test: a second identical request is not prompted. |
| J. Settings editor | No ACP settings method. SDK `updateSettings` and `applyFlagSettings` exist (sdk.d.ts:2970-2985) but only the adapter holds the SDK | R (write settings files with a schema check); C only if a subcommand is confirmed (none checked) | R with a schema check. Show "applies next session" until live apply is verified. |
| K. Hooks | No method. `includeHookEvents` exists (acp-agent.js:356); output unverified | R (read hook config); verify the option | Read-only list from settings and plugin files. Enable the events option after a check. |
| L. Plugins | No ACP plugin method | C (`claude plugin` subcommands, after confirmation); R (read `installed_plugins.json`) | Run plugin actions through the CLI after explicit confirmation. Plugin install runs code, so confirm each time. Reload by restarting with session/resume. |
| M. MCP add, remove, OAuth | Add and remove: R (`.mcp.json`) or C (`claude mcp add`). OAuth needs `elicitation.url` (acp-agent.js:1031, 1069-1112). Project `.mcp.json` already loads (acp-agent.js:7897) | D (`elicitation.url`); C for add and remove | Do not pass `.mcp.json` again (it duplicates servers). Pass only host-owned servers in `mcpServers`. Declare `elicitation.url`. Add and remove via CLI with confirmation. |
| N. AskUserQuestion | Needs `clientCapabilities.elicitation.form` (acp-agent.js:7030-7040). Without it the tool is disallowed (acp-agent.js:7818, 7941) | D (`elicitation.form`) | Declare in PR 12. Test the undeclared path too. |
| O. Subagent child sessions | Needs `clientCapabilities.subagents` (acp-subagents.js:9-13). RFD form for non-AIR (native-subagents.js:635-661). Child cannot be prompted or cancelled (README:65) | D (`subagents`) | Declare and render. No child controls. Stop all background tasks only if the adapter stops them (verify). |
| P. Compaction presentation | Not a gap. Without `session.compaction` the adapter sends a tool_call (acp-agent.js:2584-2592) | D (`session.compaction`) | Declare in PR 18 for a native row. Not required. |
| Q. Failed Bash output | Terminal output needs `clientCapabilities._meta.terminal_output` or `terminal_output_delta` (client-capabilities.js:41-42; renderer.js:228, 291-296). Success output already arrives (bash.js:18-40). Failed command returns nothing without it (bash.js:29-31) | D (`_meta.terminal_output`) after verify | Verify on a failing command. Declare only if output is missing. |
| R. Steering and queued sends | Steering is advertised to all clients (acp-agent.js:1415-1427; handler 2380-2452). OpenKaava blocks it: `steer` false (harness/claude.rs, `CLAUDE.capabilities`) and busy refusal (session.rs, `Session::prompt`) | Host change (no upstream); P (queue locally) | Host-side queue for take-back (PR 9). Enable steer for send-now in PR 10. |
| S. Prompt suggestions | Dropped (acp-agent.js:5653-5654) | U | Skip until forwarded. |
| T. Rate-limit notice | Adapter sends `_meta['_claude/rateLimit']` on usage_update (acp-agent.js:5619-5627). OpenKaava drops the `_meta` | Read the `_meta` (OpenKaava change) | Read in PR 18. Not an adapter gap. |
| U. Thinking budget | Only `MAX_THINKING_TOKENS` env (acp-agent.js:9933-9945) | R (settings env); effort option | Effort option only. Budget via settings after D12. |
| V. Additional directories and guard | Accepted on session/new (acp-agent.js:7832-7834). Guard is worktree-only (guard.rs, its module comment) | Owner decision (D5) | Keep the guard strict. Show extra dirs read-only until decided. |
| W. Bypass mode | Reachable when allowed (session-mode.js:261). Guard coverage in bypass unverified | Owner decision (D4) | Off until verified. |
| X. Output style live switch | Listed command only; no outputStyle wiring (acp-agent.js:9011). SDK `updateSettings` can set it (sdk.d.ts:2985) but only the adapter holds the SDK | R (write setting); restart with session/resume | Write the setting and restart with resume. Verify. |
| Y. Remote Control, cloud routines, teleport, agent teams | No ACP evidence. Remote Control has a settings route (`remoteControlAtStartup`, vs-code doc) | D7 (owner); R for the setting | Default skip. Settings toggle later if D7 says yes. |
| Z. Third-party provider switch | Exposed (acp-agent.js:1398-1400; 1848-1904) | Owner decision on UI | P2 (corrected from earlier draft). |
| AA. OS notifications, URI launch | Shell work | Shell | Shell (PR 27). |
| AB. AIR identity gate | Many items need AIR keys (air-extension.js:1-53; README:12-26) | D1 | Decide before PRs 8, 26 and the AIR-only items. Check the adapter's terms first (not checked). |
| AC. Memory files | File operations | R; shell file viewer | Native list; edit in shell viewer. |
| AD. Status line | No statusLine handling (grep) | R (run the user's command with JSON on stdin, per statusline doc) | Owner decision. Run in the tab only if approved. |
| AE. `/btw` side question | No ACP method; overlay is CLI UI | Separate side query (own design) | P2. Not verified. |
| AF. Voice dictation | Audio is client-side; needs claude.ai | Client audio | P2. Owner decision. |
| AG. Diagnostics | `claude doctor` runs in terminal. `/heapdump` holds credentials | C (terminal pane for doctor) | Doctor in terminal pane. Never offer heapdump. |
| AH. Sign in and out | Credentials stay in the CLI | C (`claude auth login`, terminal); ACP logout (acp-agent.js:1937-1970) | Sign-in button opens terminal. Sign-out is confirmed. |
| AI. Computer use and Chrome | MCP-based, default off | Owner decision (D9) | Skip until D9. |
| AJ. Session close and delete | Exposed (acp-agent.js:6209, 6217; session-index/connection.js:229) | — | Not a gap. Close gracefully (P1). Delete needs confirmation (P2). |

## 5. Implementation plan

### 5.1 Owner decisions

| ID | Decision | Needed before | Notes |
|---|---|---|---|
| D1 | Declare AIR client keys or not | PR 8, PR 26, and items E, F, G, H, AB | Unlocks rename, archive, goal panel, async tasks, file-change audit, plan file path, fork at message. Check the adapter's README and terms first. Not checked. |
| D2 | Start the agent on tab open, or on first send | Cost only | Today the first send starts it (harness.rs, `spec`; session.rs, `Session::start`). Early start costs a process per open tab. |
| D3 | Offer "don't ask again" on requests with no file, and where it is stored | PR 11 | Adapter writes `localSettings`. A scope rule is needed. |
| D4 | Bypass permissions in the tab | PR 2 | Off until the guard is checked in bypass mode. |
| D5 | Additional directories and the guard | Later | Guard is worktree-only today. |
| D6 | Rewind: private git ref, or wait for upstream | PR 25 | Needs a design note. Never touch the user's index. |
| D7 | Remote Control, cloud routines, teleport, agent teams | Later | Default is skip. Remote Control has a settings route. |
| D8 | PR status and CI actions in the tab | Later | Desktop feature. Host-side. |
| D9 | Chrome integration, Computer use, voice | Later | MCP-based or audio. Sensitive. |
| D10 | Background subagent and task panel | PR 26 | Full view depends on D1. |
| D11 | How sessions and groups map to clusters | PR 7 | Sidebar layout is shell work. |
| D12 | Thinking toggle semantics | PR 3 | Default taken (section 0): `MAX_THINKING_TOKENS`, applies next session. Built in the P1 pass. |

### 5.2 Ordered PRs

Rules for every PR: run `pnpm verify` before commit (`pnpm verify:fast` while iterating). Put user-facing strings in `strings.ts`. Each bug fix ships with its test. Use `mock-agent` (crates/kaava-agent-host/src/bin/mock-agent.rs) where it covers the message. Check acceptance on `pnpm ui launch` with `pnpm probe --agent --server agent`. Never run `pnpm app` or `pnpm dev`.

1. **Read agent capabilities and config options at setup.** Scope: store `modes` and `configOptions` from the `session/new` reply and from `config_option_update`; `agentCapabilities` and `authMethods` are not stored yet (PR 7 and PR 24 read them when they need them) (session.rs, `Shared::handshake`). ACP: `initialize` result, `session/new` result. Acceptance: the mock-agent session tests show `modes` and `config` in the status, kept when the handshake fails and updated by `config_option_update`. Done, narrowed (see Done so far); the adapter version log line is unchanged and has no test.
2. **Mode switcher.** Scope: flip `modes` (harness/claude.rs, `CLAUDE.capabilities`). Mode dropdown and Shift+Tab. Initial mode stays `default` (`Policy::ask_first` in harness.rs). Bypass only if allowed (D4). ACP: `session/set_mode` or config option `mode`; `current_mode_update`. Acceptance: each allowed mode round-trips; unknown id rejected; label shown.
3. **Model and effort.** Scope: picker from the model option; effort option; allowlist applied by the adapter. ACP: `session/set_config_option` (`model`, `effort`); `config_option_update`. Acceptance: next turn uses the chosen model; `config_option_update` reflected. D12 has a default (section 0); its toggle is built in the P1 pass.
4. **Fast mode.** Scope: `fast` option with disabled reasons. ACP: config option `fast`. Acceptance: toggle reflects after the next turn; reason text shown when unavailable.
5. **Slash command menu.** Scope: consume `available_commands_update` (the last arm of `Normalizer::update` in normalize.rs today); filter as you type; argument hints; MCP prompts shown as `mcp:`. ACP: `available_commands_update`. Acceptance: menu lists only advertised commands; typed commands still send as text. Resolve the sweep conflicts.
6. **@ mentions, files and images.** Scope: file picker over the worktree; `resource_link` and text `resource` blocks; image chip. ACP: `session/prompt` content blocks (acp-agent.js:9067-9122). Acceptance: mentioned file and image reach the child. No audio block sent.
7. **Session list, load and resume.** Scope: picker (D11); `session/list`, `session/load`, `session/resume`; `/clear` and New session map to `session/new`; carry-over fixed. ACP: `session/list`, `session/resume`, `session/load`. Acceptance: after app restart a session loads its transcript and resumes with prior context.
8. **Titles and rename (local).** Scope: show `session_info_update` title; rename stays local until D1. ACP: `session_info_update`. Acceptance: title appears after first prompt.
9. **Queue while busy.** Scope: host queue replaces the busy refusal (session.rs, `Session::prompt`). Take back with Up; Stop clears the queue (session.rs, `Session::cancel` already clears). ACP: `session/prompt` at turn end. Acceptance: Enter during a turn queues; Up takes it back; cancel empties the queue.
10. **Send now (steering).** Scope: flip `steer` after PR 9; interrupt or background choice. ACP: `_session/steering`. Acceptance: message reaches the running turn (mock-agent). Live check needed.
11. **Permission scope.** Depends on D3. Scope: stop the `allow_always` filter (normalize.rs, `Normalizer::approval`) for requests with no file, per the owner's scope. ACP: `session/request_permission` option `allow_always`. Acceptance: a second identical request is not prompted; `settings.local.json` gets the rule (verified once). Outside-worktree refusal still works in every mode.
12. **AskUserQuestion form.** Scope: declare `elicitation.form`; render form; fold answers into tool input. ACP: `elicitation/create` form; response folded into `updatedInput` (elicitation.js:170-256). Acceptance: answer reaches the tool; undeclared path tested.
13. **Plan card with plan text.** Scope: declare `plan`; show `plan_update` text; approve and reject options; clear-context option. ACP: `plan_update` (exit-plan.js:85-110); ExitPlanMode options. Acceptance: each option sends the right response; plan text shows.
14. **MCP status and actions.** Scope: native MCP panel and `/mcp` route; host-owned `mcpServers` only (Section 4 M). ACP: `/mcp` adapter command; SDK-backed status. Acceptance: panel matches status; reconnect, enable and disable work.
15. **MCP OAuth.** Scope: declare `elicitation.url`; open sign-in in the browser; show completion. ACP: URL elicitation; `elicitation/complete`. Acceptance: OAuth completes; timeout shows an error.
16. **Subagent child rows and background stop.** Scope: declare `subagents`; render `subagent_update`; stop background tasks. ACP: `subagent_update`; `_session/async_task/stop`. Acceptance: child row appears; stop returns control.
17. **Failed Bash output.** Scope: verify on a failing command; declare `_meta.terminal_output` only if output is missing. ACP: tool_call content; `_meta.terminal_output`. Acceptance: failing command shows its output in the row.
18. **Compaction and usage.** Scope: declare `session.compaction` for a native row; read cost and `_claude/rateLimit` in usage; `/usage` and `/context` as panels. ACP: `compaction_update`; `usage_update` cost and `_meta`; structured `/usage`. Acceptance: cost and rate-limit show; compaction row updates.
19. **Notices and model fallback.** Scope: render notices and auto-mode fallback. ACP: `notice` (session-notices.js). Acceptance: fallback notice shows once.
20. **Settings and rules panel.** Scope: read and write settings files with a schema check; permission rules list and editor; "applies next session" note (Section 4 J). Acceptance: edit persists; next session reads it.
21. **Hooks, plugins and skills panels.** Scope: read-only hooks list; plugin list with CLI actions after confirmation; skills visibility; `/reload-plugins` as restart with resume. ACP: `session/resume`; CLI subcommands. Acceptance: plugin change takes effect after restart; no action without confirmation.
22. **Memory, export, copy and help.** Scope: CLAUDE.md and memory list; export to file; message copy; `?` help panel listing advertised commands and shortcuts; transcript view modes. ACP: none new. Acceptance: export file has the transcript; help lists the menu.
23. **Keyboard parity.** Scope: Option+P, O, T; Ctrl+T; Up history; Ctrl+X Enter queue. Acceptance: each shortcut is in help.
24. **Status and auth actions.** Scope: native status panel (`/status` replacement); sign-in opens a terminal pane; sign-out confirmed. ACP: `authStatus`; `logout`. Acceptance: no credential is typed in the tab.
25. **Fork and rewind design.** Scope: fork the session (unstable `unstable_forkSession`) behind a flag. Rewind: design note only until D6. ACP: `unstable_forkSession`. Acceptance: forked session opens with the copy.
26. **Background work panel.** Scope: Ctrl+B on tool rows; background state panel; workflow progress. Depends on D1 and D10. ACP: `backgroundedBashToolCall`; async task events. Acceptance: backgrounded command keeps running after the turn ends.
27. **Notifications and badges.** Scope: OS notice and tab badge on turn end and pending permission (shell). ACP: turn events. Acceptance: notice appears when the tab is hidden.

**Later (P2).** Providers UI, sandbox, status line, voice, hook events, `/btw`, prompt suggestions, Vim mode, emoji, spellcheck, screen reader pass, Chrome, PR status, Remote Control, cloud routines, Computer use, scheduled tasks.