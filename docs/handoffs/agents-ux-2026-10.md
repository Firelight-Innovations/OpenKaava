# Agents UI/UX rework: file claims

Owner: Braden Seaborn. Started 2026-10-25. Worktree `.claude/worktrees/agents-ux`, branch
`worktree-agents-ux`, cut from `origin/main` at `2bd7fca0`.

This session reworks the agent tab and the agent bar from Braden's screenshot feedback. Two other
sessions run at the same time:

- **UI/UX rework to match marketing copy** (local, worktree `.claude/worktrees/veistra-sidebar`):
  shell chrome, sidebar, rail.
- **Rename OpenKaava to Veistra** (remote, branch `claude/loving-hamilton-nfdkbr`): every
  identifier, including `crates/kaava-agent-host` -> `crates/veistra-agent-host` and
  `apps/agent-tab/ui/src/kaava-show.generated.ts` -> `veistra-show.generated.ts`.

## Claimed by this session

- `apps/agent-tab/**`
- `src/shell/agentbar/**`
- `src/shell/state/agentBar.ts`, `agentSessions.ts`, `agentOpeners.ts` and their tests
- `src/shell/rail/AgentsPage.tsx`, `AgentsPage.test.tsx`, `agentspage.css`
- `src/shell/toolwindow/agentTabFrames.ts`
- `src/agent-tokens.css`
- Backend, for slash commands and `/login`: `crates/kaava-agent-host/src/{event,normalize,session,host}.rs`,
  `src-tauri/src/apps/agent_tab.rs`, `docs/agent-harnesses.md`
- One added line each in `src/bindings.ts` and `src/shell/toolwindow/ToolWindow.tsx`, to relay the
  `agent-tab:login` event to the tab that asked

## Not touched by this session

`src/tokens.css`, `src/shell/rail/Rail.tsx`, `src/shell/WindowRoot.tsx`, `src/shell/frame/**`, the
title bar, the cluster switcher and every other rail page. If a change needs one of these, it is
asked for here first.

## Rename

The rename changes almost nothing inside the claimed files. This branch rebases onto the rename once
it merges. Until then, new identifiers keep the existing `kaava` spelling, so the rename's search
and replace still catches them.
