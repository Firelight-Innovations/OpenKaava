# Kaava agent host and agent bar: handoff for the implementation agent

Owner: Braden Seaborn. Date: 2026-10-13. State: DRAFT FOR AGENT HANDOFF (v0.1).
Reader: **Agent C**, a cloud agent that implements and tests this feature.
Design source: `docs/design/KAAVA-AGENT-EMBEDDING-DESIGN.md` (read it first; this document turns it into tasks).
Related: `docs/KAAVA-UX-REWORK.md` (environments, clusters, panes; "UX spec" below), `docs/design/OPENKAAVA-PLANE-DESIGN.md`, `docs/design/kaava-ds/` (tokens; the owner's `claude/kaava-tokens.css`).
Lint note: `ste_lint.py` was not run on this document. Terms marked PROPOSED are not in `core/terminology.csv` yet.

### Repository notes (added when this was committed)

- **`apps/agents/` already exists** and is a different thing: the cloud Agents app that lists
  machines, workflows and cloud sessions (`docs/design/CLOUD-SYSTEM-DIAGRAM.md`). The proposed
  `apps/agent` sits one letter away from it. Settle the name with the owner (§11.2) before creating
  the directory, and record it in §12.
- `core/terminology.csv`, `core/decisions/` and `claude/openkaava-cloud-prd.md` live in the owner's
  design repository, not here.
- The repository's own working agreements in `CLAUDE.md` and `STANDARDS.md` apply on top of this
  document: `pnpm verify` before every commit, never grow a lint baseline, every new app needs its
  entry in `vite.config.ts`.

---

## 0. Rules for Agent C

1. **Scope.** Build the agent host, the adapters, the agent tab, the agent bar, and the Kaava tool server described below. Nothing else. Do not touch Plane, the registry app, the canvas app, or Schematify.
2. **Never read, store, log, or forward a Claude or ChatGPT login token.** Claude and Codex own their sign-in. Kaava only spawns their programs. Add a test that greps logs and the session store for token-shaped strings.
3. **Run Claude as the unmodified `claude` binary.** Do not patch it, wrap its auth, or remove its login methods. Do not use the Claude Agent SDK to sign users in.
4. **Naming in the UI:** "Claude", "Codex", "Pi". Never "Claude Code" in a label, title, or icon. Do not copy Claude Code or Codex logos or look-alike visuals.
5. **No agent writes to main.** Every agent process starts with its working directory set to its environment (UX spec §0 and §2). The host refuses to start an agent on main.
6. **Reuse before building.** Use ACP and the existing adapters (§3). Use existing React and Rust libraries where they exist. Name each reuse in the PR description.
7. **Terms.** Use only the PROPOSED terms in §1.3. Put every user-facing string that uses them in `apps/agent/src/strings.ts`, so a rename touches one file.
8. **Secrets.** None in the repository, the image, or a local file. API keys for tests come from environment variables set by the owner.
9. **Escalate, don't guess.** If a verify-first item (§10) fails, or two requirements conflict, stop and write the conflict into §10 or §11. Do not work around it.
10. **Tests are part of done.** A task is not done until its acceptance row passes in CI on Linux. Windows checks are owner-run (§9).
11. `pnpm verify`, `cargo deny`, `dependency-cruiser`, and the PR scope script shall pass on every PR. Respect `CODEOWNERS`.

---

## 1. Goal and decisions

### 1.1 Goal

Kaava shows Claude, Codex, and Pi (the Kaava default harness) in one native panel. The panel looks and behaves like the chat panels in VS Code. An **agent bar** at the bottom of each cluster starts and steers sessions. Each session is bound to its cluster's environment.

### 1.2 Decisions this implements (owner direction, 2026-10-13)

| ID | Decision |
|---|---|
| AGT-001 | Do not embed the VS Code extensions. Embed the programs they wrap. |
| AGT-002 | ACP (Agent Client Protocol) is the primary wire protocol. A native side channel is added only on request. |
| AGT-003 | Pi is the Kaava default harness. Kaava owns its ACP shim. Pi stays on upstream through extensions. |
| AGT-004 | Claude runs as the unmodified binary, signed in by the user. Codex runs as `codex app-server` or `codex-acp`, signed in by the user. |
| AGT-005 | A Kaava tool server gives all three harnesses the same context and feedback tools. |

These are not yet rows in `core/decisions/`. Do not write decision rows. Report them to the owner in the first PR.

### 1.3 PROPOSED terms

`agent host`, `adapter`, `agent bar`, `agent tab`, `harness`. Existing approved terms stay as defined: `environment`, `cluster`, `pane`, `agent session`, `cloud session`, `local worktree`, `viewer`, `comment anchor` (the last six are pending too, per the UX spec §9). Do not invent synonyms.

---

## 2. Style: "VS Code style"

The owner wants the look and feel of VS Code and its chat extensions. This section is binding.

### 2.1 Visual rules

1. **Tokens.** Define a thin mapping layer, `apps/agent/src/theme/vscode-map.css`, from Kaava tokens (`claude/kaava-tokens.css`; in this repository, `docs/design/kaava-ds/`) to VS Code-style semantic names. Components read the mapped names only. Examples: `--k-editor-bg`, `--k-sidebar-bg`, `--k-panel-border`, `--k-focus-ring`, `--k-list-hover`, `--k-list-active`, `--k-badge-bg`, `--k-diff-add`, `--k-diff-del`. Do not hard-code colors.
2. **Theme.** Dark and light, following the shell's `kaava:theme-changed` event.
3. **Density.** 13 px base text, 22 px list rows, 1 px borders, 2 px focus ring, 4 px radius on cards, no drop shadows except menus. Monospace for code, commands, and paths.
4. **Icons.** Use Codicons (MIT licensed font) for all new icons. Do not draw new icon sets.
5. **Layout inside the agent tab**, top to bottom:
   - Header: title, harness chip, environment chip, status dot, a "new session" button, a history button.
   - Transcript: scrolling list of items (§2.2).
   - Prompt box: multi-line input, attachments row, and a footer row with the mode indicator, model name, and context chips.
6. **Empty state.** A short prompt, three example tasks, and the keybinding list. No marketing copy.

### 2.2 Transcript items

| Item | Rendering |
|---|---|
| User message | Plain block with attachments listed below |
| Assistant text | Markdown, code blocks with a copy button |
| Reasoning | Collapsed row, "Thinking", expands on click; `Ctrl+O` toggles all |
| Tool call or command | One collapsed row: icon, one-line summary, status spinner or check. Expands to input and output. Long output is truncated with "Show all" |
| File change | Diff card: file path, +/- counts, inline diff, **Accept** and **Reject** buttons, "Open in editor" link |
| Approval request | Card with the exact command or change, **Allow**, **Allow for session**, **Deny**. The turn stays paused until answered |
| Plan or to-do list | Checklist card that updates in place |
| Usage | Small footer line per turn: tokens and, for API sessions, cost |
| Error | Red-bordered row with a retry button |

### 2.3 Interaction model

- **Mode indicator** at the left of the prompt footer: Ask before edits, Accept edits, Plan. Click to cycle. Claude and Codex map to their own modes. Pi's modes come from Kaava.
- **Model picker** at the footer. Lists models the adapter reports.
- **`/` command menu.** Lists the adapter's slash commands plus Kaava commands: New session, Switch model, Compact, Fork, Attach file, Send comments.
- **`@` mentions.** Files in the environment, comment anchors, canvas nodes, Plane work items.
- **Queue and steer.** Typing while the agent works queues a message. `Enter` sends it as a steer message. `Esc` stops the current turn.
- **Session history** (header button and a sidebar list): search, filter by Needs input / Working / Completed, group, archive, unarchive. Same behavior as the VS Code extension's history list.
- **Status bar item** (shell bottom bar): active harness, state, and cost for the project.

### 2.4 Keybindings

| Key | Action |
|---|---|
| `Ctrl+L` | Focus the agent bar |
| `Ctrl+Esc` | Toggle focus between the active file viewer and the agent bar |
| `Alt+K` | Insert an @-mention of the current selection (file and line range, node path, or mesh part) |
| `Esc` | Stop the current turn |
| `Ctrl+Shift+Enter` | Send and open as a new agent tab |
| `Ctrl+O` | Expand or collapse all reasoning blocks |

Existing Kaava keys stay unchanged (`Ctrl+Shift+N`, `Ctrl+Shift+O`, `Ctrl+Shift+C`, `F5`). Register all new keys through the shell's existing keybinding registry. Report any conflict.

### 2.5 Accessibility

Every control is reachable by keyboard. Focus order follows the layout in §2.1. Status uses an icon and text, not color alone. Run the repository's accessibility check on the agent tab. Aim for WCAG 2.1 AA contrast on both themes.

---

## 3. Architecture

```
React (apps/agent)                       Rust (crates/kaava-agent-host)
  Agent bar, agent tab, history   <──>   process manager
  receives normalized events              adapter trait + normalizer
  sends commands via Tauri                session store
                                          │ stdio JSONL (local)
                                          │ stdio over IAP SSH (cloud, later)
                                          ▼
                       Adapters:  pi-acp shim | claude ACP adapter | codex-acp
                                          │
                       Kaava tool server (per environment)
```

Paths above are proposals. Confirm them against the repository layout and record the final paths in §12.

### 3.1 Normalized event model

Use the Codex model: **thread** (a durable session), **turn** (one unit of agent work), **item** (message, reasoning, command, file change, approval, plan, usage, error). Item lifecycle: `started`, zero or more `delta`, `completed`. Define the types once in Rust and generate TypeScript types from them. Do not hand-write both.

### 3.2 Adapter trait (Rust)

Methods: `start(env, config)`, `prompt(thread, input)`, `steer(thread, input)`, `abort(thread)`, `answer_approval(id, decision)`, `resume(thread_id)`, `fork(thread_id)`, `set_model(id)`, `set_mode(mode)`, `list_commands()`, `shutdown()`. Each adapter reports a capability set (supports fork, supports steer, supports modes). The UI hides controls the adapter does not support.

### 3.3 Adapters

| Adapter | Program | Notes |
|---|---|---|
| Pi | `pi --mode rpc` behind a Kaava-owned ACP shim (`packages/pi-acp/`, Node) | MIT. Check for a maintained community shim first (V3). Commands: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `set_model`, `fork`, `switch_session`, `compact`. Done at `agent_settled`. |
| Claude | The unmodified `claude` binary through an ACP adapter | Pin the adapter version. Sign-in happens in Claude's own flow. |
| Codex | `@agentclientprotocol/codex-acp` (built on `codex app-server`, Apache-2.0) | Pin versions. Identify as `kaava` at initialize. |
| Mock | `packages/mock-agent/`, a scripted ACP agent | Used by every automated test (§9). |

If a real ACP adapter cannot cover a required item type, write the gap into §10. Do not fork the adapter without owner approval.

### 3.4 Environment binding and safety

1. The host takes an environment record (kind, path, branch) from the workspace state. It sets the child's working directory to the environment path.
2. The host refuses to start for kind `main`.
3. **Path guard.** For Pi, ship a Pi extension that blocks `write`, `edit`, and `bash` calls whose targets resolve outside the environment path (resolve symlinks first). For Claude and Codex, answer approval requests with a host-side check on the same rule, and deny on violation.
4. Cloud sessions use the same trait. The transport is stdio over an IAP SSH tunnel to the worker VM. This is phase S5 and is not part of the first PR set.

### 3.5 Session store

Save thread ids, harness, model, mode, and environment id in `workspaces/<project-id>.json` (UX spec §6). Never save tokens. Transcripts stay in each harness's own storage. Kaava keeps an index only. On restore, show a session whose process is gone as "Stopped" with a **Resume** button.

### 3.6 Kaava tool server

One per environment, started with the host. Exposed to Claude and Codex as an MCP server (stdio), and to Pi as native `customTools`. The tool names are identical in both.

| Tool | Behavior |
|---|---|
| `get_selection` | Returns the current file, node, mesh part, or canvas selection |
| `list_comments`, `resolve_comment` | Reads and writes `.kaava/comments/` in the environment |
| `get_canvas_node` | Returns a canvas node by id |
| `render_scene`, `render_asset` | Stub in this phase; returns "not implemented" |
| `plane_*`, `hindsight_*` | Out of scope here; reserve the names |

---

## 4. The agent bar

1. One bar per cluster, docked at the bottom of the cluster. It is bound to the cluster's environment.
2. Contents, left to right: harness picker, model picker, mode indicator, context chips, prompt box, send button.
3. **Context chips** fill automatically from the shell's selection state: file selection, selected Godot node or Blender mesh part, open comments, selected Plane work item, selected canvas node. The user can remove a chip before sending. A chip that points to an excluded or ignored file sends the path only.
4. Sending focuses the cluster's existing agent tab for that harness, or opens a new one in the pane tree. The tab is a normal pane tab: it can be split, dragged within the same environment, and restored.
5. If the harness is not installed or not signed in, the bar shows a one-line fix ("Run `claude` once to sign in") and a link to the harness's own docs. Kaava never starts a sign-in flow itself.

---

## 5. Out of scope

1. Embedding VS Code or code-server (design phase S7; separate handoff, if approved).
2. Cloud sessions over IAP (phase S5).
3. Plane, Hindsight, render, and registry tools in the tool server beyond reserved names.
4. Pi tuning, evals, and cost work (phase S6).
5. Any billing, account, or sign-in UI for Claude or ChatGPT.
6. Sub-agent maps and Claude hooks UI.

---

## 6. Tasks

Order matters. Finish T0 first.

| ID | Task | Acceptance |
|---|---|---|
| T0.1 | Spike (Rust test, Linux): spawn the mock agent, a real Pi (`--mode rpc`, API key from env), `codex-acp`, and a Claude ACP adapter; print raw messages | Transcript files for each, saved under `docs/spikes/`. Real Claude and Codex runs are owner-run (§9); record "not run" for them if no login exists |
| T0.2 | Fill the verify-first table (§10) with results | No open V-row except those marked owner-run |
| T1.1 | Crate `kaava-agent-host`: types, adapter trait, process manager | Unit tests: start, prompt, abort, crash, restart |
| T1.2 | Event normalizer with generated TypeScript types | Round-trip test over recorded transcripts; type generation is part of `pnpm verify` |
| T1.3 | Mock agent with scripted scenarios: streaming text, tool call, approval, diff, plan, error, slow turn | Each scenario has a golden event file |
| T1.4 | Pi adapter and ACP shim | Prompt, steer, abort, fork pass against real Pi when `PI_TEST_KEY` is set; otherwise against the mock |
| T1.5 | Claude adapter | Prompt and approval flow against the mock; real-run script for the owner |
| T1.6 | Codex adapter | Same as T1.5 |
| T1.7 | Environment binding and path guard (§3.4) | Tests: start on main is refused; a write outside the worktree is denied for each adapter; symlink escape is denied |
| T1.8 | Session store (§3.5) | Restart restores the list; a missing process shows "Stopped"; token-grep test passes |
| T2.1 | `apps/agent`: theme map, Codicons, agent tab shell, transcript with all item types (§2.2) | Component tests for each item type; screenshot tests in both themes |
| T2.2 | Approval card, diff card (accept/reject writes only inside the environment) | End-to-end test with the mock agent |
| T2.3 | Prompt box: modes, model picker, `/` menu, `@` mentions, queue and steer, stop | Keyboard-only test passes |
| T2.4 | Session history: search, status filters, archive, unarchive, resume, fork | Test covers each action |
| T3.1 | Agent bar and context chips wired to shell selection state | A selected node shows as a chip and arrives in the prompt payload |
| T3.2 | Keybindings (§2.4) and status bar item | No conflicts reported by the registry; docs table updated |
| T3.3 | Not-installed and not-signed-in states (§4.5) | Test with a missing binary and with an unauthenticated mock |
| T4.1 | Kaava tool server: `get_selection`, `list_comments`, `resolve_comment`, `get_canvas_node` | The same `list_comments` call succeeds from Pi, Claude (MCP), and Codex (MCP) in an integration test |
| T4.2 | Accessibility pass (§2.5) | Check passes; manual tab-order notes recorded |
| T5.0 | Windows build and owner checklist (§9) | Checklist handed to the owner with the build artifact |

---

## 7. Cost and licensing checks

1. Add the new packages to `cargo-deny` and the JS license check. Allowed: MIT, Apache-2.0, BSD, ISC. Report any other license before adding the package.
2. Pin the versions of Pi, the Claude adapter, and Codex's adapter. Record them in `docs/agent-host-versions.md` with the date tested.
3. Tests that call real model APIs run only when the owner sets the key variable. CI default is the mock. No test may exceed 1 USD per run.

---

## 8. Telemetry and logging

1. Log process start, exit code, and normalized event counts. Do not log prompt text or file contents by default.
2. A debug switch writes raw adapter traffic to a local file, with token-shaped strings masked. The file stays off by default.

---

## 9. Test plan

### 9.1 Automated (CI, Linux)

1. Unit tests for the host, normalizer, path guard, and session store.
2. Contract tests: the mock agent and each real adapter produce the same normalized event shape for the same scripted scenario, where the real adapter can run.
3. Component and screenshot tests for the agent tab in both themes.
4. End-to-end test with the Tauri app and the mock agent: open a worktree cluster, send a prompt, approve a change, see the diff, accept it, confirm the file changed inside the worktree and nowhere else.
5. Security tests: start on main refused; escape by `..`, absolute path, and symlink denied; token-grep over logs and the store.
6. Crash tests: kill the agent process mid-turn; the UI shows "Stopped" and offers Resume.

### 9.2 Owner-run (Windows, real logins)

Agent C cannot sign in to Claude or ChatGPT. Prepare a script and a checklist. The owner runs them.

1. Windows install of the app and each harness runs without WSL (V1).
2. Claude: sign in once in a terminal, send a prompt from the agent bar, approve a command, accept a diff.
3. Codex: the same.
4. Pi with an API key: the same.
5. Close and reopen the app; sessions restore; Resume works.
6. Record results in §12.

---

## 10. Verify-first items (record results here)

| # | Item | Owner | Result |
|---|---|---|---|
| V1 | Claude, Codex, and Pi run natively on Windows as Tauri child processes without WSL | Owner | |
| V2 | The Claude ACP adapter keeps the unmodified binary's sign-in and passes permission prompts through | C, then owner | |
| V3 | Whether a maintained Pi ACP shim exists; if not, T1.4 writes one | C | |
| V4 | Pi RPC covers steer, abort, fork, and extension UI requests as documented | C | |
| V5 | `codex-acp` covers approval, diff, and plan items | C | |
| V6 | Anthropic written confirmation before any external release that includes Claude | Owner | |
| V7 | Codex CLI license text confirmed (the adapter is Apache-2.0) | C | |

---

## 11. Open items for the owner

1. Approve the PROPOSED terms (§1.3) and the AGT rows.
2. Confirm the final crate and app paths (note `apps/agents/` is already taken by the cloud Agents app).
3. Confirm the default harness for the first release: Pi (needs an API key) or Claude/Codex (user plan).
4. Decide whether the worker VM later runs Pi by default.
5. Decide on the optional full-editor tab.

---

## 12. Results log

(Agent C fills this in: final paths, pinned versions, V-row results, owner checklist results, known gaps.)

---

## Sources

1. Design: `docs/design/KAAVA-AGENT-EMBEDDING-DESIGN.md`
2. OpenAI, Unlocking the Codex harness: https://openai.com/index/unlocking-the-codex-harness
3. Pi coding agent: https://github.com/badlogic/pi-mono
4. Claude Code in VS Code (UI reference for the chat panel): https://code.claude.com/docs/en/vs-code
5. Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
6. Agent Client Protocol: https://agentclientprotocol.com/overview/introduction
7. codex-acp: https://github.com/zed-industries/codex-acp
8. Zed external agents: https://zed.dev/docs/ai/external-agents
