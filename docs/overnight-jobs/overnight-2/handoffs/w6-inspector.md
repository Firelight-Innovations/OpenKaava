# Wave 6 handoff — the Inspector

Branch `schematify/w6-inspector`, cut from `schematify/w5-schematics` and
later merged forward onto `main` (commit `facd2ed`, after waves 7b, 9b and
10b landed there — see "The merge onto main" below). PRD §17 Wave 6: PRD
§12.12's Inspector — S-04 through S-11, the `More` overflow tab, the
export-list editor, the Inspector empty state, and the 2 footer controls.

## What was built

- **`apps/schematify/ui/src/engine/inspector.ts`** (new). Every count, chip
  and label the Inspector draws, computed as pure functions from plain
  data — the same convention `engine/anatomy.ts` established for the
  Schematics: `InspectorShell.tsx` only maps this file's output onto
  markup and decides nothing itself. Covers the tab-strip width switch,
  Identity, Lifecycle (PRD §7.2's transition table restated as a lookup),
  Contract (both "one block per method" and a service's export/OpenAPI
  mode), Tests, Budgets, Dependencies, Docs, and References.
- **`apps/schematify/ui/src/shell/InspectorShell.tsx`** (rewritten).
  Renders all 8 tabs, the narrow/wide tab strip, the export-list editor
  (add/remove rows, each a single `editNode` call), the copy-on-click
  opaque-id field, the `Copy marker token` control (unlinked cases only),
  the budget `Add probe`/`Drop budget`/sign-off controls, and the 2 footer
  controls. Wave 5's `CANVAS PROPERTIES` empty state is untouched.
- **`apps/schematify/ui/src/engine/engine.ts`**: 3 new methods —
  `editNode`, `addFacet`, `dropFacet` — and a new private
  `commitSemanticOnly` that skips the layout write every other engine
  gesture makes (`commit`/`applyDoc` always write `layout/<slug>.json`
  too; an Inspector edit changes no geometry, so it must not). This is
  the mechanism behind the wave's sharpest acceptance condition.
- **Fixture completion**, not invention where PRD §16.1 already named the
  content: `graph/module.ts` gets the wireframe's 3rd named test case
  (`clock skew at the boundary`, declared/unlinked) and its remaining 2
  budgets (`jwks_refetch_rate` soft/trending, `cold_start_p95` hard/no-
  probe) — Wave 5's own comment already flagged both as curated subsets
  (1 of 3 budgets, 2 of 3 named cases). `graph/fixture.ts`'s
  `token-verifier` node gets the Identity fields WIREFRAME-EXTRACT.md
  §1.1 draws for it (`description`, `decisions`). `graph/stack.ts`'s
  `api-gateway` gets an authored `exports` list and `resolvedMethods`.
- **`graph/types.ts` / `engine/doc.ts` / `engine/layout.ts`**: widened
  `GraphNode`/`SchematicNode` with the Inspector's own fields, and widened
  `toGraph` (previously a small subset) to carry every field `buildDoc`
  already carries in — the Inspector reads through this same projection,
  so a field `toGraph` dropped was a field no tab could ever draw.

### Review round: 2 stored-count breaches, fixed (not scope creep)

A reviewer caught 2 PRD §0.4 violations — a count stored on a node rather
than computed at draw time. Both are fixed on this branch, not deferred:

- **`engine/anatomy.ts`'s `coversCount`, inherited from Wave 5.** Stored
  directly on a `contract-method` node, read by `facetContentFor` and
  `coverageOf`. Now computed: `coversCountFor(id, edges)` counts real
  `covers` edges targeting that method, `frame.ts` threads `doc.edges`
  through `drawNode` so the canvas card computes it too, not only the
  Inspector. `graph/module.ts`'s `token-verifier` fixture now carries 7
  real `covers` edges (was 2) reproducing Wave 5's own 4/3/0 split by
  construction rather than by declaration. **This is why the fix routes
  both readers through 1 function rather than just deleting the stored
  field**: before, the canvas card (`facetContentFor`, reading
  `coversCount`) and the coverage readout (`coverageOf`, also reading
  `coversCount`) happened to agree only because they read the same stored
  number — nothing enforced that agreement. A 3rd reader (the Inspector's
  Contract tab, this wave's own addition) reading a 2nd independently
  stored number would have been a 3rd place the same fact could drift.
  `coversCountFor` is now the 1 place the fact lives; every reader calls it.
- **`engine/inspector.ts`'s `additionalPassingTests`, this wave's own
  breach.** A stored integer on the module root, summed into `testsContent`'s
  drawn total. Removed entirely — `graph/module.ts` now carries all 7 real
  `test-case` nodes PRD §16.1 implies (3 named, 4 invented `[P]`, the same
  shape this wave already used for `api-gateway`'s 11 invented
  `resolvedMethods`), so `testsContent` computes `7 CASES` from
  `children.length` alone, no 2nd argument.

`engine.test.ts`'s `addFacet`/`dropFacet` tests were also strengthened —
they asserted write count and path but never content, which a reviewer
proved by swapping `inspectorNodeJson`'s return for a placeholder object
and watching all 8 tests still pass. Both now assert the written object's
real fields via `seam.semantic.get(...)`, and all 3 Inspector-write
methods (`editNode`, `addFacet`, `dropFacet`) have an undo/redo
round-trip test checking real content on both sides, not just presence.
Verified by mutation twice (`inspectorNodeJson`, `coversCountFor`), each
time confirming the new tests fail under the mutation and pass once
reverted — see the commit that made these fixes for the exact counts.

### The merge onto main

Wave 7b (the Problems panel) merged to `main` first, so this branch merged
`origin/main` and hand-resolved 1 conflict in `App.tsx` — both sides
rewired `onActivate` and the Inspector's own props, and the resolution
keeps both: this wave's `onDrillTo`/`InspectorShell` wiring and wave 7b's
`findings`/`onSelectFinding`/`Dock`/`StatusBar` wiring, with `onActivate`
derived from `onDrillTo` inside `Schematify()` exactly as it already was
before the merge. No other file conflicted.

**The real risk in this merge, and the answer: the §16.1 Problems rows
survived.** Wave 7b's own Rust test,
`the_wireframe_fixture_draws_the_five_rows_the_problems_panel_draws`
(`crates/schematify-core/tests/lint.rs`), asserts PRD §16.1's exact 5
Problems rows against `fixtures/saas-backend/`'s `token-verifier` module —
the same fixture this wave extended with 4 new test-case nodes and 7
`covers` edges (up from 2). That test passes on the merged tree, along
with the other 6 in `lint.rs` and the 19 elsewhere in the crate. The
fixture extension did not shift a Problems row.

**A note for whoever reads `cargo test --workspace` tonight: it currently
cannot reach `schematify-core` or `src-tauri` at all.** A pre-existing,
unrelated failure in `veistra-tool-manifest`'s `reference_manifest.rs` (3
tests, a path baked in at compile time from whichever worktree's `cargo`
last built that binary, colliding across every worktree that shares
tonight's `CARGO_TARGET_DIR` — confirmed against 3 different colliding
worktree names across this wave's own reruns) stops the workspace run
before either crate's tests execute. `sch-fix-flake` owns the real fix on
its own branch. Until that lands, **"`cargo test --workspace` is red"
tells you nothing about this branch** — read per-crate results instead:
`cargo test -p schematify-core` (39 tests, 0 failed, includes the
`lint.rs` suite above) and `cargo test -p veistra-orchestrator` (583
tests, 0 failed, 1 pre-existing ignored, includes all 26
`apps::schematify::tests::` cases) were both run directly against the
merged tree (`facd2ed`) and are clean.

## Acceptance conditions (PRD §17 Wave 6)

| Condition | Status | Evidence |
|---|---|---|
| The Inspector edits a node and writes 1 file. One, not two. | **Pass** | `engine.test.ts`'s Inspector describe block: `editNode`/`addFacet`/`dropFacet`/the export-list editor each assert `engine.semanticWrites` holds exactly 1 path, `seam.layouts.keys()` is empty, and (after the review round) the written object's real content via `seam.semantic.get(...)`. |
| The Contract tab draws an OpenAPI view for `api-gateway`, whose 11 exports resolve to 11 methods. | **Pass** | `inspector.test.ts`: `contractContent(gateway, [])` against the real stack fixture — `exportRows` and `resolvedMethods` both length 11. |
| Every Inspector string in §12.12 draws from the fixture. | **Pass, no remaining gap** | Every quoted literal form (`3 METHODS`, `✓ N covers edges`/`▲ no covers edge…`, `7 CASES`/`5 passing`/`1 failing`/`1 unlinked`, `linked · 41ms`/`linked, failing`, the unlinked sentence, `3 BUDGETS`, the run reference, `1.8 ms`/`< 3 ms`, `—`, `trending to breach · sign-off required`, `No probe declared`, the lint-error note) is asserted in `inspector.test.ts` against the real `token-verifier`/`api-gateway` fixtures. The gap this table used to name (4 of 7 test cases as a stored rollup) is closed — see the review-round section above; `7 CASES` is now computed from 7 real nodes. |
| 5 flat tabs draw at 380 px, 4 tabs plus `More` draw at 360 px. | **Pass** | `inspector.test.ts`'s `tabStripFor` tests, both widths, numerically. |

## Every assumption, and why

1. **The tab-strip width is a prop (`panelWidthPx`), not a live resize
   measurement.** The shell's Inspector column has a fixed width
   (`--kv-panel-inspector`, 360px) — nothing in this app makes it
   dynamically resizable yet, so there is no real container width to
   measure. `App.tsx` passes no override, so the running app always shows
   the 360px/4-tabs-plus-`More` layout; the 380px/5-flat layout exists and
   is tested but is not reachable by a human today. **What a human should
   decide:** whether the Inspector column ever needs to actually widen
   (e.g. a splitter), or whether this was always meant as a 2-context
   distinction (in-app vs. a wider standalone exhibit) that this app
   doesn't need to reconcile at runtime.
2. **At 380px, `More` disappears entirely rather than shrinking to 3
   items.** PRD §12.12: "the panel holds 5 flat tabs at 380 px" — read
   literally (no "…plus `More`"), `Dependencies`, `Docs` and `References`
   are unreachable at that width in this build. The alternative reading
   (`More` stays, holding the remaining 3) is equally defensible and an
   easy 1-line change (`tabStripFor` in `engine/inspector.ts`) if a human
   picks it instead. **Flagged for a human**, not fixed unilaterally.
3. **The 4 test cases PRD §16.1 declines to name individually are now 4
   real, invented `[P]` nodes**, not a stored rollup — a review round
   reversed this wave's own first attempt (a stored `additionalPassingTests`
   integer), which was a PRD §0.4 breach. Each of the 4 carries its own
   given/when/then, marker token, and a real `covers` edge; see the
   review-round section above.
4. **`api-gateway`'s 4 module slugs and 11 method names/signatures are
   invented.** PRD §16.1 gives the service's own counts (`11 exports`,
   `4 modules`) but no Service Schematic fixture exists for it the way
   `fixture.ts` exists for `auth-service` — nothing else needed the
   content until this wave's acceptance condition did.
5. **`Assign` sets a fixed placeholder assignee (`"you"`), not a real
   picker.** No design exists yet for who gets offered as an assignee;
   the control is real (it calls `editNode` and writes a file) rather than
   inert, which was the standing note to avoid "a rule enforced only by
   the absence of a gesture." A real assignee picker is later-wave UI
   work.
6. **The Lifecycle tab's transitions are read-only display, not clickable
   buttons that perform a transition.** PRD §7.3's human-only gate at
   `accepted` has no policy to attach to yet (the wiring handoff's own
   note: wiring `schematify_transition` without Wave 10's gate "would make
   an enforcement point that enforces nothing"). Building a transition
   button here would be exactly that.
7. **The Docs tab's textarea saves on blur**, calling `editNode` against
   the module's own `doc-block` child when one exists; a module with none
   draws a read-only placeholder. No richer editor (markdown preview,
   audience picker) was built — PRD §12.12 doesn't specify one beyond
   "a full editor," and this is the narrowest reading that is still a
   real, working edit path.
8. **Dependencies' external-library rows come off the module's own
   `external-dep` facet children**, not a separately stored list — the
   same fact `engine/anatomy.ts`'s `facetContentFor` already draws on that
   facet's canvas card. Keeps 1 source of truth rather than 2 lists that
   can drift.
9. Every other `[P]` a fixture value needed (the invented budget probe
   command, the invented `< 500 ms` threshold for `cold_start_p95`, the
   marker-token UUIDs) is marked at its own line in `graph/module.ts` and
   `graph/stack.ts`.

## What a human must look at on screen

No browser is available to this job. In the morning, with `pnpm ui launch`
or `pnpm dev:agent`:

1. Open the Service Schematic for `auth-service`, select `token-verifier`,
   open the Inspector's Identity tab. Confirm `OPAQUE ID` is a real UUID-
   shaped field, that clicking it copies to the clipboard, and that no
   other visible field on the node (canvas face or elsewhere) draws that
   id — PRD §17 Wave 6's own 2nd bullet: "and nowhere else."
2. Drill into the Module Schematic for `token-verifier`, select the module
   root, open Tests. Confirm the 3 drawn cases read as 2 different kinds
   of problem at a glance (the failing case's red framing vs. the unlinked
   case's dashed/hollow framing) — the distinction this wave's 3rd bullet
   asks for should be visible without reading the text.
3. Same module, Budgets tab. Confirm `cold_start_p95` draws `Add probe`
   and `Drop budget` side by side, and that `jwks_refetch_rate` draws a
   sign-off control rather than those 2.
4. At the Stack Schematic, select `api-gateway`, open Contract, toggle to
   OpenAPI. Confirm 11 method blocks draw. This is the 1 acceptance
   condition a script proves numerically but a human should still read —
   the invented method names (assumption 4 above) are the one part of
   this screen worth a sanity check.
5. Resize nothing (assumption 1): confirm the Inspector reads reasonably
   at its real 360px width with `More` present, since the 380px layout is
   not reachable in this build today.
6. Type in the Docs tab's textarea, click elsewhere, reopen the module.
   Confirm the edit persisted for the session (it will not survive a
   reload — `writeSemantic` is still in-memory per the wiring handoff).

## Verified, and how

Checked twice: once on this wave's own commits, and again on the merged
result (`facd2ed`, `origin/main` merged in — see "The merge onto main"
above). The table below is the merged-result run, the one that matters.

| Check | Result |
|---|---|
| `pnpm build` | Pass. |
| `pnpm test:js` | Pass — 692 tests (28 in `packages/bridge`), including `engine/inspector.test.ts`'s assertions against the real `token-verifier`/`api-gateway` fixtures, `engine.test.ts`'s Inspector describe block (write-count, write-path, written-content, and undo/redo round-trip checks for `editNode`/`addFacet`/`dropFacet`), and wave 7b's `problems`/`staleness` suites running clean against this wave's extended fixture. |
| `pnpm typecheck` | Pass. |
| `pnpm lint:js` | Pass — 0 errors, the same 8 pre-existing React-hook warnings named in earlier handoffs, none in a file this wave touched. |
| `pnpm lint:comments` | Pass — 0 grandfathered. |
| `pnpm lint:version` / `lint:identity` / `lint:branding` | Pass. |
| `pnpm format:check` | Pass, no changes needed on the merged tree. |
| `cargo test --workspace` | **Still fails on the pre-existing, unrelated `veistra-tool-manifest` flake — see "The merge onto main" above for what to read instead.** `cargo test -p schematify-core` and `cargo test -p veistra-orchestrator`, run directly, are both clean. |
| `cargo clippy` | Pass — 0 warnings, at the baseline of 0. |
| `pnpm baseline` | Never run. |

No test was deleted or skipped. A run of pre-existing tests was updated
because the fixture they assert against grew, not because they were
wrong: `module.test.ts`'s node/facet counts (grew twice over the wave, to
16 nodes / 15 facets) and its `layer backend · N facets` string, and its
`coverageOf`/`facetContentFor` calls (signature changed to take real
edges/a covers count instead of a stored field) — both PRD §0.4-driven
changes, the 2nd one a review-round fix rather than this wave's own
first draft.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016X8PJJ3xTD4BTuNBLSJyTQ
