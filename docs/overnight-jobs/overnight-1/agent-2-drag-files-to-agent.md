# Agent 2 — Drag Files to Agents

Read `00-PRIMARY-CONTEXT.md` in full before this. It has the license,
ground rules, and stack-mismatch guidance that apply to you too.

## Setup

```bash
cd Veistra
git worktree add ../Veistra-drag-to-agent -b feat/drag-files-to-agent origin/main
cd ../Veistra-drag-to-agent
```

Then read, in order: `CONTRIBUTING.md`, `STANDARDS.md`,
`docs/dev/architecture.md`, `src-tauri/src/pty.rs`, `src/shell/terminal/`,
`src/shell/drag/`, `src/shell/contract.ts`.

## The feature

Orca's "Drag Files to Agents": VS Code's editor with autosave everywhere,
drag files or images straight into an agent's prompt.

**This is the feature most affected by the stack mismatch — read carefully
before you start copying anything.** Orca has a docked agent chat pane, so
"into an agent's prompt" means a literal text input it controls. Veistra has
no such thing (see `docs/dev/architecture.md` — no tool is docked yet, no
agent broker exists). The only place an agent runs in Veistra today is as a
CLI process inside a terminal in the terminal band. Do not try to build a
docked chat pane tonight to make Orca's exact model fit — that's a much
bigger feature than this one and isn't your scope. Adapt the *goal* (get a
file reference into whatever the agent is reading from), not Orca's literal
mechanism.

In `/tmp/orca-reference`, the drag-and-drop handling and file-explorer code
(search `src/` for `drag`, `file-explorer`, `editor`) is worth reading for
the interaction pattern — visual affordance on drag-over, multi-file
handling, path formatting — even though the destination is different here.

## Scope

1. Dragging one or more files from Veistra's Files app (or the OS file
   explorer) onto an active terminal tab inserts the file path(s), quoted
   correctly for the shell in use, at the terminal's current input
   position. Insert text only — never execute anything.
2. Multi-file drag: space-separated, correctly quoted paths.
3. Visible drop-target affordance while dragging over the terminal band.
   Check `src/shell/drag/` for the drag-and-drop pattern already used
   elsewhere in the shell and reuse it — don't invent a second one.
4. If time allows: dragging an image file inserts its path the same way
   (not raw bytes — Veistra has no way to know what agent or CLI tool is
   running in a given terminal, so a path is the safe, general answer).

## Out of scope

- No docked agent chat pane, no agent-aware protocol, no attempt to detect
  what's running inside a given terminal. The terminal should stay agent-
  agnostic.
- `src/shell/diff/`, `src/shell/worktree/` — another agent owns diff
  annotation tonight.
- `src-tauri/src/apps/` — another agent owns the Design Mode app surface.
- GitHub/Linear integration.

## Conventions

- New Tauri commands: `src-tauri/src/commands.rs`, registered in
  `generate_handler!` in `lib.rs`, typed wrapper in `src/bindings.ts`.
- `pnpm verify` clean before opening the PR.
- `cargo clippy` caches diagnostics — `cargo clean -p <crate>` if a recheck
  looks suspiciously instant after a Rust change.

## Done means

- Working drag-to-terminal flow on `feat/drag-files-to-agent`, `pnpm
  verify` green, PR opened against `main` (not merged).
- PR description covers: what you built, what you left out, which Orca
  file(s) you drew the interaction pattern from (for attribution), and any
  file outside `terminal/`/`drag/`/`pty.rs` you had to touch.
