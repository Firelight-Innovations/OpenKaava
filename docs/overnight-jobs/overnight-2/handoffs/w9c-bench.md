# Wave 9c: benchmark scripts and budget nodes — handoff

Scope: two bullets of PRD §17 Wave 9 (`docs/design/SCHEMATIFY-PRD.md`) —
"Declare the 6 budgets in section 14.7 inside Schematify's own `.veistra/`
project, each with its probe command" and "Add the 6 `pnpm bench:*` scripts."
Read §14.7 for the table, §5.10 for the budget facet schema, §6.1 for storage
layout. Built in worktree `sch-w10a-gates`, branch `schematify/w9c-bench`,
off `origin/main` at `e60fa7b` (after wave 7a's linter merged; before wave 8's
search and wave 10a's boundary check). `origin/main` has since merged both,
and this branch has been merged up to `79a42a2` to pick them up — see the
search and boundary-check sections below for what that changed.

## The 6 `pnpm bench:*` scripts

| Script | Status | What it does |
|---|---|---|
| `bench:load` | **real** | Runs `crates/schematify-core/tests/fixtures.rs`'s `the_stress_fixture_loads_inside_the_wave_one_budget` with `--nocapture`, reports the `stress-2000 loaded in N ms` line the test already prints. |
| `bench:lint` | **real** | Runs `crates/schematify-core/tests/lint.rs`'s `the_stress_fixture_lints_inside_the_wave_seven_budget`. That test did not print its elapsed time before this wave — I added one `println!`, matching the convention `fixtures.rs` already used for the load budget, so there was a number to report. |
| `bench:frame` | **real** | Runs `apps/schematify/ui/src/engine/frameBudget.test.ts` via `vitest run --reporter=verbose` (the default reporter hides a passing test's `console.log`). Same story: I added one `console.log` of the median to the existing median-of-21 test. |
| `bench:startup` | **honest stub** | No probe exists. Measuring cold launch to first Schematic paint needs a launched, running application, and CLAUDE.md reserves that for Braden. Prints why and exits 1. |
| `bench:drag` | **honest stub** | No probe exists. Measuring drag-to-write needs a launched application and a simulated drag. Same reason, same shape. |
| `bench:search` | **real** | Wave 8 merged `schematify_search` and `GraphIndex` into the core crate, with `crates/schematify-core/tests/registries.rs`'s `search_returns_a_first_result_inside_the_wave_eight_budget` already asserting the budget. That test measured its elapsed time but only printed it inside the failure message, so a passing run reported nothing to parse — the same gap `lint.rs` had before this wave added its `println!`. Fixed the same way: one `println!("stress-2000 search in {} us", elapsed.as_micros())` ahead of the assertion, and `bench:search` now runs that test through `runProbe` exactly like `bench:load` and `bench:lint`, rather than re-measuring search itself. |

None of the two remaining stubs invents a number. Each prints the budget it is
standing in for and exits 1, so a caller checking only the exit code cannot
mistake a stub for a pass. `scripts/bench-lib.mjs` holds the shared `runProbe`
(spawn the real test, stream its output, pull the number out with a regex,
now with an optional `unit` for `bench:search`'s microseconds) and `stub`
(print and fail) that all six scripts use — one implementation of "read a
budget from its test," not six.

**Why real scripts run the test rather than re-measuring:** the wave brief was
explicit that two implementations of one budget drift, and the test is the one
that gates a wave. Re-timing the loader, the linter, or the engine a second
way in a `.mjs` script would risk exactly that drift, and would also mean the
number `pnpm bench:load` reports could differ from the number that actually
gates Wave 1's acceptance.

## The 6 budget nodes

`crates/schematify-core/self/.veistra/nodes/` — six JSON files, one per row of
the §14.7 table. This is a project directory of its own, a sibling to
`fixtures/` rather than a fourth fixture: §14.7's last paragraph explicitly
distinguishes these six ("Schematify's own project") from the fixture budget
nodes in §16 ("project data," outside this rule). Placing them under
`fixtures/` would have collapsed that distinction.

**Location was silent in every source** (searched the PRD, the baseline
audit, and `apps/README.md`), so I picked the simplest reading and noted it
here per the standing instruction. One thing ruled `.veistra/` at the actual
repository root out: `src-tauri/src/project/marker.rs` already gives `.veistra/`
a different, established meaning in this codebase — the generic trace
directory beside any `<name>.veistra` project manifest Veistra opens — and a
literal `.veistra/` at the repo root would collide with that rather than with
Schematify's own nodes/edges/rules layout.

Each node: `kind: "budget"`, the envelope common to every node, `parent:
null` (project root — no lint rule requires a facet to nest under a
module or service, and inventing a container node just to hold six facets
would be more schema than the task asked for), and the `BudgetFields` of
§5.5/§8: `metric`, `op: "<"`, `value`, `unit`, `tier`, `probe: { command,
parser: "veistra-bench-v1" }`, `sign_off: null`. `authored_by: "agent"` — an
honest provenance record of who wrote the file, not a claim about who decided
the numbers (the PRD did, in §14.7).

Every id is a real UUIDv7 minted through the crate's own `mint_id()` (via a
throwaway test, run once and deleted — not committed), not hand-typed, so the
version and monotonicity the crate's `id.rs` documents actually hold.

**Validated with the crate as authority, not by eye:** a new test,
`crates/schematify-core/tests/self_budgets.rs`, loads this project through
`load_project` and `Node::budget()` and asserts every field against the
§14.7 table by value — metric, value, unit, tier, and the exact probe command
each budget claims. `exactly_one_budget_is_soft_and_the_rest_are_hard` pins
the tier distinction PRD §14.7 calls out by name: "A soft threshold and a
target threshold shall never act as a wave gate." A drifted field, a probe
command that stops matching a real script, or a tier that quietly moved from
hard to soft all fail this test, not just a human reading the JSON.

## The boundary check from the last wave

Thought about this, per the prompt's warning. Every file this wave adds under
`self/.veistra/` is a `nodes/` file — budget facets are node files per §5.5 and
§6.1's layout table ("`nodes/<uuid>.json` — semantic — services, modules,
facets"), not a separate `facets/` tree. Nothing here touches `runs/` or
`layout/`, so `scripts/check-veistra-boundary.mjs`'s rule (which only fires when
one `.veistra` root's diff touches *both* `nodes/` and `runs/`) has nothing to
see. The script merged with wave 10a, after this branch forked, and is now
present here after merging `origin/main`. Run directly —
`node scripts/check-veistra-boundary.mjs --base e60fa7b --head 846b83f` —
it reports `veistra-boundary: clean (18 file(s) changed)`, confirming by
measurement what the by-construction argument above already predicted.

## Verification

Foreground, all green after merging `origin/main`: `pnpm build`, `pnpm test:js`,
`pnpm lint:js`, `pnpm lint:comments`, `pnpm format:check`. Also ran each of
the 6 `pnpm bench:*` scripts directly and read their output: the four real
ones (`load`, `lint`, `frame`, `search`) report a real number and exit 0; the
two remaining stubs (`startup`, `drag`) print their reason and exit 1. See
`## Verification (post-merge)` at the end of this handoff for the exact
numbers.

Background: `cargo test -p schematify-core`, `node scripts/clippy-baseline.mjs`
— see the post-merge section for current counts; the numbers below predate
wave 8's search and wave 10a's boundary check merging in.

**One transient problem, not from this wave's code:** `cargo test --workspace`
failed twice in a row with `schematify_core::lint`, `RuleId`, `RULE_COUNT`
reported as absent from the crate root — which they are not; `lib.rs:56`
still exports all three. A third `cargo test --workspace` run afterward
passed clean, and in between I isolated both crates this wave's changes
touch or sit beside: `cargo test -p schematify-core` (177 tests) and
`cargo test -p veistra-orchestrator --lib` (560 tests) each pass on their
own. Three other Schematify branches were open and pushing at the same time
(#84, #86, #87), and `CARGO_TARGET_DIR` is the shared, warm target directory
every agent in this job was told to point at — the same class of problem the
icon generator hits under a concurrent `pnpm build`, for `cargo` instead.
Isolating the one crate this wave touches is the test that actually answers
whether this wave's
Rust is correct, and it passes. Worth a clean re-run once the other branches
are quiet.

## Assumptions

- `crates/schematify-core/self/.veistra/` is Schematify's own project directory.
  Not named anywhere; picked as the simplest reading that does not collide
  with the repository's other `.veistra/` meaning. If the dashboard or Runs work
  landing in parallel expects a different path, it is a one-directory move —
  nothing else in this wave references the path by string outside the new
  test and the six files themselves.
- `authored_by: "agent"` on all six nodes, since an agent wrote the files,
  even though the numbers themselves come from the PRD.
- `parent: null` on all six — no module/service node was invented to hold
  them.
- No `brief.json` was added to `self/.veistra/` — out of scope for this wave's
  two bullets, and `load_project` handles its absence without error.

## Left undone

- A real `bench:startup` and `bench:drag` need a launched application; that
  is Braden's, not an agent's, per CLAUDE.md. `bench:search` is no longer in
  this list — Wave 8's search index merged, and it is real as of this branch.
- `cargo test --workspace` should be re-run clean once the other open
  Schematify branches are not also building against the shared target
  directory (see above).

## Verification (post-merge)

After merging `origin/main` (wave 8's search, wave 10a's boundary check, and
the wiring/w4-nodes merges) up to `79a42a2`, re-ran everything, foreground:
`pnpm build`, `pnpm test:js` (35 files / 583 tests, plus `packages/bridge`'s
28), `pnpm lint:js` (0 errors, 8 pre-existing warnings unrelated to this
branch), `pnpm lint:comments` (434 files, none over budget), `pnpm
format:check` (prettier and `cargo fmt --check` both clean). Background:
`pnpm test:rust` — clean this time, no repeat of the transient flake noted
above (`schematify-core`: 173 unit + 18 fixtures + 7 lint + 9 registries + 3
self_budgets = 210, all pass; workspace total 658 passed, 1 ignored, 0
failed); `pnpm lint:rust` — `clippy: 0 warnings, none above the baseline of
0`.

All 6 `pnpm bench:*` scripts run directly, output read rather than assumed:

| Script | Real/stub | Printed | Exit |
|---|---|---|---|
| `bench:load` | real | `stress-2000 loaded in 86 ms` → `graph_load_ms = 86 ms` | 0 |
| `bench:lint` | real | `stress-2000 lint in 42 ms` → `full_lint_ms = 42 ms` | 0 |
| `bench:search` | real | `stress-2000 search in 756 us` → `search_first_result_ms = 756 us` | 0 |
| `bench:frame` | real | `dense fixture frame time: median 1.47 ms over 21 samples` → `frame_time_ms = 1.47 ms` | 0 |
| `bench:startup` | honest stub | `cold_launch_ms — NOT IMPLEMENTED` | 1 |
| `bench:drag` | honest stub | `drag_to_write_ms — NOT IMPLEMENTED` | 1 |

Four real, two honest stubs — down from three and three, since `bench:search`
moved into the real column this pass. Neither stub invented a number or
softened its exit code.

## Pull request

`gh pr create --draft --base main --title "Schematify wave 9c: benchmark scripts and budget nodes"`,
to be marked ready with `gh pr ready` once verification is confirmed clean.
