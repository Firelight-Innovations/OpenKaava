# Wave 7a handoff: the graph linter rules

The Rust half of PRD wave 7. Rules L01 through L13 of PRD section 10.4, in
`crates/schematify-core/src/lint.rs`, plus the finding type the Problems panel
of PRD section 12.14 is built against.

Nothing in `apps/`, nothing in `src-tauri/`, no Tauri command, no interface
file. The panel, the severity glyphs, the collapsed strip and status-bar cell 3
are the interface half and belong to a later agent.

Branch `schematify/w7a-linter`, pull request
<https://github.com/Firelight-Innovations/Veistra/pull/83>.

---

## 1. The interface the Problems panel is built against

Import from `schematify_core`.

```rust
pub fn lint(graph: &Graph) -> LintReport
```

One call, one pass, no state. The linter opens no file and writes nothing, so
a panel may re-run it after every edit.

### The four columns, and where each comes from

PRD section 12.14 gives the panel `SEVERITY`, `RULE`, `NODE` and `LOCATION`.
Every one of them is read off a `Finding`. The panel formats nothing and
computes nothing, deliberately: a cell the panel invents is a second
definition of what the rule found, and the two drift.

| Column | Read from | Example from the reference fixture |
|---|---|---|
| `SEVERITY` | `finding.severity` (`Severity::Error` or `Warning`) | `● ERROR` |
| `RULE` | `finding.rule.name()` | `Budget declared without a probe` |
| `NODE` | `finding.node_cell` | `token-verifier · cold_start_p95` |
| `LOCATION` | `finding.location.cell()` | `› Token Verifier` |

The glyph in the `SEVERITY` cell (`●` and `▲`) is the panel's, because it is a
drawing decision and PRD section 13 owns the token it is drawn in. Everything
else in the row is a string this crate produced.

### The click-through

`Each row navigates to the offending node on the correct Schematic`, per PRD
section 12.14. Two fields carry that:

- `finding.location.schematic() -> Option<Uuid>` names the node whose
  Schematic to open. `Some(service)` is a Service Schematic, `Some(module)` a
  Module Schematic, `None` the Stack Schematic, the decision log or the product
  surface, which the `Location` variant distinguishes.
- `finding.subject: Uri` names what to select once it is open. It is a
  `schematify://` reference rather than a bare identifier, so a screen row
  (rule L13) and a decision row (rule L07) are addressable in the same field
  as a node row without the panel guessing which collection to look in.

### The type, in full

```rust
pub struct Finding {
    pub rule: RuleId,        // L01..L13; carries name() and severity()
    pub severity: Severity,  // copied, so a sort needs no table lookup
    pub subject: Uri,        // what to select: node, screen or decision
    pub node_cell: String,   // the NODE column, drawn
    pub location: Location,  // the LOCATION column, and the surface to open
    pub detail: String,      // one sentence of evidence, for a tooltip
    pub evidence: Vec<Uuid>, // the other elements: cycle members, the edge
}

pub enum Location {
    Stack,                                 // "Stack"
    Service { id: Uuid, title: String },   // "Stack › Auth Service"
    Module  { id: Uuid, title: String },   // "› Token Verifier"
    DecisionLog,                           // "Decision Log"
    Product,                               // "Product"
}
```

`Location` carries the title as well as the identifier so `cell()` renders
without the graph in hand. A panel that held only the drawn breadcrumb would
have to parse it back into an identifier before it could navigate.

`evidence` is what the drawn cell had to leave out. The dependency-cycle row
draws `session-codec → token-issuer → …` and carries all three members, so an
Inspector can list the whole cycle and a future "select the cycle" affordance
has something to select.

### The report

```rust
pub struct LintReport {
    pub findings: Vec<Finding>,  // sorted: errors, then warnings
    pub nodes: usize,
    pub edges: usize,
    pub screens: usize,
    pub decisions: usize,
    pub rules: usize,            // always RULE_COUNT
}
```

with `errors()`, `warnings()` and `of(RuleId)`. The first two are what
status-bar cell 3 counts; PRD section 0.4 makes them computed at draw time,
which they are, on every call.

The four input counts exist so a test can state what was linted. A duration
budget asserted against a report that walked nothing is a test that cannot
fail, and this build has been caught by that shape before.

**Sort order.** Errors above warnings, then by rule code, then by the drawn
`NODE` cell, then by subject identifier. Fully deterministic, so a rerun over
an unchanged graph draws the same rows in the same order and a panel needs no
sort of its own.

---

## 2. The rule table

`CATALOG` in `lint.rs` is PRD section 10.4 as data. One row per rule, holding
the identifier, the drawn name, the severity and the function that finds it.
`lint()` walks that array and nothing else.

| Rule | Drawn name | Severity | Fires on the reference fixture |
|---|---|---|---|
| L01 | Containment graph is a tree — no node has two parents | Error | no |
| L02 | Dependency graph is acyclic | Error | **yes** |
| L03 | Budget declared without a probe | Error | **yes** |
| L04 | Library whitelisted but absent from registry | Error | no |
| L05 | Annotation node carrying a semantic edge | Error | **yes** |
| L06 | Dangling reference after resolver exists | Error | no |
| L07 | Superseded decision without a successor | Error | no |
| L08 | ui_refs cache does not match references_ui edges | Error | no |
| L09 | Cross-service call to a non-exported method | Error | no |
| L10 | Shared node sits above the LCA of its dependents | Warning | **yes** |
| L11 | Contract method with no covers edge | Warning | **yes** |
| L12 | Reference to a deprecated node without acknowledgement | Warning | no |
| L13 | Screen with no backing module | Warning | no |

### How wave 8 adds a fourteenth rule

Three edits, none of them inside an existing function:

1. Add a variant to `RuleId`. The compiler then refuses to build until
   `RuleId::code` names it, which is the reminder that the other two steps
   exist.
2. Write the rule as a free function with the signature
   `fn(&Scan<'_>, &mut Vec<Finding>)`.
3. Add one `CatalogRow` naming the identifier, the drawn name, the severity
   and that function.

Nothing dispatches on `RuleId`, so no `match` grows an arm. This is the shape
`EdgeKind` uses in the engine, and the reason for it is that a linter is
exactly where a list of special cases accumulates: waves 8 and 10 both add
here, and the structure that survives them is one where adding is appending.

`Scan` is the graph plus the indexes a rule would otherwise rebuild: inbound
covers counts, `contains` edge sources, `references_ui` edges by module and by
screen, the dependency adjacency, and test cases per parent. Built once. A new
rule should reach for it rather than walking `graph.edges()` again.

---

## 3. Acceptance conditions

From PRD section 17, wave 7, the half this branch owns.

| Condition | Result | Evidence |
|---|---|---|
| `fixtures/saas-backend/` produces exactly the 5 rows of PRD section 16.1, same rule names, node cells and location cells | **Pass** | `tests/lint.rs::the_wireframe_fixture_draws_the_five_rows_the_problems_panel_draws`, which asserts all four cells of all five rows against a literal table, and asserts the count is five |
| Errors sort above warnings | **Pass** | `tests/lint.rs::errors_sort_above_warnings_in_the_wireframe_fixture` |
| The linter runs over `fixtures/stress-2000/` in under 500 ms, asserted from a test suite | **Pass** | `tests/lint.rs::the_stress_fixture_lints_inside_the_wave_seven_budget`. **29 ms** measured on this machine against a 500 ms hard budget, in the unoptimised `cargo test` build, so the shipped figure is lower |
| `pnpm verify` passes | **Pass** | Section 6 lists every step |
| Both badges stay visible on the collapsed strip | **Not this branch** | Interface half. `LintReport::errors()` and `::warnings()` are what it counts |

### The budget assertion, and why it cannot pass vacuously

`fixtures/stress-2000/` lints **clean**: zero findings. It holds 20 services
and 1980 bare modules, with no facet, no screen, no decision and no library, so
nine of the thirteen rules have nothing to look at; the generator wires every
dependency edge backwards in mint order, which leaves L02 nothing; and its
edges run between services as well as inside them, so a shared module's
dependents share only the project root and the module sits *below* that rather
than above it, which is not what L10 fires on.

A timing assertion over an empty report is exactly the shape the reviewers have
flagged twice on this build, so the test states what went in and what came out
before it times anything:

- the fixture loaded 2000 nodes and 3000 edges, and the load report is clean;
- the run reports 13 rules dispatched, 2000 nodes and 3000 edges walked;
- the finding count is asserted against a named constant, so a rule change
  that alters it fails loudly rather than silently widening the budget;
- rule L02 specifically found nothing, which is the property the fixture
  generator claims in its own comment.

That still leaves "the rules ran but every one of them returned early" as a
way to pass, so `the_rules_really_run_over_the_stress_fixture` plants one
budget node with no probe inside the same 2000-node graph and asserts rule L03
finds it and names the module and the metric. The clean run proves the linter
is fast; the planted run proves it was looking.

---

## 4. The fixture change, and the ambiguity behind it

**Three `covers` edges were added to `fixtures/saas-backend/`.** They are
appended after every other entity in `saas-backend.mjs`, so the seeded minter
hands the same identifier to everything built before them: regenerating adds
three edge files and rewrites none of the other 5648. `git status` after
`node fixtures/generate.mjs` shows exactly three new files.

### Why

Rule L11 fires on a contract method with no inbound `covers` edge. PRD section
16.1 draws exactly one such row, against `token-issuer.mint`. The fixture as
built had four methods in that state on modules that declare test cases:
`issue_pair`, `mint`, `refresh_pair` and `skew_window`. It had 27 in that state
across the whole graph.

No reading of L11 produces one row from that input. `mint` is not
distinguishable from `refresh_pair` by export status, by parameters, by module
lifecycle or by anything else in the schema. The wave prompt says the fixture
is the tiebreaker for an ambiguous rule, so the resolution is in two parts: one
scope clause on the rule, and three edges in the fixture.

### The scope clause on L11

**L11 fires only on a contract method whose module declares at least one test
case.** A module with no declared test is not under-covered in one method, it
is untested as a whole, and that is what the lifecycle gate of PRD section 7.2
exists for: nothing reaches `implemented` without its declared tests linked.
Firing here on every method of every untested module would put 27 rows in a
panel PRD section 12.14 designed for five, and bury the one method somebody
genuinely missed.

That clause alone takes the fixture from 27 rows to four. The three edges take
it to one.

### The contradiction this accepts

Section 16.1 states, in its module-tier paragraph, that `skew_window` holds
**0 covers edges**. Its Problems table draws **one** L11 row, against `mint`.
Both cannot hold: L11 fires on any uncovered contract method, and `skew_window`
is on `token-verifier`, a module that declares seven test cases.

The Problems table wins, on the only criterion anyone checks. The wave 7
acceptance condition names those five rows as the thing a test asserts. No test
asserts the module-tier prose and nothing in the build reads it, so the table
is the half with a consequence and the paragraph is the half without one.

This is not PRD section 0.4, and the argument does not need it. That rule
settles a count drawn on a wireframe against a count the build computes. Both
halves here are prose in the requirements document's own fixture
specification, and nothing computes either of them.

`skew_window` gains one covers edge, from `clock-skew-at-the-boundary`, which
is the test case section 16.1 declares for exactly that behaviour.

This is conflict 4 in the wave 1b handoff, which recorded it and left it for
this wave. It is resolved the other way round from that handoff's guess: 1b
expected wave 7 to report two rows.

---

## 4a. Open item for the owner: the L11 scope clause

**This one wants a decision rather than a note.** Scoping L11 to modules that
declare at least one test case narrows the rule materially beyond the literal
text of PRD section 10.4, which says only that a contract method holding 0
inbound `covers` edges fires it. No wireframe backs the narrowing. It was
chosen because it is the reading that makes the reference fixture produce the
stated rows, which is what the wave prompt asks for when a rule is ambiguous,
and because the rule reads better narrowed. Both are judgement calls.

| | |
|---|---|
| **What ships** | L11 fires on an uncovered contract method whose module declares at least one test case. One row on the reference fixture: `token-issuer.mint`. |
| **The literal reading** | Every uncovered contract method fires. **27 rows** on `fixtures/saas-backend/`, against a Problems panel PRD section 12.14 designs for five. 22 of the 27 are the export methods of the six services that carry no test cases at all. |
| **If the owner overrules this** | Delete the `test_cases_by_parent` check in `contract_method_without_covers` in `lint.rs`, which is four lines. Then either the fixture grows about 24 test-case nodes so the counts stay at five, or the wave 7 acceptance row is restated. The three `covers` edges added in section 4 stay correct under either reading. |

The narrowing is separable from the section 16.1 contradiction above. That one
had to be resolved somehow; this one did not.

---

## 5. Ambiguities in PRD section 10.4, and the reading taken

**L01 has no representable "two parents" without a second mechanism.**
`NodeEnvelope::parent` holds one value, so the drawn condition cannot arise
from the node schema alone. It can arise from a hand-written `contains` edge
file: PRD section 5.6 has the kind in the vocabulary and `Edge::is_stored` is
the only thing that normally keeps it off disk, so a bad merge or a hand edit
produces one. L01 counts the `parent` field plus every live inbound `contains`
edge. It also reports a cycle in the `parent` chain, because the rule's heading
is `Containment graph is a tree` and a node that contains its own container is
not a tree under any reading of it.

**L10 fires on "above" alone.** PRD section 10.4 names a node drawn above the
lowest common ancestor of its dependents, and its note confirms it against
`crypto-primitives`. A node drawn *below* its lowest common ancestor is a
different fault with a different fix, so it draws no row. This is load-bearing
for the stress fixture, where a great many modules sit below the project root
their cross-service dependents share; reporting those would have produced
hundreds of rows the PRD never asked for.

**A cycle has no first member, so one is chosen.** Both L01 and L02 rotate a
cycle so the member with the lowest slug leads, then draw the first two and
mark the clip: `session-codec → token-issuer → …`. Without that the drawn cell
would change with the order the loader happened to read files in. L02 reports
one row per strongly connected component rather than one per distinct cycle,
because a component with three cycles through it is one fault.

**L06 excludes layout placements.** A placement naming a node that is no longer
drawn is a stale cache the layout writer prunes, not a reference a reader would
follow, and a row for it would navigate to nothing. Every other reference in
the graph is checked: `parent`, `superseded_by`, `stale.source`, `decisions`,
both ends of every live edge, `exports`, `ui_refs`, `registry_ref`, `anchor`,
`members`, `backed_by`, flow steps and both decision links.

**L09 reads "exported" off the method, not off the service.** A cross-service
`depends_on` or `implements` edge landing on a `contract-method` whose
`exported` field is false is the error. PRD section 5.3 also has an authored
`exports` array on the service; the two agreeing is not checked here, and is
worth a fourteenth rule if anyone wants it.

**L12 reads "acknowledgement" as the referring node being off the live path.**
A node that is itself `deprecated` or `stale` has already been marked as
needing attention, and a second row saying so adds nothing. Anything else
holding a live edge to a deprecated node draws a warning.

**L11's cell draws the method title, L03's the metric.** `token-issuer.mint`
and `token-verifier · cold_start_p95` are both `<module slug><separator><member
name>`, which is what section 16.1 draws. The separator differs between the two
because the wireframe's separators differ.

**The `NODE` cell clips a quoted body at 16 characters, on a word boundary.**
That is the width that reproduces `comment "Two caches here…"` from a body
running to ninety characters.

---

## 6. Verification

| Step | Result |
|---|---|
| `pnpm build` | Pass |
| `pnpm test:js` | Pass, unchanged by this wave |
| `pnpm test:rust` | Pass |
| `pnpm lint:js` | Pass, 0 errors and the 8 pre-existing React hook warnings |
| `pnpm lint:rust` | Pass, no new clippy findings and no baseline change |
| `pnpm lint:comments` | Pass, 0 grandfathered |
| `pnpm format:check` | Pass |

No baseline file was regenerated. No test was deleted or skipped.

**New tests: 15.** Eight unit tests in `lint.rs` and seven integration tests in
`tests/lint.rs`.

---

## 7. Left undone

- **The Problems panel, the severity glyphs, severity grouping and
  click-through.** Interface work, and the wave prompt scoped it out. Section 1
  above is what it is built against.
- **Status-bar cell 3.** Same. `LintReport::errors()` and `::warnings()` are
  the two numbers it draws, computed on every call per PRD section 0.4.
- **The `schematify_lint` Tauri command is not wired.** Deliberate: it belongs
  with the panel, and PRD section 14.5 requires it to carry the
  `actor: "human" | "agent"` argument every command carries.
- **No rule writes anything.** The linter reports; nothing here repairs a
  `ui_refs` cache, and PRD section 5.11 puts that write wherever an edge is
  created.
- **`LinterResult` in a run artifact is not populated from a lint run.** PRD
  section 5.10 has `{ rules, violations }` and the fixture seeds it from the
  project rule registry, which is 14 rows of a different kind of rule. Whether
  cell 3 counts this crate's 13 graph rules or that registry's 14 is a wave 8
  question; the fixture's `14 rules · 0 violations` refers to the registry.
- **No schema field was added.** Every rule reads a field the crate already
  models, so the closed schemas of wave 1b are untouched.
