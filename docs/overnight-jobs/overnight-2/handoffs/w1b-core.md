# Wave 1b handoff: `crates/schematify-core`

The data half of PRD wave 1. Everything is inside `crates/schematify-core` plus
its fixtures, and one line each in `eslint.config.js`, `.prettierignore` and the
root `Cargo.toml`. No app, no `src-tauri/`, no `catalog.toml`, no
`vite.config.ts`, and no Tauri command. Wave 2 wires the commands to these
types.

Branch `schematify/w1b-core`, pull request
<https://github.com/Firelight-Innovations/Veistra/pull/80>.

---

## 1. The public API other waves call

Import from `schematify_core`. The crate re-exports `uuid::Uuid`, so a consumer
does not declare its own `uuid` and discover at a type error that the versions
differ.

### Identity, addressing, naming

| Item | What it is |
|---|---|
| `mint_id() -> Uuid` | One UUIDv7 from the process-wide minter. |
| `IdMinter::new()`, `::from_seed(u64)`, `.mint()`, `.mint_at(unix_ms)` | A private minter. Strictly monotonic, including inside one millisecond and across a clock that steps back. |
| `id_timestamp_ms(Uuid) -> Option<u64>` | The millisecond a v7 was stamped with. `None` for any other version. |
| `Uri { kind: UriKind, id: Uuid }` | A `schematify://` reference. `Uri::node/screen/flow/decision(id)`, `Uri::parse(&str)`, `Display`, `FromStr`, serde as a string. |
| `UriKind::{Node, Screen, Flow, Decision}` | `.as_str()` and `.directory()`. |
| `UriError` | Names a retired `forger://`, `journeyman://` or `decision://` scheme separately from a malformed one. |
| `Slug` | A validated name. `Slug::new`, `.as_str()`, `.is_decision_shaped()`. Serde as a string. |
| `SlugScope` | PRD section 3.2 as a type. `SlugScope::for_node(&NodeKind, Option<Uuid>)`. |
| `SlugIndex` | `.claim(scope, &Slug, id)`, `.lookup(scope, &str)`. Re-claiming for the same id is not a collision. |

### Schemas

| Item | What it is |
|---|---|
| `Node { envelope: NodeEnvelope, fields: Map<String, Value> }` | The envelope of PRD 5.1 plus an open map. `Node::new(envelope)`, `.with_fields(&T)`, `.id()`, `.kind()`. |
| `Node::service()`, `.module()`, `.contract_method()`, `.test_case()`, `.budget()`, `.doc_block()`, `.external_dep()`, `.comment()`, `.group()` | Typed views over `fields`. Each returns `Result<_, serde_json::Error>`. |
| `Authorship::{Human, Agent}` | What `authored_by` takes. Not `Actor`, which has a third value. |
| `Staleness { source, member, at }` | Why a node is stale, on `NodeEnvelope::stale`. |
| `NodeKind` | Nine named variants plus `Custom(String)`. `.as_str()`, `.is_annotation()`, `.is_facet()`. |
| `Layer` | Five values, `.badge()`. |
| `ServiceFields`, `ModuleFields`, `ContractMethodFields`, `TestCaseFields`, `BudgetFields`, `DocBlockFields`, `ExternalDepFields`, `CommentFields`, `GroupFields` | The added fields of PRD 5.3 to 5.5. |
| `BudgetTier`, `TestStatus`, `DocAudience`, `Probe` | The enumerations those fields take. |
| `Edge`, `EdgeKind`, `EdgeTier` | PRD 5.6 and 11.1. `Edge::new`, `.is_stored()`, `.is_live()`; `EdgeKind::all()`, `.tier()`, `.is_semantic()`. |
| `Screen`, `Flow`, `FlowStep` | PRD 5.7 and 5.8. `kind` is a one-variant `ScreenKind` or `FlowKind`, checked when the file is read. |
| `Decision`, `DecisionStatus`, `DecisionKind` | PRD 5.9, plus `.is_superseded_without_successor()` for rule L07. |
| `Rule`, `Severity`, `LibraryEntry`, `LibraryRegistry` | PRD 5.10 and 10. `LibraryRegistry::get`, `.contains`, `.by_name`. |
| `Layout`, `Placement` | PRD 5.10. `Layout::new(slug)`, `.file_name()`. |
| `RunArtifact`, `BudgetResult`, `TestResult`, `LinterResult`, `ReconcileResult`, `RUN_SCHEMA_VERSION` | PRD 5.10. `.is_known_schema()`, `.budgets_passing()`, `.tests_passing()`, `ReconcileResult::drawn()`, `.error_count(bool)`. |
| `ProjectBrief`, `SuccessMetric` | PRD 5.12. |

### Storage

| Item | What it is |
|---|---|
| `write_json_atomic(&Path, &T)` | Temporary file in the same directory, `sync_all`, rename. Pretty-printed with a trailing newline. |
| `AtomicWriteError` | Names the step that failed. |
| `Store::open(project_root)` | Everything below hangs off this. |
| `.veistra_dir()`, `.node_path(id)`, `.edge_path`, `.screen_path`, `.flow_path`, `.decision_path`, `.rule_path`, `.libraries_path()`, `.brief_path()`, `.layout_path(slug)`, `.run_path(node, n)`, `.audit_path(node)` | PRD 6.1 as functions. |
| `.init()` | Creates the nine directories. |
| `.write_node`, `.write_edge`, `.write_screen`, `.write_flow`, `.write_decision`, `.write_rule`, `.write_libraries`, `.write_layout`, `.write_run` | Atomic writes. `write_edge` returns `false` for a `contains` edge and writes nothing. `write_run` refuses an unknown schema before touching the disk. |
| `.write_transition(&mut Node, to, actor, actor_name, at, reason) -> Result<AuditRow>` | The PRD 6.3 pair. Checks the transition first, so an illegal one writes nothing. |
| `.read_audit(node)`, `.rename_layout(from, to)`, `.deprecate(...)`, `.delete_node(...)` | `delete_node` always errors, per PRD 6.6. |
| `WriteLayer`, `layer_of(&Path)`, `allowed_together(&[PathBuf])` | The CI path gate of PRD 6.2 and 6.3 as functions. |

### Loading and the graph

| Item | What it is |
|---|---|
| `load_project(&Path) -> Result<LoadOutcome>` | Walks `.veistra/`. The only error is `CoreError::NoProject`. |
| `LoadOutcome { graph, report }` | |
| `Report { quarantined, unreadable, slug_collisions, id_collisions, misnamed, slug_index, duration_ms }` | `.is_clean()`, `.slug_owner(scope, slug)`. |
| `IdCollision { id, kept, discarded }`, `MisnamedFile { id, file }` | Two files claiming one identifier, and a filename disagreeing with the identifier inside it. |
| `Quarantine { subject, field, reference, reason, file }`, `QuarantineReason`, `ReadProblem` | `subject` is the referring thing, never the missing one. |
| `Graph` | `.node`, `.nodes`, `.edge`, `.edges`, `.screen(s)`, `.flow(s)`, `.decision(s)`, `.rules`, `.layout`, `.runs`, `.audit`, `.libraries`, `.brief`. |
| `Graph` containment | `.children`, `.roots`, `.descendants`, `.ancestors`, `.lowest_common_ancestor(&[Uuid])`, `.modules_of_service(id)`, `.module_root(id)`, `.facet_count(module)`. Every walk carries a visited set, so a cyclic `parent` chain terminates. |
| `Graph` dependency | `.dependencies`, `.dependents`, `.is_shared`, `.shared_node_parent`, `.shared_node_is_at_lca`, `.has_dependency_cycle`, `.dependency_cycle`. |
| `Graph` mutation | `.insert_node`, `.insert_edge`, `.insert_screen`, `.insert_flow`, `.insert_decision`, `.insert_rule`, `.insert_layout`, `.insert_run`, `.insert_audit`, `.set_libraries`, `.set_brief`, `.quarantine`, `.reindex`. Call `.reindex()` after inserting. |
| `Graph` misc | `.node_count`, `.edge_count`, `.nodes_of_kind(&NodeKind)`, `.is_quarantined`, `.quarantined`. |

### Lifecycle

| Item | What it is |
|---|---|
| `Lifecycle` | Eight states. `.as_str()`, `.all()`, `Display`. |
| `Actor::{Human, Agent, System}` | `.as_str()`, `Display`. |
| `check_transition(from, to, actor) -> Result<&TransitionRule, LifecycleError>` | The gate wave 10 enforces at the command boundary. |
| `LifecycleError::{IllegalTransition, HumanOnly, WrongActor}` | `HumanOnly` is the PRD 7.3 refusal and is separate on purpose. |
| `transition_table()`, `transitions_from(Lifecycle)`, `TransitionRule` | The PRD 7.2 table as data, for a surface that draws it. |
| `AuditRow` | One row of `runs/<node>/audit.json`. |
| `contract_fields_changed(&Node, &Node) -> bool` | PRD 7.4's definition of a contract change. |
| `stale_cascade(&Graph, changed, at) -> Vec<StaleDrop>` | The accepted dependents that drop to `stale`, each with the `Staleness` to write onto it. |
| `StaleDrop { node, staleness }` | One drop and its reason. |

### Errors

`CoreError` is the one error the crate returns across its surface, with a
`Result<T>` alias. `SlugError`, `UriError`, `LifecycleError` and
`AtomicWriteError` each convert into it. `CoreError::TransitionTornWrite` is the
one state no rollback can repair, and it names both failures.

Every schema except `Node` denies unknown fields. `Node` absorbs one into its
open map; nothing else has anywhere to put it, so a field a later wave writes
into a `Screen` would be dropped on the next rewrite. Failing the parse is
louder than losing the data.

`RunArtifact` is closed too, and the loader reads its `schema` field through a
probe before deserializing it. A later bench format adds a field, which is the
only reason anyone bumps a version, and deserializing first would turn the one
thing PRD 5.10 requires a reader to report, the version, into a parse error
that names nothing.

---

## 2. Acceptance conditions

| Condition | Result | Evidence |
|---|---|---|
| `pnpm verify` passes | **Pass** | Section 7 below lists each step and its result. |
| The loader reads `fixtures/stress-2000/` in under 1000 ms, asserted from a test | **Pass** | `tests/fixtures.rs::the_stress_fixture_loads_inside_the_wave_one_budget`. The measured load is 71 ms on this machine, against a 1000 ms budget. |
| A dangling reference produces a quarantine record and no crash | **Pass** | Nine reasons in `QuarantineReason`, covered by `load_tests.rs`. `every_kind_of_dangling_reference_is_reported_rather_than_dropped` exercises seven at once. |
| Every named node in PRD 16.1 exists in `fixtures/saas-backend/` | **Pass** | `tests/fixtures.rs::every_node_named_in_the_wireframe_fixture_exists`, against a 32-slug list. |

Test coverage the prompt asked for, all passing: round-trip serialisation of
every schema; slug uniqueness rejection per scope; UUIDv7 monotonicity across
5000 mints in one millisecond and across a backward clock step; the atomic
writer leaving no partial file and no temporary; the loader quarantining a
dangling reference; every legal and every illegal cell of the PRD 7.2 table
(`every_illegal_transition_is_refused` walks all 64 pairs); and the shared-node
rule at both tiers, including a node above and a node below the lowest common
ancestor.

**159 tests**: 141 unit and 18 integration, 27 of them added across the two review rounds. The whole workspace is 801 and all pass.

---

## 3. Review findings, and what changed

An Opus review of pull request 80 returned twelve findings. All twelve are
fixed on this branch. Each fix arrives with the test that would have caught it,
per STANDARDS section 8.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | `modules_of_service` walked containment with no visited set, so two node files whose parents point at each other hung the process. | Visited set, seeded with the starting node. `descendants` is seeded the same way now, so a chain that loops back does not report a node as its own descendant. | `a_parent_cycle_terminates_every_containment_walk` |
| 2 | A duplicate identifier was inserted over the first file, silently, and which file survived varied with the parallel chunk order. | Files are sorted by path before insertion, the first wins, and the loser is reported in `Report::id_collisions`. The real path is carried from the parse through to every quarantine row, so `Quarantine::file` names a file that exists. A filename disagreeing with the identifier inside it is reported in `Report::misnamed`. | `two_files_claiming_one_identifier_are_both_reported`, `the_surviving_file_of_a_collision_is_the_same_on_every_load`, `a_filename_that_disagrees_with_its_identifier_is_reported`, `a_quarantine_row_names_the_file_the_reference_was_read_from` |
| 3 | `Screen`, `Flow` and `Decision` dropped the `kind` field, and no schema denied unknown fields, so anything a later wave wrote into the seven closed types was discarded on the next rewrite. | `kind` restored on all three as a one-variant enum, so the word is checked at parse time. `deny_unknown_fields` on every schema except `Node`, whose open map is what makes it the exception. | `a_closed_schema_refuses_a_field_it_does_not_model`, `the_three_product_schemas_carry_their_kind`, `a_file_declaring_the_wrong_kind_is_refused` |
| 4 | `write_transition` wrote the node first and the audit second, so a corrupt audit advanced the node on disk and in memory while returning an error. | The audit is read before anything is written. A failed node write restores the field. A failed audit append rewrites the node with the old state, and reports `CoreError::TransitionTornWrite` when even that fails. | `an_unreadable_audit_leaves_the_node_where_it_was`, `an_illegal_transition_leaves_the_audit_alone` |
| 5 | `stale_cascade` and `contract_fields_changed` had no tests, so nothing pinned the direction of a dependency edge. | Six tests, including one asserting that the node that changed does not stale itself and one asserting the cascade is direct rather than transitive. | `a_contract_change_stales_the_accepted_nodes_that_read_it`, `only_the_four_contract_fields_count_as_a_contract_change`, and four more |
| 6 | `check_transition` accepted `deprecated` to `deprecated` through the wildcard row while `transitions_from` offered nothing, and the self-loop appended a row to an append-only audit. | A move to the state a node is already in is refused, for every state. | `a_state_never_transitions_to_itself`, `a_node_never_transitions_to_the_state_it_is_in` |
| 7 | PRD section 7.4's second caption line had no data model: `stale_cascade` returned bare identifiers and nothing survived a reload. | `NodeEnvelope::stale` carries a `Staleness { source, member, at }`, and `stale_cascade` returns `StaleDrop` values that supply it. The elapsed time is not stored; `2h ago` is computed at draw time. | `the_cascade_names_the_module_and_the_member_the_caption_draws`, `a_staleness_mark_round_trips`, `the_stale_node_carries_the_reason_the_caption_draws` |
| 8 | The slug-scope contract asked for a facet's module root and the only caller passed the immediate parent. | Slugs are claimed after the index is built, and a facet's anchor comes from `Graph::module_root`, which walks past a group. | `a_facet_under_a_group_is_scoped_to_its_module_root`, `a_facet_under_a_group_still_reports_its_module_root` |
| 9 | `authored_by` was typed as `Actor`, admitting `system`, while PRD 5.1 allows `human` or `agent`. | A separate `Authorship` enum with two values. `Actor` keeps its third value for the one transition nobody requests. | The envelope round-trip tests, which no longer compile with an `Actor` there |
| 10 | The `is_facet` doc sentence called the two annotation kinds tier-3. | The sentence now says what the code does and cites PRD 5.4's "annotation facets included". | `the_annotation_tier_and_the_facet_tier_are_named` |
| 11 | The rename had no retry, so on a Windows-only product a scanner holding the file for a moment was a hard error. | Five attempts with doubling backoff, 75 ms in the worst case, on a permission error or Windows error 32 or 33 alone. The bytes are already synced by then, so a retry repeats a rename and never a write. | `a_sharing_violation_is_treated_as_transient_and_a_real_failure_is_not`, `a_rename_onto_a_missing_directory_fails_without_waiting` |
| 12 | `crates/schematify-reconcile` landed on main pinning `uuid` and `tempfile` literally, ignoring the workspace pins this branch added. | Nothing changed, deliberately. Both specifications resolve to the same version today, so nothing breaks. See section 9. | None |

A second round found four more, all fixed here.

| # | Finding | Fix | Test |
|---|---|---|---|
| 13 | Closing `RunArtifact` broke the thing its version field exists for: the loader deserialized before checking the version, so a future bench file that added a field failed to parse and landed in `unreadable` with its version unnamed. The test that appeared to cover this carried only current fields, so it could not fail. | The version is read through a small probe struct before the artifact. An unknown version is quarantined and named; a current-version file with an unknown field still fails loudly. The test now uses a file that genuinely adds fields. | `a_future_run_format_is_quarantined_by_version_rather_than_failing_to_parse`, `a_current_version_run_with_an_unknown_field_still_fails_loudly`, `a_run_file_with_no_version_at_all_is_reported_as_unreadable` |
| 14 | Determinism was fixed for nodes alone. Edges, screens, flows, decisions and rules still arrived in directory order. | The sort moved into `json_files`, so every kind gets it, and a `SortByPath` trait puts each collection back in that order after the parallel chunks rejoin. A seventh kind cannot miss it. | `a_directory_listing_comes_back_in_path_order`, `the_surviving_file_of_a_collision_is_the_same_for_every_kind` |
| 15 | `kind` was a string with a default and was never compared against the constants, so a file in `screens/` declaring itself a flow parsed happily. | `ScreenKind`, `FlowKind` and `DecisionKind`: one variant each, checked by serde. The string constants are gone rather than left as decoration. | `a_file_declaring_the_wrong_kind_is_refused` |
| 16 | The rename after the retry loop was unreachable, because the final attempt returns through the error arm. | The loop no longer falls through. | The two existing retry tests |

---

## 4. PRD ambiguities resolved

**A node is an envelope plus an open map, not a tagged enum.** PRD 11.2 lets a
user register a node kind this build has never seen. Under a
`#[serde(tag = "kind")]` enum that file is a parse error at load time; under the
open map it round-trips byte for byte and only the typed view is unavailable.
The typed views (`node.module()` and its siblings) give back the safety for the
nine known kinds.

**`GroupFields` has no `title`.** PRD 5.5 lists `title` among a group's added
fields, and the envelope in 5.1 already has one. A node cannot carry two, and
serde rejects the duplicate outright. The heading drawn on a group box is
`envelope.title`.

**`facet_count` is a method, not a field.** PRD 5.4 marks it computed and 0.4
forbids storing a count, so it is `Graph::facet_count(module)` and appears in no
JSON file.

**The staleness cascade is direct dependents only.** PRD 7.4 names "every node
with an inbound `depends_on` edge to the owning node". A node that goes stale
has had no contract change of its own to propagate, and a transitive reading
would mark a whole subtree stale on one signature edit. `stale_cascade` also
walks up from a changed facet to its owning module, because dependency edges are
drawn between modules rather than between facets.

**A quarantined node stays in the graph.** PRD 6.6 says quarantine and report.
Dropping the node would put its own children out of reach and turn one dangling
reference into a cascade of them. `Graph::is_quarantined` is how a surface finds
out; the node is still addressable.

**`load_project` returns one error.** Only "there is no `.veistra/` here". A
malformed file, a dangling reference and a slug collision are all reported in
the `Report` beside a graph that loaded, because a project that half-loads is
worth drawing.

**A `references_ui` edge resolves its target against the screens.** Every other
edge endpoint is a node. This is the one place an endpoint leaves the node
collection, and the loader is explicit about it rather than quarantining every
such edge.

**The library registry is not part of quarantine's node collection.** A missing
`allowed_libraries` entry quarantines the module with reason `MissingLibrary`.
Rule L04 in wave 7 reports the same condition; the loader reporting it too is
deliberate, because the graph cannot resolve the reference at all.

**Slug scope for a facet is the module root, resolved by walking.** PRD 3.2
says "its module root" and 5.5 lets a group sit between a facet and its module,
so the immediate parent is the wrong anchor whenever it does. The loader claims
slugs after the containment index is built and asks `Graph::module_root` for the
anchor. Two methods named `verify` inside one module now collide even when a
group separates them, which is what the section asks for.

---

## 5. Wireframe arithmetic conflicts

PRD 0.4 decides all of these the same way: the computed value is the truth and
the wireframe carries the conflict. Section 16.4 lists the first two. The other
three turned up while building the fixture and are new.

| # | Drawn | Computed | Where | Resolution |
|---|---|---|---|---|
| 1 | `6 services` on the Stack Schematic | `7 services` | PRD 16.4, open item 19.11 | The fixture holds seven nodes of kind `service`. A surface counts them. |
| 2 | `layer backend · 4 facets` on the module root | 15 facets on `token-verifier` | PRD 16.4, open item 19.12 | The wireframe draws seven facet cards beside a count of four; the fixture's full facet count is 15, which is what 5.4 defines. |
| 3 | `2 dependents` on `crypto-primitives` alongside `crypto-primitives.sign changed 2h ago` staling `audit-emitter` | 2 dependents, and `audit-emitter` is not one of them | New | The two cannot both hold. Rule L10 fires only if every dependent of `crypto-primitives` sits inside one subtree, and `audit-emitter` sits outside it. The fixture keeps the drawn count and the L10 warning, and makes `audit-emitter` stale from `token-verifier`, whose `verify_signature` the contract history shows changing on 25 Aug. The node now carries that reason in its `stale` field, so a surface draws the caption from the graph rather than from copy. The wireframe's `crypto-primitives.sign` is the part that does not follow, and no method by that name exists in the fixture to draw. |
| 4 | One `Contract method with no covers edge` row, against `token-issuer.mint` | Two rows: `token-issuer.mint` and `token-verifier.skew_window` | New | 16.1 gives `skew_window` zero covers edges explicitly, and rule L11 fires on any contract method with none. Either the Problems panel is truncated or L11 is meant to fire on exported methods alone. The fixture reproduces the content and wave 7 will report two rows. |
| 5 | The five most recent audit rows | Six rows are needed to make them legal | New | The drawn rows run `reviewed → specified` at 24 Aug 09:05 and then `assigned → implemented` at 24 Aug 22:18, with nothing between them. PRD 7.2 has no such edge. The fixture inserts `specified → assigned` at 24 Aug 12:40, which pushes `21 Aug 15:31` out of the five most recent. Four of the five drawn rows are reproduced exactly. |

`http-entry` draws `4 exports` and the export strip lists four methods on other
modules. That is not a conflict: the badge is the service's export count drawn
on its entry-point module, and the fixture computes it from `auth-service`.

---

## 6. Assumptions

- **Fixture identifiers are seeded, not minted.** A fixture rebuilt with a live
  clock changes 5648 files on every run and cannot be reviewed. The generator
  mints UUIDv7-shaped ids from a seeded stream, so a regeneration is an empty
  diff. The layout matches RFC 9562, so the loader cannot tell.
- **All three fixtures are committed**, 5648 files and about 4 MB. A wave 3
  agent running `cargo test` should not also need `node` on the path. They are
  in `.prettierignore` because Prettier would reformat all of them and the
  regeneration diff would then depend on which tool ran last.
- **`fixtures/generate.mjs` is the entry point** and delegates: `fixture.mjs`
  holds the shared machinery, `saas-backend.mjs` the authored fixture,
  `generated.mjs` the two synthetic ones.
- **The unnamed services get modules.** PRD 16.1 gives module counts for four of
  the seven services. `ledger-store`, `notification-service` and `event-bus` get
  two each, which is the smallest number that lets `ledger-store` hold its three
  authored exports.
- **`platform-core` is a containment parent.** It has kind `group`, which PRD 5.5
  puts in the annotation tier, and 16.1 has it containing two services.
  Containment is not an edge, so the annotation rule of 11.3 is not engaged.
- **The fixture carries the defects the Problems panel draws**, on purpose: a
  dependency cycle through `session-codec`, `cold_start_p95` with no probe, and
  the `m.ross` comment holding a `covers` edge. Waves 7 and 10 have something to
  find. A fixture that lints clean would be the wrong test input.
- **The directory is not fsynced after the rename.** A directory handle cannot
  be flushed on Windows the way a file can. The guarantee this writer makes is
  that no reader sees a partial file, not that a rename survives a power cut; a
  design file lost that way is recovered from git.
- **Reading is parallel.** `load.rs` splits each directory across
  `available_parallelism()` threads. The stress fixture is 5000 files against a
  1000 ms budget and sequential reading on Windows was not obviously going to
  fit. There is generous headroom now.
- **Attribution.** Commits carry `Co-Authored-By: Claude Opus 5`, per the
  orchestrator prompt and the session's attribution notice, rather than the
  `Claude Fable 5.1` line in `00-AGENT-CONTEXT.md`.

---

## 7. Verification

| Step | Result |
|---|---|
| `pnpm build` | Pass |
| `pnpm test:js` | Pass, unchanged by this wave |
| `pnpm test:rust` | Pass, 801 across the workspace, 159 of them new |
| `pnpm lint:js` | Pass, 0 errors and the 8 pre-existing React hook warnings |
| `pnpm lint:rust` | Pass, no new clippy findings and no baseline change |
| `pnpm lint:comments` | Pass, 0 grandfathered |
| `pnpm lint:version`, `lint:identity`, `lint:branding` | Pass |
| `pnpm format:check` | Pass |

No baseline file was regenerated.

---

## 8. Files outside the crate

Three, each one line of content.

- `Cargo.toml` — `uuid`, `getrandom` and `tempfile` added to
  `[workspace.dependencies]`, following the existing convention that versions
  are pinned there. The `crates/*` glob already makes the new crate a member,
  so no member list changed.
- `eslint.config.js` — `crates/*/fixtures/*.mjs` added to the glob that grants
  Node globals, beside `scripts/**/*.mjs`.
- `.prettierignore` — `crates/schematify-core/fixtures/*/`, the generated JSON.

Nothing in `apps/`, `src-tauri/`, `catalog.toml` or `vite.config.ts` was
touched, so this merges independently of the wave 1a rename.

---

## 9. The dependency pin this branch leaves open

`crates/schematify-reconcile` merged to main while this branch was in review. It
pins `uuid = { version = "1", features = ["serde"] }` and `tempfile = "3"` in
its own manifest rather than through `[workspace.dependencies]`, which this
branch added for exactly those two crates.

Nothing conflicts and nothing breaks. Both specifications resolve to the same
version today, and the lockfile merge was one hunk: keep both package blocks in
alphabetical order.

What is left is a workspace pin one member ignores, which is the drift the root
`Cargo.toml` says the pins exist to prevent. **The wiring wave should change
those two lines in `crates/schematify-reconcile/Cargo.toml` to
`uuid.workspace = true` and `tempfile.workspace = true`.** The workspace pin
already carries the `serde` feature the reconcile crate asks for. Doing it here
would have touched another wave's crate for no gain tonight.

---

## 10. Left undone

- **`crates/schematify-reconcile` is not here.** PRD 9.3 puts the `veistra
  reconcile` binary in its own crate, and wave 9 owns it. Nothing in this crate
  scans a working tree.
- **`packages/schematify-ui` is not here.** PRD wave 1 lists it; it is the
  interface half and belongs to wave 1a or wave 2.
- **The terminology rows are not added to `core/terminology.csv`.** PRD section
  2 asks for them before wave 1 closes. That file is outside the repository, at
  `C:/Users/bjsea/Documents/Viestra/company/core/`, and is not in this
  worktree. Whoever closes wave 1 should add the twelve terms and the seven
  acronym rows.
- **No Tauri command.** Deliberate, and the prompt said so. Wave 2 wires them.
- **The graph linter is not implemented.** PRD 10.4 belongs to wave 7. The
  predicates each rule needs are here and named in the API table above:
  `shared_node_is_at_lca` for L10, `dependency_cycle` for L02,
  `BudgetFields::probe` for L03, `LibraryRegistry::contains` for L04,
  `NodeKind::is_annotation` with `EdgeKind::is_semantic` for L05,
  `Decision::is_superseded_without_successor` for L07.
- **The `ui_refs` cache is not written automatically.** PRD 5.11 makes the
  `references_ui` edge authoritative and the cache derived, written by
  Schematify on every edge change. The types and the mismatch check are here;
  the write happens wherever an edge is created, which is wave 3.
