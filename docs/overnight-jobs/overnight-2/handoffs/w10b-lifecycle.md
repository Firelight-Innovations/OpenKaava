# Wave 10b handoff: lifecycle enforcement and the staleness cascade

Branch `schematify/w10b-lifecycle`, off `main`. Scope: PRD §7 in full, §6.3
(the lifecycle write exception), §5.1 (the node envelope's `stale` field),
§14.5 (`schematify_transition`), §14.6 (boundary enforcement — CODEOWNERS and
the path-scope gate were already built by wave 10a; this wave only had to
respect them, not build them).

## 1. What was built

### The `schematify/transition` command (`src-tauri/src/apps/schematify.rs`)

Wired the one PRD §14.5 operation the wiring wave deliberately left unwired
("wiring `transition` without its gate would make an enforcement point that
enforces nothing"). Takes `actor`, `node` (the whole current node, same
convention as `write-node`), `to`, `actorName`, `at`, `reason`, and calls
`Store::write_transition` — the crate's own atomic node-write-plus-audit-append
from wave 1b. `check_transition` runs inside that call, before either write
lands, so an illegal or agent-only-restricted move writes nothing.

**PRD §7.3's human-only gate is enforced by construction, not a special
case**: `actor_param` (already present from the wiring wave) admits only
`"human"` or `"agent"` from a client — never `"system"` — and
`Store::write_transition` refuses `reviewed → accepted` or `stale → accepted`
from an agent token before touching disk. `core_rpc` gained one branch: a
`CoreError::Lifecycle` refusal maps to `-32602` (INVALID_PARAMS) instead of
the generic `-32603`, and carries `LifecycleError`'s own message (`HumanOnly`
names itself), so a caller can tell "you may not" from "the disk failed."

**Proved at the boundary, not just in the core** (the acceptance condition
asked for this explicitly): `transition_rejects_an_agent_reaching_accepted_at_
the_command_boundary` and its `..._from_stale_too` sibling call `dispatch`
with `"schematify/transition"` exactly as a real `invoke` would reach it —
not `schematify_core::check_transition` directly — and assert the file on
disk and the audit history are both untouched after the refusal. **Made to
fail on purpose**: temporarily replaced the `actor_str` match in `transition`
with a hardcoded `Actor::Human` (bypassing the real gate) and reran just
these two tests — both failed with the RPC call succeeding and returning a
`to: "accepted"` node instead of an error. Reverted before committing.

### The staleness cascade (PRD §7.4)

Wired into `schematify/write-node`, not `transition` — a contract change is
an edit to a `contract-method`'s `signature`/`params`/`returns`/`errors` or a
service's `exports`, which travels through an ordinary node write, and the
node making the change need not itself transition. `write_node` now loads the
project before writing (to get the "before" shape), writes, and — only if
`contract_fields_changed` says the write changed a contract field — calls
`apply_stale_cascade`, which walks `stale_cascade` (wave 1b, already fully
implemented and tested against a cycle-safe visited-set graph walk) and drops
each `accepted` dependent to `stale` via `Store::write_transition` with
`Actor::System`, so every drop gets its own audit row like any human or agent
move. `NodeEnvelope.stale` (the crate's own doc comment: "Wave 10 sets it;
this crate defines it") is set from the `Staleness` mark before that write.

**`at` is validated before anything is written**, not after: if the write
changes a contract field, an RFC 3339 `at` is required in `params`
(`INVALID_PARAMS` otherwise) and checked *before* `store.write_node` runs, so
a missing timestamp never leaves the changed node's own file ahead of a
cascade that then could not run. An ordinary write that changes no contract
field needs no `at` at all — existing/future non-cascading `write-node` calls
are unaffected.

**Made to fail on purpose**: replaced `contract_changed` with a hardcoded
`false` and reran `write_node_stales_an_accepted_dependent_when_a_contract_
field_changes` — failed (`staled` came back empty against an expected
`token-issuer` drop). Reverted before committing.

**Not made atomic across the whole cascade set**, on purpose: `Store::
write_transition` keeps one node's write and its audit row atomic with each
other (PRD §6.3), but PRD §7.4 names no cross-node transaction. If a later
dependent's write fails after an earlier one in the same cascade already
landed, the changed node's own write has still committed and the cascade is
left partially applied — documented on `apply_stale_cascade`, not hidden.
A human re-review still resolves any node correctly whichever way it landed;
nothing is corrupted, only incomplete.

### The caption's second line (`apps/schematify/ui/src/graph/`)

`project.ts`'s own comment already flagged this as a known gap ("Only STALE
is derivable tonight"): the `badge: "STALE"` was wired by the wiring wave,
but `staleReason` — PRD §7.4's `crypto-primitives.sign changed 2h ago.
Re-review required.` — was never populated, even though `types.ts` already
declared the field. New file `staleness.ts` (`agoCompact`, `staleCaption`)
computes the elapsed-time phrase at draw time (never stored, matching every
other computed number in this app) from the raw `Staleness` mark
`schematify/load-graph` now serializes on a stale node's envelope.
`project.ts` resolves `stale.source` (a node id) against the `byId` map it
already builds, and wires the result into `GraphNode.staleReason`. Exact
wireframe wording pinned by `staleness.test.ts` and a new `project.test.ts`
case using `vi.spyOn(Date, "now")`.

## 2. Acceptance conditions

| Condition | Result |
|---|---|
| A contract change drops every dependent from `accepted` to `stale`, asserted over a real fixture in the Rust crate | **Pass.** `write_node_stales_an_accepted_dependent_when_a_contract_field_changes` builds a small dependency graph through the real `Store`/`dispatch` path (not a hand-typed stand-in), changes a `contract-method`'s `params`, and asserts the one `accepted` dependent drops to `stale` with the right `Staleness` mark while a `draft` dependent is untouched. |
| An agent call to the accept transition is rejected at the command boundary | **Pass**, asserted through `dispatch("schematify/transition", …)`, not `check_transition` directly — see the "made to fail on purpose" note above. Covered from both legal predecessor states, `reviewed` and `stale`. |

## 3. Every test added, and which were made to fail on purpose

7 new Rust tests in `schematify.rs` (19 → 26), all under
`apps::schematify::tests`, plus two small fixture helpers
(`sample_module`, `sample_contract_method`) the cascade tests share:

- `write_node_stales_an_accepted_dependent_when_a_contract_field_changes` — **made to fail on purpose** (see §1).
- `write_node_does_not_cascade_when_nothing_but_a_comment_changed`
- `write_node_refuses_a_contract_change_with_no_at_and_writes_nothing`
- `transition_moves_a_node_and_appends_the_audit_row_a_reader_gets_back`
- `transition_rejects_an_agent_reaching_accepted_at_the_command_boundary` — **made to fail on purpose** (see §1).
- `transition_rejects_an_agent_reaching_accepted_from_stale_too`
- `transition_refuses_an_illegal_move_and_writes_nothing`

`"schematify/transition"` was also added to the two existing table-driven
tests (`every_method_below_state_refuses_a_missing_actor`,
`..._refuses_a_call_with_no_open_project`), so it inherits that coverage
automatically.

7 new Vitest cases in `staleness.test.ts`, 2 new cases in `project.test.ts`.

## 4. Verification

| Step | Result |
|---|---|
| `cargo test -p veistra-orchestrator --lib apps::schematify::` | Pass, 19 → 26 tests (see §3) |
| `pnpm build` | Pass |
| `pnpm test:js` (workspace + `packages/bridge`) | Pass, 641 + 28 |
| `cargo test --workspace` (fail-fast) | Stopped on the first failing target, a pre-existing flake — see below |
| `cargo test --workspace --no-fail-fast` | Ran every target: all unit tests pass (including `schematify-core`'s 173 and `veistra_orchestrator_lib`'s full suite), 5 integration-test **binaries** fail — all the same pre-existing flake, none in code this wave touches — see below |
| `pnpm lint` (version/identity/branding/js/rust/comments) | Pass — `lint:js` is 0 errors, 8 pre-existing React-hook warnings unrelated to this wave; `lint:rust` (clippy) 0 warnings above the baseline of 0 |
| `pnpm format:check` | Pass (`cargo fmt --check` and `prettier --check` both clean) |
| `node scripts/check-comments.mjs` | Pass, 445 files, none above limit (0 grandfathered) — required trimming the module doc comment and `apply_stale_cascade`'s doc comment, and rewriting `staleness.ts`'s comments, to stay under the 20-line run cap |
| `npx vitest run apps/schematify` | Pass, 262 tests |
| `npx eslint` on the four changed/added TS files | Clean |

**None of the `cargo test --workspace` failures are this wave's.** All 5
failing integration-test binaries — `veistra-tool-manifest`'s
`reference_manifest`, and `schematify-core`'s `fixtures`, `lint`,
`registries`, and `self_budgets` — panic on the same error shape,
`NoProject { root: "…\\.worktrees\\sch-review-w6\\crates\\schematify-core
\\fixtures\\…" }` (and one on `w9b-review` for `veistra-tool-manifest`):
a path baked in at compile time from `env!("CARGO_MANIFEST_DIR")`,
resolved against whichever worktree last compiled that test binary into
the **shared** `CARGO_TARGET_DIR` — neither `sch-review-w6` nor
`w9b-review` is this wave's worktree (`sch-w10b-lifecycle`). This is the
same shared-target-dir staleness defect the orchestrator named as
`sch-fix-flake`'s to own, just manifesting on two crates rather than the
one crate its original report named — worth flagging back, not fixing
here. Every unit-test target (no fixture path involved) passes clean,
`veistra_orchestrator_lib`'s (this wave's crate) included in full.

## 5. Assumptions

- **`schematify/transition`'s `node` param carries the whole node**, exactly
  like `write-node` — `Store::write_transition` rewrites the whole file, and
  this handler has no second source of truth to fill in the rest from. A
  caller that only sends `{id, to}` will fail typed deserialization.
- **`at` is trusted from the caller**, for both `transition` and the cascade
  — `crates/schematify-core` has no clock of its own (its id minter is
  seeded, not wall-clock-driven, for the same reason `write_transition`'s
  `at: &str` parameter already was in wave 1b), and every other Schematify
  timestamp (`node.created`, `Decision.date`) already follows this
  convention. Adding `chrono` (which `crates/schematify-reconcile` already
  pins independently, per the wave 1b handoff's open item) to get a
  server-side clock felt like scope creep for a command with no live
  frontend caller yet.
- **The cascade's audit `reason` is a fixed string**, `"An upstream contract
  changed."`, not something a caller supplies — PRD §7.2's trigger column
  already states the cause ("An upstream contract changes"), and there is no
  human in the loop at the moment this fires to author a better one.
- **`apply_stale_cascade`'s actor name is the literal `"schematify"`** — PRD
  §7.2's audit row needs *a* name beside the `system` actor, and no other
  identity exists for an automated transition.

## 6. Left undone

- **No frontend caller of `schematify/transition` yet.** The Inspector's
  accept/reject buttons (PRD §12.7's lifecycle actions) are UI work no wave
  before this one built the surface for — `backend.ts`'s own header already
  says `write-node`/`write-edge` "are not called from here"; `transition`
  joins that list. Wiring it is a future wave's job once that UI exists.
- **`schematify_ingest_run` and `schematify_search`** — explicitly out of
  this wave's scope (owned elsewhere per the orchestrator prompt), and per
  the wiring handoff, being built on other branches tonight.
- **The `ui_refs` cache write** (PRD §5.11) and the review queue (S-25, PRD
  §20) — explicitly out of scope, owned by other agents.

## 7. What a human should verify on screen

Nothing in this wave changed anything renderable without a live `.veistra/`
project open in a real Veistra window — no browser was available, and none
of this wave's claims rest on a screenshot. Once a project with a `stale`
node exists (or `crates/schematify-core/fixtures/saas-backend/`'s own
`audit-emitter` fixture is loaded through a Schematic that draws the Outline),
worth checking by eye:

- The Outline row for a `stale` node draws the caption's second line
  (`staleness.ts`'s output) under the `⚠ STALE — upstream contract changed`
  primary line, matching the wireframe's two-line form exactly.
- A contract-method edit that changes `signature`/`params`/`returns`/`errors`
  through the real UI (once wave-later work wires a facet editor to
  `write-node`) actually produces the cascade end to end, not just through
  the `dispatch`-level test here.
