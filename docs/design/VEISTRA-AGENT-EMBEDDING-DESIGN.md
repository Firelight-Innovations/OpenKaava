# Veistra agent embedding: Claude Code, Codex, and the Pi agent bar

Owner: Braden Seaborn. Date: 2026-10-13. State: DESIGN PROPOSAL, NOT YET APPROVED.
Related: `docs/VEISTRA-UX-REWORK.md` (environments, clusters, panes), `docs/design/VEISTRA-PLANE-DESIGN.md`, `claude/veistra-cloud-prd.md` (not in this repository).
Implementation handoff: `docs/handoffs/agent-host.md`.
Lint note: `ste_lint.py` was not run on this document. Terms marked PROPOSED are not yet in `core/terminology.csv`.
Superseded in part (2026-10-25): the agent bar was removed. Agent sessions run only in the agent tab.

## 1. Answer in brief

Do not embed the VS Code extensions. Embed the engines they wrap.

- The Claude Code and Codex extensions are VS Code webviews. They need a VS Code extension host to run. They cannot be dropped into a Tauri/React app.
- Both extensions are thin UIs over a harness process. The harness speaks a documented protocol over stdio.
- Veistra spawns those harness processes itself. One native React agent panel renders all of them.
- Veistra's own harness (Pi) plugs into the same panel through the same protocol.
- The agent bar is a composer strip over that panel. It carries a harness picker and context chips.

Two optional extras: a full VS Code tab (code-server) as an escape hatch, and a Veistra MCP server that gives every harness the same context and feedback tools.

## 2. Why not embed the extension UIs

| Fact | Source | Consequence |
|---|---|---|
| The Claude Code extension bundles its own CLI and runs a local MCP server named `ide` so the CLI can open diffs and read the selection | Claude Code VS Code docs | The UI depends on VS Code APIs (diff viewer, selection, notebooks). Outside VS Code, those calls have nothing to talk to. |
| The extension is available on the VS Code Marketplace and on Open VSX | Same | A VS Code-compatible host can install it. |
| The Codex extension (`openai.chatgpt`) works in VS Code, Cursor, Windsurf and Insiders | Codex IDE docs | Same dependency on an extension host. |
| Codex's extension launches `codex app-server` as a child process | OpenAI, "Unlocking the Codex harness" | The reusable part is the app server, not the extension. |

Embedding a whole editor is possible, but it costs more than it returns:

1. One editor server per environment. Veistra binds every cluster to one worktree or cloud session (UX spec §2).
2. Two state models. Veistra would not see inside the extension's chat, so it could not anchor comments, link Plane issues, or enforce the no-work-on-main rule.
3. A heavy bundle: a Node server plus Code-OSS, inside a Tauri app.
4. Marketplace terms. Microsoft's marketplace is intended for Microsoft's own products. Open VSX is the safe source. Confirm that the Codex extension is on Open VSX before you rely on this path (open item V3).

Keep this route only as a late "Open full editor" tab.

## 3. Recommended architecture: an agent host with adapters

```
React UI (Tauri webview)
  Agent bar  +  Agent tabs (live in the pane tree)
        │ Tauri events / commands (normalized events only)
Rust: veistra-agent-host            [PROPOSED term: agent host]
  - process manager (one process per agent session, cwd = environment)
  - adapter trait: start / prompt / steer / abort / approve / resume / fork
  - event normalizer -> thread / turn / item model
  - session store (ids saved in workspaces/<project>.json)
        │ stdio JSONL (local)  or  stdio over IAP SSH (cloud)
  Adapters  [PROPOSED term: adapter]
    Pi          pi --mode rpc               (Veistra default harness)
    Claude      unmodified `claude` binary  (ACP adapter, or stream-json)
    Codex       codex app-server            (or codex-acp)
        │
Veistra MCP server (per environment): selection, comments, canvas, viewers, Plane
```

### 3.1 Pick one wire model

Two good choices.

**A. Agent Client Protocol (ACP).** JSON-RPC over stdio. Local agents run as editor subprocesses. Zed runs Claude Agent and Codex this way, through adapters installed from an ACP registry. The Codex adapter (`@agentclientprotocol/codex-acp`, Apache-2.0) is built on the Codex app server. It supports permission requests, edit review, TODO lists, slash commands, MCP servers and ChatGPT-subscription login.
- Pro: one client implementation covers Claude, Codex, Pi and any future agent (Gemini CLI and others).
- Con: lowest common denominator. Harness-specific features such as Claude subagent maps, hooks UI, and Codex cloud delegation need a side channel.

**B. Native protocol per harness.** Codex app server: JSON-RPC lite over JSONL, with `initialize`, then thread, turn and item events and approval requests. Claude: Agent SDK or `claude -p` with stream-json. Pi: `--mode rpc` JSONL, or the in-process SDK.
- Pro: full fidelity.
- Con: three clients to build and keep current.

**Recommendation:** ACP-first. Write Pi's ACP shim yourself, since you own that harness. Add a native side channel for one or two high-value features only after customers ask. Use Codex's thread, turn and item model as Veistra's internal event shape, because it is the cleanest of the three.

### 3.2 Per-harness notes

**Pi (Veistra default harness).** MIT license. Packages: `pi-ai` (providers), `pi-agent` (loop), `pi-coding-agent` (the CLI), `pi-tui`.
- Run modes: interactive, print/JSON, `--mode rpc`, and an SDK (`createAgentSession`).
- RPC commands include `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `set_model`, `fork`, `switch_session` and `compact`. Streaming arrives as `message_update` with `text_delta`. The run is finished at `agent_settled`.
- The extension API registers tools and commands, handles events such as `tool_call`, and adds UI. The SDK takes `customTools`, a resource loader (skills, prompts, `AGENTS.md`), and a session manager. Sessions are JSONL trees with branching.
- Pi deliberately omits MCP, sub-agents, permission popups, plan mode and built-in to-dos.
- Veistra consequences:
  1. Run Pi as a Node sidecar per environment in RPC mode. Keep the SDK for tests.
  2. Expose Veistra tools as native Pi `customTools`. No MCP is needed for Pi.
  3. Enforce environment rules in a Pi extension on the `tool_call` event: block writes outside the worktree. Pi has no permission popups, so this is the only guard.
  4. Plan mode, to-dos and sub-agents come from Veistra (orchestrator and UI), not from Pi.
  5. Stay on upstream Pi through extensions as long as you can. Fork only for a measured reason.

**Claude.** Run the unmodified `claude` binary and let it own sign-in. Agent SDK is the other option: it runs the Claude Code binary and gives you sessions, hooks, permissions, MCP and subagents.
- The extension's `claudeProcessWrapper` setting shows the intended seam: the process is replaceable and the extension only needs its stdio.
- Branding: the SDK docs allow "Claude Agent" (preferred in menus) or "Claude" inside an "Agents" menu. They do not allow "Claude Code" or Claude Code-style visuals as your product's branding. The legal page lets you say in plain text that you run Claude Code.

**Codex.** `codex app-server`, JSON-RPC over stdio. Run `codex app-server generate-ts` for typed bindings. The VS Code extension pins a tested binary and identifies itself as `codex_vscode` at `initialize`. Do the same: pin a version and identify as `veistra`. The app server is backward compatible, so older clients work with newer servers.

### 3.3 Where processes run

| Environment | Where the harness runs | Transport |
|---|---|---|
| Local worktree | Laptop, cwd = `.veistra/worktrees/<name>` | Child process, stdio |
| Cloud session | Worker VM | stdio tunneled through IAP SSH, or a small `veistra-agentd` daemon with a WebSocket over the IAP tunnel |
| Main | No agent allowed | Read-only browse only |

Codex's own web product tunnels the same stdio streams to a container, so the pattern is proven. The thread model (durable, resumable) lets the UI reconnect after a laptop sleep. This replaces the batch `claude -p` job loop for interactive work. Keep `claude -p` for unattended Plane `ai:*` jobs.

## 4. The agent bar

**Definition [PROPOSED term: agent bar].** A slim composer strip at the bottom of the active cluster. It always targets the cluster's environment.

Contents, left to right:
1. Harness picker: Pi (default), Claude, Codex.
2. Model and effort picker, read from the adapter.
3. Mode: plan, ask, accept edits. Pi's modes come from Veistra.
4. Context chips, filled automatically:
   - the selection in the file viewer,
   - the selected Godot node or Blender mesh part (the UX spec's comment anchors),
   - open comments in `.veistra/comments/`,
   - the selected Plane work item,
   - the selected canvas node.
5. Prompt box. `Ctrl+L` focuses it. Typing while the agent works queues a steer message.

Behavior:
- Sending opens or focuses an **agent tab** in the cluster's pane tree. The transcript lives there, so it can be split, moved and restored with the rest of the layout.
- Item renderers: assistant text, reasoning (collapsed), command execution, file change as a diff with accept and reject, approval card, plan and to-do list, usage.
- Session list per environment: resume, fork, archive.
- A cloud session streams into the same tab type.
- The environment bar shows agent state (working, needs input, done), as the UX spec already requires.

## 5. Veistra MCP server: the real integration layer

Claude Code's extension runs a local `ide` MCP server so the CLI sees selections and opens diffs. Veistra does the same, but for game work. One server per environment, exposed to Claude and Codex as MCP and to Pi as native tools.

| Tool | Purpose |
|---|---|
| `get_selection` | Current file, node, mesh part, or canvas selection |
| `list_comments`, `resolve_comment` | The select-to-comment loop from the UX spec |
| `get_canvas_node` | Design intent for an asset or scene |
| `render_scene`, `render_asset` | Headless Godot or Blender output, returned as images |
| `plane_*` | Work item read, comment, state change |
| `hindsight_recall`, `hindsight_retain` | Memory |

This matches the two problems you named: give the agent context, and give it feedback. It also makes the harness a swap-in part. The context layer is what you would sell.

## 6. Auth and terms

| Path | Status |
|---|---|
| End user runs the unmodified `claude` binary and signs in with their own subscription, even when a platform hosts the binary | Allowed (Claude Code legal page) |
| Developer builds a product on the Agent SDK | Anthropic says to use API-key authentication. It does not permit third-party developers to offer Claude.ai login or route through Free, Pro or Max plan credentials for their users. |
| Collecting or storing Claude.ai credentials or session tokens | Not allowed |
| Pi's `/login` with Claude Pro or Max | Pi supports it. It is the third-party-harness pattern Anthropic's policy targets. Do not ship it. Use API keys, Bedrock, Vertex or OpenRouter for Claude models in Pi. |
| Codex with a ChatGPT login or API key | Codex owns its own sign-in. Veistra never touches the token. |

Rules for Veistra:
1. Veistra never reads, stores or forwards a subscription token.
2. Claude runs as the unmodified binary, signed in by the user. Customers do the same on their own machines.
3. Do not call anything "Claude Code" in the UI. Use "Claude" and "Codex".
4. The `claude-oauth-token` secret on the worker VM is your own single-user use. It is a gray area for an internal tool and not acceptable for customers. If Veistra goes external, either have customers sign in themselves or ask Anthropic sales for written approval.

## 7. Build plan

| Step | Work | Acceptance |
|---|---|---|
| S0 spike (1–2 days) | Rust test that spawns `codex app-server`, `claude` (ACP or stream-json) and `pi --mode rpc`, and prints normalized events for one prompt each | Three transcripts with streamed text, one tool call and one approval each |
| S1 | Crate `veistra-agent-host`: adapter trait, normalizer, session store | One prompt runs end to end on each adapter |
| S2 | Agent tab renderer: transcript, approval card, diff, steer, abort | Diff accept writes only inside the worktree |
| S3 | Agent bar and context chips | A Godot node selection reaches the agent as context |
| S4 | Veistra MCP server and Pi `customTools` | Same `list_comments` call works from all three harnesses |
| S5 | Cloud sessions through IAP stdio | Laptop sleep and reconnect resumes the same thread |
| S6 | Pi tuning: tool set for Godot and Blender, compaction, caching, replay evals from session JSONL | Measured cost and success rate per task against Claude and Codex baselines |
| S7 (optional) | code-server tab as "Open full editor" | Opens on the environment path |

Timing: you paused Veistra development to run customer discovery. The one-week redesign after the interviews is the natural slot for S0–S3. Add one question to the interviews: which agent do you use today? The answer decides whether Claude, Codex or Pi gets first-class polish.

## 8. Verify first

| # | Item |
|---|---|
| V1 | Codex app server and Claude Code run natively on Windows without WSL in a Tauri child process |
| V2 | The Claude ACP adapter keeps sign-in with the unmodified binary and passes permission prompts through |
| V3 | Codex extension is on Open VSX (needed only for S7) |
| V4 | Pi RPC covers steer, abort, fork and UI requests as documented; write the ACP shim if no maintained one exists |
| V5 | `claude -p` stream-json input mode accepts mid-run user messages (needed if you skip ACP) |
| V6 | Written confirmation from Anthropic sales before any external release that includes Claude |

## 9. Decisions for the owner

1. ACP-first (recommended) or native protocols per harness.
2. Approve the terms: agent host, adapter, agent bar, harness.
3. Include S7 or drop it.
4. Whether the Pi default applies to the cloud worker too, or the worker stays on Claude for now.

## Sources

1. OpenAI, Unlocking the Codex harness: https://openai.com/index/unlocking-the-codex-harness
2. Pi coding agent README: https://app.unpkg.com/@mariozechner/pi-coding-agent@0.68.0/files/README.md
3. Pi RPC and SDK docs: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs
4. Claude Code in VS Code: https://code.claude.com/docs/en/vs-code
5. Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
6. Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
7. Zed external agents (ACP): https://zed.dev/docs/ai/external-agents
8. codex-acp adapter: https://github.com/zed-industries/codex-acp
9. Agent Client Protocol: https://agentclientprotocol.com/overview/introduction
10. Codex IDE extension: https://learn.chatgpt.com/docs/codex/ide
