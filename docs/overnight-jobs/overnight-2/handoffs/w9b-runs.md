# Wave 9b handoff: the run artifact reader and ingestion

Scope: `crates/schematify-core` only. No app, no `src-tauri/`, no Tauri
command. Everything below is a pure function of the crate.

Branch `schematify/w9b-runs`.

---

## 1. What was already there

Wave 1b (see `handoffs/w1b-core.md`, finding #13) already built the
`RunArtifact` schema, `RUN_SCHEMA_VERSION`, `Store::write_run` (refuses an
unknown schema before touching disk) and `Store::run_path`, and it already
fixed the version-probe defect: `load_project`'s `read_runs` reads a small
`SchemaProbe { schema }` before deserializing the full artifact, so a future
format that adds a field is quarantined by version rather than failing to
parse. That defect is the one this wave was told not to regress.

## 2. What this wave built

**The reader**, factored out of `load.rs` into `run::read_run_artifact(bytes:
&[u8]) -> Result<RunArtifact, RunReadError>`. It is the exact same two-step
probe-then-parse `load_project` used inline before this wave; `load.rs`'s
`read_runs` now calls it instead of duplicating the probe struct, so the
loader's path and a new external-file path cannot read the version two
different ways. `RunReadError` distinguishes `UnknownSchema(String)` (the
probe read a version this build does not know) from `Malformed` (anything
else, including a current-version file that fails the closed-schema parse).
Six tests in `run.rs` cover the reader directly, including the "unknown
schema is not even attempted as a parse" case and the "current version,
unknown field, still fails loudly" case that finding #13 in wave 1b's own
retrospective says a weak test looked like it covered but did not.

**The ingestion**, in the new `crates/schematify-core/src/ingest.rs`:

- `ingest_run(graph: &Graph, store: &Store, scope: Uuid, artifact:
  RunArtifact) -> Result<()>` — the pure entry point. Takes an
  already-parsed artifact and a `scope`: the node whose CI workflow produced
  the run (per the fixture, `token-verifier`'s module node, not any budget
  node).
- `ingest_run_file(graph: &Graph, store: &Store, scope: Uuid, path: &Path)
  -> Result<()>` — reads a file CI dropped somewhere outside `.veistra/`
  through `read_run_artifact`, then calls `ingest_run`. **This is the entry
  point a later wave wires to a Tauri command**: give it the graph, the
  store, the node id, and the path CI wrote the artifact to.

Both are exported from the crate root (`schematify_core::ingest_run`,
`::ingest_run_file`), alongside `read_run_artifact` and `RunReadError`.

## 3. The two things the prompt asked to get right

**Findable from the budget it answers, explicitly.** PRD 6.1 keys `runs/`
by one node per directory, and one CI workflow answers several budgets in
one file — the `token-verifier` fixture run reports `verify_p95`,
`jwks_refetch_rate` and `cold_start_p95` in one artifact, and all three are
separate `budget`-kind nodes that are direct children of the module the run
is filed under. The pre-existing storage layout already implies that link
by path plus the `metric` string; nothing made it explicit or checked it.
Two things now do:

- `Graph::runs_for_budget(budget: Uuid) -> Vec<&RunArtifact>` (in
  `graph.rs`) is the read side: give it a budget node, it resolves that
  budget's containing scope and filters that scope's runs down to the ones
  whose `budgets` array carries a matching `metric`. A caller never needs to
  know that a run is filed under the *parent* rather than under the budget
  itself. Covered by a new fixtures.rs test,
  `a_budget_node_finds_the_run_that_answers_it_without_naming_its_module`,
  against the real `saas-backend` fixture: all three of `token-verifier`'s
  budgets resolve to its one run, and `token-issuer`'s `issue-p95` (which
  never ran) correctly finds nothing.
- `ingest_run` is the write side's half of the same check: before writing
  anything, it walks `scope`'s direct children, and if any `BudgetResult` in
  the artifact names a metric that matches no `budget` node there, ingestion
  is refused with `CoreError::RunAnswersNoBudget` — the artifact would land
  on disk but be permanently unfindable through `runs_for_budget`, so it
  never lands at all.

**Never corrupt or overwrite a good run.** `ingest_run` checks
`store.run_path(scope, artifact.run).exists()` before calling
`Store::write_run`, and refuses with `CoreError::RunAlreadyIngested` if a
file is already there — `write_json_atomic` itself is fine with an
overwrite (that is what makes an edit to a *node* safe), but a run is
audit evidence, and a stale or corrupted re-ingestion at the same run
number must never replace what already landed. Test
`a_second_ingestion_at_the_same_run_number_never_overwrites_the_first`
ingests once, attempts a second ingestion at the same run number with a
different `commit`, asserts the refusal, and then re-reads the file on disk
to assert it is still byte-identical to the first ingestion — not just that
the call returned an error, per the standing "a test that cannot fail is
worse than none" note. `CoreError::UnknownRunScope` covers the third
failure mode, a `scope` that names no node at all, for the same reason:
unfindable, so refuse before writing.

`ingest_run_file`'s own failure path is covered too: a file on disk
declaring a future schema version is refused with `UnknownRunSchema`
naming the version, and nothing is written under `scope`.

## 4. Assumptions and ambiguities, and the reading taken

- **`scope` is the module or service the workflow ran under, never a budget
  node.** PRD 5.10's example artifact and the `saas-backend` fixture both
  file one run under a module (`token-verifier`) that answers three budget
  children in one file. Building ingestion to require a *single* budget per
  run would have contradicted the fixture and the spec's own example, so the
  crate does not offer a "the node is the budget" reading anywhere.
- **The budget-match check looks at direct children of `scope` only, not
  the full descendant set.** Every budget node in the fixture is an
  immediate child of the node its run is filed under. Wave 1b's own
  ambiguity note on slug scoping walks past an intervening `group` for a
  *different* reason (module-root anchoring for slugs); nothing in section
  8 or the fixture shows a budget separated from its run's scope by a group,
  so this wave did not add that walk. If a future project nests a budget
  under a group before its module, `ingest_run` will refuse an otherwise
  legitimate artifact with `RunAnswersNoBudget`; widening `children(scope)`
  to `descendants(scope)` in `ingest.rs` is the one-line fix if that turns
  out to be real.
- **`ingest_run` does not auto-assign a run number.** The `run` field is
  part of the CI-authored `veistra-bench-v1` payload, per PRD 5.10's own
  example (`"run": 1184`), and `Store::write_run` already writes to
  `run_path(scope, run.run)`. Ingestion trusts CI's own number and refuses a
  collision rather than silently renumbering, which would let two different
  results end up claiming the same evidence.
- **An artifact with an empty `budgets` array is never refused.** A run
  that reports only tests, the linter, or reconciliation (no budgets) has
  nothing to validate against a budget node, so the loop in `ingest_run`
  is vacuously fine. Nothing in the fixture exercises this case; it follows
  from `#[serde(default)]` already making `budgets` optional on the wire.

## 5. Left undone

- No Tauri command. Per the prompt, this is a later wave's wiring; call
  `schematify_core::ingest_run_file(&graph, &store, scope, path)`.
- No CLI or script drops a real CI-produced file anywhere; this wave only
  proves the crate-level machinery against artifacts built in tests and the
  fixture.
- `Graph::runs_for_budget` is not wired into the linter or any drawn
  surface. It exists as the API a later wave's Budgets tab or rule reads.

## 6. Verification

`pnpm build`, `pnpm test:js`, `pnpm lint:js`, `pnpm lint:comments`,
`pnpm lint:version`, `pnpm lint:identity`, `pnpm lint:branding`,
`pnpm format:check` all run in this wave's process; `pnpm test:rust` and
`pnpm lint:rust` run backgrounded. Results are reported in the pull request
once every step finishes; `cargo test -p schematify-core` alone (183 unit
tests plus the fixtures, lint and registries integration suites, including
the new tests this wave added) passes with 0 failures ahead of the full
workspace run.
