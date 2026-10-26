# Agent 3 — GitHub Native (Issues & PRs)

Read `00-PRIMARY-CONTEXT.md` in full before this. It has the license,
ground rules, and stack-mismatch guidance that apply to you too.

## Setup

```bash
cd Veistra
git worktree add ../Veistra-github-native -b feat/github-native origin/main
cd ../Veistra-github-native
```

Then read, in order: `CONTRIBUTING.md`, `STANDARDS.md`,
`docs/dev/architecture.md`, `src-tauri/src/git.rs` (existing
status/diff/worktree code — reuse its worktree-creation path, don't
duplicate it), `src-tauri/src/settings/`, `src/shell/contract.ts`.

## The feature

Orca's "GitHub & Linear, Native": browse PRs, issues, and project boards
in-app, open a worktree from any task, review without a context switch. We
are doing GitHub only — no Linear.

In `/tmp/orca-reference`, Orca's own changelog groups its worktree, github,
and linear code into modules under `shared/` — start there. The list
UI/UX (how issues and PRs render, how filtering and search work, how
opening a worktree from a task item is triggered) is worth porting closely.
The auth flow and API client are Node/Electron-specific — you're rebuilding
those in Rust, using Orca's as a reference for *what* it does (token
storage, which endpoints it calls, how it maps a repo to its GitHub remote)
rather than code to translate directly.

## Scope

1. **Auth:** a personal access token, entered and stored through Veistra's
   existing settings system (`src-tauri/src/settings/`) — not a new ad hoc
   storage mechanism. No OAuth device flow tonight; a PAT field is enough.
2. **A new region in the shell** listing open issues and PRs for the repo
   the current project is a checkout of. Follow the existing pattern: one
   directory per region under `src/shell/`, built against `contract.ts`,
   same shape as `diff/` or `worktree/`. Determine the repo from git remote
   info — extend `git.rs` minimally if it doesn't already expose that.
3. **Opening an issue or PR creates a worktree for it**, reusing the
   existing worktree-creation code path in `git.rs`. Do not write a second
   worktree-creation path.
4. Use the GitHub REST API (not GraphQL) — simpler auth surface, fewer new
   dependencies. Check `Cargo.toml` for an HTTP client already in the
   dependency tree before adding a new crate.
5. Network failure or rate limit must degrade to a visible "couldn't reach
   GitHub" state — never a crash, never a silently empty list.

## Out of scope

- No Linear integration.
- No writing back to GitHub — no comments, no PR creation, no merging.
  Read-only browse plus worktree-open only, for 0.2.0.
- `src-tauri/src/apps/`, `pty.rs`, `src/shell/terminal/`, `src/shell/drag/`
  — other agents own that tonight.
- `src/shell/diff/` — another agent owns diff annotation tonight (your
  worktree-open flow can *use* the existing worktree/diff surfaces, but
  don't modify them).

## Conventions

- New Tauri commands: `src-tauri/src/commands.rs`, registered in
  `generate_handler!` in `lib.rs`, typed wrapper in `src/bindings.ts`.
- New settings fields go through the schema in `src-tauri/src/settings/` —
  the same generation path every other setting uses. Don't hand-write a
  settings UI row outside that schema.
- The PAT is a secret: never log it, never let it surface in an error
  message that could land in agent traces under `.veistra/`. Check
  `STANDARDS.md` for how the codebase already handles anything
  security-sensitive before inventing your own approach.
- `pnpm verify` clean before opening the PR.

## Done means

- Working GitHub issues/PRs list with worktree-open, on
  `feat/github-native`, `pnpm verify` green, PR opened against `main` (not
  merged).
- PR description covers: what you built, what you left out (especially
  anything cut for auth/API complexity), which Orca file(s) you drew the
  UI/UX pattern from (for attribution), and any file outside your new
  region you had to touch.
