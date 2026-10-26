# Schematify sweep — the first time anything ran it

Written 2026-09-04, against `main` at `29c3956`, after PRs #76–#98 landed
Schematify overnight.

## Why this exists

`docs/overnight-jobs/overnight-2/MORNING-SUMMARY.md` states the gap plainly:

> **No browser was available to any agent all night.** Every visual claim is
> read-verified only.

`vitest` runs `environment: "node"` with no rendering library, so none of the
111 `.tsx` files under `apps/schematify/ui/` has behavioural coverage. The
backend had 52 dispatch tests, all green, all happy-path.

So twenty-four PRs of design-layer machinery had never been *run*. This sweep
ran it: all eighteen JSON-RPC methods against real fixtures, the `veistra
reconcile` CLI end to end against a purpose-built tree, scale to 2000 nodes,
and — for the first time — a person-equivalent looking at the screen.

Six agents, each owning an isolated cluster in one agent-owned instance, each
writing into its own copy of a fixture. Findings below are ordered by severity,
and every one names what was run.

## The shape of the result

**The backend is in good health.** Most of this document is negative results,
and they matter: the error-reporting surface nobody had exercised turns out to
be correct, every lint rule fires, every product-layer write round-trips,
performance is sub-linear at 16× the reference graph.

**What is wrong clusters into one theme:** things that cannot detect their own
failure. Two tests with no ability to go red. Fixtures that exercise neither
the linter nor the scanner they are the reference for. An endpoint that
validates state against a value the caller supplies. A canvas that computes
`NaN` and commits it. None of these announce themselves; each needs someone to
go looking.

---

## Breaks

### B1 — `schematify/transition` validates against a state the caller invents

`src-tauri/src/apps/schematify.rs:583` → `crates/schematify-core/src/store.rs:375`

`check_transition` checks the transition table against the `from` in the
caller's payload. It never reads the node off disk first.

Reproduced twice, independently. Node `rate-limiter`
(`01a03637-7800-702c-8ba9-ddd34a5262f9`), genuinely `lifecycle: "draft"`. Sent
its own JSON back with `lifecycle` edited to `"reviewed"`, `to: "accepted"`,
`actor: "human"`. It succeeded. On disk afterwards: `accepted`.

A draft node crossed `specified`, `assigned`, `implemented` and `reviewed` in
one call, and passed the human-review gate PRD §7 treats as a core invariant.

The actor gate *is* correctly enforced — `reviewed→accepted` and
`stale→accepted` are refused for `"agent"`. It simply gates a `from` the caller
made up, so it protects nothing.

### B2 — the same endpoint persists the caller's whole node

Same location. `store.write_node(node)` writes the entire struct it is handed,
not just the lifecycle and audit row.

In the call above, `title` was also set to `CANARY-TITLE-OVERWRITE`. That is
what landed on disk. So any client holding a stale snapshot silently clobbers
concurrent edits to `title`, `description`, `parent`, `allowed_libraries` and
everything else, every time it moves a lifecycle.

**The fix for both:** read the node from disk using only the caller's id,
validate `from` against that, and apply only lifecycle plus audit.

### B2b — `schematify/write-node` ignores the lifecycle gate entirely

`src-tauri/src/apps/schematify.rs` (`write_node`)

Found while fixing B1/B2, and **more severe than either.** `write-node` accepts
and persists any `lifecycle` value with no call to `check_transition`, no actor
gate, and no audit row.

Reproduced against the live app. Node `rate-limiter`
(`01a03637-7800-702c-8ba9-ddd34a5262f9`), genuinely `draft` on disk. Sent its
own JSON back through `write-node` with `lifecycle` set to `"accepted"`, as
**`actor: "agent"`**. It returned `{id, path, staled: []}`. On disk afterwards:
`accepted`.

B1 required the caller to lie about the from-state, and there was at least a
gate there to lie *to*. Here there is nothing to defeat: a caller does not need
to forge anything, because nothing looks. And the actor matters —
`reviewed → accepted` is documented human-only, and an **agent** crossed the
whole ladder in a single write.

So PRD §7's lifecycle model is advisory as shipped. Every gate B1 describes can
be bypassed more simply through the general node editor.

### B3 — "Fit" permanently destroys the Schematic canvas

`apps/schematify/ui/src/engine/` (viewport/fit computation)

Reproduced by the visual sweep, then by me. Measured from inside the app iframe:

```
start:                      nodes=7  zoom=200%
after drill into a node:    nodes=7  zoom=200%
after breadcrumb back up:   nodes=4  zoom=68%
after clicking Fit:         nodes=0  zoom=NaN%
```

It does not recover:

```
after clicking Stack breadcrumb: nodes=0  zoom=100%
after Auto-sort:                 nodes=0  zoom=100%
```

Every `.kv-node` leaves the DOM. The instance stays dead for every tier, while
the status bar still reports `layout/stack.json clean`. Only mounting a fresh
Schematify instance recovers it.

**The data is fine** — `schematify/load-graph` on the same cluster returns the
full graph with a clean report. This is entirely frontend view state.

**Root cause, found while fixing it (PR #105), and it is the sharpest example
of this document's theme.**

`fitTo` in `viewport.ts` validated its bounding box with
`bounds.width <= 0 || bounds.height <= 0`. **`NaN` fails every relational
comparison** — `NaN <= 0` is `false` — so a `NaN` box walked straight through a
guard written to stop exactly this, into the scale division, and out into
`Viewport`. It never self-corrects, because every later culling comparison
against a `NaN` zoom is also `false`. That is why the canvas stayed dead
through navigation and Auto-sort.

The `NaN` came from `buildDoc` in `layout.ts`, which copied a stored node's
`x`/`y`/`width`/`height` straight off parsed layout JSON with no runtime check.
One missing field is `undefined`, and `undefined` arithmetic becomes `NaN`
through `unionRect`/`boundsOf`. Reproduced from the repo's own `auth-service`
fixture plus a layout file missing one node's `width`.

So the validation existed, ran, and was structurally incapable of catching the
value it was written for.

**The live trigger is a second route into the same hole.** Measured in the
running app, the canvas element does not exist for a window after a breadcrumb
navigation — the component remounts:

```
after drill:                  canvas=738x678  nodes=5
immediately after breadcrumb: canvas=none     nodes=0  zoom=undefined
```

So `fitTo`'s `size` comes from a missing element and `size.width` is
`undefined` — and `undefined <= 0` is `false` for the same reason `NaN <= 0`
is. The fixture's own layout JSON is well formed (every node rect has all four
fields, the stored viewport is a correct `{x, y, zoom}`), so the stored-geometry
path was never the one firing here.

Two different malformed inputs, one guard that cannot reject either. The
`Number.isFinite` floor is what actually closes it; validating stored geometry
closes a second, latent route. It also gives the likeliest account of the
milder `200%` signal: a canvas caught *partially* measured yields a
small-but-finite size, and a finite-but-wrong size yields a finite-but-absurd
zoom.

Note a related signal: a plain Fit on a fresh canvas moves zoom to `200%` and
drops visible nodes 9 → 7. `200%` is a strange answer for "fit" and may be the
same arithmetic in a milder form.

**One unresolved disagreement, recorded rather than settled.** Reviewing PR
#105, a second reader traced `SchematicCanvas.tsx` and could not find a code
path that produces `size.width === undefined`: `ResizeObserver` reports
`contentRect.width` as a real number by spec, and `engine.ts` seeds `size` with
`{1320, 700}`, so on that reading the field should never be undefined. The
measurement above is empirical and the trace is analytical, and they have not
been reconciled — most likely because the observer never fires at all for an
element that is not there, leaving something else to explain the `undefined`
that was actually read back. Nothing turns on it for the fix, whose
`Number.isFinite` floor covers a non-finite `size` however it arises; it matters
because the live trigger should not be recorded as confirmed when only its
effect was seen.

### B4 — two tests that cannot fail

`crates/schematify-reconcile/`

Both proven inert by mutation, in an isolated copy of the crate:

- `token::tests::token_pattern_compiles` — the body is
  `let _ = token_pattern();`, with **no assertion**. Replacing the marker regex
  with `@veistra:(.*)` — matches anything, still compiles — left this test green
  while 13 others correctly went red.
- `report::tests::summary_counts_match_outcome_kinds` — only ever exercises the
  **empty** run. Mutating `summarize()`'s `Matched` arm to increment
  `declared_absent` left **all 35 lib tests green**, this one included.

This was the dominant defect pattern of the overnight build; reviewers caught
ten across six waves. These are the eleventh and twelfth, and they sit in the
crate that decides whether code matches the design.

---

## Wrong

### W1 — `module-dashboard` accepts any node kind on the UUID path

`src-tauri/src/apps/schematify.rs:898`

Verified directly. A **service** UUID (`api-gateway`) and a **test-case** UUID
(`expired-token-is-rejected`) were both accepted and returned a full dashboard
labelled with that node, budgets and tests computed over the wrong scope.

The **slug** path already filters on `kind == Module` and refuses correctly —
so this is an oversight on one branch, not a design choice.

### W2 — the `[⋯]` node menu does the wrong thing

`apps/schematify/ui/src/engine/SchematicCanvas.tsx:646`

Worse than the "drawn but inert" it was recorded as. The click falls through to
the node's own handler: on a module node it drills in, on a leaf it selects.
No menu ever appears.

### W3 — a `duplicate` reconcile row renders an empty SITE column

`src-tauri/src/apps/schematify.rs:1138`

`title_of()` falls back to `value.get("slug")`, but a real `Duplicate` outcome
carries only `node_id` and `sites` — **no `slug` key at all**. For a duplicate
whose node id is not in the title map, the column silently renders empty. Fails
quietly; needs an edge-case id to surface. Confirmed against JSON captured from
the real writer.

### W4 — stale `reconcile.json` verdicts never expire

`crates/schematify-reconcile/src/bin/veistra.rs` (`write_run_files`)

Only writes directories for node ids in the *current* run's outcomes.
Demonstrated: a tree with 9 hand-authored `reconcile.json` dirs, reconciled
against a copy with zero source files, gained 31 new dirs and left all 9
**untouched** — including one claiming `outcome: matched` for a file not in the
tree. `schematify/reconcile-status` serves that as current.

Needs a decision: clean up on each run, or stamp with the run and let readers
judge staleness.

### W5 — semantic edits are lost on reload, silently

`apps/schematify/ui/src/graph/backend.ts:211-240`

A reparent, a duplicate, or an edge dragged into existence is accepted by the
UI, looks saved, and is gone on reload. Only position drags persist.

**The underlying deferral is deliberate and documented** — see the seam's own
doc comment and `handoffs/wiring.md` §366-386. The engine sends a partial node
(no `lifecycle`, `authored_by`, `created`) because a reparent genuinely cannot
know them; routing that through would fail every gesture, and inventing them
would be guessing.

The defect is the **silence**, not the deferral. Losing work without saying so
is not licensed by having a good reason for not saving it yet. Who supplies the
missing fields is a schema decision and remains open.

### W6 — `comment` nodes are dropped in the projection layer

`apps/schematify/ui/src/graph/project.ts:133` and `:274-280`

The type gap people keep reporting is already fixed — `NodeKind` includes
`"comment"`. The drop moved one layer down: `SERVICE_SCHEMATIC_KINDS` omits it,
and `MODULE_FACET_KINDS` omits **both** `comment` and `group`. The backend
models comments fully (`node.rs:36-58`, `CommentFields`), and the engine below
already treats them as annotation-tier. Only the projection discards them.

### W7 — `write-brief` accepts an empty `product_name`

`crates/schematify-core/src/brief.rs:29-49`

A *missing* field is refused; an empty one succeeds and writes. No non-empty
check exists on any field. Inconsistent contract rather than data loss.

### W8 — the staleness caption is correct and cannot be read

`apps/schematify/ui/src/engine/` (node card sizing)

The last of the summary's six, and the only one nobody had ever seen. It exists
and its content is right:

> ⚠ STALE — upstream contract changed
> token-verifier.verify-signature changed 9d ago. Re-review required.

That matches the node's real `stale` metadata exactly — source, member and a
correctly computed "9d ago".

But the node card is `overflow: hidden` at a fixed height (128px measured at
tier 3) and the caption element has room for roughly 1.3 lines at that width.
On screen the card cuts off mid-sentence after
`token-verifier.verify-signature`; the rest is in the DOM and never visible. In
the compact grid the whole second line is gone, cut after "upstream contract
changed".

So the feature works and its output is unreadable. Nothing in the card's layout
accounts for its own longest content.

---

## Rough

- **R1 — quarantine is reported by subject id only.** `load-graph` exposes it
  solely through `report.quarantined[]`. The graph keeps the flag
  (`Graph::is_quarantined`) and deliberately retains the dangling edge per PRD
  §6.6, but the RPC never surfaces a per-node boolean, so every consumer must
  re-join two arrays by id.
- **R2 — Windows path separators are mixed** in RPC responses
  (`".../saas-b\\.veistra"`) and in `site.file`, where the real writer emits
  OS-native paths while hand-authored fixtures use forward slashes.
- **R3 — `actorName` is camelCase while the node payload is snake_case.** A
  deliberate asymmetry (RPC params vs. domain objects), but a caller assuming
  one convention will be bitten.
- **R4 — the dashboard's `linter.rules` can drift** from the live linter: it
  reports the ingested run's snapshot (14) where the current linter has 13.
  By design, but compounds W4.
- **R5 — the loader accepts a hand-written `contains` edge file** even though
  the writer refuses to create one. Not reachable through the app.
- **R6 — outline rows do not select, and this looks deliberate.** Two rows were
  tested: `audit-emitter` (carrying a STALE badge) and `http-entry` (an
  unremarkable module). Both are fully inert — no selection, no drill, no
  breadcrumb change. The group-expand toggles beside them do work, so the
  surface is not broken, just not a selector. Filed as design rather than
  defect on that evidence. It is still a poor outcome that the badge telling
  you a node is stale sits on a row that will not take you to it — and with W8,
  the caption you would go there to read is clipped anyway.

---

## The fixtures cannot prove the things they are the reference for

Two findings that are not defects in the app, and matter more than most that
are.

- **Neither fixture exercises the linter.** `lint` returns **zero findings** on
  `stress-2000` and `dense-service`, with 13 rules loaded. Both are generated
  as pure `service`→`module` `depends_on` chains with no screens, flows or
  decisions.
- **`saas-backend` contains no source files at all.** Every non-`.veistra` path
  is absent, so `veistra reconcile` against it can only ever report
  `declared_absent` — 31 of them — and never exercises the scanner's match
  path.

**The rules and the scanner both work.** A targeted defect was planted for each
untested rule — L01, L04, L06, L08, L09, L12, L13 — and every one fired with
correct detail, location and severity. A purpose-built tree produced all four
reconcile outcomes across six comment syntaxes. The machinery is sound; the
fixtures simply cannot detect it breaking, which is the same property as a test
that cannot fail.

---

## What works — the negative results

These were all provoked deliberately, and all behaved correctly.

**`load-graph`'s entire error-reporting surface**, which no test had ever made
non-empty:

| branch | provoked by | result |
|---|---|---|
| `unreadable` | invalid JSON in a node file | reported, and correctly cascaded `quarantined` for children pointing at it |
| `slugCollisions` | two nodes sharing a slug | reported, naming holder and claimant |
| `misnamed` | file renamed, id unchanged | reported |
| `idCollisions` | same id in two files | reported, plus an honest second classification as `misnamed` |
| `quarantined` | edge target pointing at nothing | reported with subject, field, reference, reason |

**Writes and invariants.** `write-layout` touches exactly one file (all 204
hashed before and after) and refuses a non-object `layout`; `read-layout`
returns bare `null` for an unwritten slug and round-trips byte-identical; the
staleness cascade genuinely stales dependents on disk with a `system` audit
row; a `contains` edge writes nothing; a `references_ui` edge lands
`schematify://screen/<id>` in the module's `ui_refs`; `Edge`'s
`deny_unknown_fields` refuses and names the field; an unknown *node* field
survives a round trip, per PRD §11.2's open map.

**The product layer**, 24 cases: upsert-by-id for screens *and* flows (the flow
case had no prior test), `write-brief` as a true replace, all four
`write-decision` refusals, all five `supersede-decision` refusals, and the
server genuinely overwriting a forged successor payload — sent
`status:"SUPERSEDED"` with a fake `supersedes`, got `ACTIVE` with the correct
one on disk.

**Analysis.** All 13 lint rules fire. `runs` sorts newest-first project-wide
(proven with four runs ingested out of order). `ingest-run` refuses eight
distinct malformed inputs with useful messages, all before writing anything.
`reconcile-status` handles real `NodeReconcileFile` payloads, including an
invalid-JSON file refused with a clear parse error.

**Scale.** `load-graph` on 2000 nodes / 3000 edges: **146ms cold, 112–123ms
warm**, against 23ms for 125 nodes. 16× the nodes and ~24.5× the files for ~5×
the time — sub-linear. Repeat loads stable. Two clusters interleaved never bled
counts.

**The UI, on the six surfaces the morning summary flagged.** Problems badges
read 3/2 in the correct accents, with a genuine 6px blank-row separator against
23px rows. The collapsed dock is 29px with both badges intact. The Inspector
measures exactly 360px and all eight tabs render distinct content. The Module
dashboard loads, renders its tiles and history sections, and `← Back`
navigates. The Runs tab shows its single row and the status bar's "9d ago" is
arithmetically right. `Registries` and `Rules` label themselves as Wave 8
placeholders rather than looking broken.

---

## Not reached

- **Token Verifier's module dashboard**, which is where the two real sparklines
  and the "No probe declared" caption would appear. The module tested had no
  budgets declared.
- The **export strip** — not found on any surface reached.
- **"A real project draws zero ENTRY badges"** — no ENTRY badge was seen
  anywhere, which is circumstantial, not confirmation.

## A note on mutation testing, learned the hard way

The countermeasure this repo adopted for tests that cannot fail is: break the
production code, watch the test go red, restore, and say so in the commit
message. It works. But it has a failure mode of its own, found while fixing B3.

`fitTo` ended up with **two independent safety nets** — a `Number.isFinite`
check on the inputs and a second on the computed result. Either one alone saves
every bad case. So dropping the guard a test *names* left the test green, and
the mutation appeared to prove nothing was being tested.

The agent caught this in its own work, corrected three misleading mutation
comments, and re-verified properly: it checked out the fully pre-fix versions of
`viewport.ts`, `layout.ts` and `geometry.ts` wholesale and confirmed all five
non-finite-input tests go red **together**, then restored to 20/20 green.

**So: where redundant guards exist, mutating one proves nothing.** Mutate the
whole pre-fix state, or the mutation evidence is itself the thing it was meant
to rule out. A mutation comment that names one line and was never checked
against the others is a claim, not a proof.

## Corrections made during the sweep

Recorded because each was believed before it was checked.

- **`.veistra/runs/<uuid>/reconcile.json` is written** by shipped code —
  `write_run_files`, unconditionally. The suspicion that nothing wrote it was
  wrong.
- **The module tier is wired** and uses real backend UUIDs. Only the **stack**
  tier still returns a hardcoded empty graph. A stale comment at
  `backend.ts:190-191` still says otherwise.
- **`EmptyModule.tsx` has no control at all** — the gap is "no affordance
  exists", not "an affordance is inert". Its own header comment is wrong.
- **The lint rules are not dead.** An earlier reading of "no fixture fires
  them" as "they cannot fire" was wrong; all 13 fire when a defect is planted.

## Tooling notes

- `pnpm probe` mangles JSON arguments containing parentheses or braces through
  Windows batch quoting, reporting a bogus "not valid JSON". Call
  `node scripts/veistra-probe.mjs` directly.
- `snapshot` refs go stale the moment the DOM beneath them changes. Re-using
  one snapshot across several clicks produced a false "the tabs do not update"
  result before a one-at-a-time retest showed all eight correct.
- `veistra-shot.png` is tracked in git and rewritten by every screenshot, so it
  dirties the tree continuously and can be swept into an unrelated commit.
- `.mcp.json` is committed with duplicate keys — `veistra-debug` and `veistra-echo`
  each appear twice — and a running app rewrote it to `{"mcpServers":{}}`
  mid-sweep — though that rewrite turned out **not** to be a second bug: it is
  what `sync()` does when `mcp.writeProjectConfig` is off or nothing is enabled
  in that instance. **The writer is not at fault**, which is worth stating because it
  is the natural suspicion: `mcp::config`'s `merge`/`sync` build the table as a
  `serde_json::Map`, which structurally cannot hold two entries under one key.
  The duplication came from commit `9f5e300`, a merge of two branches that had
  each independently renamed `helve-*` to `kaava-*` (now `veistra-*`); git's line-based merge
  interleaved both sides' near-identical insertions into one object rather than
  reporting a conflict, and JSON's last-key-wins meant the file kept parsing, so
  nothing downstream ever complained. A structurally invalid file survived
  because every consumer was tolerant of it.

  The fix (PR #107) closes the class rather than the instance: a test now
  compares the tracked file against `merge(None, enabled_ids)`, so any drift
  between what is committed and what `sync()` actually produces fails the build.
  That immediately caught a second, separate defect — `veistra-design` was
  **missing** from the tracked file entirely, having shipped enabled by default
  after the file was last hand-edited.
