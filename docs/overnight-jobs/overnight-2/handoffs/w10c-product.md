# Wave 10c handoff — the product layer

Branch `schematify/w10c-product`, off `main` at `61e4ba2`, merged forward
once with `origin/main` at `e23fe4e` (after wave 7b's Problems panel, wave
9b's runs, and wave 10b's lifecycle enforcement all landed) to pick up 4
merge conflicts — `App.tsx`, `graph/backend.ts`, `graph/project.ts`, and
`src-tauri/src/apps/schematify.rs` — resolved by keeping both sides' work
side by side; see "The merge with wave 10b" below. Scope: the Project
brief, the Screen registry, the Flow editor, and the Decision log (PRD
`docs/design/SCHEMATIFY-PRD.md` §5.7, §5.8, §5.9, §5.12, §12.17, §12.18),
plus the screen chip, the module-root screen path, their click-through to
the Screen registry, and the `◈ NOT HERE` rewrite. Lifecycle enforcement,
the staleness cascade, the review queue, S-25, the Problems panel, the Runs
dock tab, the Module dashboard, and CODEOWNERS are other agents' scope and
are not touched here.

## The merge with wave 10b

`src-tauri/src/apps/schematify.rs` was edited concurrently by wave 10b
(lifecycle enforcement, PR #94, merged first) — both waves added match arms
to the same `dispatch` function and touched the same module doc comment,
`actor_param` doc comment, and `use schematify_core::{...}` import list.
Resolved by keeping both sides: the combined `use` list carries every item
either wave needed, the module doc comment states both wave 10b's and wave
10c's additions in 2 short paragraphs (trimmed afterward to clear the
20-line comment-density cap), and every dispatch arm from both waves is
present (`transition` alongside `write-screen`/`write-flow`/`write-brief`/
`write-decision`/`supersede-decision`). Neither wave's tests needed
changing — `core_rpc`'s new `CoreError::Lifecycle` branch (wave 10b) and
this wave's decision-boundary checks are independent code paths that never
call each other. `apps/schematify/ui/src/graph/project.ts` and
`graph/backend.ts`/`App.tsx` had the same shape of conflict (2 waves adding
independent imports/exports to the same file) and merged the same way.
Full verification after the merge: see the table below — everything was
re-run against the merged tree, not just the pre-merge one.

## What was built

### Rust — the decision log's append-only boundary

- `crates/schematify-core/src/store.rs`: `Store::write_brief`, mirroring
  `write_screen`/`write_flow`/`write_decision`.
- `src-tauri/src/apps/schematify.rs`: five new `schematify/*` JSON-RPC
  methods on the existing dispatch function (no new Tauri command, per
  `docs/audits/schematify-baseline.md` §11) — `write-screen`, `write-flow`,
  `write-brief` (all freely editable/upserting), and `write-decision` plus
  `supersede-decision`, which together are PRD §5.9's rule: "Schematify
  shall never edit a decision row in place. Schematify shall never remove a
  decision row. A change adds a new row and marks the prior row
  `SUPERSEDED`."

**How the boundary is enforced, not just drawn:**

- `write-decision` refuses outright if a file already exists at the
  decision's id (an edit-in-place attempt), and refuses a payload that
  arrives already claiming `status: SUPERSEDED` or a non-null
  `supersedes`/`superseded_by` (so a client cannot smuggle in a
  pre-superseded row through the "create" path).
- `supersede-decision` is the *only* method that can move a row to
  `SUPERSEDED`. It reads the prior row **back off disk**, not from the
  request body, and changes only its `status` and `superseded_by` fields —
  every other field (title, context, decision, consequences, date) is the
  value that was already there. The successor's own `supersedes`/
  `superseded_by` are computed server-side too, overriding whatever the
  client sent.
- No method deletes a decision file. There is no `delete-decision` or
  similar in the dispatch match at all.

## Acceptance: a decision row cannot be edited or removed, proved at the boundary

Proved with dispatcher-level tests in `src-tauri/src/apps/schematify.rs`,
not a disabled UI button:

- `write_decision_refuses_to_edit_an_existing_row_in_place` — writes a
  decision, then sends the same id back with a changed title; the second
  call is refused (`INVALID_PARAMS`) and the test reads the file on disk
  afterward to assert it is byte-for-byte the original, not just that the
  call errored.
- `write_decision_refuses_a_payload_that_already_claims_a_supersession` —
  two cases, a pre-superseded payload and a payload pre-claiming
  `supersedes`.
- `supersede_decision_adds_a_row_and_marks_the_prior_superseded` — writes a
  successor and asserts every one of the prior row's original fields
  (title/context/decision/consequences/date) is unchanged after the call,
  proving the prior row's *content* cannot move through this method either.
- `supersede_decision_ignores_a_forged_supersession_on_the_successor_payload`
  — a successor payload that claims `SUPERSEDED` status and forged
  `supersedes`/`superseded_by` ids is silently corrected to the server's own
  values.
- `supersede_decision_refuses_a_prior_row_that_is_already_superseded` — no
  double supersession.
- `supersede_decision_refuses_a_successor_id_that_already_exists` — reuses
  the same edit-in-place guard `write_decision` uses.
- `no_method_removes_a_decision_row` — dispatches 3 plausible delete/edit
  method names (`schematify/delete-decision`, `remove-decision`,
  `edit-decision`) and asserts every one resolves to `METHOD_NOT_FOUND`.

The React `DecisionLog` component (`apps/schematify/ui/src/product/`)
independently honors PRD §12.18's UI rule too — no row, active or
superseded, carries an edit or remove control — but that is belt-and-braces:
the acceptance condition is met by the Rust tests above regardless of what
the UI draws.

## Tests broken on purpose, per the standing instruction

- `screenBackingModuleCount`: temporarily inverted the `nodeIds.has(id)`
  check to always return the full `backed_by.length` — the "counts only
  resolved references" test failed (asserted `2`, got `3`); restored.
- `resolveFlowSteps`: temporarily returned the raw `step.screen` string
  instead of looking it up — the "resolves to a title" test failed;
  restored.
- `sortDecisions`: temporarily removed the status-first comparison,
  sorting by date alone — the "every active row before every superseded
  row" test failed (a superseded row with a later date sorted first);
  restored.
- `write_decision`'s edit-in-place guard (Rust): temporarily removed the
  `path.is_file()` check — `write_decision_refuses_to_edit_an_existing_row_in_place`
  failed (the second write silently succeeded and the title changed);
  restored.
- `supersede_decision`'s "read from disk, not from the payload" rule:
  temporarily built the prior row's rewritten copy from `successor`'s
  fields instead of `prior`'s — the "every original field unchanged" test
  failed; restored.
- `screenReferenceId` (engine/anatomy.ts): temporarily loosened the regex
  to accept the retired `journeyman://` scheme — the "returns null for the
  retired scheme" test failed; restored.

## Where the reference fixture lacked something needed

`crates/schematify-core/fixtures/saas-backend/` — the wave 1b reference
fixture PRD §16.1 describes — holds **no** `screens/`, `flows/`,
`decisions/` directories and no `brief.json`. `Store::init()` creates all
three directories for a fresh project, but the committed fixture's own
generator never populated them. This means:

- `schematify/load-graph` against the real fixture returns `screens: []`,
  `flows: []`, `decisions: []`, `brief: null`.
- The Screen registry, Flow editor, and Decision log all draw their honest
  empty states against the real fixture, and the Project brief form opens
  on `emptyBrief()` rather than populated content.
- **Nothing here was invented to fill that gap.** Per the standing
  instruction ("if the fixture lacks something you need to draw, say so"),
  this handoff records it rather than hand-typing a stand-in screen or
  decision into `fixtures/saas-backend/` — the exact mistake the prompt
  warned cost a prior wave dearly (`project.ts`'s facet-collapse bug). A
  later wave (or the fixture's own owner) can add `fixtures/saas-backend/`
  product-layer content once someone decides what PRD §16.1's implied
  content should look like — it names none explicitly for screens, flows,
  the brief, or decisions.

## The screen chip, the module-root screen path, and the click-through

- `engine/anatomy.ts`: `SCREEN_CHIP_LABEL` (`"◈ SCREEN"`, renamed from the
  wireframe's own `"◈ JOURNEYMAN"` per PRD §12.5) and `screenReferenceId`,
  parsing a `schematify://screen/<id>` reference down to the id a click
  opens.
- `engine/frame.ts`: `DrawnNode.screenReferenceId`, computed from the
  module root's own `screenRef` field. `drawn.counts` is untouched — the
  existing `module.test.ts` assertion that it contains the raw
  `schematify://screen/login-form` string still passes; this is a new,
  additive field.
- `engine/SchematicCanvas.tsx`: a `kind: "screen"` node now draws as the
  labelled chip and *nothing else* — no lifecycle treatment, no ports, no
  badges, matching PRD §12.5's "a screen reference is a reference and never
  an editor." The module root's own `screenRef` line is now a `<button>`
  when `onOpenScreen` is wired, falling back to the same inert text every
  other unwired control in this app already draws when it is not.
- `App.tsx`: `onOpenScreen` sets the Outline's section to `Product`, opens
  the `Screens` tab, and passes the clicked id down as `initialScreenId` so
  `ScreenRegistry` selects that row.

**Not exercised against the real fixture's Service Schematic.** No fixture
in this app (`graph/fixture.ts`'s `AUTH_SERVICE_GRAPH`, the real
`fixtures/saas-backend/`) contains an actual `kind: "screen"` node or a
`references_ui` edge on the Service Schematic — only the module root's
`screenRef` text field is populated (`graph/module.ts`'s hand-typed
`MODULE_GRAPH`, matching PRD §16.1's "One screen reference to
`schematify://screen/login-form`"). Adding a screen node and edge to the
*canonical* `AUTH_SERVICE_GRAPH` fixture was deliberately avoided: that
fixture's exact node/edge counts (`12 nodes · 9 edges`) are load-bearing
across many already-passing wave 2/3/5 acceptance strings, and a 13th node
would break them. The chip's rendering is instead covered by
`anatomy.test.ts`'s direct tests of `screenReferenceId` and by
`module.test.ts`'s new assertion that the module root's `screenReferenceId`
resolves correctly — the chip *shape* itself has no automated coverage
this wave, and a human should look at it (see below).

## What a human must verify on screen

No browser was available (`00-AGENT-CONTEXT.md` forbids `pnpm dev:agent`/
`pnpm ui launch` for this job). In the morning, with a project open:

1. Open the Outline's `Product` tab. Confirm the 3 sub-tabs (`Brief`,
   `Screens`, `Flows`) render, and that the Screen registry's table columns
   line up (SLUG, TITLE, STATES, MODULES, DESIGN) — this wave verified
   their content by unit test, never by eye.
2. Create a screen, save it, reload the panel (switch to `Decisions` and
   back), and confirm it persisted and the state/module counts are correct.
3. Open the Outline's `Decisions` tab. Confirm no row — active or
   superseded — carries any button but `Supersede`, and that `Supersede`
   disappears once a row is superseded.
4. Create a decision, then supersede it, and confirm both rows appear with
   the right statuses and that the original row's content did not change.
5. On the Service Schematic, if a project ever carries a `kind: "screen"`
   node, confirm it draws as a small dotted chip (`◈ SCREEN` / `screen/
   <slug>`) rather than a full module box, and that clicking it opens the
   Screen registry at that screen. No fixture in this repo currently
   exercises this — see above.
6. On the Module Schematic (`token-verifier`), confirm the root's
   `schematify://screen/login-form` line is now clickable (cursor changes,
   click opens the registry at `login-form`) rather than plain text.
7. Confirm the `◈ NOT HERE` note on the Module Schematic's empty state
   (`?view=empty-module`) now reads "User-facing behaviour, flows and
   screens belong in the Screen registry. Schematify references them; it
   does not hold them."

## Assumptions, recorded because a source was silent

1. **Layout: the center body swaps, the Outline stays.** PRD §12.17/§12.18
   name what each surface holds, not where it sits in the shell. No
   wireframe draws any of S-19 through S-22. Swapping the Schematic +
   Inspector body for `product/ProductPanel` (leaving the Outline,
   breadcrumb, and toolbar in place) was chosen over cramming a table-plus-
   form into the 238px Outline column, which those descriptions would not
   fit legibly.
2. **Backing modules are edited as a raw list of `schematify://node/<id>`
   strings**, not through a module picker. No such picker exists anywhere
   in this app yet — a Schematic's own multi-select is a different gesture
   over a different kind of node — and building one is out of this wave's
   scope.
3. **The Decision log's default sort is active-first, then newest date
   first**, and its filter defaults to `ALL`. PRD §12.18 states only that
   the log "draws as a table filtered by `status`," not an ordering.
4. **`ListField`'s add-on-Enter, remove-with-×, free-text shape** for
   every string-array field (brief's `users`/`goals`/`non_goals`/
   `constraints`, a screen's `states`/`acceptance`/`backed_by`) is this
   wave's own invention — no wireframe draws either surface.
5. **The product graph loads once per open Schematic, lazily**, the first
   time either `Product` or `Decisions` is opened, and reloads after every
   write. `App.tsx`'s own header states the same "read once, project many
   views" rule already governing the design graph.
6. **`write-screen`/`write-flow`/`write-brief` upsert freely**; only the
   decision log is append-only. PRD §5.9's rule is written on `Decision`
   alone, and §5.7/§5.8/§5.12 state nothing of the kind.

## Verification

| Step | Result |
|---|---|
| `pnpm build` | Pass — `dist/assets/schematify-*.js` built |
| `pnpm test:js` | Pass — 681 + 28 (bridge), run against the post-merge tree |
| `pnpm lint:js` | Pass — 0 errors, the same 8 pre-existing `react-hooks/exhaustive-deps` warnings named in prior waves' handoffs, none in a file this wave touched |
| `pnpm lint:comments` | Pass — 0 grandfathered, after trimming `schematify.rs`'s module doc comment twice (once pre-merge, once again once wave 10b's own paragraph landed alongside it) and `EmptyModule.tsx` once |
| `pnpm lint:version`/`lint:identity`/`lint:branding` | Pass |
| `pnpm format:check` (prettier + `cargo fmt --all -- --check`) | Pass |
| `cargo test --workspace` | Pass — every crate green, 0 failed (`schematify-core` lib: 186; `schematify.rs`'s own suite: part of the workspace's `veistra-orchestrator` binary tests). Run with an isolated `CARGO_TARGET_DIR`, not the shared one — see the note below |
| `cargo clippy` (`node scripts/clippy-baseline.mjs`) | Pass — 0 warnings, at the baseline of 0 |

**A shared-`CARGO_TARGET_DIR` false failure, not this wave's bug.** Two
separate `cargo test --workspace` runs against the shared target dir this
job's instructions point at failed to compile with
`error[E0599]: no method named `write_brief` found for struct `Store``,
even though `grep -n "pub fn write_brief" crates/schematify-core/src/store.rs`
confirms the method is right there. A `cargo check -p schematify-core`
run alone against the same shared dir succeeded moments earlier. Re-running
both the check and the full test suite with the shared target-dir variable
unset (an isolated, private target dir) passed cleanly both times, before
and after the merge — this is the same class of defect
`docs/overnight-jobs/overnight-2/handoffs/w10a-gates.md`'s "known false
failure" note describes for `veistra-tool-manifest`, just manifesting as a
compile error instead of 3 named test failures. If a reviewer sees this
error against the shared target dir, retry with `CARGO_TARGET_DIR` unset
before concluding the code is wrong.

No test was deleted or skipped.

## Left undone, on purpose

- No product-layer content in the reference fixture — see above.
- No screen node/edge in any Service Schematic fixture — see above.
- No module picker for a screen's backing modules — raw URI list instead.
- Search (S-18), registries/rules tables (S-15/S-16), the review queue
  (S-23), S-25, the Problems panel, the Runs dock tab, the Module
  dashboard, lifecycle enforcement, the staleness cascade, and CODEOWNERS
  are all other agents' scope, untouched here.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016X8PJJ3xTD4BTuNBLSJyTQ
