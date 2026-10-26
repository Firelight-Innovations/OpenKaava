# Wave 0 handoff — baseline audit

## What was built

`docs/audits/schematify-baseline.md`, the only file this wave touches besides
this handoff. It runs the baseline audit from PRD section 14.2.

## Acceptance conditions

| Condition | Status |
|---|---|
| Names every path (Tauri crate, front-end workspace, package list) | Done — sections 1–2 |
| Names the tab-strip module and its literal strings | Done — section 3. Traced the actual mechanism: `src-tauri/src/apps/mod.rs`'s `REGISTRY` constant (lines 157–238) holds the strings; `ClusterBar.tsx` only renders a runtime `title` field they seed |
| Records presence/absence of `veistra.toml`, `.veistra`, `veistra-tool://`, `@veistra/*` | Done — section 4. All four present; clarified `veistra.toml` (stack manifest) is not the same thing as `<name>.veistra` (project manifest) |
| Names every `pnpm verify` step, expanded | Done — section 5, plus the comment-density linter's exact thresholds |
| Every occurrence of Forger/Journeyman/forger:// /journeyman:// /@forger: | Done — section 12. `forger://`, `journeyman://`, `@forger:` appear only in the planning docs, never in product code. `Forger`/`Journeyman` (and lowercase) appear in ~180 lines across ~45 product-code and doc files, tabulated by category (apps to delete, registration to remove, generic test placeholders that happen to say "forger", prose needing a rewrite, file/directory names) |
| Reference machine | Done — section 13, via PowerShell CIM queries |
| Conflict with PRD §14.3 reported | Done — section 8 resolves placement per the owner's override; section 11 records the conflicts found |

## Assumptions

1. "Existing conventions win" (00-AGENT-CONTEXT.md) licenses overriding not
   just PRD §14.3's two paths but also §14.4/§14.5's command-registration
   plan. Every existing app dispatches all its methods through one already
   registered `app_call` Tauri command, keyed by JSON-RPC method string —
   there is no per-app `#[tauri::command]`. Recommended Schematify follow
   that: zero new `generate_handler!` lines, zero new `src/bindings.ts`
   entries, all 10 operations become method-string match arms in
   `apps/schematify.rs`'s own dispatch function. See audit section 11.
2. `catalog.toml` needs **no** Schematify entry. It is empty and is the
   *tool* install library; Home, Files and Tutorial have never appeared
   there, and Forger/Journeyman were removed from it when they became
   first-party apps. The task brief's premise that they "appear" there does
   not hold — recorded as a correction, not followed.
3. Single-file vs. directory Rust module for `apps/schematify.rs`: every
   existing app is one file (`design.rs` at 37 KB is the largest), so this
   audit recommends starting as one file and splitting into private sibling
   modules only if it grows past roughly 1,500–2,000 lines — a
   recommendation for whichever wave writes it, not a rule this audit could
   verify against a real example.
4. The Forger/Journeyman occurrence table treats `docs/overnight-jobs/` as
   planning source rather than product code, and counts its hits per file
   instead of listing every line, since Wave 1 has no reason to edit the
   PRD's own inputs.

## Left undone, and why

Nothing in this wave's scope. Wave 0 is audit-only; every other file in the
repository is unchanged, verified by `git status` before the final commit.

## Verification run

- `pnpm install` — clean, in this worktree.
- `pnpm run lint:comments` — 353 files checked, none over limit (this
  worktree's new file is Markdown, outside the linter's scanned roots).
- `pnpm run format:check` — Prettier and `cargo fmt --all -- --check` both
  clean.
- Full `pnpm verify` was not run, per the task brief: this wave's change is
  one Markdown file, so build/test were judged unnecessary and skipped
  deliberately, not overlooked.
