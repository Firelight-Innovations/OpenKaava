# Wave 9a handoff — marker scanning and `veistra reconcile`

## What was built

`crates/schematify-reconcile`, a new workspace member (picked up automatically
by the existing `crates/*` glob — no root `Cargo.toml` edit). Six library
modules plus a `veistra` binary target:

- `token.rs` — the `@veistra:<uuid> <slug>` marker grammar (PRD section 9.1), a
  compiled `Regex` built once per scan, and `parse_token`/`parse_captures` for
  testing the grammar directly.
- `scan.rs` — `scan_tree(root) -> ScanResult`, walking with `ignore::WalkBuilder`
  (`.gitignore` honored via `require_git(false)`, `node_modules`/`target`
  always excluded), reading every file's raw bytes and regex-matching line by
  line regardless of language.
- `graph.rs` — the `GraphLookup` trait (see below), `InMemoryGraph`, and
  `JsonFileGraph`.
- `outcome.rs` — `ReconcileOutcome`, one variant per PRD section 9.2 row, each
  carrying its evidence (`EvidenceSite` — file and line).
- `reconcile.rs` — `reconcile(root, graph) -> ReconcileRun`, the comparison
  that turns a scan plus a graph into outcomes; `has_error`/`exit_code`.
- `report.rs` — `write_run_files` (the `.veistra/runs/<node-uuid>/reconcile.json`
  writer) and `render_text`/`render_json` for the `--out` report.
- `src/bin/veistra.rs` — `veistra reconcile [--root <path>] [--out <path>]
  [--format text|json]`.

## Fixes from the Opus review of this PR

Five findings came back, two of them correctness bugs. All five are fixed in
this commit:

1. **Run artifacts landed at `<root>/runs/`, not `<root>/.veistra/runs/`.** PRD
   section 6.1 puts `runs/` inside `.veistra/`, beside `nodes/` — which
   `graph.rs`'s own loader already read from correctly. Fixed in `report.rs`
   (`write_run_files`) and the CLI test that asserted the old path.
2. **The scanner read `.veistra` and `.git` as source.** A `test-case` facet's
   `impl_ref` field (PRD 5.5/5.10) can hold the same marker text the scanner
   looks for, so the node file itself counted as a second occurrence and a
   correct project reported a false `duplicate` and exited 1. `scan.rs`'s
   `ALWAYS_SKIP_DIRS` now excludes `.veistra` and `.git` alongside
   `node_modules`/`target`; `scan::tests::a_marker_inside_veistra_or_git_produces_no_occurrence`
   covers it directly. Fixed together with finding 1, since moving `runs/`
   inside `.veistra` would have made the false duplicate worse otherwise.
3. **`veistra reconcile` returned exit code 2 when writing results failed**,
   colliding with PRD section 9.3's exit code 2, which is reserved for "the
   command read no project at that path." A write failure happens after the
   project read fine and reconciliation completed — a different failure
   class. It now uses exit code 3 (`EXIT_RESULT_NOT_WRITTEN` in
   `src/bin/veistra.rs`), a code the PRD does not claim; covered by
   `tests/cli_reconcile.rs::a_result_write_failure_exits_3_not_2`, which
   blocks `.veistra/runs/` from being created and asserts `Some(3)`.
4. **`uuid`'s `v4` feature was enabled but unused** (nothing in this crate
   generates a UUID; every one is parsed from a marker or a node file).
   Dropped from `Cargo.toml`, keeping only `serde`.
5. **The markable-node rule was too narrow and kind-based.** See "Widened
   the markable set" below.

## Public API for the wiring wave

**Implement `GraphLookup` (`crates/schematify-reconcile/src/graph.rs`) for
whatever `schematify-core` exposes as its loaded graph, and pass it (or `&dyn
GraphLookup`) to `reconcile::reconcile` in place of `JsonFileGraph`.** Nothing
else in this crate changes.

```rust
pub trait GraphLookup {
    fn lookup(&self, id: Uuid) -> Option<NodeFacts>;
    fn markable_node_ids(&self) -> Vec<Uuid>;
}
```

`NodeFacts { id, slug, kind, lifecycle }` carries `kind` and `lifecycle` as
the wire strings from the common node envelope (PRD section 5.1), not as
`schematify-core` enums — this crate cannot depend on that crate's types any
more than its code.

Two callers use this trait: `reconcile::reconcile(root: &Path, graph: &dyn
GraphLookup) -> ReconcileRun` (the comparison logic) and
`src/bin/veistra.rs::run_reconcile`, which today constructs `JsonFileGraph::load(&root)`
and would instead construct the real graph. `schematify_reconcile_status`
(the Tauri command PRD section 9.3 names) is expected to call
`report::write_run_files`'s output — it reads
`.veistra/runs/<node-uuid>/reconcile.json` off disk rather than calling into
this crate directly ("Schematify shall never scan the working tree from the
interface process," PRD 9.3) — so the wiring wave's other job is on the
`schematify-core`/Tauri side, not here.

### Widened the markable set — driven by data, not by kind

The first version of this crate limited `JsonFileGraph::markable_node_ids`
(the set checked for `declared_absent`) to nodes with `kind ==
"contract-method"`. Review pointed out PRD section 9.1 says every design
element *with a counterpart in code* carries a marker — broader than one
kind — and asked for the decision to follow the data rather than a list of
kinds this crate would have to keep in step with the schema.

`graph.rs` now reads each node file generically for a non-null `impl_ref`
field (PRD section 5.5's `test-case` field, "the code implementing the
test") and treats its presence — regardless of `kind` — as "this node
declares an implementation reference," hence markable. `NodeEnvelope` gained
an `impl_ref: Option<serde_json::Value>` field; `serde`'s `Option`
deserializer already collapses a JSON `null` to `None`, so a present-but-null
field behaves the same as an absent one. A future facet kind that adds an
`impl_ref`-shaped field is covered automatically, with no whitelist to
update.

This is still a schema-reading choice, not a PRD-stated rule — `impl_ref` is
the only field named in the schema for "this design element names its own
code implementation," so it is what "declares an implementation reference"
resolves to today. If Braden disagrees with tying markability to that one
field name, `JsonFileGraph::markable_node_ids` in `graph.rs` is the one place
to change it — `InMemoryGraph` (used by every other test) is unaffected,
since its `with_node(facts, markable: bool)` already takes markability as an
explicit caller-supplied bit.

## Acceptance conditions

| Condition | Status |
|---|---|
| `pnpm verify` passes | Pass — `build`, `test:js`, `lint:js` (0 errors), `lint:comments`, `lint:version`, `lint:identity`, `lint:branding`, `format:check` all green; `test:rust` (`cargo test --workspace`, 14 binaries, 0 failures) and `lint:rust` (`clippy-baseline.mjs`, 0 warnings above baseline) confirmed after the review fixes too |
| Duplicate marker token → error, exit code 1 | Pass — `tests/cli_reconcile.rs::duplicate_marker_token_exits_1` spawns the real compiled `veistra` binary via `CARGO_BIN_EXE_veistra` and asserts `Some(1)`; now also confirmed not a false positive from the `.veistra`-scanning bug (finding 2) |
| Every PRD 9.2 outcome reachable and tested | Pass — `Matched`, `DeclaredAbsent` (both `error: false` and `error: true`), `PresentUnknown`, `Duplicate` each have a direct unit test in `reconcile.rs`, plus `outcome.rs` tests each variant's `is_error`/`kind`/`drawn` mapping |
| Crate compiles and tests without `crates/schematify-core` existing | Pass — that crate does not exist in this worktree; `schematify-reconcile` depends on nothing under `crates/` |

40 tests total (35 unit + 5 integration), all passing as of this commit.

## Assumptions

1. **Which node "declares an implementation reference."** Resolved by
   ruling during review: markability is driven by a non-null `impl_ref`
   field on the node's own JSON, not by its `kind`. See "Widened the
   markable set" above for the reasoning and where to change it.
2. **`reconcile.json`'s schema.** PRD 9.3 names the path, not the shape. It
   is `{schema: "veistra-reconcile-v1", at: <rfc3339>, outcome: <the
   ReconcileOutcome, flattened>}`, mirroring how `run-<n>.json` carries a
   `schema` tag (section 5.10). Overwritten each run — the PRD gives this
   file no run number the way `run-<n>.json` has one.
3. **Which node id a `runs/` directory is keyed by, for `present_unknown` and
   `duplicate`.** Section 9.3 says the command writes one file "for every
   node it touches." Read broadly: `present_unknown` and `duplicate` outcomes
   key their `.veistra/runs/<id>/` directory by the marker's own id even though
   no graph node exists for it, rather than being omitted from the on-disk
   audit trail entirely.
4. **Exit code 2 also covers a bad CLI argument**, not only "no project at
   that path" — PRD 9.3 defines no other code for that failure class. A
   failure writing results *after* a successful project read and
   reconciliation is a third, distinct class and uses exit code 3
   (`EXIT_RESULT_NOT_WRITTEN`) instead — see "Fixes from the Opus review"
   above, finding 3.
5. **`declared_absent`'s error boundary** is lifecycle ∈ {`implemented`,
   `reviewed`, `accepted`, `stale`}, excluding `deprecated` (a superseded
   node is not expected to still be backed by live code) — see the doc
   comment on `LIFECYCLE_REQUIRES_MARKER` in `reconcile.rs`.
6. **`.gitignore` without a `.git` directory.** `ignore::WalkBuilder`
   defaults to requiring a discoverable `.git` before honoring any
   `.gitignore`. Set `require_git(false)` so "respect .gitignore" holds even
   for a fresh scaffold or a checkout without `.git` — this also matches the
   task instruction, which named `.gitignore` unconditionally.
7. **No `clap` dependency.** `--root`/`--out`/`--format` are hand-parsed in
   `src/bin/veistra.rs`; `clap` is not yet in this workspace's dependency tree,
   and three flags did not seem worth the addition or the `deny.toml` check.

## For the wiring wave: dependency consolidation, not yet done

This crate pins `uuid`, `regex`, `ignore`, and `chrono` directly in its own
`Cargo.toml` rather than through `[workspace.dependencies]`, because none of
the four was already there when this wave started. A separate, concurrent
branch is adding `uuid` to the workspace dependency table. Deliberately not
addressed here — that branch has not merged, and touching the same table
from two branches at once would only collide with it. Whoever lands second
(or the wiring wave, if it comes after both) should consolidate this crate's
four pins onto `[workspace.dependencies]` where an entry already exists.

## Left undone, and why

- **`schematify_reconcile_status`, the Tauri command PRD 9.3 names**, and any
  UI. Out of this wave's scope per the task brief (crate + CLI only); the
  wiring wave section above names what it would call.
- **`veistra`'s other subcommands** (load-graph, lint, search, etc. from PRD
  14.5/section 9 neighbors) — this binary has only `reconcile`; later waves
  add a subcommand by matching on it in `main`, no shared file to edit.
- **Comment-syntax-aware scanning was deliberately not built.** The PRD states
  the token is "found by plain regular expression" specifically because a
  per-language parser "breaks on the first language nobody anticipated." The
  scanner reads raw text with one regex for every file; the "handle the
  comment syntaxes... at minimum" requirement is met because that single path
  already handles Rust `//`, Python `#`, JSX `{/* */}`, HTML `<!-- -->`, and
  TOML `#` without special-casing any of them — tested directly in
  `scan.rs::finds_markers_across_several_comment_syntaxes`.

## Verification run

- `pnpm install` — clean.
- `cargo test -p schematify-reconcile` — 40 passed, 0 failed (re-run after
  the review fixes above; was 38 before finding 2's and finding 3's new
  tests).
- `cargo clippy` via `node scripts/clippy-baseline.mjs` — 0 warnings above baseline.
- `cargo fmt -p schematify-reconcile` — applied after both the initial
  commit and the review fixes, clean since.
- `pnpm run build`, `pnpm run test:js`, `pnpm run lint:js`, `pnpm run
  lint:comments`, `pnpm run lint:version`, `pnpm run lint:identity`, `pnpm run
  lint:branding`, `pnpm run format:check` — all green, re-run after the fixes.
- `cargo test --workspace` — 14 test binaries, all `test result: ok`, 0
  failures, re-run after the fixes.
