# Overnight 2: Schematify. Agent context (read first)

You are one of several agents building Schematify overnight inside the Veistra
monorepo. No human is available until morning. Do not ask questions. Decide,
record the assumption, and keep going.

## Sources, in precedence order

All in `docs/overnight-jobs/overnight-2/`:

1. `Forger Wireframes.html` (visual and copy truth for 6 screens; open with grep,
   it is a 670 KB single-file design export, search for the screen name)
2. `SCHEMATIFY-PRD.md` (the model, vocabulary, build waves; read section 17 first,
   then the sections your wave names)
3. `FORGER-SPEC.md` (data model)
4. `FORGER-UI.md` (interaction model)
5. `OpenKaava-naming-decision.md` (rename record)

Company standards live outside the repo at `C:/Users/bjsea/Documents/Viestra/company/core/`:
`writing-standard.md`, `terminology.csv`, `decisions/`. Writing there is authorized.

## Overrides to the PRD (the owner decided these)

- **The PRD author did not know this repo. Existing conventions win** over PRD
  section 14.3 paths. Apps live at `apps/<name>/ui` (React, own `index.html`,
  `src/main.tsx`, `src/rpc.ts`) with a Rust side at `src-tauri/src/apps/<name>.rs`,
  registered in `src-tauri/src/apps/mod.rs`, `catalog.toml`, and `vite.config.ts`.
  Read `docs/dev/architecture.md` and `STANDARDS.md` before writing a file. The
  Wave 0 audit at `docs/audits/schematify-baseline.md` records the resolved paths
  once it lands; prefer it when present.
- Crate placement: `crates/schematify-core` and `crates/schematify-reconcile`
  (the `crates/` workspace already exists). Fixtures live at
  `crates/schematify-core/fixtures/` with `generate.mjs` beside them.
- Forger and Journeyman are boilerplate. Wave 1 deletes them outright.
- Autonomous merges to `main` are authorized. An orchestrator reviews and merges.

## Where you work

- One git worktree per wave under `C:/Users/bjsea/Documents/Viestra/code/helve/.worktrees/<name>`,
  on branch `schematify/<name>`. Your prompt names yours. Use absolute paths; do
  not `cd` into the main checkout at `helve/orchestrator` to edit anything.
- First: `pnpm install` in the worktree (about 1 minute, warm store).
- Export `CARGO_TARGET_DIR=C:/Users/bjsea/Documents/Viestra/code/helve/orchestrator/target`
  in every shell that runs cargo, so you share the warm build. Shell state does
  not persist between Bash calls; re-export each time.
- Never run `pnpm app`, `pnpm dev`, `tauri dev`, or `pnpm ui launch`. Never touch
  port 1420. Never kill a process you did not start.

## Commit cadence (non-negotiable)

- Commit after every coherent unit of work, at least every 20 minutes of edits.
  Small commits are the recovery mechanism if something goes wrong.
- Push after every commit: `git push -u origin schematify/<name>`.
- Open a draft PR as soon as your first commit is pushed:
  `gh pr create --draft --title "Schematify wave N: <scope>" --body-file <file>`.
  Mark it ready with `gh pr ready` when done.
- Commit messages: imperative subject, body says why. End with:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

## Verification

`pnpm verify` (build, test, lint, format:check) must pass before you mark the PR
ready. Run it as separate pieces so nothing sits silent for minutes:

- Foreground: `pnpm build`, `pnpm test:js`, `pnpm lint:js`, `pnpm lint:comments`,
  `pnpm lint:version`, `pnpm lint:identity`, `pnpm lint:branding`, `pnpm format:check`.
- Background (Bash `run_in_background`): `pnpm test:rust`, `pnpm lint:rust`.

`pnpm verify:fast` is fine for the inner loop. `pnpm format` fixes formatting.
Never run `pnpm baseline`. Never delete or skip a failing test to make it pass.
The three lint baselines may shrink and may not grow.

## Rules from the PRD that always apply

- Every count drawn on a surface is computed at draw time. Store no count.
- `[W]` items in PRD sections 12 and 13 are truth. `[P]` items are proposals;
  build them unless the wireframe contradicts them.
- Every Tauri command carries an `actor: "human" | "agent"` argument.
- Shared registration files (`src-tauri/src/apps/mod.rs`, `commands.rs`, `lib.rs`,
  `generate_handler!`, `src/bindings.ts`, `vite.config.ts`, `catalog.toml`) are
  touched only when your prompt says so, and minimally.
- No literal hex colors in the Schematify UI. Tokens only (PRD section 13).
- Where every source is silent: pick the simplest reading, note it in your
  handoff file, and continue. Do not stop.

## Handoff

Write `docs/overnight-jobs/overnight-2/handoffs/<name>.md` in your worktree and
commit it with the wave: what you built, each acceptance condition and whether it
passes, every assumption, everything left undone and why. The PR body carries the
same content. Your final message to the orchestrator: PR URL, acceptance summary,
open problems. Keep it under 300 words.
