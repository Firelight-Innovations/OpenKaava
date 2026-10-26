# Wiring wave handoff — the swap

Branch `schematify/wiring`, off `main` at `3a30391` (after wave 3's engine
merged), later merged forward to `main` at `a9a7222` (after wave 7a's linter
and wave 10a's CI gates landed) once a review pointed out both were sitting
unwired in the same crate this branch already depended on. This wave connects
the application to `crates/schematify-core` through the seam every earlier
wave was told to read the graph through, per
`docs/overnight-jobs/overnight-2/00-AGENT-CONTEXT.md`.

## What was built

### Rust: `src-tauri/src/apps/schematify.rs`

Eight JSON-RPC methods on Schematify's one dispatch function — no new Tauri
command, no `generate_handler!` line, no `bindings.ts` wrapper, per
`docs/audits/schematify-baseline.md` §11 and `home.rs`'s own pattern. Every
method requires an `actor: "human" | "agent"` parameter and refuses a call
missing or misusing it (decision SCH-API-003) — parsed and validated, but
not yet fed to a policy, since none of these eight reach a lifecycle
transition. `src-tauri/Cargo.toml` gained one dependency,
`schematify-core = { path = "../crates/schematify-core" }`.

| Method | Params | Does |
|---|---|---|
| `schematify/state` | — | Unchanged, wave 1a's. |
| `schematify/open-project` | `actor` | Reports the cluster's project root and whether `.veistra/` exists under it. Read-only — does not call `Store::init()`. |
| `schematify/load-graph` | `actor` | `load_project`, shaped by hand into `{ graph: { nodes, edges, screens, flows, decisions, rules, libraries, brief }, report: { clean, quarantined, unreadable, slugCollisions, idCollisions, misnamed, durationMs } }`. Hand-shaped because `Graph` and `Report`'s own sub-types (`Quarantine`, `IdCollision`, …) carry no `Serialize` — the crate is a library, not a wire format. |
| `schematify/write-node` | `actor`, `node` | Deserializes `node` as `schematify_core::Node` (whole envelope + kind fields) and writes it via `Store::write_node`. |
| `schematify/write-edge` | `actor`, `edge` | Same, for `Edge`. Reports `stored: false` for a `contains` edge, which the crate refuses to write at all. |
| `schematify/write-layout` | `actor`, `slug`, `layout` | Writes `layout/<slug>.json` **verbatim**, not through `schematify_core::Layout`/`Placement` — see "The layout mismatch" below. |
| `schematify/read-layout` | `actor`, `slug` | Reads the same file back verbatim, or `null` if it does not exist. Not one of PRD §14.5's ten — added because a write-only seam cannot serve `openSchematic`, which reads a layout before drawing anything. |
| `schematify/lint` | `actor` | `load_project` then `schematify_core::lint(&graph)` (wave 7a, merged after this branch's base but before this wave closed). Returns the whole `LintReport` as-is — `Finding`/`Location`/`LintReport` are fully `Serialize`, unlike `Graph`/`Report`, so no hand-shaping is needed here. |
| `schematify/reconcile-status` | `actor`, `node` (a UUID) | Reads `runs/<node>/reconcile.json` verbatim, or `null` if it does not exist — see "The reconcile-status file, too" below. |

`schematify/lint` and `schematify/reconcile-status` are wired and tested at
the RPC layer only — nothing in `apps/schematify/ui/` calls either yet. That
is correct for tonight: the Problems panel that would call `lint` and the
Inspector tab that would call `reconcile-status` are both interface work the
wave 7a and wiring prompts scope to a later agent (`w7a-linter.md` §7: "The
Problems panel… is interface work"). Wiring the RPC ahead of its caller is
the same shape as `write-node`/`write-edge` below.

**Left undone, and why:** `schematify_transition` (wave 10's lifecycle gate —
`write_transition` exists in the crate, but wiring it without the gate PRD
§7 and wave 10 own would make an enforcement point that enforces nothing) and
`schematify_ingest_run`/`schematify_search` (both are being built on other
branches tonight; wiring against nothing on this app's side would be
guessing which shape they will land in, not connecting to something real).

A first pass at this handoff listed `lint` and `reconcile-status` here too, as
blocked by missing machinery. That was wrong and a review caught it: the
linter (wave 7a) and the reconcile crate's result/run-artifact types (present
in `crates/schematify-core` since the crate itself landed) were both already
sitting in the same dependency this branch already had — the branch had
simply never been rebased onto wave 7a's merge to see it. Fixed by merging
`main` forward and wiring both; see the two rows above.

19 tests in `schematify.rs` (up from the 3 wave 1a shipped), each asserting
written content (a reader gets back what was sent) rather than only "did not
throw" — including one that round-trips a layout file carrying fields
`schematify_core::Layout` cannot hold (pinning the mismatch below), one that
seeds a real dependency cycle and asserts `schematify/lint` reports it as
`L02`, and one that seeds a
`reconcile.json` by hand and asserts `schematify/reconcile-status` returns it
verbatim. `cargo test --workspace`: 832 passed, 1 pre-existing ignored
(`github::live::fetches_a_real_repository`), 0 failed. `clippy`: 0 warnings,
at the baseline of 0.

### The layout mismatch — read this before touching layout persistence

`schematify_core::Layout`/`Placement` (PRD §5.10, minimal reading: position
and size, keyed by id string) do not match
`apps/schematify/ui/src/graph/layout.ts`'s `LayoutFile` — what wave 3's
engine actually reads and writes. `LayoutFile` also carries a `version`, a
combined `{x, y, zoom}` viewport (the crate splits `zoom` and `pan`
separately), and whole `LayoutAnnotation` records for groups and comments
(`title`, `author`, `body`) that `Placement` has nowhere to put.

Rather than lossily reshape one to fit the other (which would silently drop
every comment body on the first real write), `schematify/write-layout` and
`schematify/read-layout` write and read the frontend's JSON **verbatim**,
through the same atomic writer `Store` itself uses
(`schematify_core::write_json_atomic`), at the same path
`Store::layout_path` computes. This is documented at the function and pinned
by a round-trip test.

**Ruling from review: the crate is not wrong.** Checked against PRD §5.10
directly, `schematify_core::Layout` matches the specification exactly; the
extra shape (`version`, the combined viewport, whole annotation bodies) is
the front end's own invention, not two schemas that drifted from one spec.
Writing verbatim rather than downcasting through the typed struct was the
right call for tonight — downcasting would silently drop every annotation
body, the worst of the three options available (verbatim, downcast, or
refuse to wire the write at all). **Not fixed tonight, and not this wave's
call to make unilaterally.**

**Follow-up for whoever next touches `crates/schematify-core`'s layout
schema.** The real question is not "which shape is right" but where an
annotation's body belongs at all. PRD §11.3 puts groups and comments in the
annotation tier, out of reconciliation — so the open question is whether an
annotation's body (title, author, prose) belongs in the layout file
alongside its geometry, or in the node store like every other piece of
authored content, with the layout file narrowed back to carrying only
position and size for annotations too, the way it already does for every
node. Evidence for **narrowing the front end** (store the body in `nodes/`):
consistency with every other authored field in this schema, and PRD §6.2's
own reason for splitting layers at all — a body edit is content, not
arrangement, and arguably should not be able to go stale from an unrelated
drag the way a purely cosmetic file is allowed to. Evidence for **widening
the crate** (add the body to `Placement` or a sibling type): an annotation
is explicitly *not* semantic (PRD §11.3 keeps it out of reconciliation and
forbids it carrying a semantic edge), so treating its content as more akin
to `nodes/` data may misclassify it, and `engine/layout.ts`'s
`toLayoutFile`/`buildDoc` already treat annotations as cosmetic-tier
end-to-end. **Narrowing the front end looks like the more likely resolution**
— it keeps the crate's existing PRD-§5.10-exact `Layout` type as the one
schema, and treats an annotation's body the same way every other piece of
prose in this system is treated: authored content lives in the semantic
tree. But this is a design call, not a fact this handoff can settle, and
until someone makes it, **there are two live shapes for one file**: the
crate's typed `Layout`/`Placement`, and the front end's actual
`LayoutFile`/`LayoutAnnotation` with a body no typed reader can see.

### The reconcile-status file, too

The same shape of question, smaller: `crates/schematify-reconcile/src/
report.rs` writes `runs/<node>/reconcile.json` as its own
`NodeReconcileFile { schema, at, outcome: ReconcileOutcome }` — a type in the
*reconcile* crate. `schematify_core::ReconcileResult` (in `run.rs`, exported
since the core crate landed) is a **different** type, matching PRD §5.10's
`{ rules, violations }` shape for a run artifact generally, not this file
specifically. `schematify/reconcile-status` reads the file verbatim, the
same reasoning as the layout read above applied word for word: deserializing
into `schematify_core::ReconcileResult` would either fail outright (the
fields don't match) or silently coerce a shape it was never written in.
Nothing here adds `schematify-reconcile` as a `src-tauri` dependency — the
raw-JSON read needs no type from either crate.

## Front end: the fixture is replaced behind the seam

`apps/schematify/ui/src/graph/index.ts`'s `defaultSeam` — what
`engine/index.ts`'s `openSchematic` uses when `App.tsx` calls it with no seam
argument, i.e. what the running application actually uses — now resolves to
a real backend instead of `createMemorySeam()`. Three new/changed files, all
inside the seam (`graph/`):

- **`graph/project.ts`** (new). Projects the whole-project graph
  `schematify/load-graph` returns down to the one-service `ServiceGraph`
  shape `./types.ts` still defines (Wave 2's placeholder — no tier switch
  exists yet, PRD §17 Wave 5). Picks the node with `kind: "service"` whose
  `slug` matches, walks `parent` to find every descendant (cycle-guarded, the
  same pattern `index.ts`'s `computeDepth` already uses), keeps only `module`
  kind descendants (facets, comments, and — per the owner's count ruling
  below — groups are all excluded rather than collapsed to `"module"`), and
  keeps only `depends_on`/`implements`/`references_ui` edges whose both ends
  survive the filter. Fully unit-tested (`project.test.ts`, 18 assertions)
  against a hand-built multi-service raw graph and against `auth-service`'s
  real containment shape, including a containment-cycle case.
- **`graph/backend.ts`** (extended). Adds `createBackendSeam()`: real
  `invoke` calls for `loadGraph` (via the projection above),
  `loadDenseGraph` (unchanged — still the in-code dense fixture; the real
  dense fixture doesn't exist on disk, wave 3's own assumption 10),
  `readLayout`, `writeLayout`. `writeSemantic`/`removeSemantic` stay
  in-memory — see "What still doesn't persist" below.
- **`graph/index.ts`**. `defaultSeam` now reaches `createBackendSeam()`
  through a **dynamic** `import("./backend")`, memoized, rather than a
  static one. A static import would pull `@veistra/bridge`'s `window`
  access into `index.test.ts`, which runs on plain Node — the exact failure
  wave 2's review round 2 already fixed once by splitting `rpc.ts` into
  `backend.ts`. `loadGraph()` (the fixture-returning function) and
  `createMemorySeam()` are byte-for-byte unchanged.

**No file outside `graph/` changed an import.** `App.tsx`,
`engine/index.ts`, `engine/presets.ts`, every `shell/` component — untouched.

### Which service the app opens on

`engine/presets.ts`'s `SERVICE_CONFIG` hardcodes `layoutSlug: "auth-service"`
(Wave 3 scope). `graph/backend.ts` hardcodes the same slug as the service to
project from the real graph. This is not an independent guess:
`fixtures/saas-backend/` was built specifically to reproduce PRD §16.1's
`auth-service` fixture (`w1b-core.md`'s own acceptance condition — "Every
named node in PRD 16.1 exists in `fixtures/saas-backend/`" — and its
generator, `fixtures/saas-backend.mjs`, literally sets
`parent: service.id` on every top-level module, confirmed by reading it).
Against a project with no `auth-service`, `loadRealGraph()` throws a named
error, which `App.tsx`'s existing rejection handling (wave 2 review round 2's
fix) already renders as `.kv-shell__error` rather than hanging. Wave 5's tier
switch is where a real, non-hardcoded service picker belongs.

## The real fixture vs. the wave 2 stand-in — verified, not assumed

Another review confirmed no front-end wave has ever read
`crates/schematify-core/fixtures/saas-backend/` — every badge, count and
caption assertion up to this wave passed against
`apps/schematify/ui/src/graph/fixture.ts`'s hand-typed `AUTH_SERVICE_GRAPH`,
written to look like the wireframe rather than read from anything. This
wave's job — connecting the real loader — is what makes checking the two
against each other possible for the first time, so it was done: the real
fixture's `auth-service` was run through `schematify/load-graph` and then
through `projectServiceGraph`, and the result compared field by field against
the stand-in. **The stand-in fixture was not touched** — a fixture bent to
match a drawing is a defect, per this job's standing rule, and nothing here
edits `fixture.ts`.

### A wiring bug this comparison caught, and fixed

The first version of `projectServiceGraph` collapsed every node kind except
`group` to `"module"` — modeled on `engine/layout.ts`'s `toServiceGraph`,
misread as precedent for this direction too. Against the real fixture,
`auth-service`'s 12 real modules plus 58 of their own tier-3 facets
(contract methods, test cases, budgets, a doc block, an external dependency)
all drew as one flat 70-node service — PRD's Module Schematic content
leaking into the Service Schematic. Fixed: `project.ts`'s
`SERVICE_SCHEMATIC_KINDS` now keeps `module` and `group` and drops every
facet and the one comment entirely, rather than collapsing anything to
`"module"`. A `group` is still projected and drawn — see the count ruling
below for why it is nonetheless invisible to the status bar's arithmetic.
`load_graph_against_the_real_fixture_reports_a_clean_project_and_auth_service`
in `schematify.rs` pins the real fixture's raw shape (12 modules, 1 group
under `auth-service`); `project.test.ts` pins the projection itself, both
against synthetic data (a comment and 3 facet kinds, and a `group` that is
drawn but never an edge endpoint) and against a real-shaped test using
`auth-service`'s actual 12 module slugs plus `token-pipeline`.

### Two gaps in the model, not just differences in data

These are not places the stand-in guessed wrong — they are places the real
graph holds information this application currently has no way to draw at
all, and they belong at the top of this list rather than buried in it.

- **No structural source for the ENTRY badge exists anywhere in the schema.**
  PRD §12.1 draws `http-entry`'s `ENTRY` badge and the wave 2 stand-in
  hardcodes it, but `schematify_core` has no "this module is the service's
  entry point" flag — `ServiceFields.entry_point` is prose on the *service*
  ("Started by the platform supervisor."), not a reference to a module.
  `project.ts` derives `STALE` from `lifecycle` but can derive no `ENTRY`
  from anything today, so a real project's Outline draws zero `ENTRY`
  badges. **What a fix looks like:** either a new field on `ModuleFields`
  (e.g. `entry_point: bool`, authored the same way `exports` is) or a
  derived rule stated somewhere a linter could check (the module the
  service's HTTP/RPC surface actually calls first — no such signal exists
  in the schema today either). **Owner:** whoever designs the schema change
  belongs with wave 1b's crate; the front-end read of it, once it exists,
  is a 1-line addition to `project.ts` next to the `STALE` derivation.
- **A real `comment` annotation has no representation in this application's
  node kinds at all, and is silently dropped.** `two-caches-on-purpose`,
  authored `m.ross`, anchored to `jwks-cache`, sits directly under
  `auth-service` in the real fixture.
  `apps/schematify/ui/src/graph/types.ts`'s `NodeKind` union is
  `"service" | "group" | "module"` — there is no `"comment"` member, so a
  project that genuinely holds this content loses it the moment it is
  drawn; nothing downstream ever learns the comment exists. **What a fix
  looks like:** widening `NodeKind` to add `"comment"` (parallel to how
  `"group"` already carries the annotation tier — see the count ruling
  below for the shape that gives it: drawn, never counted, never an edge
  endpoint), or a sibling type entirely — `ServiceGraph` could carry its
  own `annotations` array rather than folding comments into `nodes` — plus
  deciding where it draws: an Outline row, a
  canvas-only marker anchored to its target, or both. That drawing decision
  is exactly the kind of call this wiring wave was told not to make
  unilaterally. **Owner:** Wave 4 (node anatomy, badges, canvas treatments)
  is the natural home — it already owns every other per-node visual
  decision this schema drives.

### Ruling: a group is drawn but not counted — implemented

An earlier version of this section reported a 13th top-level element, a
`group` node called `token-pipeline`, and concluded the real node count was
13 against the wave 2 acceptance string's 12 — and a first attempt at fixing
it dropped the group from the projection entirely, which the owner also
corrected: a group is a real containment box the Module and Service
Schematics draw, so removing it from what this app projects would be wrong
in the other direction. **The actual ruling is narrower and gets both halves
right: drawn and counted are 2 different questions.** A `group` is
annotation-tier under PRD §11.3 — "it arranges and it annotates, it does not
mean" — the same category as the comment above, and 2 binding decisions
already say an annotation is not a *node* for counting purposes without
saying it is not drawn: WIREFRAME-EXTRACT.md's Resolutions section ruled an
annotation-tier box is never a node and never an edge endpoint when it
settled the Stack Schematic's edge count, and wave 3's own review required
`buildFrame`'s counts to count semantic nodes only, so that adding a comment
leaves the count unchanged while the comment still appears on the canvas
(`w3-engine.md`'s review round 2 finding).

**Implemented as 2 separate mechanisms, not 1 filter:**

- `project.ts`'s `SERVICE_SCHEMATIC_KINDS` keeps `module` *and* `group` — a
  group is projected into `ServiceGraph.nodes` and drawn, matching every
  other node's shape (`kind: "group"`, a real `parentId`).
- `project.ts`'s `MODULE_ONLY_EDGE_ENDPOINT_KINDS` is narrower: `module`
  alone. A `depends_on` (or any dependency-family edge) naming a group as
  its source or target is dropped even though the group itself is drawn —
  the "never an edge endpoint" half of the ruling, enforced independently
  of the node list.
- `graph/types.ts` gains `ANNOTATION_NODE_KINDS`/`isAnnotationNodeKind`
  (`["group"]` today, parallel to `engine/config.ts`'s own
  `ANNOTATION_KINDS`/`isAnnotationKind` for the engine's wider vocabulary).
  `graph/index.ts`'s `countNodes` — read by `statusCell1` and
  `outlineFooter` alike — now filters annotation-tier kinds out before
  taking `.length`. This is the "never counted" half, and it lives where
  the count is computed, not where the graph is projected: a group is a
  member of `graph.nodes` the whole time, exactly as drawn as any module,
  and is simply not one of the numbers the arithmetic sums.

`project.test.ts` asserts the full shape: a synthetic group (`g1`) is
present in `graph.nodes` with `kind: "group"`, an edge naming it as an
endpoint is dropped, and a real-shaped case built from `auth-service`'s
actual 12 module slugs plus `token-pipeline` draws **13** nodes while
`countNodes` on that same result reports **12**. **Real data now yields a
count of 12, matching the wave 2 acceptance string exactly —
`.veistra/ · 12 nodes · 9 edges` is true against reality, not merely against
the stand-in — while the group itself still reaches the canvas as the
containment box it actually is.**

### What still agrees

Every one of the 12 module slugs and their parent structure matches the
stand-in exactly — same containment tree, same depth (`http-entry`,
`token-issuer`, `token-verifier` top-level; `jwks-cache`/`clock-skew` under
`token-verifier`; `session-store` top-level with `session-codec`/
`session-index` under it; `crypto-primitives`, `password-hasher`,
`rate-limiter`, `audit-emitter` top-level). `audit-emitter`'s `STALE` badge
matches. Both report exactly 9 `depends_on` edges, and now exactly 12 nodes.

### What actually differs

- **The edge topology matches on count (9=9) but not on content.** 5 of the
  9 real edges have no counterpart in the stand-in, and 5 of the stand-in's
  9 have no counterpart in the real data — 4 edges are shared. Real-only:
  `session-store → session-codec`, `jwks-cache → crypto-primitives`,
  `clock-skew → crypto-primitives`, `audit-emitter → token-verifier`,
  `rate-limiter → session-index`. Stand-in-only: `token-issuer →
  crypto-primitives`, `token-verifier → crypto-primitives`, `password-hasher
  → crypto-primitives`, `rate-limiter → token-verifier`, `audit-emitter →
  crypto-primitives`. This confirms, rather than merely repeats, an
  admission `fixture.ts`'s own comment already carried ("All 9 were
  invented by this agent, not read from any specification") — that
  admission is now retired as a suspicion and stands as a checked fact.
- **Lifecycle values mostly weren't set at all in the stand-in.** Real:
  `http-entry` `specified`, `token-issuer` `specified`, `token-verifier`
  `accepted`, `jwks-cache` `specified`, `session-store` `specified`,
  `session-codec` `specified`, `session-index` `specified`. `fixture.ts`
  leaves all 7 of those `undefined` — no lifecycle dot or treatment was ever
  wrong for them because none was ever drawn. One real disagreement where
  the stand-in *did* commit to a value: `rate-limiter` is real `draft`,
  stand-in `assigned`. A later wave needs these facts, not a green suite
  that never looked.

None of this is pushed through silently. `index.test.ts` and `fixture.ts`
are untouched and still pass — they are testing the stand-in, honestly
labeled as such by wave 2's own header comment, and stay useful for running
without a backend. What changed is that the gap between the stand-in and
reality is now measured rather than assumed, and a human opening a real
project tonight should expect the edge lines and the lifecycle dots (once
wave 4 draws them) to read differently than they did against the fixture —
that is the real graph telling the truth, not a regression. The node count
and the group question are no longer part of that gap.

### What still doesn't persist against a real project

A node drag **does** now reach a real `layout/<slug>.json` file
(`schematify/write-layout`) — task item 4's requirement.

A reparent, a duplicate, or an edge dragged into existence do **not** yet
reach a real `nodes/`/`edges/` file. `engine/engine.ts`'s own
`nodeJson`/`edgeJson` — unchanged by this wave, and explicitly out of scope
("no file outside the seam should change its imports; if you find yourself
editing a component, stop") — build a **deliberately partial** payload:
`{ id, slug, title, kind, parent }` for a node, `{ id, kind, from, to }` for
an edge. That file's own comment states why: "Wave 1's schemas own the full
shape, and this engine writes only what a duplicate or a reparent can
honestly know." `schematify_core::NodeEnvelope` requires `lifecycle`,
`authored_by` and `created`; `Edge` requires `created`. None are optional,
and `schematify/write-node`/`write-edge` refuse a payload missing them (see
the round-trip tests in `schematify.rs`).

So routing the engine's existing partial JSON straight to the real commands
would fail every reparent and duplicate outright. Inventing the missing
fields in `backend.ts` would be guessing content the engine never claimed to
know — a real node-creation flow knows a lifecycle and an author; this seam
does not. `createBackendSeam()`'s `writeSemantic`/`removeSemantic` therefore
stay backed by an in-memory `Map`, identical in behavior to
`createMemorySeam()`'s. **A reparent, duplicate, or dragged-in edge persists
only for the running session tonight, exactly as before this wave** — only
the layout write became real. Completing the other two is Wave 3 (widen
`nodeJson`/`edgeJson` to a full, schema-valid payload) or Wave 6 (a real
node-creation form that knows an author and a lifecycle) engineering, not a
wiring change.

**A later fix stopped this from being silent, without changing any of the
above.** The gap this section describes was previously invisible: a reparent
looked exactly as saved as a node drag, and only reopening the project (or
reading this file) told a person otherwise. `SchematicEngine.semanticWrites`
(`engine/engine.ts`) already recorded every path the in-memory `Map` had
touched; what was missing was anything reading it. The status bar now has a
5th cell (`shell/StatusBar.tsx`, `statusCell5` in `graph/index.ts`) that
reads `engine.semanticWrites` on every render and draws `N unsaved changes —
session only, lost on reload` the moment any reparent, duplicate, or edge
creation has happened this session, blank otherwise. This is presentation
only — it does not write anything, and it does not make the fix above
optional. It exists so the gap this section documents is visible to the
person hitting it, not just to whoever next reads this handoff. Wiring the
real `write-node`/`write-edge` commands (Wave 3 or Wave 6, above) is still
the fix that empties `semanticWrites` for good; once it lands, cell 5 goes
blank on its own and nothing else about it needs to change.

## How the front end selects the fixture for tests

Unchanged from before this wave, and this is the answer to "how do tests
stay backend-free":

- `graph/index.ts`'s exported `loadGraph()` function still always returns
  the hand-typed `AUTH_SERVICE_GRAPH` fixture. `index.test.ts` imports and
  calls it directly — untouched by this wave, still green.
- `graph/index.ts`'s exported `createMemorySeam()` still wraps that same
  fixture plus in-memory layout/semantic maps. Every engine test
  (`engine.test.ts`, `frame.test.ts`, `frameBudget.test.ts`,
  `layout.test.ts`, `routing.test.ts`) constructs its own
  `createMemorySeam()` explicitly and passes it to `openSchematic` — none of
  them read `defaultSeam`, so none of them touch the real backend or
  `@veistra/bridge`.
- Only `defaultSeam` changed, and only `App.tsx` (via `openSchematic`'s
  default parameter) reads `defaultSeam`. `App.tsx` is not under test this
  wave (no jsdom in this repo's Vitest config, per wave 2's own header
  comment) — its behavior against a real project is the one thing this
  wiring cannot prove from a test, see below.

## Verified, and how

| Check | Result |
|---|---|
| `pnpm build` | Pass. `dist/assets/schematify-*.js` built. |
| `pnpm test:js` | Pass — 508 + 28 (bridge). Includes 18 `project.test.ts` assertions on real projected content (not just "did not throw"), covering the facet and comment exclusions, the group-is-drawn-but-not-an-edge-endpoint case, and a real-shaped 13-drawn/12-counted regression case; the merge from `main` also brought wave 10a's 13 `check-veistra-boundary.test.mjs` cases along, unrelated to this wave's own changes. |
| `pnpm typecheck` (`tsc`) | Pass, plus re-run as `npx tsc -p tsconfig.json --noEmit --typeRoots ./__no_types__` (wave 2's technique for ruling out this machine's stray home-directory `@types/node`) — also clean. No Node builtin, no post-ES2020 API in any new file. |
| `pnpm lint:js` | Pass — 0 errors, the same 8 pre-existing React-hook warnings named in the wave 2/3 handoffs, none in a file this wave touched. |
| `pnpm lint:comments` | Pass after trimming 4 spots that exceeded the 20-consecutive-comment-line cap over the course of this wave (`backend.ts`, `index.ts`, and `schematify.rs`'s module doc comment twice, once after the first pass and again after adding `lint`/`reconcile-status`) — moved detail into this handoff instead of re-baselining. 0 grandfathered. |
| `pnpm lint:version`/`lint:identity`/`lint:branding` | Pass. |
| `pnpm format:check` | Pass, after `cargo fmt --all` (rustfmt wanted several lines in the test module rewrapped, twice). |
| `cargo test --workspace` | Pass — 832 passed, 1 pre-existing ignored, 0 failed, including 19 in `schematify.rs` itself (the permanent regression test against the real fixture, the `lint` cycle test, the `reconcile-status` round-trip). Run 4 times across this wave's two passes; the first run was piped through `tail` and silently truncated the real per-crate totals — a lesson worth naming so it isn't repeated — every run after that was captured whole. |
| `cargo clippy` (`node scripts/clippy-baseline.mjs`) | Pass — 0 warnings, at the baseline of 0. |
| `pnpm baseline` | Never run. |
| Real fixture vs. stand-in, by hand | See "The real fixture vs. the wave 2 stand-in" above — the one check no script runs, and the one that found the facet-inclusion bug. |

No test was deleted or skipped.

## Assumptions

1. **`actor` is parsed and validated on every method, but not yet acted on.**
   None of the eight methods this wave wires reach a lifecycle transition, so
   there is no policy for wave 10's gate to attach to yet — but every call
   still has to name who it is, honestly, per the task's explicit
   instruction not to default it silently.
2. **The front end always sends `actor: "human"`.** This app has no
   agent-initiated gesture yet — every call reaching `backend.ts` today
   follows a person's mouse and keyboard. One constant
   (`graph/backend.ts`'s `ACTOR`), not re-derived per call.
3. **`schematify/open-project` is read-only** — reports whether `.veistra/`
   exists, never calls `Store::init()` to create it. PRD §14.5 says
   "validates", not "creates"; a project with no `.veistra/` tree yet is a
   state `load-graph` already reports honestly (`CoreError::NoProject`,
   surfaced as a plain refusal).
4. **`schematify/load-graph`'s response is hand-shaped JSON, not a direct
   serialization of `Graph`/`Report`.** Neither type derives `Serialize`
   (the crate is a library, not a wire protocol) — see the table above.
5. **The layout write/read is verbatim JSON, not `schematify_core::Layout`.**
   The two shapes disagree (see "The layout mismatch"); reshaping losslessly
   is a crate-design decision, not this wave's to make unilaterally.
6. **`auth-service` is the one service slug this wave projects**, matching
   `SERVICE_CONFIG`'s hardcoded `layoutSlug` and confirmed against the real
   fixture generator, not guessed independently.
7. **No ENTRY badge for real data**, and **`module` and `group` kinds reach
   the Outline while `comment` cannot reach it at all** — a group is drawn
   but excluded from `countNodes` specifically, per the owner's count
   ruling; a comment has no `NodeKind` member to be represented by in the
   first place. Both confirmed, not merely assumed, against the real
   fixture; see "The real fixture vs. the wave 2 stand-in" above.
8. **A contains, covers, satisfies, or documents edge is dropped from the
   real-graph projection.** `./types.ts`'s `GraphEdge` union only names 3
   kinds; containment is `parentId`, and the other 2 have no drawing yet.
9. **`schematify/lint` returns the raw `LintReport`, no envelope around it.**
   `Finding`, `Location` and `LintReport` are all `Serialize`, so there was
   nothing to hand-shape — unlike `load-graph`, where `Graph`/`Report`
   forced a manual reshape.
10. **`schematify/reconcile-status` reads `runs/<node>/reconcile.json`
    verbatim, the same reasoning as the layout read, applied to a second
    file with the same problem** — see "The reconcile-status file, too"
    above. `node` is required as a UUID string; a malformed one is refused
    (`INVALID_PARAMS`), not silently treated as "not found".

## What a human must check on screen

Nobody watched this run against a real window tonight
(`00-AGENT-CONTEXT.md` forbids `pnpm app`/`pnpm dev:agent`/`pnpm ui launch`
for this job). In the morning, with a project that has a `.veistra/` tree
seeded from `crates/schematify-core/fixtures/saas-backend/` (or any real
project with an `auth-service`):

1. Open Schematify. Confirm it draws the real graph rather than hanging on
   the splash screen or showing `.kv-shell__error` — a wrong
   `DEFAULT_SERVICE_SLUG` or a project missing `auth-service` would show the
   latter, which is the intended failure mode, not a crash.
2. Drag a node, then look at `.veistra/layout/auth-service.json` on disk
   directly — confirm it now holds the new position, and that no file under
   `.veistra/nodes/` or `.veistra/edges/` changed. Reopen the app and confirm
   the position survived (loaded back through `readLayout`).
3. Reparent or duplicate a node, then check `.veistra/nodes/` — confirm
   (per "What still doesn't persist" above) that **nothing changed on
   disk**, and that this matches what you expect before Wave 3/6 completes
   the partial-payload gap. If a human decides this gap should close sooner,
   it is `engine/engine.ts`'s `nodeJson`/`edgeJson` that need widening, not
   this file.
4. Look at the Outline against `fixtures/saas-backend/`: **13 rows** — the
   12 modules named in PRD §16.1 plus `token-pipeline`, a real `group` that
   is drawn like any other row — but status bar cell 1 should still read
   `.veistra/ · 12 nodes · 9 edges`, matching the wave 2 acceptance string
   exactly, because `countNodes` excludes annotation-tier kinds from the
   arithmetic while `graph.nodes` (what the Outline walks) still carries
   the group. That gap between 13 rows and a count of 12 is the ruling
   working as intended, not a bug — see "Ruling: a group is drawn but not
   counted" above. If the Outline shows 12 rows instead of 13, the group
   is being dropped from the projection again; if cell 1 reads 13, `graph/
   index.ts`'s `countNodes` regressed back to a bare `.length`. `http-entry`
   should carry no `ENTRY` badge (expected — a real gap in the schema, see
   above), the comment `two-caches-on-purpose` should draw nowhere at all
   (also a real gap, see above), and the edge lines will not match the
   stand-in's shape (also
   expected — "What actually differs" above lists which 5 of 9 changed).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EkL1TAeCe1DYp1FZFRhfXQ
