# Agent 1 — Annotate AI Diffs

Read `00-PRIMARY-CONTEXT.md` in full before this. It has the license,
ground rules, and stack-mismatch guidance that apply to you too.

## Setup

```bash
cd Veistra
git worktree add ../Veistra-annotate-diffs -b feat/annotate-ai-diffs origin/main
cd ../Veistra-annotate-diffs
```

Then read, in order: `CONTRIBUTING.md`, `STANDARDS.md`,
`docs/dev/architecture.md`, `src-tauri/src/git.rs`, `src/shell/diff/`,
`src/shell/worktree/`, `src/shell/contract.ts`.

## The feature

Orca's "Annotate AI Diff": drop a comment on a diff line, ship it back to
the agent, review/edit/commit without leaving the app — CI status,
conflict resolution, and PR creation all live in the same view.

In `/tmp/orca-reference`, find the diff-review / annotation module (search
`src/` for `diff`, `annotat`, `review`). Its comment data model — how a
comment attaches to a line or a hunk, how threads work, how a comment gets
serialized to send back to an agent — is the part worth porting closely; it's
plain frontend state and should adapt cleanly to React in `src/shell/diff/`.
Its backend plumbing (however Orca persists comments, however it talks to
its own agent-runner process) is Electron-specific — redesign that part for
Rust rather than translating it line by line.

## Scope

1. In the existing diff view, let the user attach a comment to a specific
   line or hunk of an uncommitted or agent-produced diff.
2. Persist comments per-project. Veistra already has a per-project state
   location — read "Projects" in `docs/dev/architecture.md` for what
   `.veistra/` already holds and follow that pattern; don't invent a second
   one.
3. Comments must survive a restart, the same way other durable state in this
   app is re-derived on load (see `shell_store.rs` for the existing
   precedent).
4. Give the user a way to get annotated comments out to an agent. Veistra has
   no agent chat pane — the only agent surface is a terminal (PTY) process.
   A "copy to clipboard" or "insert into the active terminal" action is
   correct scope for tonight; do not build a new transport.
5. If you get through 1–4 cleanly and have time left: batch-apply (send
   several comments back at once) and a resolved/unresolved state per
   comment, matching Orca's model, are good next slices — in that order.

## Out of scope

- CI status checking, conflict resolution, and PR creation from within the
  diff view — Orca bundles those into the same screen, we are not doing
  that tonight. Comment-and-send-back only.
- Any new agent-to-app transport or protocol.
- `src-tauri/src/apps/`, `pty.rs`, `src/shell/terminal/`, `src/shell/drag/`
  — another agent owns terminal/drag work tonight; if you need to insert
  text into a terminal, use whatever's already there rather than adding to
  those files. If nothing usable exists yet, fall back to clipboard-only
  and note it in your PR description.
- GitHub/Linear integration — a different agent owns that.
- Design Mode / embedded browser work — a different agent owns that.

## Conventions

- New Tauri commands: `src-tauri/src/commands.rs`, registered in
  `generate_handler!` in `lib.rs`, typed wrapper in `src/bindings.ts`.
- Errors cross the IPC boundary through the existing serializable error type
  in `error.rs` — don't add a second error shape.
- `pnpm verify` clean before opening the PR.
- `cargo clippy` caches diagnostics — if a recheck after a Rust change looks
  suspiciously instant, `cargo clean -p <crate>` first.

## Done means

- Working diff-annotation flow on `feat/annotate-ai-diffs`, `pnpm verify`
  green, PR opened against `main` (not merged).
- PR description covers: what you built, what you deliberately cut and why,
  which Orca file(s) you adapted from (for the attribution header/NOTICE
  entry), and any file outside `diff/`/`worktree/`/your new comments module
  that you had to touch.
