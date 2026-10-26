# Wave 9d handoff: the Runs tab, the Module dashboard, and run ingestion

Branch `schematify/w9d-surfaces`, worktree `helve/.worktrees/sch-w9d-surfaces`.
Scope: wire `schematify_ingest_run` onto wave 9b's `ingest_run_file`, build
the Runs dock tab, draw status-bar cell 4, and build the Module dashboard
(PRD §12.13) with all 5 counters, every named column, and every section
header. Read `docs/design/SCHEMATIFY-PRD.md` §12.13, §12.1, §5.10, §8, §0.4,
§13, §16.1, §17 Wave 9; `docs/overnight-jobs/overnight-2/WIREFRAME-EXTRACT.md`;
the wave 9b handoff (`handoffs/w9b-runs.md`); and the wave 7b handoff for the
dock-tab and status-bar-cell pattern this wave follows.

## 0. Merged onto `main` after review feedback

`main` moved 3 times after this branch was cut (wave 6/PR #92 — Inspector,
`coversCount` deletion; wave 10b/PR #94 — the `transition` arm and the
human-only gate; wave 7b/PR #91 — Problems panel, already the pattern this
wave followed). Merged `origin/main` in (1 real conflict, in
`src-tauri/src/apps/schematify.rs`'s header doc comment and import list —
the dispatch match, every function body, and the 2 test method-list arrays
auto-merged cleanly), re-verified the merged result end to end (`cargo test
--workspace`, `pnpm typecheck`, `npx vitest run apps/schematify`, clippy,
eslint, prettier, `cargo fmt`), and fixed one thing the review round flagged
as the same defect shape this wave's own surfaces could have carried:

**`Dock.tsx`'s Problems badges drew a guessed `0`/`0`.** `problemBadges(findings
?? [])` computed and drew `{errors: 0, warnings: 0}` both while the first
`schematify/lint` call was in flight and forever on failure — pre-existing
from wave 7b, not introduced by this wave, but directly in the file this
wave already touches for the Runs tab and named as the exact anti-pattern to
avoid. Changed to `findings ? problemBadges(findings) : null`, drawing blank
until real data lands, the same `findings ? … : ""` convention
`StatusBar.tsx`'s cell 3 already uses. This wave's own 2 new surfaces
(`RunsPanel.tsx`, `StatusBar.tsx` cell 4) never had this defect — both
already drew blank on `null`, verified again after the merge.

No `coversCount` usage anywhere in this wave's own files (`ModuleDashboard.tsx`,
`RunsPanel.tsx`, `graph/dashboard.ts`) — nothing here draws a covers count,
so wave 6's consolidation onto `engine/anatomy.ts::coversCountFor` needed no
follow-up. The `ingest-run` arm stays a plain method arm with no lifecycle
gate of its own (it never moves a node's `lifecycle`), so it did not need
wave 10b's human-only enforcement pattern — that gate lives entirely inside
`transition`, untouched by this wave.

One merge-time build hazard, not a code defect: `cargo check` first failed
with `no ingest_run_file in the root` immediately after merging, despite
`lib.rs` visibly re-exporting it — a stale fingerprint in the
`CARGO_TARGET_DIR` shared across every worktree tonight (`cargo clean -p
schematify-core -p veistra-orchestrator` reported "Blocking waiting for
file lock on build directory", confirming concurrent-build contention).
Cleared and rebuilt clean; not a rebase/merge conflict.

**`main` moved a 4th time (PR #97, the atomic-rename flake fix) while the
above was in flight.** Merged again — 0 conflicts this time, a clean
auto-merge. PR #97 added a `manifest_dir()` test helper (reads
`CARGO_MANIFEST_DIR` from the environment first, falling back to the
compile-time value, to survive a test binary reused across worktrees sharing
one `CARGO_TARGET_DIR`) and used it in one existing test in this file; this
wave's own 2 real-fixture tests
(`module_dashboard_against_the_real_fixture_draws_the_16_1_values`,
`list_runs_against_the_real_fixture_finds_the_one_ingested_run`) used the
same raw `env!("CARGO_MANIFEST_DIR")` pattern PR #97 was fixing, so both were
switched to call `manifest_dir()` too, for consistency and so they get the
same protection.

Also added in that review round, addressing 2 things flagged directly: a new
test proving `COUNT` and `SITE` are computed independently rather than
agreeing only by construction (§3), and a stronger, file-named disclosure of
the contract-history rows' non-schema origin (§4).

## 0.1 Second review round: APPROVE-WITH-FIXES — one blocking

Full review came back with 2 findings, 1 blocking. Both are done.

**Blocking, and correctly so: the contract-history fabrication had a real
path into a real project.** §4's `referenceContractHistory(moduleSlug)`
matched on the bare string `"token-verifier"` and drew PRD §16.1's 3 invented
rows whenever it matched. The reviewer traced a live path to it carrying real
data end to end: `RunsPanel.tsx` passes a real backend module id to
`schematify/module-dashboard`, which returns that module's real slug off the
real graph, and `ModuleDashboard.tsx` compared that real slug against the
literal. A real project with a module slugged `token-verifier` — an entirely
ordinary name for an auth service — would have silently drawn this app's own
invented dates and descriptions into that project's own dashboard, exactly
the failure mode a "record of what actually happened" tool must never
produce. **Fixed by removing the fabrication entirely**, not by tightening
the gate: `referenceContractHistory` is now `contractHistory()` (no
parameter — there is nothing left for one to decide), always returns `[]`,
and the table draws empty for every module, including `token-verifier`,
until a real schema exists. See the rewritten §4 below for the full
reasoning and where this leaves a future wave. `apps/schematify/ui/src/graph/dashboard.test.ts`'s
own test for this function now asserts the unconditional empty return
rather than the 2-branch slug match.

**The "agree by construction" claim in the old §3 had no runtime check
behind it — added one.** The reviewer corrupted a `reconcile.json` to claim
`outcome: duplicate` against a run artifact declaring `duplicate: 0` and
found nothing caught it: `module_dashboard` drew `OUTCOME: duplicate, SITE:
"…", COUNT: 0`, a self-contradictory row, silently. Added `countMismatch: bool`
to every `ReconciliationRow` — `true` when the number of `reconcile.json`
entries `reconciliation_rows` actually found for an outcome disagrees with
what the run artifact declared for it. `ModuleDashboard.tsx` now draws a
`▲` beside a mismatched count, in `--kv-warn`, with a `title` explaining why,
plus one summary line under the table when any row mismatches — never a
silent, self-contradictory row again. 2 new/strengthened Rust tests: the
reviewer's own reproduction, pinned verbatim
(`a_reconcile_json_that_contradicts_a_zero_declared_count_is_flagged`), and
the existing independence test now also asserts `countMismatch: true` on its
deliberately-disagreeing row. The real-fixture test now asserts
`countMismatch: false` on all 4 rows too — the runtime proof that this
wave's own 8 authored `reconcile.json` files really do agree with
`run-1184.json`, not just by inspection.

## 1. What was built

### Rust (`src-tauri/src/apps/schematify.rs`) — 3 new dispatch arms

No new `#[tauri::command]` — all 3 are match arms on the existing
`app_call`/`dispatch` path, per the brief.

- **`schematify/ingest-run`** — the Tauri wiring for wave 9b's
  `schematify_core::ingest_run_file`. Takes `{ actor, module, path }`, loads
  the project, opens the `Store`, and calls `ingest_run_file(&graph, &store,
  scope, Path::new(&path))`. Every `CoreError` wave 9b's crate can return
  (`UnknownRunScope`, `RunAnswersNoBudget`, `RunAlreadyIngested`,
  `UnknownRunSchema`) surfaces through the same `core_rpc` mapping every
  other method here already uses.
- **`schematify/module-dashboard`** — shapes PRD §12.13 from the graph: 5
  counters, budget history (with a real, computed sparkline), the
  reconciliation table, and the lifecycle audit log. `module` accepts either
  a node id or a slug — see §3 below for why. Contract change history is
  **not** shaped here; no schema on the graph records one (§4).
- **`schematify/runs`** — S-14's "run number, timestamp, commit, workflow
  file, ingest state," project-wide (undrawn by any wireframe screen, so
  built to the simplest reading of S-14's own 5 nouns). A run's mere
  presence is its ingest state: `ingest_run_file` refuses anything that
  fails its checks before it ever reaches disk, so every row this call
  returns already reads `Ingested`.

26 new/updated Rust tests in `schematify.rs`, including one against the real
committed fixture (`module_dashboard_against_the_real_fixture_draws_the_16_1_values`)
that checks every counter and every reconciliation-row cell against PRD
§16.1's literal values, cell by cell.

### Frontend (`apps/schematify/ui/src/`)

- **`graph/dashboard.ts`** — pure, DOM-free (same convention as
  `graph/problems.ts`): the wire types, and every formatting function the 2
  new surfaces need (`budgetsCounter`/`budgetsNote`, `testsCounter`/
  `testsNote`, `linterCounter`/`linterNote`, `reconciliationCounter`/
  `reconciliationNote`, `latestRunLine`, `relativeTime`/`statusCell4`,
  `shortDate`, `auditTransition`/`auditActorCell`, `budgetThreshold`/
  `budgetLatestValue`, `signOffCaption`, `noProbeCaption`,
  `referenceContractHistory` — see §4). 26 unit tests, all against the
  §16.1 reference values.
- **`graph/backend.ts`** / **`graph/index.ts`** — `fetchModuleDashboard`,
  `fetchRuns`, `ingestRun`, the 3 new `invoke` calls, alongside the existing
  6. `backend.ts` stays the only file in this app allowed to contain
  `invoke`.
- **`shell/RunsPanel.tsx`** — the Runs dock tab: `RUN`, `MODULE`, `WHEN`,
  `COMMIT`, `WORKFLOW`, `INGEST STATE` columns, a clickable row opening that
  run's module dashboard.
- **`shell/Dock.tsx`** — `Runs` tab now draws `RunsPanel` instead of Wave
  2's placeholder text.
- **`shell/StatusBar.tsx`** — cell 4 now draws `statusCell4(latestRun)`
  (`run #1184 · 2h ago`), blank with no run, same "no invented placeholder"
  rule cell 3 already follows.
- **`shell/ModuleDashboard.tsx`** — the dashboard itself: header (breadcrumb,
  `READ ONLY · THE RECORD OF WHAT HAPPENED`, the elided `runsPath`), the 5
  counter cards, a budget-history section (a real, computed SVG sparkline
  per budget — threshold line plus the latest measured point, or the
  "No probe declared" caption for `cold_start_p95`), the reconciliation
  table (a `▲` and a summary line when `countMismatch` fires on any row —
  §0.1, §3), the contract change history section (always empty — §4), and
  the lifecycle audit log with its own human-only-transition footnote.
- **`App.tsx`** — fetches `schematify/runs` once per app mount (same
  "project-wide, not per tier" reasoning as `schematify/lint`), opens the
  dashboard from a Runs row or the Module Schematic's own new `Module
  dashboard` header button, and renders `ModuleDashboard` as a full overlay
  over `.kv-shell` (`position: absolute; inset: 0`) rather than a 4th tier —
  it is a read-only record, not a Schematic.

## 2. Acceptance conditions

| Condition | Result |
|---|---|
| The dashboard holds no editable control | **Pass, by construction.** `ModuleDashboard.tsx` and its 2 child components contain exactly 1 interactive element, the `← Back` button, which navigates away and writes nothing. No `<input>`, `<select>`, `<textarea>`, or `contentEditable` element anywhere in the component. Verified by reading the render tree — this app's test suite is DOM-free (`vitest.config.ts`: `environment: "node"`), the same standard wave 7b's own "both badges stay visible" condition used, so a human should still confirm on screen (§6). |
| The actor column names human or agent on every row | **Pass.** `auditActorCell` draws `{actorName} · human` or `◇ agent · {actorName}` — the 2 differently-*ordered* forms WIREFRAME-EXTRACT.md §6.1 transcribes, not a single template. Unit-tested against both forms. |
| Every counter and every column cell draws the §16.1 value | **Pass for every counter and column this wave computes**, proven against the real fixture, not a hand-typed stand-in: `module_dashboard_against_the_real_fixture_draws_the_16_1_values` (Rust) asserts `budgets` 2/3 (1 hard budget missing a probe), `tests` 5/7 (1 failing, 1 unlinked), `linter` 14 rules/0 violations, `reconciliation` 7/8 (1 declared absent), all 4 reconciliation rows including the exact `SITE` text and `countMismatch: false` on each (§3), and the 5 most recent audit rows. **One named exception**: the `CONTRACT CHANGE HISTORY` table's 3 §16.1 rows are not produced — §4 explains why drawing them was reverted as a real defect, not a shortcut kept. |
| A duplicate marker token produces an error and exit code 1 | Not this wave's to prove — `crates/schematify-reconcile`'s own `cli_reconcile.rs::duplicate_marker_token_exits_1` (wave 9a) already covers it; this wave adds no CLI behavior. |

## 3. The reconciliation table's `SITE` column — the one real design decision

`ReconcileResult` (wave 9b, `crates/schematify-core/src/run.rs`) carries only
4 counts — `matched`, `declared_absent`, `present_unknown`, `duplicate` — no
site information, so it answers the `COUNT` column but nothing else.
`SITE` (`src/auth/verifier.ts +3 more`, `skew_window — no marker`) can only
come from `crates/schematify-reconcile`'s own per-node `reconcile.json`
files (PRD §9.3), and the fixture had none — `veistra reconcile` has never run
against `fixtures/saas-backend/`, and it has no real source tree to scan
against anyway (`src/auth/verifier.ts` is fictional, invented for the
wireframe).

Per this job's own §0.4 hazard note — *"If the fixture lacks the items
behind a count, synthesize the items rather than storing the number"* — this
wave added 8 real `reconcile.json` files to the committed fixture (7
`matched`, 1 `declared_absent`, matching the module's own children: the
module itself, its 2 linked contract-methods, 2 linked test-cases, and its 2
child modules matched; `skew_window` declared-absent), in the real
`schematify-reconcile` on-disk shape (`NodeReconcileFile`/`ReconcileOutcome`,
verified against `crates/schematify-reconcile/src/report.rs` and
`outcome.rs`). `module_dashboard`'s new `reconciliation_rows` function reads
every one of these back at draw time (module plus its direct children, same
"direct children of scope" boundary wave 9b's own `ingest_run` already drew
for budgets) and computes `SITE` as "first distinct file, `+N more`" — never
a stored string. `COUNT` still comes from the run artifact's own
`ReconcileResult`, not from counting these files, so the 2 sources agree by
construction rather than by accident — and, as of §0.1's review round, that
agreement is checked at runtime, not just claimed: each row carries
`countMismatch`, `true` whenever the number of `reconcile.json` entries
found disagrees with the run artifact's own declared count for that
outcome, drawn in the UI as a `▲` beside the count rather than left silent.

**This is the one place a reviewer should look hardest.** The `reconcile.json`
files are hand-authored evidence, the same category `run-1184.json` and
`audit.json` already are in this fixture — not a live `veistra reconcile` run
against real code. If that reads as manufacturing evidence rather than
recording it, the alternative (leave `SITE` at `—` for a fixture with no real
reconciliation data) is one line to switch to: drop the 8 new files and
`first_and_overflow` degrades to `—` for every row, honestly, with `COUNT`
still correct.

**The independence of `COUNT` and `SITE` is asserted, not just true by
construction.** `reconciliation_count_and_site_are_computed_independently_and_can_visibly_disagree`
(`src-tauri/src/apps/schematify.rs`) builds a synthetic project where a run
artifact declares `matched: 5` but only 1 real `reconcile.json` file exists
on disk, naming 1 file. The test asserts `reconciliation.matched` still
reads `5` (from the run artifact, untouched by the evidence gap) and `SITE`
still reads only the 1 real file (not `+4 more`, which would mean `SITE` had
started fabricating itself from `COUNT`). Broken on purpose to confirm it
can fail — flipped the expected count to `1`, watched it panic with `left:
Number(5), right: 1`, reverted — see §8.

## 4. Contract change history — unreachable for every module, on purpose

PRD §12.13's 4th table (`CONTRACT CHANGE HISTORY`) has no backing schema
anywhere in `crates/schematify-core`: `AuditRow` records a lifecycle
*transition*, never the edit that motivated one, and a `contract-method`
node keeps only its current fields, overwritten on every edit (PRD §6.1's
"one node per file"). There is nothing on the graph to compute this table
from, and inventing a change-log schema mid-wave is a crate decision this
wave did not make unilaterally.

**This section originally drew PRD §16.1's 3 example rows for a module
slugged `token-verifier`. §0.1 records why that was wrong and pulled: the
gate was a bare string match on a real, id-driven RPC path
(`RunsPanel.tsx` → `schematify/module-dashboard` → the module's real slug),
so any real project with a module of that ordinary name would have had this
app's own invented history silently drawn into its own dashboard.** The
fix is not a better gate — it's removing the fabrication. The exact source
is `apps/schematify/ui/src/graph/dashboard.ts`, function `contractHistory()`
(no parameter): it always returns `[]`, for every module, including
`token-verifier`, and `ModuleDashboard.tsx` draws the honest empty-state
message in every case. No crate, no RPC call, and no fixture file backs
this table, and nobody should read its emptiness as this wave having missed
something in the fixture — the table is unreachable by design until a real
schema exists. **Flagged for whoever owns `crates/schematify-core`'s schema
next**: a real fix needs either a `contract_history: Vec<...>` field
somewhere durable, or a derivation from a 2nd source (e.g., git blame on the
node file) neither this wave nor any already-merged wave has built. §16.1's
3 rows remain unproven against this table specifically — a genuine, honestly
reported gap in "every counter and every column cell draws the §16.1 value"
(§2), the one cell this wave could not make true without inventing schema.

## 5. Assumptions, all recorded because a source was silent

1. **`schematify/module-dashboard` accepts a node id or a slug.** The Module
   Schematic's own engine (`apps/schematify/ui/src/graph/module.ts`) is a
   hand-typed stand-in with no real backend uuid — wave 7b's own handoff
   §6/§7 already recorded this as a pre-existing gap, not this wave's to
   close. Resolving `module` by slug when it does not parse as a uuid lets
   the `Module dashboard` button work today for `token-verifier` without
   waiting on that gap to close.
2. **Status bar cell 4 is project-wide**, reading `schematify/runs`' newest
   row rather than a per-tier run. PRD §12.1 draws `run #1184 · 2h ago` on
   the Service Schematic's status bar, but neither the Stack nor the Service
   Schematic names one single module a run could belong to — the same
   ambiguity cell 3's own project-wide lint scope already resolved one way.
3. **The sign-off caption's lead-in sentence** (`Twelve runs of monotonic
   climb.`) is drawn as fixed UI copy, not computed — the reference fixture
   only ever ingests 1 run per node (`fixtures.rs`:
   `assert_eq!(runs.len(), 1)`), so there is no real run count to state.
   `signOffCaption` draws the graph-derived half (`Sign-off named: {signOff}.`)
   for real and treats the flourish the same way `"Errors first · never
   hidden"` is treated elsewhere in this app — always-drawn copy, not a
   claim about data.
4. **The budget sparkline is a single point**, for the same 1-run-per-node
   reason — a real multi-run trend line has nothing to draw from in this
   fixture. The threshold line and the one measured point are both real,
   computed numbers.
5. **The Module Schematic's header gained a `Module dashboard` button**,
   `[P]` per PRD §12.1 ("carries... a `Module dashboard` control"), placed
   in the existing chrome row rather than a redesigned tier-specific header
   — a fuller Module-tier chrome overhaul (no search field, no Auto-sort,
   `Pre-fill with agent`) is Wave 5/10 territory this wave did not touch.

## 6. What a human must check by eye

No browser was available this wave. Everything below is unverified on
screen.

1. **The Module dashboard itself** — open the Module Schematic on
   `token-verifier` and click `Module dashboard`: the 5 counter cards should
   read `2 / 3` / `1 hard budget has no probe`, `5 / 7` / `1 failing · 1
   unlinked`, `0` / `14 rules · 0 violations`, `7 / 8` / `1 declared,
   absent`, and the header should read `runs/0192f4a1-…-` — actually the
   real elided uuid for `token-verifier`, not the wireframe's own example
   uuid (§16.1 draws a different, illustrative uuid than the fixture's real
   one; this wave draws the real one, correctly).
2. **The reconciliation table** — confirm all 4 rows, especially the `SITE`
   cells: `src/auth/verifier.ts +3 more` and `skew_window — no marker`. On
   this fixture, confirm no `▲` mismatch marker is drawn on any row (the
   authored evidence agrees with `run-1184.json` by design — §0.1, §3) and
   no summary line appears under the table.
3. **The budget history sparklines** — 2 real charts (`verify_p95`,
   `jwks_refetch_rate`) and 1 "No probe declared" caption
   (`cold_start_p95`), no chart drawn for the last.
4. **The contract change history section** — confirm it draws the empty-state
   message ("No contract change history recorded yet…"), not the wireframe's
   3 example rows — §4 records why drawing them was reverted as a real
   defect.
5. **The `← Back` button** returns to the Module Schematic cleanly.
6. **The Runs dock tab** — 1 row, `#1184`, `Token Verifier`, `2026-08-25
   14:02Z`, `4f2c9ab`, `ci/verify.yml`, `Ingested`; clicking it should open
   the same Module dashboard.
7. **Status bar cell 4** on the Service Schematic — `run #1184 · 2h ago`
   (or the real elapsed time from whenever this is checked), blank before
   the first `schematify/runs` call resolves.
8. **No editable control anywhere on the dashboard** — the acceptance
   condition this wave can only assert by reading code (§2); a human glance
   is the actual proof.

## 7. Left undone, on purpose

- Contract change history's real schema — §4.
- The known Module-tier backend-loading gap (wave 7b §6/§7) — the
  `Module dashboard` button works around it by slug, but the Module
  Schematic itself still draws stand-in content, not the real graph.
- A fuller Module-tier header (no search/auto-sort, `Pre-fill with agent`) —
  out of this wave's named scope.
- No visual/pixel verification of any kind — §6.

## 8. Verification

| Step | Result |
|---|---|
| `cargo test -p veistra-orchestrator schematify::` | 35 passed |
| `cargo test --workspace` | All passing (the "known false failures" the brief warned about are not present in this run — already fixed elsewhere) |
| `cargo clippy --workspace --all-targets -- -D warnings` | 0 warnings above baseline |
| `cargo fmt --all -- --check` | Pass |
| `npx vitest run apps/schematify` | 338 passed |
| `npx eslint apps/schematify/ui/src/` | 0 problems |
| `npx prettier --check apps/schematify/ui/src/` | Pass |
| `node scripts/check-comments.mjs` | 455 files checked, none above limit |
| `pnpm verify:fast` | Pass |
| `pnpm verify` (full) | Pass, exit code 0, run against the merged tree (`origin/main` merged twice — §0) — the last run before this PR was marked ready |

Tests broken on purpose and confirmed to fail, then restored:

- `budgetsNote`'s pluralization (`graph/dashboard.test.ts`'s first case) —
  hardcoded the `s` suffix, reran, watched it fail with `"1 hard budgets has
  no probe"` vs. the expected `"1 hard budget has no probe"`, reverted.
- `ingest_run_refuses_a_second_ingestion_at_the_same_run_number`
  (`src-tauri/src/apps/schematify.rs`) — flipped `is_err()` to `is_ok()`,
  reran, watched it panic at the assertion, reverted.
- `reconciliation_count_and_site_are_computed_independently_and_can_visibly_disagree`
  (`src-tauri/src/apps/schematify.rs`, added in the 1st review round — §3) —
  flipped the expected `matched` count from `5` to `1`, reran, watched it
  panic with `left: Number(5), right: 1`, reverted.
- `a_reconcile_json_that_contradicts_a_zero_declared_count_is_flagged`
  (`src-tauri/src/apps/schematify.rs`, added in the 2nd review round — §0.1)
  — temporarily removed the `countMismatch` field from `ReconcileRow::to_value`
  (reverting to the pre-fix shape), reran, watched it panic on `left: Null,
  right: true` (the field missing from the JSON entirely), reverted.

`pnpm baseline` was never run. No test was deleted or skipped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016X8PJJ3xTD4BTuNBLSJyTQ
