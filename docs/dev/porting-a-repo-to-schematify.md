# Porting a repository to Schematify

This page is the missing manual. It records what it actually takes to turn an
existing repository into a Schematify project, written while doing it to this
one — and, just as importantly, it records what the repository does **not**
tell you, because that is the list a future documentation or skills MCP server
has to fill.

Read [SCHEMATIFY-PRD.md](../design/SCHEMATIFY-PRD.md) for what Schematify is.
Read this for how to feed it.

---

## 1. What a port actually is

A Schematify project is a directory named `.kaava/` at the root of the
repository it describes. Nothing else. There is no database, no index, no
lockfile, no init command, and no registration step:

> On project open Schematify walks `.kaava/`, parses every file, and builds the
> graph in memory. There is no index to consult and none to keep in step.
>
> — `crates/schematify-core/src/load.rs`

So "porting a repo to Schematify" means exactly one thing: **writing a tree of
JSON files that `schematify_core::load_project` accepts and
`schematify_core::lint` does not flag.** Everything below serves that sentence.

The `.kaava/` tree describes the repository it sits in. It is committed
alongside the code, reviewed in the same pull request, and branches with it —
`crates/schematify-core/src/store.rs` calls that "the traceability property in
operation" rather than a defect.

---

## 2. The authority map

There is no single document that specifies the on-disk format. It is spread
across six places, and they do not all agree in emphasis. In descending order
of authority when they conflict:

| Authority | What it decides | Where |
|---|---|---|
| The serde structs | Field names, types, and which are optional. **This wins.** | `crates/schematify-core/src/{node,edge,product,decision,registry,layout,run,brief}.rs` |
| The loader | What is fatal, what is quarantined, what is merely reported | `crates/schematify-core/src/load.rs` |
| The linter | The 13 rules a finished tree must satisfy | `crates/schematify-core/src/lint.rs` |
| The slug type | What characters a slug may contain, and its uniqueness scope | `crates/schematify-core/src/slug.rs` |
| The PRD | Intent, tier model, the reasoning behind each rule | `docs/design/SCHEMATIFY-PRD.md` §3–§11 |
| The reference fixture | A worked example of every file kind | `crates/schematify-core/fixtures/saas-backend/.kaava/` |

**The PRD is a build specification, not a user guide.** It is written to an
agent implementing Schematify, and several of its examples are illustrative
rather than literal — PRD §5.7's screen example omits `id`, which the struct
requires. When the PRD and a struct disagree, the struct is what runs.

---

## 3. The on-disk contract, in full

```
.kaava/
├── brief.json                  ProjectBrief          semantic
├── nodes/<uuid>.json           Node                  semantic
├── edges/<uuid>.json           Edge                  semantic
├── screens/<uuid>.json         Screen                semantic
├── flows/<uuid>.json           Flow                  semantic
├── decisions/<uuid>.json       Decision              semantic
├── rules/<uuid>.json           Rule                  semantic
├── registry/libraries.json     LibraryRegistry       semantic
├── layout/<slug>.json          Layout                cosmetic
└── runs/<node-uuid>/           RunArtifact, AuditRow audit
```

One node per file, named for the identifier inside it. The single exception is
`registry/libraries.json`, which is one file holding an array.

### The three layers, and why they matter to a port

`crates/schematify-core/src/store.rs::layer_of` classifies every path into
`Semantic`, `Audit`, or `Cosmetic`, and this is not filing tidiness — it is a
permission boundary enforced by two mechanisms that will fire on your port:

- `.github/CODEOWNERS` assigns an owner to every semantic directory and
  deliberately assigns **none** to `runs/` and `layout/`.
- `.github/workflows/kaava-boundary.yml` runs
  `scripts/check-kaava-boundary.mjs`, which **fails any pull request touching
  `nodes/` and `runs/` together**, with one narrow exception for a lifecycle
  transition (one node file plus that node's `audit.json`).

A port that writes `nodes/` and also seeds `runs/` in the same commit is
blocked by CI. Write the semantic tree; leave `runs/` empty for a real
benchmark job to fill.

> Both files were *written* for a repo-root `.kaava/`. CODEOWNERS says so in as
> many words — its patterns are unanchored precisely "if this repository is
> ever opened as a Schematify project itself" — and CODEOWNERS is correct as
> written. The check script was not: its two path patterns required a directory
> before `.kaava`, so the gate matched the three fixtures and silently ignored
> the root. §9 has the details; it is fixed, with tests.

### Node — the common envelope

Every file under `nodes/` carries this, plus the fields its `kind` adds.

| Field | Type | Notes |
|---|---|---|
| `id` | UUIDv7 string | Must match the filename. A mismatch is reported as `MisnamedFile`, not fatal. |
| `slug` | string | `[A-Za-z0-9._-]`, non-empty, no leading `.`, ≤128 bytes. |
| `kind` | string | `service`, `module`, `contract-method`, `test-case`, `budget`, `doc-block`, `external-dep`, `comment`, `group`, or any user-registered string. |
| `title` | string | Drawn on the card. |
| `description` | string, optional | |
| `lifecycle` | string | `draft`, `specified`, `implemented`, … see `lifecycle.rs`. |
| `layer` | string, optional | `backend`, `data`, `edge`, `frontend`, `external`. Service and module only. |
| `parent` | UUID or null | The containment tree. **A dangling parent quarantines the node.** |
| `decisions` | array of `schematify://decision/<uuid>` | Optional. Dangling entries quarantine. |
| `authored_by` | `"human"` or `"agent"` | |
| `created` | RFC 3339 timestamp | |
| `superseded_by` | UUID or null | |

Added per kind:

- **service** — `entry_point` (prose), `exports` (array of contract-method
  UUIDs *inside this service*), `schemas`.
- **module** — `allowed_libraries` (array of library-registry UUIDs),
  `ui_refs` (array of `schematify://screen/<uuid>`). `facet_count` is
  **computed, never stored** — PRD §0.4 makes every count a draw-time
  computation.
- **contract-method** — `signature`, `params[]`, `returns`, `errors[]`,
  `semantics`, `exported` (bool).
- **test-case** — `given`, `when`, `then`, `impl_ref`, `status`
  (`declared` | `linked` | `passing` | `failing`), `last_result_ms`.
- **budget** — `metric`, `op`, `value`, `unit`, `tier`
  (`hard` | `soft` | `target`), `probe` (`{command, parser}`), `sign_off`.
- **doc-block** — `body`, `audience` (`agent` | `human` | `both`).
- **external-dep** — `registry_ref` (a library UUID), `usage_note`.
- **comment** — `body`, `author`, `anchor`. Annotation tier.
- **group** — `title`, `color`, `members[]`, `collapsed`. Annotation tier.

### Edge

```json
{ "id": "<uuid>", "kind": "depends_on", "source": "<uuid>", "target": "<uuid>",
  "created": "2026-09-06T00:00:00Z", "superseded_by": null }
```

Seven kinds: `contains`, `depends_on`, `implements`, `references_ui`, `covers`,
`satisfies`, `documents`.

**`contains` is never written as a file.** The `parent` field on the child node
*is* the containment relation. Containment draws as nesting; dependency draws
as a line. Writing a `contains` edge file is the single most likely first
mistake.

### Slug uniqueness scope

From `slug.rs::SlugScope`, and this is the rule that produces confusing load
errors if you get it wrong:

| Kind | Unique within |
|---|---|
| service | the project root |
| module | **its containment parent** |
| facet | **its module root — the nearest module ancestor, not the immediate parent** |
| screen / flow / decision | its collection |
| rule / library | its registry |

The facet rule is the trap. A facet nested three modules deep shares a slug
namespace with every other facet under the *top* module of that subtree. In
practice: prefix every facet slug with its module's slug.

### Decision slugs are structured

`DEC-<AREA>-<TOPIC>-<NNN>`, where AREA and TOPIC are uppercase letters and NNN
is exactly three digits — `slug.rs::is_decision_shaped` checks that shape.
This is the one slug that is deliberately structured; PRD §3.1 bans a
structured *identifier* and §3.3 permits a structured *slug*.

---

## 4. Identifiers

UUIDv7. Not v4, not sequential, not path-derived — PRD §3.1 rejects the last
two explicitly, because two agents on two branches that both mint `MOD-0042`
produce two nodes with one identity and no tool reports it.

`crates/schematify-core/src/id.rs` exposes `mint_id` and `IdMinter`, but
**nothing in the repository will mint ids for a tree you are authoring from
outside the app.** A port written by a script has to mint its own.

If you generate them, derive the random bits from a hash of a stable key
(kind + owner + slug) rather than from a random source. The result is still a
valid v7 — version and variant bits are what make it one — and a re-run then
produces the same tree, so a regenerated port shows an empty diff instead of
4000 changed files.

---

## 5. What the linter demands

`schematify_core::lint` runs 13 rules. Eight are errors and five are warnings.
A port aiming to land clean has to satisfy every error rule by construction:

| Rule | Severity | What a port must do |
|---|---|---|
| L01 containment is a tree | Error | One `parent` per node; never re-parent into a descendant. |
| L02 dependency is acyclic | Error | Detect and break cycles before writing. Real codebases have mutual imports; model the shared piece as its own module. |
| L03 budget without a probe | Error | Never write a `budget` node without `probe.command`. Drop the budget instead. |
| L04 library absent from registry | Error | Only put registry UUIDs in `allowed_libraries`. |
| L05 annotation with a semantic edge | Error | Give `comment` and `group` nodes no edges. |
| L06 dangling reference | Error | Every UUID reference must resolve. |
| L07 superseded decision, no successor | Error | Keep every mined decision `ACTIVE`. |
| L08 `ui_refs` ≠ `references_ui` | Error | Write both from one source. The edge is authoritative; the field is a cache. |
| L09 cross-service call to an unexported method | Error | Only fires on an edge *targeting a contract-method*. Module-to-module edges cannot trip it. |
| L10 shared node above its LCA | Warning | Only fires when the LCA is a real node and the parent sits above it. A shared node whose dependents span services never fires. |
| L11 contract method with no `covers` | Warning | Emit `covers` edges from test cases where the mapping is real. |
| L12 reference to a deprecated node | Warning | Nothing is deprecated in a fresh port. |
| L13 screen with no backing module | Warning | Resolve each screen's backing code paths to a module. |

Warnings are not failures, and some of them are the *point*: L10 and L11 firing
on a real repository is Schematify reporting a real finding about that
repository's architecture, not a defect in the port.

---

## 6. Marker tokens, and choosing not to write them

PRD §9.1 defines the link between a node and its code. The token is the literal
string `@kaava:` followed by a full UUID and an optional slug — written here as
`@kaava:<uuid> <slug>` on purpose, because a real one in this file would be a
real marker. `crates/schematify-reconcile/src/token.rs` matches it with a plain
regular expression that requires all five UUID groups, so the placeholder form
is inert and the literal form is not.

> **This is not hypothetical.** `kaava reconcile` on this repository today
> reports 9 `present, unknown` and 3 `duplicate` outcomes, and every one of them
> is PRD §9.1's own example token quoted as prose — in the PRD itself, in
> `token.rs`'s doc comments, in `scan.rs`'s test strings, and in
> `apps/schematify/ui/src/graph/module.ts`'s fixture data. Those predate this
> port and are why `kaava reconcile` exits 1 on a clean checkout. An earlier
> draft of this page added a tenth site by quoting the example verbatim.

`kaava reconcile` reports four outcomes: `matched`, `declared, absent`,
`present, unknown`, `duplicate`.

**Which nodes are even eligible is not what PRD §9.2 implies.**
`JsonFileGraph::load` marks a node as expected-to-carry-a-marker if and only if
its file declares a non-null `impl_ref` — *by field, not by kind*. `impl_ref` is
listed in PRD §5.5 on `test-case` alone. So in a port like this one, the 478
test cases are reconciled and the 645 contract methods are invisible to
reconciliation entirely, silently. If you want a contract method reconciled,
give it an `impl_ref`; nothing in the PRD tells you that, and nothing warns you
when you do not.

**A port does not have to write markers.** PRD §9.2 makes `declared, absent` an
error only *after* a node's lifecycle reaches `implemented`. A port that leaves
every node at `specified` is a complete, valid, reconcilable project whose
reconcile run reports every node as declared-and-absent without failing. That
is a legitimate end state: it is the design declared ahead of the code being
annotated, which is the direction Schematify is built to work in.

Writing markers later is purely additive and touches no `.kaava/` file except
the lifecycle transitions.

---

## 7. How to verify a port

`kaava reconcile` is **not** a validator. `JsonFileGraph::load` in
`crates/schematify-reconcile/src/graph.rs` reads only `.kaava/nodes/*.json` and
only three fields from each. It will happily pass a tree with dangling edges, a
broken containment tree, and a malformed registry.

The real check is `schematify_core::load_project` plus `schematify_core::lint`,
and **there is no command in this repository that runs them over an arbitrary
project.** They are reachable three ways:

1. **The `schematify/lint` app method**, via `pnpm probe --agent --server agent
   app_call`. Needs a running OpenKaava with developer mode on, and needs the
   project open. See [CLAUDE.md](../../CLAUDE.md).
2. **A Rust test in-tree**, the way `crates/schematify-core/tests/self_budgets.rs`
   pins `crates/schematify-core/self/.kaava/`.
3. **A throwaway binary with a path dependency on `schematify-core`**, which is
   what this port used:

```toml
# Cargo.toml, outside the workspace
[workspace]
[dependencies]
schematify-core = { path = ".../crates/schematify-core" }
```

```rust
let outcome = load_project(&root)?;          // report.quarantined, .unreadable,
                                             // .slug_collisions, .id_collisions
let report = lint(&outcome.graph);           // report.findings
```

Share `CARGO_TARGET_DIR` with the repo's `target/` and it compiles in about ten
seconds against the already-built crate.

**This gap is the single strongest argument for the skills MCP server.** A
`schematify_validate(path)` tool that shells to that binary would remove the
only genuinely awkward step in the whole procedure.

---

## 8. The procedure that worked

1. **Fix the service list by hand.** Tier 1 is a judgement call about what the
   repository *is*, and it is the one layer worth deciding rather than
   discovering. Sixteen services here: the Tauri backend, the shell frontend,
   six first-party apps, three npm packages, four crates, and the build and
   verification machinery.
2. **Fan out over slices to discover tiers 2 and 3.** Partition the source tree
   into slices small enough that one agent can read all of it, then run two
   passes per slice: structure (modules, containment, dependencies, external
   deps), then facets (contract methods, test cases, doc blocks, budgets).
   Force structured output against a JSON schema so nothing has to be parsed.
3. **Mine the product layer separately.** Decisions, the rule registry, the
   library registry, screens and flows all come from prose and manifests
   rather than from source structure, so they parallelise independently of
   step 2.
4. **Generate the files deterministically.** Do not ask a model to write the
   JSON. Ask it for structured facts and let a script mint the ids, enforce
   slug scopes, resolve references, break dependency cycles, compute the
   `ui_refs` cache from the `references_ui` edges, and lay out the Schematics.
   Every invariant in §5 above is a property of the generator, not of a prompt.
5. **Load, lint, fix, repeat** with the validator from §7.
6. **Run the repository's own gates**: `pnpm verify` and
   `node scripts/check-kaava-boundary.mjs`.

---

## 9. Traps

- **`.prettierignore` did not cover a repo-root `.kaava/`.** It excludes
  `crates/schematify-core/fixtures/*/` — the fixtures, not the concept. Worse
  than a formatting nuisance: `write_json_atomic` calls
  `serde_json::to_vec_pretty`, which expands every array, and Prettier collapses
  a short array back onto one line. Left format-checked, `pnpm format:check`
  would start failing the moment anyone dragged a node in the app. This port
  added a `.kaava/` entry with that reasoning written down.
- **`kaava reconcile` writes into `runs/`, and that is a commit CI rejects.**
  One `reconcile.json` per node — 490 files here — landing in the audit tree
  beside the semantic tree you just generated. Generate, validate, commit; run
  reconcile *after*, and do not commit what it wrote.
- **The boundary gate could not see a repo-root `.kaava/` at all.** Its two
  patterns began `.*\/\.kaava`, which requires a slash before `.kaava`, so
  `.kaava/nodes/<uuid>.json` matched nothing and the gate reported no violation
  — for exactly the case its own header and `.github/CODEOWNERS` say it is
  there to cover. It failed open and silently. Fixed on 2026-09-06 with the two
  tests that catch it, in `scripts/check-kaava-boundary.test.mjs`.
- **`contains` edges do not exist as files.** The `parent` field is the edge.
- **The facet slug scope is the module root, not the parent.** §3 above.
- **`kaava reconcile` passing means almost nothing.** §7 above.
- **Do not derive a UUIDv7's timestamp field from mint order.** It is tempting,
  because it makes ids sort in creation order. It also means inserting one node
  renumbers every node minted after it, so adding a single service turned a
  one-file diff into 1800 changed files. Derive the whole id from a stable key
  and let the graph carry the ordering.
- **Address a second pass by slug, not by id.** Anything computed from a
  generated tree — the covers mapping here — should record
  `(module, test, method)` slugs. An id is a function of your generator; a slug
  is a function of the repository.
- **`crates/schematify-core/self/.kaava/` already exists** and is *not* a
  self-port — it is six budget nodes pinning PRD §14.7's table, and
  `tests/self_budgets.rs` asserts them by value. Do not fold it into a
  repo-root port; the test resolves it against `CARGO_MANIFEST_DIR`.
- **PRD examples omit required fields.** §5.7's screen example has no `id`.
  Read the struct.

---

## 10. What this port produced

Written on 2026-09-06 against `main` at 0.4.0, from 136 Rust files and 334
TypeScript files.

| | |
|---|---|
| Files under `.kaava/` | 3229 |
| Nodes | 1810 — 17 services, 250 modules, 1543 facets |
| Facets by kind | 645 contract-method, 478 test-case, 199 external-dep, 186 doc-block, 35 budget |
| Edges | 1181 — 602 `covers`, 289 `depends_on`, 186 `documents`, 69 `references_ui`, 35 `satisfies` |
| Product layer | 43 screens, 16 flows, 89 decisions |
| Registries | 70 rules, 68 libraries |
| Load | 0 quarantines, 0 unreadable, 0 slug collisions, 0 id collisions, 0 misnamed |
| Lint | **0 errors**, 149 warnings — all L11 |
| `pnpm verify` | passes |

The 149 warnings are the point rather than a defect: L11 fires on a contract
method whose module declares test cases and none of them covers it. That is a
true statement about this repository's test coverage *of its own declared
interfaces*, and no other tool in the repo reports it. Line coverage never
reports that number — PRD §5.5 says so, and this is the first time the claim has
been run against real code.

Two passes produced those `covers` edges. A slug heuristic in the generator got
213; an agent per module, reading the actual test bodies, got 389 more across
149 methods, and every proposed pair survived validation against the graph. The
remaining 149 methods have no test that touches them.

The 17th service is `examples/echo-tool`. It was not in the original sixteen and
was added because the linter asked for it: `kaava-rpc` looked like a shared node
sitting above the lowest common ancestor of its dependents (L10), and the reason
was that the graph modelled only one consumer. The reference tool core is the
second, it is real, and adding it made the finding go away correctly rather than
by suppression. That is the linter doing its job on its own repository.

---

## 11. What exists, and what does not

**Exists and is good:**

- The complete schema, as executable serde structs with doc comments that
  explain intent, not just shape.
- The PRD's reasoning: §3.1 on why not sequential ids, §4.3 on the shared-node
  rule, §6.2 on why the layers split, §9.1 on why a regex and not a docstring
  parser. This is the most valuable prose in the repository and the hardest to
  reconstruct.
- A worked reference fixture with every file kind present, deliberately seeded
  with five lint findings so the Problems panel has something to draw.
- Mechanical enforcement written for a root `.kaava/` before one existed:
  CODEOWNERS covers it correctly, and the boundary check was one regex away
  from doing so.

**Does not exist:**

- Any document describing how to adopt Schematify on an existing repository.
  This page is the first.
- A `kaava init`, a scaffold, or any command that creates a `.kaava/` tree.
  `kaava` has exactly one subcommand, `reconcile`.
- A standalone validator. §7.
- A JSON Schema, a TypeScript type, or any machine-readable description of the
  format outside the Rust structs. An external generator has to be written
  against prose or against Rust source.
- A documented lifecycle-transition path for a bulk import: `Store::write_transition`
  writes one node and one audit row, which is correct for a person and wrong
  for a port promoting four hundred nodes at once.
- Guidance on granularity. Nothing says whether a Rust module is a Schematify
  module, or how deep containment should nest. The reference fixture implies
  an answer (7 services, 37 modules, 81 facets) and nothing states one.
- Any statement of what a *good* port looks like, as distinct from a valid one.
- Any statement that reconciliation keys on `impl_ref` rather than on node kind
  (§6). A contract method is silently outside reconciliation, and neither the
  PRD nor any surface says so.
- Any warning that `kaava reconcile` writes into `runs/`, which is the tree the
  boundary gate forbids you to commit beside `nodes/`. The two rules are each
  documented and their interaction is not.
- A way to run the linter from a terminal. §7.

---

## 12. What a Schematify skills MCP server should expose

Derived from what actually cost time here:

| Tool | Why |
|---|---|
| `schematify_validate(root)` | The single biggest gap. Wraps `load_project` + `lint` and returns quarantines, collisions and findings as structured data. §7. |
| `schematify_schema(kind)` | Returns the field list for a node kind, an edge, a screen, a rule — generated from the structs so it cannot drift. |
| `schematify_mint_id()` | Removes the "invent a UUIDv7 by hand" step, which is where a hand-written port goes wrong first. |
| `schematify_slug_scope(kind)` | Answers "unique within what?" without reading `slug.rs`. |
| `schematify_lint_rules()` | The 13 rules with severity and what satisfies each, so a generator can be written against them. |
| `schematify_write(root, objects)` | Writes a batch of nodes/edges atomically through `Store`, enforcing `allowed_together` so a caller cannot trip the boundary gate by accident. |
| `schematify_example(kind)` | Returns the reference fixture's instance of a file kind. |
| `schematify_reconcile(root)` | Runs the command *and reports that it wrote `runs/`*, so the caller knows not to commit that alongside the semantic tree. |
| `schematify_markable(root)` | Answers "which of my nodes does reconciliation actually look for?" — the `impl_ref` rule of §6, which nothing else surfaces. |

The first three would have removed most of the friction in this port on their
own.

**One design note for whoever builds it.** Every tool above is a read, a
schema question, or a write through `Store`. None of them should generate
design content, and the reason is this port: the model's job was to return
structured facts about the repository, and a deterministic generator did the id
minting, slug scoping, reference resolution and cycle breaking. Every defect in
the first generated tree — order-dependent ids, a facet resolved against the
wrong module, a screen whose backing path was prose, a dependency edge pointing
at the source's own service — was one bug in the generator, found by the linter
and fixed once. Had the model been writing the JSON, each would have been
scattered across a few hundred files and found one at a time.
