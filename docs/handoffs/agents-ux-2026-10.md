# Agents UI/UX rework: file claims

Owner: Braden Seaborn. Started 2026-10-25. Worktree `.claude/worktrees/agents-ux`, branch
`worktree-agents-ux`, cut from `origin/main` at `2bd7fca0`.

This session reworks the agent tab and the agent bar from Braden's screenshot feedback. Two other
sessions run at the same time:

- **UI/UX rework to match marketing copy** (local, worktree `.claude/worktrees/veistra-sidebar`):
  shell chrome, sidebar, rail.
- **Rename Veistra to Veistra** (remote, branch `claude/loving-hamilton-nfdkbr`): every
  identifier, including `crates/veistra-agent-host` -> `crates/veistra-agent-host` and
  `apps/agent-tab/ui/src/veistra-show.generated.ts` -> `veistra-show.generated.ts`.

## Claimed by this session

- `apps/agent-tab/**`
- `src/shell/agentbar/**`
- `src/shell/state/agentBar.ts`, `agentSessions.ts`, `agentOpeners.ts` and their tests
- `src/shell/rail/AgentsPage.tsx`, `AgentsPage.test.tsx`, `agentspage.css`
- `src/shell/toolwindow/agentTabFrames.ts`
- `src/agent-tokens.css`
- Backend, for slash commands and `/login`: `crates/veistra-agent-host/src/{event,normalize,session,host}.rs`,
  `src-tauri/src/apps/agent_tab.rs`, `docs/agent-harnesses.md`
- One added line each in `src/bindings.ts` and `src/shell/toolwindow/ToolWindow.tsx`, to relay the
  `agent-tab:login` event to the tab that asked

## Not touched by this session

`src/tokens.css`, `src/shell/rail/Rail.tsx`, `src/shell/frame/**`, the cluster switcher and other
rail pages remain outside the original scope. Braden subsequently requested an Open chat button,
so `WindowRoot.tsx` and `titlebar.css` now include that small addition.

## Rename

The rename changes almost nothing inside the claimed files. This branch rebases onto the rename once
it merges. Until then, new identifiers keep the existing `veistra` spelling, so the rename's search
and replace still catches them.

## Agent composer update, 2026-10-25

All changes remain in this worktree. The settings popup now separates harness selection from
models, orders versions newest first, features the latest family members and the current selection,
and expands older variants with More models. Effort sits beneath models as an animated slider;
only the running model's advertised levels are enabled. Reduced motion stops the animations.

Before the first prompt, an effort choice is passed in `LaunchSpec` and applied after model selection,
before the handshake reports Ready. Unsupported levels leave the agent's reported default intact.
Ultra effort is a Claude-only sixth slider stop: the adapter's `_meta.claudeCode.options.settings`
carries `ultracode`, without writing user or project configuration. It applies to the current session
via `session/resume`, selects supported deep reasoning and preserves model, permission mode, MCP
capabilities and history. New prompts wait for queued settings. Violet animated dots on the slider
and composer follow the supplied reference. Reduced motion retains a static equivalent.

The slash catalogue includes documented Claude builtins, advertised harness commands, and grouped
`/skills` subcommands. Commands unavailable over ACP explicitly open a fresh native CLI terminal.
`/effort ultracode on|off` controls the current conversation. The plus button and @ search use
`refs/search`, with nested Design, project management, other clusters, files, comments and saved
context. Picks appear as removable chips and serialize stable reference URIs. Jira/Linear support
saved context and manual HTTPS issue links; there is no authenticated connector. Dictation has a
button and an intentionally empty callback.

`/btw` opens an independent side session (`<instance>:btw`) with a bounded text snapshot of the main
conversation. Its transcript, stop, clear and approvals are independent, and it can run during the
main turn. It uses the same harness and selected model. Closing the panel hides it; `/btw` reopens
it. The host reaps it with the parent tab, cluster change, reset or app shutdown. No native ACP btw
method exists, so this uses a separate query rather than sending /btw into the main session.

Usage-limit errors use a neutral dismissible card, retain reset information and remove RPC wrappers.
Other errors expose technical details under a disclosure. Duplicate text/error notices in the same
turn render once. The additional backend changes are `harness.rs`, `session.rs`, their tests, and
two write-method entries in `src-tauri/src/apps/mod.rs` for side-session prompts and approvals.

Harness switching now stops the old agent before starting another and transfers bounded context.
The history button persists conversations in app data, scoped to the current worktree and shared
across harnesses. Search, archive/unarchive, reopen, and choosing a continuation harness are wired.
`agent_history.rs` owns storage; `AgentHost::restore` sanitizes restored activity and supplies context
on the next send. Opening history never starts inference. The title bar now has an Open chat button;
the tab header also exposes a side-chat button.
