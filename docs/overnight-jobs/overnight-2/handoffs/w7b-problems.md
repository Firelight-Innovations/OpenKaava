# Wave 7b handoff — the Problems panel and status-bar cell 3

Branch `schematify/w7b-problems`. The interface half of PRD wave 7; wave 7a
(`crates/schematify-core/src/lint.rs`, PR #83) built the linter rules and the
`Finding`/`LintReport` type this wave draws.

## 1. What changed in the crate, and why this wave touched it at all

The task brief said not to rebuild L01–L13, and this branch doesn't — every
rule function in `lint.rs` is untouched. Two fields were **added** to the
wire types the rules already produce, because the existing shape did not
carry what the panel needs and the alternative was the panel inventing it:

- **`Finding.rule_name: String`** — `Finding.rule` serializes to its bare
  code (`"L02"`, since `RuleId` has no `rename_all`), never the `RULE`
  column's drawn text. `RuleId::name()` exists but is a Rust method, invisible
  over JSON-RPC. Without this field the panel would need its own copy of PRD
  §10.4's 13-row table to turn a code back into a name — exactly the "second
  definition that drifts" `lint.rs`'s own header warns against. Populated
  once, in `Finding::new`.
- **`Location::Service.slug` / `Location::Module.slug: String`** — the
  frontend's own tier-open seam (`engine/navigation.ts`'s `configFor`) keys a
  Service or Module Schematic *instance* by slug, not by id. `Location`
  already carried `id`/`title` "so the cell renders without the graph"; slug
  is here for the identical reason, so a panel can navigate without fetching
  the whole graph a second time to resolve one. Populated in `location_of`,
  the single function that constructs both variants.

Both are strictly additive. `grep`-verified before touching anything: only
`Finding::new` constructs a `Finding`, and only `location_of` constructs
`Location::Service`/`Location::Module` — so no other call site, in this crate
or `src-tauri/`, needed updating. Every existing Rust test still passes
unmodified (see §5); none read a `Location` variant by literal field access,
only through `.cell()`/`.schematic()`.

**`schematify/lint`** (`src-tauri/src/apps/schematify.rs`) was already wired
by the `wiring` wave — `lint_graph` calls `schematify_core::lint` and
serializes the whole `LintReport` verbatim. Nothing in that function changed;
the 2 new fields ride through `serde_json::to_value` for free.

## 2. What was built, `apps/schematify/ui/src/`

- **`graph/problems.ts`** — pure, DOM-free (same convention as
  `graph/navigation.ts`... `engine/navigation.ts`): the wire types
  (`RawFinding`, `RawLintReport`), the camelCased `Finding`/`Location`,
  `projectFindings`, `severityGlyph`/`severityWord`, `locationCell` (mirrors
  `Location::cell()`), `problemBadges`, `statusCell3`, `subjectId` (parses the
  uuid off a `schematify://` reference), `drillTargetForLocation`, and
  `resolveClickThrough` — the tested decision behind PRD §12.14's "each row
  navigates to the offending node on the correct Schematic": already-open ⇒
  select only; elsewhere ⇒ navigate and select once the new Schematic opens.
- **`graph/backend.ts`** — `fetchLintReport()`, the one new `invoke` call,
  alongside the existing 5. Still the only file in this app allowed to
  contain `invoke`.
- **`graph/index.ts`** — re-exports `problems.ts` and adds `fetchLintReport`
  through the same lazy `import("./backend")` the seam already uses, so a
  plain-Node test of this module still never touches `window`.
- **`shell/ProblemsPanel.tsx`** — the 4 columns, severity glyph + word, a
  blank-row break between severity groups (drawn from the backend's own
  order — errors already sort above warnings, so this never re-sorts), and a
  clickable row wherever `drillTargetForLocation` names a Schematic.
- **`shell/Dock.tsx`** — now a real tab switcher (was inert). Draws the
  `Problems`/`Runs`/`Registries`/`Rules` tabs, the 2 badges on `Problems`, a
  collapse toggle, and `ProblemsPanel` under the active tab; `Runs` and
  `Registries`/`Rules` keep Wave 2's placeholder text, Waves 8/9's to fill.
- **`shell/StatusBar.tsx`** — cell 3 now draws `statusCell3(findings)`
  (`3 errors · 2 warnings`), blank while the first `schematify/lint` call is
  in flight rather than a guessed `0 errors · 0 warnings`. Cell 4 stays
  Wave 9's.
- **`App.tsx`** — fetches `schematify/lint` once per app mount (findings are
  project-wide, not tier-scoped — re-fetching per tier switch would be both
  wasteful and pointless), and `handleSelectFinding` wires
  `resolveClickThrough`'s answer to the 2 things App already owns: `setPath`
  (Wave 5's own tier-navigation array) for `navigate`, and a
  `pendingSelectRef` applied once the newly-opened engine exists, or
  `engine.select([...])` directly when already on the right Schematic.

## 3. Acceptance conditions

| Condition | Result |
|---|---|
| `fixtures/saas-backend/` produces the 5 rows of PRD §16.1, same rule names, node cells, location cells, asserted from a Rust test against the real fixture | **Pass, pre-existing.** `crates/schematify-core/tests/lint.rs::the_wireframe_fixture_draws_the_five_rows_the_problems_panel_draws` — wave 7a's own test, unmodified and still passing after this wave's 2 additive fields (reverified, see §5). This wave adds no 2nd, hand-typed TS stand-in of those 5 rows — `problems.test.ts` uses its own small literal fixtures to test the *projection and formatting functions*, never restates the reference fixture's 5 rows as expected output. |
| Errors sort above warnings | **Pass, pre-existing.** `crates/schematify-core/tests/lint.rs::errors_sort_above_warnings_in_the_wireframe_fixture`, unaffected by this wave. `ProblemsPanel.tsx` never re-sorts — see §2. |
| Both badges stay visible on the collapsed strip | **Pass, by construction.** `Dock.tsx`: the badge-carrying tab row (`.kv-dock__tabs`) sits outside the `{collapsed ? null : (...)}` block that the collapse toggle hides — collapsing removes the note line and the panel, never the tabs or badges. No DOM renderer exists in this app's test suite (`vitest.config.ts`: `environment: "node"`), so this is verified by reading the render tree, the same standard every prior wave's "click-to-drill... logic only" rows used — a human should confirm on screen (see §6). |

## 4. Tests, and which were made to fail on purpose

**14 new tests, `apps/schematify/ui/src/graph/problems.test.ts`.** Every pure
function in `problems.ts` — `projectFindings`, `severityGlyph`/`severityWord`,
`locationCell` (all 5 surfaces), `problemBadges`/`statusCell3`,
`subjectId`, `drillTargetForLocation` (all 5 surfaces), and
`resolveClickThrough` (already-open, cross-tier, same-tier-different-instance,
and the null case).

**Broken on purpose: `locationCell`'s test.** Changed the `service` case to
return `location.title` alone (dropping the `"Stack › "` prefix), reran
`npx vitest run apps/schematify/ui/src/graph/problems.test.ts`, watched it
fail with the exact wrong string (`"Auth Service"` vs. expected
`"Stack › Auth Service"`), then reverted. Recorded in the wave 7b commit
message per the task's own rule.

No other test in this wave was a serious candidate for "cannot fail" —
`resolveClickThrough`'s 4 cases each assert a different shape
(`{select}` vs. `{navigate, select}` vs. `null`), and `problemBadges` is
checked against both a mixed count and an empty one, so a wrong filter or an
off-by-one in either would already fail one of them without a deliberate
break needed to prove it.

**Rust**: no rule logic changed, so no new Rust test was written for a rule.
The 2 additive fields are exercised implicitly by every existing `lint.rs`
and `tests/lint.rs` test that constructs or reads a `Finding`/`Location` —
all reverified passing after both additions (`cargo test -p schematify-core
-p veistra-orchestrator lint`, then the full `cargo test --workspace`).

## 5. Verification

| Step | Result |
|---|---|
| `cargo test -p schematify-core -p veistra-orchestrator lint` (after `slug`) | Pass |
| `cargo test -p schematify-core -p veistra-orchestrator lint` (after `rule_name`) | Pass |
| `cargo test --workspace` | Pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | Pass, 0 warnings |
| `cargo fmt --all -- --check` | Pass (1 formatting fix applied and reverified) |
| `npx tsc` (typecheck, via `pnpm run typecheck`) | Pass |
| `npx vitest run apps/schematify` | Pass — 265 tests (was 251 before this wave) |
| `npx eslint` on every touched file | Pass, 0 errors, 0 warnings |
| `npx prettier --check` on every touched file | Pass (1 formatting fix applied and reverified) |
| `node scripts/check-comments.mjs` | Pass, 0 above limit, 0 grandfathered (1 file trimmed under the 20-line run cap before this line was true) |

`pnpm baseline` was never run. No test was deleted or skipped. The full
`pnpm verify` (not just its pieces above) is the last step before this PR is
marked ready — see the PR itself for that run's result if this line predates
it.

## 6. What a human must check by eye

No browser was available this wave (`00-AGENT-CONTEXT.md` forbids
`pnpm dev:agent`/`pnpm ui launch`/`pnpm app` for this job). Everything below
is unverified on screen:

1. **The Problems panel itself**, open Schematify on `auth-service` (the
   default landing view): the dock's `Problems` tab should be active by
   default, its badge pair should read `3` and `2` against the real project
   (`fixtures/saas-backend/`, once a real `.veistra/` project is open — the
   panel currently draws against whatever `schematify/lint` answers for
   whatever project is open in the cluster), 5 rows in 2 groups (3 errors,
   a blank-row break, 2 warnings), each row's `SEVERITY` cell reading
   `● ERROR`/`▲ WARN` in the error/warn accent colors.
2. **The collapse toggle** (`▾`/`▴` button, right end of the tab row) —
   confirm clicking it hides the note line and the panel while the tab row
   and both badges stay drawn, and confirm the collapsed strip's height
   (28 px, `[P]`, this wave's own invented value — no wireframe draws it)
   reads as a strip rather than a half-collapsed dock.
3. **A Problems row click**, on a row whose location is `Stack › Auth
   Service` (rows 1, 3, 4 of the reference fixture) — the app should stay on
   the currently-open Schematic (or navigate to the Stack Schematic if a
   different one is open) and the offending node should end up selected.
   **Known gap, not this wave's to close**: `graph/backend.ts`'s real seam
   (`loadRealGraph`) does not yet honor the `tier`/`slug` arguments
   `schematify/load-graph` is called with — it always projects
   `auth-service` regardless — so navigating to the Stack or Module
   Schematic through the real backend currently opens an empty canvas rather
   than real content. This predates this wave (wave 5 built the Stack/Module
   tier UI against hand-typed stand-in fixtures in `graph/stack.ts`/
   `graph/module.ts`, not the real loader) and is outside this wave's named
   scope (Problems panel + status-bar cell 3). A `Stack › <service>`-location
   row (3 of the reference fixture's 5) navigates to a real Service
   Schematic for any service slug the project holds — `project.ts`'s
   `projectServiceGraph` is already generic, not hardcoded to `auth-service`
   — so that half works fully today; only the Module-location row (row 2,
   `› Token Verifier`) hits the gap. The click-through *decision*
   (`resolveClickThrough`) is fully implemented and unit-tested regardless of
   this gap; only the tier-loading half of what it navigates *to* is
   incomplete, and it was incomplete before this wave started.
4. **Status bar cell 3** — confirm it reads `3 errors · 2 warnings` against
   the reference fixture, blank (not `0 errors · 0 warnings`) for the instant
   before the first `schematify/lint` call resolves.
5. **A failed `schematify/lint` call** (e.g., no project open) — confirm the
   Problems panel draws its error text in place of the table, and status bar
   cell 3 stays blank rather than drawing stale or zeroed counts.

## 7. Assumptions, all recorded because a source was silent

1. **The dock's default state is expanded, and the collapse trigger is a
   chevron button.** No wireframe screen draws the collapsed state or names
   how to reach it (all 6 are captioned "problems open"). `[P]`.
2. **The collapsed strip's height is 28 px.** Invented — tall enough for one
   row of tabs, nothing named by any source. `[P]`.
3. **Severity groups are separated by 1 blank row**, not a header or a
   divider line — the simplest reading that still reads as 2 groups without
   inventing new copy. `[P]`.
4. **`schematify/lint` is fetched once per app mount, not re-run per tier
   switch or per graph edit.** PRD §0.4's "recompute at draw time" is
   satisfied at the level of "never cache to disk, always answer fresh from
   the current graph on each call" — this wave reads it as not requiring a
   fetch on every React render too. A later wave adding a live-edit gesture
   (write a node, then relint) would call `fetchLintReport()` again from
   wherever that gesture already lives; nothing here blocks that.
5. **Stack-tier navigation targets use the literal slug `"stack"`.**
   Restated from `engine/presets.ts`'s `STACK_CONFIG.layoutSlug` rather than
   imported (`graph/` cannot import `engine/` — see `problems.ts`'s own doc
   comment on `NavigationTarget`) — `configFor` ignores a stack target's slug
   entirely, so this only has to match by convention.
6. **The known backend tier-loading gap (§6 item 3) is not this wave's to
   fix.** Completing `graph/backend.ts`'s tier-aware `loadRealGraph` (writing
   the equivalent of `projectServiceGraph` for the Stack and Module tiers
   against the real `RawGraph`) is a materially larger, separately-scoped
   piece of work — the task brief named the Problems panel, the click-through
   *decision*, and status-bar cell 3, not the Schematic loader. Flagged
   clearly rather than silently worked around.

## 8. Left undone, on purpose

- The backend tier-loading gap, §6 item 3 / §7 item 6.
- `Runs`, `Registries`, and `Rules` dock tabs — Waves 8 and 9's own scope,
  unchanged placeholder text.
- Status-bar cell 4 (the latest run) — Wave 9's.
- No visual/pixel verification of any kind — §6.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016X8PJJ3xTD4BTuNBLSJyTQ
