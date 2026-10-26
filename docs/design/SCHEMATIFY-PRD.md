# Schematify — Product Requirements Document

**Product:** Veistra
**Application:** Schematify
**Status:** Draft 3, for implementation handoff
**Date:** 2026-09-02
**Owner:** Ozymandias
**Audience:** Claude Code, running in waves against the Veistra monorepo

---

## 0. Document control

### 0.1 What this document replaces

Schematify replaces two named applications. HELVE Forger held the technical design graph. HELVE Journeyman held the product layer. Schematify holds both.

The names Forger and Journeyman are retired at the first commit of Wave 1.

### 0.2 Source documents and precedence

| Rank | Source | Location | Use |
|---|---|---|---|
| 1 | The wireframes | Claude Design project `522c739c-b021-4cce-b8a2-ae11c9f3353d`, file `Forger Wireframes.dc.html`. The local copy is `Forger Wireframes.html`. | The visual truth for 6 screens |
| 2 | This document | `docs/design/SCHEMATIFY-PRD.md` | The model, the vocabulary, the build order |
| 3 | `FORGER-SPEC.md` | Veistra project docs | The data model, sections 1 to 14 |
| 4 | `FORGER-UI.md` | Veistra project docs | The interaction model, sections 1 to 13 |
| 5 | `OpenKaava-naming-decision.md` | Veistra project docs | The rename record |

**The wireframes are the source of truth.** Where a wireframe and this document disagree, the wireframe wins, and the disagreement becomes an open item. Where a wireframe and the two Forger documents disagree, the wireframe wins. Where this document and the two Forger documents disagree, this document wins. Where every source is silent, raise the question and stop.

`core/writing-standard.md` governs every document this build produces.

### 0.3 The provenance marker

Two markers run through sections 12 and 13.

**[W]** marks a value, a string, or a rule read from a wireframe. A [W] item is the source of truth, and a build that departs from it is a defect.

**[P]** marks a value, a string, or a rule this document adds. No wireframe shows it. A [P] item is a proposal, and the owner overrules it at no cost.

An unmarked statement in sections 12 and 13 is [P].

### 0.4 The counts rule

Every count drawn on a surface is computed from the graph at draw time. Schematify shall store no count. A count typed into a wireframe is a drawing, and the computed value is the truth. Section 16.4 lists the places where a computed count and a drawn count differ.

### 0.5 How an implementing agent reads this

Read section 17 first, for the wave list and the wave order. Read section 1 to section 16 next. Close a wave only after every acceptance condition in that wave passes.

Section 16 holds the reference fixture. The fixture reproduces the wireframe content. Build every screen against that fixture, and the screen and the wireframe then hold the same words.

---

## 1. Product definition

### 1.1 What Schematify is

Schematify is the design layer of Veistra. Schematify holds the full plan for one software project. Schematify hands that plan to coding agents in a machine-readable form.

The brand truth: the full-scale plan is drawn once, and every build after that follows the lines.

### 1.2 The Schematic

A **Schematic** is one drawn surface bound to one node. Each Schematic shows one piece of the software.

Schematify presents 3 Schematic kinds:

| Kind | Bound to | Shows | Typical size |
|---|---|---|---|
| Stack Schematic | The project root | Every service, the containment nesting, the dependency edges | 3 to 20 nodes |
| Service Schematic | One service | Every module in that service, at unbounded containment depth | 10 to 200 nodes |
| Module Schematic | One module | The facets of that module | 5 to 40 nodes |

The navigation holds 3 levels. Structural depth inside a Schematic is unbounded. Depth in the containment tree is not depth in the navigation.

A module drawn as a box on a Service Schematic and the root node on its own Module Schematic are one node in 2 renderings. One identifier, one file, 2 drawings.

### 1.3 What Schematify holds

| Layer | Content | Prior owner |
|---|---|---|
| Technical | Services, modules, facets, contracts, tests, budgets, rules, libraries | Forger |
| Product | Project brief, screens, flows | Journeyman |
| Record | Decision log, run history, lifecycle audit, reconciliation status | New to Schematify |

The decision log moves inside the application. `FORGER-SPEC.md` section 1 placed decisions in a separate application. Decision SCH-SCO-003 in section 20 supersedes that placement.

### 1.4 What Schematify does not hold

Schematify holds no visual design. A screen entry carries a name, a purpose, a state list, acceptance conditions, and a link to an external design artifact. The pixels live in Claude Design.

Schematify runs no test, no code linter, and no benchmark against the target project. Schematify declares probes. Schematify ingests probe results. A `git clone` plus the project owner's own CI produces every number Schematify displays, with Schematify uninstalled.

Schematify writes no application code. Schematify hands nodes to coding agents.

Schematify runs one linter against its own graph. Section 10.4 states those rules.

---

## 2. Terminology

`core/terminology.csv` holds 0 rows at the date of this document. This section proposes the vocabulary. Add each row to `core/terminology.csv` before Wave 1 closes. Add `CI`, `UUID`, `URI`, `CSS`, `GPL`, `HELVE`, and `CODEOWNERS` as `ACRONYM` rows in the same pass.

| Term | Definition | Do not use |
|---|---|---|
| Schematify | The design application inside Veistra | Forger, Journeyman |
| Schematic | One drawn surface bound to one node | board, diagram |
| Node | One addressed design element | box, item, entity |
| Facet | One tier-3 node inside a module | detail, property |
| Containment | The strict parent tree | ownership, hierarchy |
| Dependency | The directed acyclic call graph | link, connection |
| Probe | The declared command that measures a budget | benchmark, check |
| Marker token | The `@veistra:` string that binds code to a node | tag, annotation |
| Lifecycle | The review path of a node | status, stage |
| Staleness | The state of an accepted node after an upstream contract change | drift, rot |
| Run | One ingested CI result set | build, job |
| Schematic slug | The stable name of a Schematic, and its layout filename | canvas id |

The word `canvas` survives in exactly 2 product strings, both read from a wireframe: the Inspector control `Open module canvas` and the Module Schematic empty-state heading `SAME CANVAS, EMPTY — FIRST RUN`. Every other product string and every code identifier uses `Schematic`.

---

## 3. Identity and addressing

### 3.1 Identifiers

Every node, edge, rule, decision, screen, flow, and registry entry carries 2 identifiers.

Schematify shall assign `id` as a UUIDv7. The `id` is opaque, immutable, locally generated, and time-sortable. Every reference in the system stores the `id` and nothing else.

Schematify shall assign `slug` as a human-readable string, unique inside its parent scope. The `slug` shows on the node face and shows in code search. No reference stores a `slug`.

Schematify shall reject a sequential node identifier and a path-derived node identifier. Two agents on two branches that mint `MOD-0042` produce 2 nodes with 1 identity, and no tool reports the error. UUIDv7 removes the collision.

When a user renames a node, Schematify shall change the `slug` and shall leave the `id` unchanged. No inbound reference breaks.

### 3.2 Slug scope by kind

| Kind | Parent scope for slug uniqueness |
|---|---|
| service | The project root |
| module | Its containment parent |
| facet | Its module root |
| screen | The screen collection |
| flow | The flow collection |
| decision | The decision collection |
| rule | The rule registry |
| library | The library registry |

### 3.3 Decision slugs and decision display

A decision node carries a structured `slug` in the form `DEC-<AREA>-<TOPIC>-<NNN>`, matching the wireframe string `decision://DEC-TEC-AUTH-004`. The structured value is a slug and never an `id`. Section 3.1 bans a structured identifier as an `id` and permits a structured slug.

A reference stores `schematify://decision/<uuid>`. The Inspector `DECISIONS` field resolves that reference and draws the slug behind the `schematify://decision/` scheme. The stored value and the drawn value differ by design.

### 3.4 URI scheme

Schematify resolves 1 URI scheme inside 1 application:

- `schematify://node/<uuid>` — a service, module, or facet
- `schematify://screen/<uuid>` — a product screen
- `schematify://flow/<uuid>` — a product flow
- `schematify://decision/<uuid>` — a decision log entry

The schemes `forger://`, `journeyman://`, and `decision://` are retired. Wave 1 shall convert every stored reference to the `schematify://` form.

Wave 1 shall audit the repository for `veistra.toml`, the `.veistra` file extension, `veistra-tool://`, and the `@veistra/*` npm scope. Where an identifier exists, the rename shall leave it unchanged. Where an identifier is missing, Wave 1 shall report the gap and shall continue.

---

## 4. The two relations

### 4.1 Containment

Containment is a strict tree. Each node holds 1 parent. Containment answers the question of where a node lives.

Schematify shall draw containment as nesting. Schematify shall never draw a containment edge as a line. The wireframe footer states the rule: `contains = nesting · depends_on = drawn`.

### 4.2 Dependency

Dependency is a directed acyclic graph. A node holds 0 or more dependency edges. Dependency answers the question of what a node calls.

Schematify shall draw dependency as a line with an arrowhead at the target.

### 4.3 The shared-node rule

A shared node is never a child of one of its consumers. The containment parent of a shared node is the lowest common ancestor of every node that depends on it. Each consumer holds a `depends_on` edge to the shared node.

This rule applies at the service tier and at the module tier. One linter routine shall enforce the rule at both tiers.

A shared node draws the badge `SHARED · AT LCA` and a dependent count. The Stack Schematic draws a callout headed `WHY EVENT-BUS SITS HERE` with the body `Four consumers, so its containment parent is their lowest common ancestor — the stack root — not any one of them. Same rule at tier 2.`

### 4.4 Allowed libraries

Allowed libraries form a third concept. Allowed libraries are a field on a node, not an edge. Internal relations are edges. External libraries are a list.

---

## 5. Schemas

### 5.1 Common node envelope

```json
{
  "id": "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8",
  "slug": "token-verifier",
  "kind": "module",
  "title": "Token Verifier",
  "description": "Verifies JWT signatures against the rotating key set.",
  "lifecycle": "specified",
  "layer": "backend",
  "parent": "0192f4a0-1111-7000-8000-000000000000",
  "decisions": ["schematify://decision/0192f4a2-2222-7000-8000-000000000000"],
  "authored_by": "human",
  "created": "2026-08-25T00:00:00Z",
  "superseded_by": null
}
```

The `authored_by` field takes `human` or `agent`.

### 5.2 Layer

The `layer` field sits on a service node and on a module node.

| Value | Badge | Provenance |
|---|---|---|
| `backend` | `BACKEND` | [W] Stack Schematic |
| `data` | `DATA` | [W] Stack Schematic |
| `edge` | `EDGE` | [W] Stack Schematic |
| `frontend` | `FRONTEND` | [P] |
| `external` | `EXTERNAL` | [P] |

The wireframes draw a layer badge on tier 1 alone. No module node in the Service Schematic draws one. Schematify draws the badge on both tiers, and that extension is [P].

### 5.3 Service node

Adds 3 fields:

- `entry_point` — the launch method of the service, in natural language. The entry-point node pins to the Schematic edge and draws a pin badge.
- `exports` — an array of contract-method node identifiers published across the service boundary. Every entry resolves to a `contract-method` facet inside the service.
- `schemas` — the schema definition for a data service, local or remote. A service with a resolved schema draws `schemas ✓`.

Exports are authored. Schematify shall never roll up a lower-level contract into a service export list. A service entry point composes, transforms, or orchestrates two or more internal calls. An automatic roll-up leaks internals and misdescribes the surface.

The export strip states the rule verbatim: `Everything not listed is internal by construction.`

### 5.4 Module node

Adds 3 fields:

- `allowed_libraries` — an array of registry entry identifiers. A library missing from the registry cannot enter this array.
- `ui_refs` — an array of `schematify://screen/<uuid>` values. Section 5.11 states the sync rule against the `references_ui` edge.
- `facet_count` — computed, never stored. The value counts every facet node whose parent is this module, annotation facets included.

### 5.5 Facet nodes

Each facet is its own file with the common envelope plus its own fields.

| Facet kind | Card header | Added fields |
|---|---|---|
| `contract-method` | `CONTRACT-METHOD` | `signature`, `params[]`, `returns`, `errors[]`, `semantics`, `exported` |
| `test-case` | `TEST-CASE` | `given`, `when`, `then`, `impl_ref`, `status`, `last_result_ms` |
| `budget` | `BUDGET` | `metric`, `op`, `value`, `unit`, `tier`, `probe`, `sign_off` |
| `doc-block` | `DOC-BLOCK` | `body`, `audience` |
| `external-dep` | `EXTERNAL-DEP` | `registry_ref`, `usage_note` |
| `comment` | `COMMENT · ANNOTATION` | `body`, `author`, `anchor` |
| `group` | `group · annotation` | `title`, `color`, `members[]`, `collapsed` |

The `test-case` `status` field takes `declared`, `linked`, `passing`, or `failing`.
The `budget` `tier` field takes `hard` or `soft` or `target`, and draws the badge `HARD` or `SOFT` on a card.
The `doc-block` `audience` field takes `agent`, `human`, or `both`, and draws as `audience: agent`.
The `budget` `sign_off` field holds an actor name and a run number, drawn as `Sign-off named: m.ross, run #1179`.

A `group` nests inside another `group`. A `comment` anchors to a node or floats free.

### 5.6 Edge schema

```json
{
  "id": "0192f4b0-0000-7000-8000-000000000000",
  "kind": "depends_on",
  "source": "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8",
  "target": "0192f4a3-0000-7000-8000-000000000000",
  "source_port": "out",
  "target_port": "in",
  "created": "2026-08-25T00:00:00Z",
  "superseded_by": null
}
```

Direction runs from `source` to `target`. A `contains` relation stores no edge file; the `parent` field on the child node holds it.

### 5.7 Screen node

```json
{
  "kind": "screen",
  "slug": "login-form",
  "title": "Login form",
  "purpose": "Collects credentials and starts a session.",
  "states": ["empty", "filled", "submitting", "error", "locked"],
  "acceptance": ["A locked account shall show the recovery path."],
  "design_ref": "https://claude.ai/design/p/<project-id>?file=<file>",
  "backed_by": ["schematify://node/<module-uuid>"]
}
```

### 5.8 Flow node

```json
{
  "kind": "flow",
  "slug": "first-run-signup",
  "title": "First-run signup",
  "trigger": "A visitor opens the product with no account.",
  "steps": [
    { "screen": "schematify://screen/<uuid>", "action": "The visitor enters an email address." }
  ],
  "outcome": "The visitor holds an active session."
}
```

### 5.9 Decision node

```json
{
  "kind": "decision",
  "slug": "DEC-TEC-AUTH-004",
  "title": "Verify signatures against a rotating key set",
  "context": "The prior design pinned one signing key.",
  "decision": "Schematify shall verify against the published key set.",
  "consequences": "Key rotation adds a network fetch to the cold path.",
  "status": "ACTIVE",
  "supersedes": null,
  "superseded_by": null,
  "date": "2026-08-19"
}
```

The `status` field takes `ACTIVE` or `SUPERSEDED`. The decision log follows the Veistra change rule. Schematify shall never edit a decision row in place. Schematify shall never remove a decision row. A change adds a new row and marks the prior row `SUPERSEDED`.

### 5.10 Rule, library, layout, and run schemas

**Rule** (`rules/<uuid>.json`): `slug`, `statement`, `command`, `marker`, `severity`, `audit[]`. The `severity` field takes `error`, `warning`, or `review`.

**Library registry** (`registry/libraries.json`): a single JSON object holding an array under `libraries`. Each entry carries `id`, `name`, `version`, `license`, `rationale`, `decision`. This one file is the stated exception to the one-node-per-file rule. The registry is a single global list, and section 10.3 derives the tech-stack view from it.

**Layout** (`layout/<schematic-slug>.json`): `schematic`, `zoom`, `pan`, `nodes` as a map of node identifier to `{x, y, w, h, collapsed}`, and `groups` as a map of group identifier to `{x, y, w, h, collapsed}`. The wireframe status bar names the file by slug: `layout/auth-service.json clean`. On a slug rename, Schematify shall rename the layout file. Layout is cosmetic, and a lost layout file costs positions alone.

**Run artifact** (`runs/<node-uuid>/run-<n>.json`), schema name `veistra-bench-v1`:

```json
{
  "schema": "veistra-bench-v1",
  "run": 1184,
  "at": "2026-08-25T14:02:00Z",
  "commit": "4f2c9ab",
  "workflow": "ci/verify.yml",
  "budgets": [ { "metric": "verify_p95", "value": 1.8, "unit": "ms", "pass": true } ],
  "tests": [ { "impl_ref": "@veistra:0192f4a1…a7b8", "status": "passing", "ms": 41 } ],
  "linter": { "rules": 14, "violations": 0 },
  "reconcile": { "matched": 7, "declared_absent": 1, "present_unknown": 0, "duplicate": 0 }
}
```

The `schema` field carries the version. A reader that meets an unknown `schema` value shall reject the file and shall report the version.

Section 9.2 states the mapping from these 4 JSON keys to the 4 drawn strings.

### 5.11 The `ui_refs` sync rule

The `references_ui` edge is authoritative. The `ui_refs` field on a module node is a derived cache, written by Schematify on every edge change and never hand-edited. The linter reports a mismatch as an error.

### 5.12 Project brief

`brief.json` carries `product_name`, `problem`, `users[]`, `goals[]`, `non_goals[]`, `constraints[]`, and `success_metrics[]`. Each `success_metric` carries a number and a unit.

---

## 6. Storage

### 6.1 Layout

All design data is atomic JSON on the project filesystem, tracked by git. One node per file. No graph index file exists.

```
.veistra/
  brief.json                   # semantic — human-authored
  nodes/<uuid>.json            # semantic — services, modules, facets
  screens/<uuid>.json          # semantic — product screens
  flows/<uuid>.json            # semantic — product flows
  decisions/<uuid>.json        # semantic — decision log, append-only
  edges/<uuid>.json            # semantic
  rules/<uuid>.json            # semantic — code standards
  registry/libraries.json      # semantic — the one approved-library list
  runs/<node-uuid>/*.json      # audit — append-only
  layout/<schematic-slug>.json # cosmetic — positions, groups, collapse state
```

The wireframe status bar names the root as `sdd/`. Decision SCH-ARC-003 changes the root to `.veistra/`. Wave 2 draws `.veistra/` in that cell.

Natural language lives inside JSON string fields. Schematify shall not write a sibling Markdown file for node prose.

### 6.2 Why the layers split

The split is the enforcement mechanism for the rule that an agent shall not change the design. The permission boundary is a path glob. CODEOWNERS and a CI path check enforce the boundary.

A benchmark job that appends latency numbers writes to `runs/`. A human who edits a contract writes to `nodes/`. The two writes never conflict.

Layout splits for the same reason. A node drag shall not dirty a semantic file.

### 6.3 The lifecycle write exception

A lifecycle transition writes `nodes/<uuid>.json` and appends `runs/<node-uuid>/audit.json` in one action. The CI path-scope gate in section 14.6 shall pass that pair. The gate shall block every other write that touches `runs/` and `nodes/` together.

The `runs/` tree therefore holds 2 writers. A CI job writes result files. A human transition appends `audit.json`. No other writer exists.

### 6.4 Load

On project open, Schematify shall walk `.veistra/`, parse every file, and build the graph in memory.

Section 14.7 states the load budget and names the reference machine.

### 6.5 Branch behavior

Design data that varies by branch is correct. A feature branch that changes the design and the code together, reviewed as one pull request, is the traceability property in operation.

The `runs/` layer is the exception. Run history and sign-off records outlive a branch. The future hosted store keeps `nodes/` in git and moves `runs/` to a server keyed by opaque identifier.

### 6.6 Deletion

Nothing is ever deleted. A node with an inbound edge cannot be deleted. That node moves to `deprecated` and carries `superseded_by` set to its replacement. This rule covers nodes, edges, rules, screens, flows, decisions, and registry entries.

On a dangling reference, Schematify shall quarantine the referring node and shall report the reference. Schematify shall never drop a reference in silence.

---

## 7. Lifecycle

### 7.1 States

```
draft → specified → assigned → implemented → reviewed → accepted
                        ↑                         │
                        └─────── rejected ────────┘
```

Six states sit on the path. Two states sit outside it: `stale` and `deprecated`. Eight states exist in total.

### 7.2 The transition table

| From | To | Actor | Trigger |
|---|---|---|---|
| `draft` | `specified` | human | The author completes the node |
| `specified` | `assigned` | human | The author hands the node to an agent |
| `assigned` | `implemented` | agent | The agent links every declared test |
| `assigned` | `specified` | human | The author withdraws the assignment |
| `implemented` | `reviewed` | human | The reviewer opens the node |
| `implemented` | `specified` | human | The reviewer returns the node before review |
| `reviewed` | `accepted` | human | The reviewer accepts the node |
| `reviewed` | `specified` | human | The reviewer returns the node with a reason |
| `accepted` | `stale` | system | An upstream contract changes |
| `stale` | `accepted` | human | The reviewer re-reviews the node |
| `stale` | `specified` | human | The reviewer returns the node with a reason |
| any | `deprecated` | human | The author supersedes the node |

No other transition is legal.

A node cycles through the path more than once. The wireframe audit log shows the 5 most recent rows of a longer history, and an earlier `implemented → reviewed` row precedes the `reviewed → specified` row it draws.

Every transition appends one row to `runs/<node-uuid>/audit.json` with actor, timestamp, and reason.

When a node returns to `specified`, Schematify shall keep the agent branch reference on the node and shall mark the prior run superseded. Open item 19.1 covers the disposal rule for that branch.

### 7.3 The human-only gate

An agent shall never transition a node to `accepted`. Schematify shall block that transition at the Tauri command boundary.

The shell supplies an actor token on every command call. A call that carries an agent token and targets the accept transition returns an error. The dashboard states the guarantee: `No agent row in this log can read → accepted. That transition is human-only by construction.`

### 7.4 Staleness cascade

A contract change is a change to `signature`, `params`, `returns`, or `errors` on a `contract-method` facet, or a change to the `exports` array on a service.

When a contract changes, Schematify shall drop every node with an inbound `depends_on` edge to the owning node from `accepted` to `stale`.

A human re-review resolves staleness. No other action resolves staleness. The stale node draws the caption `⚠ STALE — upstream contract changed` with a second line in the wireframe form `crypto-primitives.sign changed 2h ago. Re-review required.`

---

## 8. Budgets and probes

A budget declares a target and the command that measures it.

```json
{
  "metric": "verify_p95",
  "op": "<",
  "value": 3,
  "unit": "ms",
  "tier": "hard",
  "probe": { "command": "pnpm bench:verify", "parser": "veistra-bench-v1" }
}
```

A budget with no probe is a Schematify lint error. The wireframe states the reason: `An unmeasurable claim is a lint error, not a warning.`

| Tier | Result |
|---|---|
| `hard` | A probe failure blocks CI |
| `soft` | A probe failure warns and needs 1 named human sign-off before merge |
| `target` | A probe result is tracked and graphed, and blocks nothing |

A soft budget that trends toward its threshold draws the caption `trending to breach · sign-off required`. The Budgets tab captures the sign-off. The dashboard names the signer and the run.

CI runs the probe and emits a `veistra-bench-v1` artifact. Schematify ingests the artifact into `runs/` and draws it. Schematify shall never invoke the probe command.

---

## 9. Code linkage and reconciliation

### 9.1 The marker token

Every design element with a counterpart in code carries a marker token, placed anywhere in the file:

```
@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier.verify_signature
```

The token is a fixed string found by plain regular expression. A docstring parser breaks on the first language nobody anticipated. The UUID is authoritative. The trailing slug lets a human grep for a readable name.

The Tests tab carries a `Copy marker token` control on every case.

### 9.2 Reconciliation outcomes

Reconciliation is the graph twin, running at symbol granularity and not at file granularity.

| JSON key | Drawn string | Meaning | Handling |
|---|---|---|---|
| `matched` | `matched` | The design element and the code site agree | Pass |
| `declared_absent` | `declared, absent` | The design declares the element and no marker exists | Error after `lifecycle` reaches `implemented` |
| `present_unknown` | `present, unknown` | A marker exists and no node carries that identifier | Error |
| `duplicate` | `duplicate` | One identifier sits at 2 or more code sites | Error |

The drawn strings are the wireframe strings. Every surface and every log line uses the drawn string. Every JSON payload uses the key.

### 9.3 The reconcile command

```
veistra reconcile [--root <path>] [--out <path>] [--format text|json]
```

The binary name is `veistra`. The crate is `crates/schematify-reconcile`. The command reads `.veistra/nodes/`, scans the working tree, and writes `runs/<node-uuid>/reconcile.json` for every node it touches.

Exit code 0 means no error outcome. Exit code 1 means one or more error outcomes. Exit code 2 means the command read no project at that path.

Schematify reads the written file through `schematify_reconcile_status`. Schematify shall never scan the working tree from the interface process.

---

## 10. Registries, rules, and the linter

### 10.1 Library registry

One global list holds every approved external library: name, version pin, license, rationale, and the approving decision. A module whitelists a library present in this list and no other.

License enforcement runs at design time. A GPL dependency becomes a blocked add at design time.

### 10.2 Rule registry

The rule registry holds the code standards an agent follows on the target project. Each rule carries a statement, the enforcing command, the marker token that locates its implementation, a severity, and its own audit history.

The dashboard `LINTER` card counts this registry, in the wireframe form `14 rules · 0 violations`. That count is project data and not a Schematify constant. The fixture in section 16 seeds 14 rows to reproduce it.

### 10.3 Derived tech stack

The tech-stack view derives from the `allowed_libraries` field on every module, read against the library registry. The view is read-only and sits in the Inspector empty state under the heading `DERIVED TECH STACK`, where no user mistakes it for an editor.

Each row draws name, version, license, and module count, in the wireframe form `jose 5.2.4 · MIT 6`. The footer reads `Read-only. Derived from per-module allowed_libraries against the registry.`

### 10.4 Schematify graph linter

The Problems panel draws the `RULE` cell from the `Drawn name` column. Four names are read from a wireframe.

| # | Drawn name | Fires when | Severity |
|---|---|---|---|
| L01 | `Containment graph is a tree — no node has two parents` | A node holds 2 parents | Error |
| L02 | `Dependency graph is acyclic` [W] | A dependency cycle exists | Error |
| L03 | `Budget declared without a probe` [W] | A budget carries no probe | Error |
| L04 | `Library whitelisted but absent from registry` | A module names a library the registry lacks | Error |
| L05 | `Annotation node carrying a semantic edge` [W] | A comment or group holds a semantic edge | Error |
| L06 | `Dangling reference after resolver exists` | A reference resolves to nothing | Error |
| L07 | `Superseded decision without a successor` | `status=SUPERSEDED` and `superseded_by` is null | Error |
| L08 | `ui_refs cache does not match references_ui edges` | The cache and the edges differ | Error |
| L09 | `Cross-service call to a non-exported method` | A call crosses a boundary to an unexported method | Error |
| L10 | `Shared node sits above the LCA of its dependents` [W] | A shared node sits above the lowest common ancestor of its dependents | Warning |
| L11 | `Contract method with no covers edge` [W] | A contract method holds 0 inbound `covers` edges | Warning |
| L12 | `Reference to a deprecated node without acknowledgement` | A live node references a deprecated node | Warning |
| L13 | `Screen with no backing module` | A screen holds 0 inbound `references_ui` edges | Warning |

L10 fires on a node drawn above the lowest common ancestor of its dependents, matching the wireframe finding against `crypto-primitives`.

---

## 11. Typed vocabulary

### 11.1 Edge kinds

| Tier | Edge kinds |
|---|---|
| 1 and 2 | `contains`, `depends_on`, `implements`, `references_ui` |
| 3 | `covers`, `satisfies`, `documents` |

A `test-case` joined by `covers` to a `contract-method` yields coverage of design. Line coverage never reports that number.

An `external-dep` joined by `satisfies` to a `budget` is legal. The Module Schematic draws a callout headed `SATISFIES` with the body `A dep can satisfy a budget. Edge types at tier 3 are closed: covers, satisfies, documents.`

### 11.2 User-defined node kinds

A user registers a schema, declares the edge kinds the schema accepts, and the new kind joins the graph. Surface S-25 holds the registration form.

### 11.3 The annotation tier

A `comment` node and a `group` node sit in the annotation tier. Schematify shall keep an annotation node out of reconciliation. Schematify shall refuse a semantic edge on an annotation node.

The refusal draws the wireframe text, headed `Drop refused`: `A comment is annotation tier. It cannot carry covers or any semantic edge.`

Without this rule, the anti-slop constraint holds a hole shaped as a text box. Load-bearing design detail then lands where the reconciler cannot read it.

---

## 12. Application surfaces

Design lineage, from `FORGER-UI.md`: the Unreal Engine Blueprint editor for node behavior, grouping, and comment boxes; draw.io for freedom of arrangement. The distinction from both: every node and every edge here is typed and load-bearing, and never decorative.

Every string in backticks below is [W] unless the line marks it [P].

### 12.1 Application shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ saas-backend   ~/work/saas-backend · main · 3 uncommitted     – □ ✕  │  34 px
├──────────────────────────────────────────────────────────────────────┤
│ [Schematify] [Files] [Terminal]                Search all apps Ctrl+K │
├──────────────────────────────────────────────────────────────────────┤
│ Stack › Auth Service › Token Verifier   [search]   Auto-sort   Fit    │
│         auth-service                                                  │
├───────────┬────────────────────────────────────────┬─────────────────┤
│ Outline   │              Schematic                  │   Inspector     │
│  238 px   │                 flex                    │  360 to 380 px  │
│           │                              68% ──|─── │                 │
│           │  depends_on  implements  references_ui   │                 │
├───────────┴────────────────────────────────────────┴─────────────────┤
│ Problems 3 2 · Runs · Registries · Rules                      196 px  │
├──────────────────────────────────────────────────────────────────────┤
│ sdd/ · 12 nodes · 9 edges │ layout/auth-service.json clean │          │
│ 3 errors · 2 warnings │ run #1184 · 2h ago                            │
└──────────────────────────────────────────────────────────────────────┘
```

**Title bar.** Height 34 px. Draws the project name, the project path, the git branch, and the uncommitted-file count. The count string shows when the count is above 0 and hides at 0. The Service Schematic draws `· 3 uncommitted`. The Stack Schematic draws no count.

**Application tab strip.** The wireframe strip carries `SDD`, `Files`, `Journeyman`, `Forger`, `Terminal`. The merge collapses `SDD`, `Journeyman`, and `Forger` into one entry, and the shipped strip reads `Schematify`, `Files`, `Terminal` [P]. The search affordance reads `Search all apps` with the shortcut `Ctrl+K`.

**Breadcrumb.** The breadcrumb holds 1 to 3 segments, one per open tier. The Stack Schematic draws `Stack`. The Module Schematic draws `Stack › Auth Service › Token Verifier`. The active segment draws its slug on a second line, in the form `auth-service`. The breadcrumb stays visible and stays clickable.

**Toolbar.** The Service Schematic and the Stack Schematic carry a node search field with the placeholder `Search nodes, methods, markers…` and an `Auto-sort` control. The Service Schematic also carries `Fit`. The Stack Schematic and the Module Schematic draw no `Fit` control, and Schematify adds `Fit` to both [P].

The Module Schematic header carries the breadcrumb, the caption `tier 3 — deepest drill-down`, a `Module dashboard` control, and a `Pre-fill with agent` control. The Module Schematic draws no search field and no `Auto-sort` control. Schematify adds both [P].

**Outline.** Width 238 px. The header reads `OUTLINE — CONTAINMENT` on the Service Schematic and `OUTLINE — SERVICES` on the Stack Schematic. A leading dot draws lifecycle state. A row draws a badge where one applies, in the forms `ENTRY` and `STALE`, and a bare child count on a collapsed parent. A parent row draws a `▾` or `▸` disclosure triangle. The footer reads `12 nodes · depth 3`.

The Module Schematic replaces the Outline with the facet palette. The left column on that tier holds no tree.

A section switcher sits above the tree with 3 entries [P].

`Design` shows the containment tree. `Product` shows the brief, the screens, and the flows. `Decisions` shows the decision log.

**Schematic.** The primary surface. Section 12.3 states its behavior.

**Zoom readout.** A percentage and a slider track sit at the lower edge of the Schematic, in the forms `68%` and `100%`.

**Edge legend.** Chips for `depends_on`, `implements`, and `references_ui` sit beside the zoom readout. The footer note reads `contains = nesting · depends_on = drawn`. The Module Schematic legend reads `contains`, `covers`, and `satisfies`.

**Inspector.** Width 360 px on the Service Schematic and 380 px on the standalone tab exhibit. Section 12.12 states its tabs.

**Bottom dock.** Height 196 px. Four tabs: `Problems`, `Runs`, `Registries`, `Rules`. The `Problems` tab draws 2 badges, an error count and a warning count. The panel header reads `Errors first · never hidden`. The dock collapses to a status strip, and both badges stay visible on that strip.

The wireframes draw the dock on the Service Schematic alone. Schematify draws the dock on all 3 tiers [P].

**Status bar.** The Stack Schematic status bar draws 2 cells: `sdd/ · 6 services` and `3 errors · 2 warnings`. The Service Schematic status bar draws 4 cells: `sdd/ · 12 nodes · 9 edges`, `layout/auth-service.json clean`, `3 errors · 2 warnings`, and `run #1184 · 2h ago`.

Cell 1 states the storage root and the counts that suit the tier. The Stack Schematic counts services. The Service Schematic counts nodes and edges. Wave 2 draws `.veistra/` in place of `sdd/` per section 6.1.

### 12.2 Surface inventory

| # | Surface | Kind | Purpose |
|---|---|---|---|
| S-01 | Stack Schematic | Schematic | Services, containment nesting, dependency edges, rolled-up health, shared-node callout |
| S-02 | Service Schematic | Schematic | Modules of one service, entry point, export strip, groups, comments |
| S-03 | Module Schematic | Schematic | Module root, typed facets, facet palette, coverage readout |
| S-04 | Inspector — Identity | Panel | `TITLE`, `SLUG`, `DESCRIPTION`, `OPAQUE ID` with copy, `KIND`, `LAYER`, `DECISIONS` |
| S-05 | Inspector — Lifecycle | Panel | Current state, legal transitions, assignee, last 3 audit rows, link to the full log |
| S-06 | Inspector — Contract | Panel | Method list, `Signatures` and `OpenAPI` toggle, export marks, covers counts, `+ add method` |
| S-07 | Inspector — Tests | Panel | Case summary chips, given-when-then rows, marker token, `Copy marker token` |
| S-08 | Inspector — Budgets | Panel | Metric rows, tier badge, value, threshold, `Add probe`, `Drop budget`, sign-off capture |
| S-09 | Inspector — Dependencies | Panel | Internal `depends_on` edges read-only, external libraries with license shown |
| S-10 | Inspector — Docs | Panel | The agent-facing documentation body in a full editor |
| S-11 | Inspector — References | Panel | Decision links, screen links, inbound reference count, dangling marks |
| S-12 | Module dashboard | Read-only page | Five counters, budget history, reconciliation, contract history, audit log |
| S-13 | Problems panel | Dock tab | Findings in 4 columns, grouped by severity, click-through to the node |
| S-14 | Runs panel | Dock tab | Run number, timestamp, commit, workflow file, ingest state |
| S-15 | Library registry | Table | Name, version, license, rationale, approving decision, module count |
| S-16 | Rule registry | Table | Statement, command, marker token, severity, audit history |
| S-17 | Derived tech stack | Read-only table | Aggregated libraries with module counts, drawn in the Inspector empty state |
| S-18 | Global search | Overlay | Every kind, ranked, with breadcrumb paths |
| S-19 | Project brief | Form | Problem, users, goals, non-goals, constraints, success metrics |
| S-20 | Screen registry | Table plus form | Screen list and the per-screen editor |
| S-21 | Flow editor | Ordered list | Trigger, ordered steps with screen references, outcome |
| S-22 | Decision log | Table plus form | Append-only rows with supersession, filtered by status |
| S-23 | Review queue | List | Nodes at `implemented`, and nodes at `stale` |
| S-24 | Empty and first-run states | Overlay | One per tier, naming what belongs there and what belongs elsewhere |
| S-25 | Node-kind registration | Form | A user-defined node kind, its schema, and its accepted edge kinds |

Wireframe coverage: S-01, S-02, S-03, S-04, S-06, S-07, S-08, S-12, and S-13 are drawn. S-05, S-09, S-10, S-11, and S-14 through S-25 are undrawn, and this document is their only source.

### 12.3 Schematic behavior

Schematify shall place a node where the user drops it and shall keep that position across a reload. Positions persist to `layout/<schematic-slug>.json`.

Schematify shall open the tier below a node on a click of that node. The breadcrumb walks back up.

Schematify shall offer auto-sort across the whole Schematic and across a choice. Auto-sort is undoable. Auto-sort never runs on load.

Schematify shall support multi-select, box-select, copy, paste, duplicate, undo, and redo [P]. On duplicate, Schematify shall mint a new UUIDv7 and shall append a suffix to the slug.

Undo covers node moves, edge changes, node edits, group changes, and comment changes. Undo shall never revert a lifecycle transition, because the audit row is append-only. Undo history is per Schematic and clears on project close.

Schematify shall draw a minimap in the Schematic corner opposite the Outline, carrying error marks and health marks [P]. No wireframe draws a minimap.

Schematify shall animate zoom-to-fit, zoom-to-choice, and search-jump. A cut breaks the spatial orientation of the user.

Schematify shall draw a collapsed parent with a child count and an edge roll-up count, in the forms `collapsed · 2 children` and `3 edges aggregated`.

Schematify shall route an edge orthogonally. An edge crosses a group border. An edge never enters a sibling box. Open item 19.8 covers the routing algorithm and the bundling rule above 40 edges.

### 12.4 Groups and comments

A group draws a titled box with its own color, a `▾` collapse triangle, and the caption `group · annotation`. A group nests inside another group.

A comment draws a free-floating box headed `COMMENT · ANNOTATION` with an author name below the heading and a `✕` dismiss glyph in the corner. A comment anchors to a node or floats free.

### 12.5 Edge creation and rendering

Edge creation drags port to port. When the target node kind rejects the edge kind, Schematify shall refuse the drop at drag time. Schematify shall draw the reason at the cursor, headed `Drop refused`.

Schematify shall refuse an edge that creates a containment cycle. Schematify shall refuse an edge that creates a dependency cycle. The refusal text reads `A dependency edge here would create a cycle.` [P] — no wireframe draws a cycle refusal.

Schematify shall never accept an invalid edge and flag it later.

| Edge | Style |
|---|---|
| `contains` | Not drawn, expressed as nesting |
| `depends_on` | Solid line, arrowhead at target |
| `implements` | Dashed line, hollow arrowhead |
| `references_ui` | Dotted line, `--kv-agent` accent, terminating in a screen chip |
| `covers` | Solid thin line, test to method |
| `satisfies` | Solid thin line, node to budget |
| `documents` | Dotted thin line |

The wireframes draw a screen reference in 2 forms. On a Service Schematic the reference draws as a labelled chip, `◈ JOURNEYMAN` above `screen/login-form`, with the label changed to `◈ SCREEN`. On a Module Schematic the reference draws as a plain path on the root node face, `journeyman://screen/login-form`, changed to `schematify://screen/login-form`.

A screen reference is a reference and never an editor. A click opens the Screen registry at that screen.

### 12.6 Node anatomy

```
┌─────────────────────────────────┐
│ ● Token Verifier          [⋯]   │  lifecycle dot · title · node menu
│ token-verifier                  │  slug, mono, dimmed, mutable, unique in parent
├─────────────────────────────────┤
│ Verifies JWT signatures against │  description, clamped to 2 lines
│ the rotating key set.           │
├─────────────────────────────────┤
│ ⬤ 3 meth  ⬤ 5 test  ⬤ 2 budg   │  facet counts, tier 2 only
├─────────────────────────────────┤
│ ▸ jose  ▸ zod                   │  allowed libraries
├─────────────────────────────────┤
│ ⚠ STALE — upstream contract …   │  caption row, drawn when a reason exists
└─────────────────────────────────┘
     ○ in                   out ○   ports: in left, out right, edge drag targets
```

The UUID stays off the node face. The UUID shows in the Inspector, in a copy-on-click field, and nowhere else.

The health wedge occupies the upper corner opposite the ports and holds that corner alone. The node menu sits inside the header row and never reaches that corner.

The facet-count row draws short labels on a Schematic, in the form `⬤ 3 meth  ⬤ 5 test  ⬤ 2 budg`, and long labels on the anatomy reference, in the form `⬤ 3 methods  ⬤ 7 tests  ⬤ 2 budg`. Schematify draws the short labels.

**Badge set.** A node draws the badges that apply to it, from this closed set:

| Badge | Applies to | Provenance |
|---|---|---|
| `📌 ENTRY POINT` | The service entry point on a Service Schematic | [W] |
| `📌 ENTRY` | The entry service on a Stack Schematic | [W] |
| `SHARED · AT LCA` | A shared node, with a dependent count below it | [W] |
| `BACKEND`, `DATA`, `EDGE` | The `layer` value at tier 1 | [W] |
| `FRONTEND`, `EXTERNAL` | The `layer` value at tier 1 | [P] |
| `◇ AGENT` | `lifecycle` set to `assigned` | [W] |
| `◇ AGENT DRAFT` | `authored_by` set to `agent` | [W] |
| `MODULE ROOT · CANNOT BE DELETED` | The root node of a Module Schematic | [W] |
| `EXPORTED` | A `contract-method` facet with `exported` set true | [W] |
| `HARD`, `SOFT` | A `budget` facet tier | [W] |

**Count strings.** A node draws the counts that apply to it. Each string is computed per section 0.4.

`4 exports` · `11 exports` · `12 modules` · `4 modules` · `contains 2` · `collapsed · 2 children` · `3 edges aggregated` · `2 dependents` · `layer backend · 4 facets` · `schemas ✓`

**Caption strings.** A node draws one caption where a state carries a reason:

| Caption | Condition |
|---|---|
| `draft · no run data` | `draft` with no ingested run |
| `draft · 0 exports authored` | A `draft` service with an empty export list |
| `reviewed · awaiting accept` | `reviewed` |
| `Pre-filled by agent. Not reviewed.` | `authored_by` set to `agent` |
| `⚠ STALE — upstream contract changed` | `stale`, plus the second line in section 7.4 |
| `worst contained: 1 soft budget trending` | A service whose rolled-up health is below passing |
| `legacy-session → session-store` | `deprecated`, naming the successor |

**Wedge glyphs.** The header draws `✓` on an accepted node, `◐` on a reviewed node, and `⚠` on a stale node.

### 12.7 Lifecycle rendering

The reference sheet carries the heading `LIFECYCLE — GEOMETRY CARRIES THE SIGNAL, NOT COLOUR`.

| State | Treatment | Legend caption |
|---|---|---|
| `draft` | Dashed border, muted fill | `draft — dashed, muted fill` |
| `specified` | Solid border, neutral fill | `specified — solid, neutral` |
| `assigned` | Solid border, agent glyph in the header | `assigned — agent glyph` |
| `implemented` | Solid border, filled bottom edge | `implemented — filled edge` |
| `reviewed` | Solid border, half-filled check | `reviewed — half check` |
| `accepted` | Solid border, filled check, saturated accent | `accepted — full check, saturated` |
| `stale` | Accepted treatment plus a warning overlay stripe | `stale — accepted + stripe` |
| `deprecated` | Heavy desaturation, struck title, 40% opacity | `deprecated — 40%, struck` |

State stays legible at zoom levels where text is unreadable. Border weight, fill saturation, and overlay geometry carry the signal. Color alone carries no signal at 22% zoom.

The zoom sheet carries the heading `THREE ZOOM LEVELS — WHAT SURVIVES` and 3 captions: `100% — everything`, `55% — title, slug, state`, and `22% — geometry only`. Border weight, bottom-edge fill, and overlay stripe survive to 22%. Dots and text do not survive.

### 12.8 Health rendering

The reference sheet carries the heading `HEALTH — SEPARATE CHANNEL, LATEST RUN ONLY`.

| Condition | Treatment | Legend caption |
|---|---|---|
| Every hard budget, soft budget, and test passing | No wedge | `all passing` |
| One soft budget or one test failing | Amber corner wedge | `soft / test fail` |
| One hard budget failing | Red corner wedge | `hard budget fail` |
| No run data | Hollow corner wedge | `no run data` |

On a service node, health rolls up as the worst status of any contained module. The node face states that status in words and draws a wedge.

### 12.9 Stack Schematic

The Stack Schematic draws every service, containment nesting, and dependency edges. The header states the counts, in the form `6 services · 7 dependency edges`. Section 16.4 records the count conflict on that string.

A shared service draws the `SHARED · AT LCA` badge and a dependent count, plus the callout in section 4.3.

The Inspector empty state carries the heading `CANVAS PROPERTIES` and the body `Nothing selected. The inspector shows canvas-level properties: 6 services, 7 dependency edges, containment depth 2, layout saved 4m ago.` Every number in that body is computed.

The derived tech stack sits below, under the heading in section 10.3.

The footer reads `click a service to drill into its modules`.

### 12.10 Service Schematic

The entry-point node pins to the Schematic edge and draws `📌 ENTRY POINT`.

The export strip pins along the Schematic edge opposite the Outline. The strip header reads `EXPORTED INTERFACE` with a count and the word `authored`, in the form `4 · authored`. Each row names a method and its owning module. The selected row draws a `←` marker beside the owning module name. A click on a row lights the owning module. The strip footer reads `Everything not listed is internal by construction.`

Deep containment draws as nested boxes, collapsible. A collapsed parent draws a child count and rolls its children's dependency edges to its own border.

### 12.11 Module Schematic

The module root node pins to the left edge and draws `MODULE ROOT · CANNOT BE DELETED` plus the body text `Same node as the box on the service canvas. One id, two renderings.` The root face draws `layer backend · 4 facets` and the screen reference path.

Facets fan outward. The Schematic reads as a contract sheet, not as a free graph.

Each facet draws an uppercase card header from section 5.5. A `contract-method` card draws the signature, the return, the covers state in the form `✓ 4 covers · matched in code`, and the `EXPORTED` badge where it applies. A `budget` card draws the tier badge, the threshold, the probe in the form `probe: pnpm bench:verify`, and the latest value in the form `1.8 ms · run #1184`. A `test-case` card draws its title and its status word, `passing` or `failing`. A `doc-block` card draws `audience: agent` and the body. An `external-dep` card draws the pinned name and the registry state, in the forms `jose@5.2.4` and `MIT · registry ✓`.

The facet palette carries the heading `FACET PALETTE`, lists `contract-method`, `test-case`, `budget`, `doc-block`, and `external-dep`, then an `ANNOTATION` heading with `comment` and `group`. The palette footer reads `Drag onto the canvas, or let an agent draft and review after.`

An agent-drafted facet draws a dashed border and 3 controls: `Accept`, `Edit`, `Discard`. The facet stays dashed until a human takes one of the 3 actions.

The coverage readout draws under the heading `COVERAGE OF DESIGN` with the body `7 of 8 covers edges present. skew_window has none — the number line coverage never reports.` Both numbers are computed.

The `SATISFIES` callout in section 11.1 draws beside the budget card.

### 12.12 Inspector

The wireframes draw 2 tab strips. The in-application strip on the Service Schematic reads `Identity`, `Lifecycle`, `Contract`, `Tests`, `More`. The standalone exhibit reads `Identity`, `Contract`, `Tests`, `Budgets`, and shows 3 populated tabs side by side at 380 px each.

Schematify ships the in-application strip. The `More` tab holds `Budgets`, `Dependencies`, `Docs`, and `References`. A tab moves out of `More` when the panel width passes 360 px, and the panel holds 5 flat tabs at 380 px.

The Inspector footer carries `Open module canvas` and `Assign` on a module node.

**Identity** draws `TITLE`, `SLUG`, `DESCRIPTION`, `OPAQUE ID` with a `copy` control, `KIND`, `LAYER`, and `DECISIONS`.

**Contract** draws a method count in the form `3 METHODS`, a `Signatures` and `OpenAPI` toggle, and one block per method with signature, return, semantics, and a covers state. The covers state draws as `✓ 4 covers edges` or as `▲ no covers edge from any test case`. A `+ add method` control sits at the foot. On a service node, this tab edits the authored export list.

**Tests** draws a case count and summary chips, in the forms `7 CASES`, `5 passing`, `1 failing`, `1 unlinked`. Each case draws `given`, `when`, `then`, the marker token, the link state, and the last duration, in the forms `linked · 41ms` and `linked, failing`. A failing case draws its mismatch, in the form `expected 1 fetch, saw 2`. An unlinked case draws `Declared, no marker found in code. Different problem from a failing test.` A `Copy marker token` control sits on every case.

**Budgets** draws a budget count in the form `3 BUDGETS` and the run reference `run #1184 · 2h ago`. Each row draws the metric, the tier badge, the current value, and the threshold, in the forms `1.8 ms` and `< 3 ms`. A budget with no value draws `—`. A soft budget near its threshold draws `trending to breach · sign-off required` and a sign-off control. A budget with no probe draws `No probe declared` with the note `An unmeasurable claim is a lint error, not a warning.` and 2 controls: `Add probe` and `Drop budget`.

**Dependencies** draws internal `depends_on` edges read-only and external libraries with the license shown, picked from the registry.

**Lifecycle** draws the current state, the transitions legal from that state, the assignee, the last 3 audit rows, and a link to the full log.

**References** draws decision links, screen links, the inbound reference count, and dangling marks.

### 12.13 Module dashboard

The header draws the breadcrumb, the caption `READ ONLY · THE RECORD OF WHAT HAPPENED`, and the storage path with an elided identifier, in the form `runs/0192f4a1-…-a7b8/`.

**Counters.** Five cards:

| Card | Content | Note |
|---|---|---|
| `LATEST RUN` | `#1184 · 2026-08-25 14:02Z · 4f2c9ab · ci/verify.yml` | — |
| `BUDGETS` | `2 / 3` | `1 hard budget has no probe` |
| `TESTS` | `5 / 7` | `1 failing · 1 unlinked` |
| `LINTER` | `0` | `14 rules · 0 violations` |
| `RECONCILIATION` | `7 / 8` | `1 declared, absent` |

**Budget history.** One graph per metric, with the threshold drawn as a line and labelled, in the forms `3 ms hard` and `1 /min soft`. The section header reads `BUDGET HISTORY — THRESHOLD DRAWN, SO A TREND IS VISIBLE BEFORE IT BREACHES`. A soft budget under sign-off draws a note in the form `Twelve runs of monotonic climb. Sign-off named: m.ross, run #1179.`

**Reconciliation.** Columns `OUTCOME`, `SITE`, `COUNT`. A `SITE` cell names the first site and an overflow count, in the form `src/auth/verifier.ts +3 more`, or names the missing element, in the form `skew_window — no marker`, or draws `—`. The section header reads `RECONCILIATION — GRAPH TWIN AT SYMBOL GRANULARITY`.

**Contract change history.** Two columns: a timestamp in the form `25 Aug 11:40`, and the change in the form `verify_signature returns Result, was throw`. The section header reads `CONTRACT CHANGE HISTORY — WHAT TRIGGERS STALENESS DOWNSTREAM`. A footnote names the node the change moved to `stale`, in the form `The 25 Aug change dropped audit-emitter from accepted to stale. Resolved only by human re-review.`

**Lifecycle audit log.** Columns `WHEN`, `TRANSITION`, `ACTOR`, `REASON`. The section header reads `LIFECYCLE AUDIT LOG — APPEND-ONLY`. An actor cell names the person and the role, in the forms `m.ross · human` and `◇ agent · claude-sdd`. The footnote states the human-only guarantee from section 7.3.

Nothing on this page is editable. The page holds no input and no control that changes state.

### 12.14 Problems panel

Columns `SEVERITY`, `RULE`, `NODE`, `LOCATION`.

The `SEVERITY` cell draws `● ERROR` or `▲ WARN`. The `RULE` cell draws the name from section 10.4. The `NODE` cell names the offending element, in the forms `session-codec → token-issuer → …`, `token-verifier · cold_start_p95`, `comment "Two caches here…"`, `crypto-primitives`, and `token-issuer.mint`. The `LOCATION` cell draws the breadcrumb path, in the forms `Stack › Auth Service` and `› Token Verifier`.

Errors sort above warnings. Each row navigates to the offending node on the correct Schematic. A user shall never scroll to discover that an error exists.

### 12.15 Registries and rules

These surfaces are tables and not Schematics. This is the spreadsheet-shaped part of the product.

The library registry blocks an add with an incompatible license and states the reason at the point of the add.

The rule registry reads as a document and not as a configuration dump. A user shall read every standard an agent follows on one screen.

### 12.16 Search

Search is global and keyboard-invoked with `Ctrl+K`. Search spans nodes, contract methods, test cases, rules, libraries, screens, flows, decisions, and marker tokens.

Search matches slug, title, description text, and marker token. Ranking runs in this order: exact slug, exact marker token, title prefix, title substring, description substring. Results group by kind and draw the breadcrumb path to each hit.

The index builds on project load and updates on every semantic write.

### 12.17 Product surfaces

The `Product` section of the Outline holds the brief, the screens, and the flows.

The Screen registry lists every screen with slug, title, purpose, state count, backing module count, and design-link state. The per-screen form edits purpose, states, acceptance conditions, design link, and backing modules.

The Flow editor holds an ordered step list. Each step names 1 screen and 1 action.

The Project brief draws one field per brief key. A `success_metric` field rejects a value with no unit.

### 12.18 Decision log

The `Decisions` section of the Outline holds the log. The log draws as a table filtered by `status`. A new decision adds a row. A superseding decision adds a row and marks the prior row `SUPERSEDED`. The surface offers no edit control on an existing row and no remove control on any row.

### 12.19 Agent affordances

Agent involvement sits at 3 places and nowhere else.

1. **Assign** — the Inspector `Assign` control hands the node to an agent and moves lifecycle to `assigned`.
2. **Pre-fill** — the `Pre-fill with agent` control on a Module Schematic drafts content for human review. Pre-filled content enters at `draft` with `authored_by` set to `agent`.
3. **Review queue** — a filtered list of nodes at `implemented` and nodes at `stale`.

### 12.20 Empty and first-run states

A new project opens on an empty Stack Schematic with 1 action: create the first service.

The Module Schematic empty state carries the heading `SAME CANVAS, EMPTY — FIRST RUN`, the lead `A module is one unit of implementable work.`, and the body `It carries a public contract, the test cases that cover it, resource budgets with probes, and the libraries it may use. Three facets are pre-seeded so the shape is obvious.`

That state seeds 1 empty `contract-method`, 1 empty `test-case`, and 1 empty `budget`, with the placeholders `name the first method…`, `given / when / then…`, and `metric, threshold, probe…`.

The state carries a boundary note headed `◈ NOT HERE`: `User-facing behaviour, flows and wireframes belong in Journeyman. Forger references them; it does not hold them.` Wave 10 rewrites that note to name the Screen registry in place of Journeyman.

### 12.21 Cross-application search

Global search shall expose its index through the shell search surface. A hit inside Schematify then reaches the shell result list. The shell surface contract is undefined at the date of this document. Open item 19.5 tracks it. Wave 8 shall build the index behind a boundary that a shell adapter reaches later.

---

## 13. Design tokens

The wireframes carry literal hex values and no named token. Wave 2 shall define these CSS custom properties, and application code shall carry no literal hex value.

### 13.1 Surface and line

| Token | Value | Use | Provenance |
|---|---|---|---|
| `--kv-bg-root` | `#0e1013` | Behind the application frame | [W] |
| `--kv-bg-app` | `#14161a` | The primary surface | [W] |
| `--kv-bg-panel` | `#1b1e24` | Panels and node fill | [W] |
| `--kv-bg-raised` | `#22262e` | Raised surface and the Schematic grid dot | [W] |
| `--kv-line` | `#2c313b` | The 1 px hairline border and the chip fill | [W] |
| `--kv-line-draft` | `#3a404b` | The dashed border of a `draft` node | [W] |

### 13.2 Text

| Token | Value | Use | Provenance |
|---|---|---|---|
| `--kv-text-primary` | `#e4e7ec` | Titles and primary body | [W] |
| `--kv-text-near` | `#c9ced8` | Near-primary body | [W] |
| `--kv-text-secondary` | `#949cab` | Labels and secondary body | [W] |
| `--kv-text-tertiary` | `#6d747f` | Slugs, hints, and edge stroke | [W] |
| `--kv-text-dim` | `#5b616c` | Dimmed body | [W] |
| `--kv-text-faint` | `#4f5663` | Faint body | [W] |
| `--kv-text-disabled` | `#4a505b` | Disabled body | [W] |

The wireframes use `#4a505b`, `#4f5663`, and `#5b616c` as text colors alone. No border and no stroke carries them.

### 13.3 Accent and semantic

| Token | Value | Use | Provenance |
|---|---|---|---|
| `--kv-accent` | `#d98a3f` | Choice, active node border, `accepted` saturation | [W] |
| `--kv-ok` | `#5fb37a` | Pass, ready, matched | [W] |
| `--kv-warn` | `#d9a93f` | Soft budget failing, test failing | [W] |
| `--kv-error` | `#d9635f` | Hard budget failing, lint error | [W] |
| `--kv-agent` | `#956fd9` | Agent-authored content and screen references | [W] |
| `--kv-accent-hover` | `#e8a862` | Hover on an accent control | [P] |
| `--kv-info` | `#5f95d9` | Informational mark | [P] |

The values `#e8a862` and `#5f95d9` appear once each in the wireframes, both as a text color. The 2 roles above are proposals.

The token `--kv-ok` carries the meaning of readiness. Schematify shall never use `--kv-ok` for decoration.

### 13.4 Typography

| Token | Value | Provenance |
|---|---|---|
| `--kv-font-mono` | `'IBM Plex Mono', monospace` | [W] |
| `--kv-font-sans` | `'IBM Plex Sans', system-ui, sans-serif` | [P] |

Every drawn string inside the 6 wireframe screens uses `IBM Plex Mono`. The sans face loads in the wireframe document chrome and reaches no product surface. Schematify draws titles, descriptions, and prose in sans, and that choice is a proposal.

The wireframe declares weight 500 and weight 600, and no weight above 600. Body text uses weight 400.

The wireframe size ramp holds 15 sizes.

`7.5px` `8px` `8.5px` `9px` `9.5px` `10px` `10.5px` `11px` `11.5px` `12px` `12.5px` `13px` `14px` `15px` `20px`

Label tracking on small monospace capitals: 0.04 em, 0.05 em, 0.06 em, and 0.07 em. The default is 0.07 em.

### 13.5 Geometry

| Token | Value | Use | Provenance |
|---|---|---|---|
| `--kv-radius` | `3px` | The default corner | [W] |
| `--kv-radius-chip` | `2px` | A chip and a badge | [W] |
| `--kv-radius-lg` | `4px` | A card and a control | [W] |
| `--kv-radius-xl` | `5px` | The Stack Schematic node box | [W] |
| `--kv-radius-pill` | `8px` | The dock count badge | [W] |
| `--kv-radius-dot` | `50%` | The lifecycle dot and the ports | [W] |
| `--kv-grid-size` | `22px` | The Service and Module Schematic grid | [W] |
| `--kv-grid-size-stack` | `26px` | The Stack Schematic grid | [W] |
| `--kv-grid-dot` | `radial-gradient(#22262e 1px, transparent 1px)` | The Schematic ground | [W] |
| `--kv-panel-outline` | `238px` | The Outline width | [W] |
| `--kv-panel-inspector` | `360px` | The Inspector width in application | [W] |
| `--kv-panel-inspector-wide` | `380px` | The Inspector width in the tab exhibit | [W] |
| `--kv-dock-height` | `196px` | The bottom dock height | [W] |
| `--kv-titlebar-height` | `34px` | The title bar height | [W] |
| `--kv-radius-frame` | `6px` | The outer window frame | [P] |

The value `6px` appears once in the wireframes, on the wireframe's own screen wrapper. Schematify reuses it for the application window frame, and that reuse is a proposal.

Icon set and icon stroke width are undecided. Open item 19.9 tracks the choice.

Schematify ships 1 theme. The theme is dark. Every color reaches the surface through a token. A later light theme swaps values and touches no code.

---

## 14. Technical architecture

### 14.1 Stack

Schematify builds inside the existing Veistra monorepo. The stack is Tauri v2, Rust, React, and TypeScript. The package manager is pnpm. The verification command is `pnpm verify`.

### 14.2 The baseline audit

Wave 0 runs before any code. Wave 0 reads the repository and writes `docs/audits/schematify-baseline.md` naming:

- The path of the Tauri crate, and the current `commands.rs`, `lib.rs`, and `generate_handler!` sites.
- The path of the front-end workspace and the current package list.
- The module that draws the application tab strip and the strings it holds.
- The presence or absence of `veistra.toml`, the `.veistra` extension, `veistra-tool://`, and the `@veistra/*` scope.
- The steps `pnpm verify` runs.
- Every occurrence of the strings `Forger`, `Journeyman`, `forger://`, `journeyman://`, and `@forger:`.
- The reference machine: processor, memory, and operating system.

Wave 0 changes no file. Where the repository contradicts section 14.3, Wave 0 reports the conflict and stops.

### 14.3 Placement

| Path | Content |
|---|---|
| `crates/schematify-core` | Schemas, storage, graph construction, the linter, lifecycle rules |
| `crates/schematify-reconcile` | Marker-token scanning and the `veistra reconcile` command |
| `src-tauri/src/apps/schematify/mod.rs` | The single Tauri command registration module for this application |
| `packages/schematify-ui` | React surface, published under `@veistra/schematify-ui` |

Wave 0 confirms these paths against the repository. A path that conflicts with the existing layout is replaced by the existing convention, recorded in the baseline audit.

### 14.4 The merge-collision rule

Parallel agent sessions collide on `commands.rs`, `lib.rs`, `generate_handler!`, and `bindings.ts`.

Schematify shall register through 1 module, `src-tauri/src/apps/schematify/mod.rs`. Schematify shall add 1 line to `generate_handler!`. Every further command lands inside that module.

A wave that touches a shared registration file shall merge alone. Two waves shall never touch a shared registration file in one merge window.

### 14.5 Tauri commands

| Command | Purpose |
|---|---|
| `schematify_open_project` | Opens a project root and validates `.veistra/` |
| `schematify_load_graph` | Returns the whole graph and the validation report |
| `schematify_write_node` | Writes 1 node file |
| `schematify_write_edge` | Writes 1 edge file |
| `schematify_write_layout` | Writes 1 layout file |
| `schematify_transition` | Applies 1 lifecycle transition and appends 1 audit row |
| `schematify_lint` | Runs the graph linter and returns findings |
| `schematify_ingest_run` | Reads a `veistra-bench-v1` artifact and writes it under `runs/` |
| `schematify_search` | Returns ranked search hits across every kind |
| `schematify_reconcile_status` | Reads `runs/<node-uuid>/reconcile.json` |

Every command carries a typed wrapper in `bindings.ts` and an `actor` argument holding `human` or `agent`.

### 14.6 Boundary enforcement

CI enforces the architectural boundary. Convention enforces nothing.

- `cargo-deny` gates Rust dependencies against the library registry.
- `dependency-cruiser` gates TypeScript imports across package boundaries.
- A path-scope check blocks a pull request that writes to `runs/` and `nodes/` together, with the lifecycle pair in section 6.3 as the one exception.
- CODEOWNERS assigns `brief.json`, `nodes/`, `edges/`, `rules/`, `screens/`, `flows/`, `decisions/`, and `registry/` to the repository owner. The `runs/` tree and the `layout/` tree carry no owner, because a CI job and a node drag write them.

Wave 10 writes the CODEOWNERS file and names the owner.

### 14.7 Performance budgets

The reference machine is the developer workstation named in the baseline audit. Every number below is a first target and moves once a probe reports measured data.

| Metric | Threshold | Tier | Probe command | Asserted in |
|---|---|---|---|---|
| Cold launch to first Schematic paint | Under 2000 ms | hard | `pnpm bench:startup` | Wave 9 |
| Graph load, stress fixture | Under 1000 ms | hard | `pnpm bench:load` | Wave 1 |
| Service Schematic frame time, dense fixture | Under 16 ms | hard | `pnpm bench:frame` | Wave 3 |
| Node drag to layout write | Under 50 ms | soft | `pnpm bench:drag` | Wave 9 |
| Full graph lint, stress fixture | Under 500 ms | hard | `pnpm bench:lint` | Wave 7 |
| Search first result | Under 100 ms | hard | `pnpm bench:search` | Wave 8 |

The lint budget and the search budget carry the `hard` tier, because a wave acceptance blocks on each. A `soft` threshold and a `target` threshold shall never act as a wave gate.

Wave 9 declares these 6 budgets as nodes inside Schematify's own `.veistra/` project. The fixture budget nodes in section 16 are project data and sit outside that rule.

---

## 15. Visual design handoff

The wireframes hold the visual truth for 6 files: `1a Service canvas`, `1b Node anatomy`, `1c Inspector tabs`, `1d Module canvas`, `1e Stack canvas`, and `1f Module dashboard`.

Import the wireframes through the Claude Design MCP before any front-end code:

```
Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import this project:
https://claude.ai/design/p/522c739c-b021-4cce-b8a2-ae11c9f3353d?file=Forger+Wireframes.dc.html
Focus on these files (the whole project is readable):
- `Forger Wireframes.dc.html`
Also read these files the selection imports:
- `support.js`
Implement: `Forger Wireframes.dc.html`
```

The wireframes carry the retired names `Forger`, `Journeyman`, `SDD`, and `journeyman://`. Read the wireframes for geometry, density, state rendering, and copy. Read section 12 for the renamed strings.

Section 12.2 states which surfaces the wireframes cover.

The wireframe file carries 2 authoring props, `showCallouts` and `showChrome`. A callout is annotation on the wireframe and never product copy. Product copy is the text inside the drawn surfaces.

---

## 16. Reference fixture

Wave 1 writes 3 fixtures under `fixtures/`. One generator script, `fixtures/generate.mjs`, produces the dense fixture and the stress fixture.

### 16.1 The wireframe fixture

`fixtures/saas-backend/` reproduces the wireframe content. A built screen and its wireframe then hold the same words.

**Project:** `saas-backend`, path `~/work/saas-backend`, branch `main`, 3 uncommitted files.

**Stack tier.** Eight nodes. Seven carry kind `service`. `platform-core` carries kind `group`.

| Node | Title | Kind and layer | Badges and counts |
|---|---|---|---|
| `api-gateway` | API Gateway | service, `edge` | `📌 ENTRY`, `11 exports`, `4 modules` |
| `platform-core` | Platform Core | group | `contains 2` |
| `auth-service` | Auth Service | service, `backend` | `accepted`, `4 exports`, `12 modules`, `worst contained: 1 soft budget trending` |
| `session-service` | Session Service | service, `data` | `2 exports`, `6 modules` |
| `billing-service` | Billing Service | service, `backend` | `6 exports`, `9 modules` |
| `notification-service` | Notification Service | service | `draft · 0 exports authored` |
| `ledger-store` | Ledger Store | service, `data` | `3 exports`, `schemas ✓` |
| `event-bus` | Event Bus | service | `accepted`, `SHARED · AT LCA`, `4 dependents` |

`platform-core` contains `auth-service` and `session-service`. `ledger-store` sits inside `session-service`. `event-bus` sits at the stack root with 4 dependents. Seven dependency edges join them.

Every service in this table carries `contract-method` facets matching its export count, so `11 exports` on `api-gateway` resolves to 11 authored methods.

**Derived tech stack:** `jose 5.2.4 · MIT` used by 6 modules; `zod 3.23.8 · MIT` used by 14 modules; `argon2 0.31 · Apache-2.0` used by 2 modules; `postgres 3.4 · Unlicense` used by 9 modules. The generator assigns `allowed_libraries` across the modules of the 7 services so each count holds.

**Service tier, `auth-service`.** Twelve module nodes, containment depth 3, 9 dependency edges, zoom 68%.

| Module | Title | State and content |
|---|---|---|
| `http-entry` | HTTP Entry | `📌 ENTRY POINT`, `4 exports` |
| `token-issuer` | Token Issuer | `Mints access and refresh pairs, binds them to a session record.`, `3 meth`, `5 test`, `2 budg`, libraries `jose` and `zod` |
| `token-verifier` | Token Verifier | `Verifies JWT signatures against the rotating key set.`, `contains 2` |
| `jwks-cache` | JWKS Cache | child of `token-verifier`, `2 meth`, `6 test` |
| `clock-skew` | Clock Skew | child of `token-verifier`, `draft · no run data` |
| `session-store` | Session Store | `collapsed · 2 children`, `3 edges aggregated` |
| `session-codec` | Session Codec | child of `session-store`, source of the dependency cycle |
| `session-index` | Session Index | child of `session-store` |
| `crypto-primitives` | Crypto Primitives | `accepted`, `SHARED · AT LCA`, `2 dependents`, `6 meth`, `14 test`, `1 budg` |
| `password-hasher` | Password Hasher | `Argon2id hashing with per-tenant cost parameters.`, `reviewed · awaiting accept` |
| `rate-limiter` | Rate Limiter | `◇ AGENT DRAFT`, `Pre-filled by agent. Not reviewed.` |
| `audit-emitter` | Audit Emitter | `accepted`, `⚠ STALE — upstream contract changed`, second line `crypto-primitives.sign changed 2h ago. Re-review required.` |

One group titled `Token pipeline`. One comment by `m.ross` reading `Two caches here on purpose — the JWKS one is remote-backed, the skew one is not. Don't merge.` One screen reference to `schematify://screen/login-form`.

**Export strip:** `4 · authored` — `issue_pair` on `token-issuer`, `verify_signature` on `token-verifier`, `revoke` on `session-store`, `check_password` on `password-hasher`.

**Problems:** 3 errors and 2 warnings.

| Severity | Rule | Node | Location |
|---|---|---|---|
| `● ERROR` | `Dependency graph is acyclic` | `session-codec → token-issuer → …` | `Stack › Auth Service` |
| `● ERROR` | `Budget declared without a probe` | `token-verifier · cold_start_p95` | `› Token Verifier` |
| `● ERROR` | `Annotation node carrying a semantic edge` | `comment "Two caches here…"` | `Stack › Auth Service` |
| `▲ WARN` | `Shared node sits above the LCA of its dependents` | `crypto-primitives` | `Stack › Auth Service` |
| `▲ WARN` | `Contract method with no covers edge` | `token-issuer.mint` | `› Token Issuer` |

**Module tier, `token-verifier`.** Methods: `verify_signature`, exported, `(token: string, jwks: KeySet)` returning `Result<Claims, VerifyError>`, semantics `Rejects on expiry, unknown kid, or skew beyond the configured window.`, 4 covers edges; `refresh_keys`, `(force?: boolean) → Promise<void>`, 3 covers edges; `skew_window`, `() → Duration`, 0 covers edges.

Test cases: `expired token is rejected`, linked and passing at 41 ms; `unknown kid triggers one refetch`, linked and failing with `expected 1 fetch, saw 2`; `clock skew at the boundary`, declared with no marker. Four further cases bring the total to 7, of which 5 pass.

Budgets: `verify_p95` hard at 1.8 ms against 3 ms with probe `pnpm bench:verify`; `jwks_refetch_rate` soft at 0.9 per minute against 1 per minute, trending, signed off by `m.ross` at run `#1179`; `cold_start_p95` hard with no probe.

One agent-drafted `doc-block` with `audience: agent` and the body `Call verify_signature before any session lookup; the key set is cached and refreshed lazily…`. One `external-dep` on `jose@5.2.4`, `MIT · registry ✓`.

**Runs:** run `#1184` at `2026-08-25 14:02Z`, commit `4f2c9ab`, workflow `ci/verify.yml`. Counters `2 / 3` budgets, `5 / 7` tests, `0` linter violations against 14 rules, `7 / 8` reconciliation.

**Reconciliation rows:** `matched` at `src/auth/verifier.ts +3 more`, count 7; `declared, absent` at `skew_window — no marker`, count 1; `present, unknown` at `—`, count 0; `duplicate` at `—`, count 0.

**Contract history:** `25 Aug 11:40` — `verify_signature returns Result, was throw`; `19 Aug 09:12` — `skew_window added`; `02 Aug 16:55` — `refresh_keys force flag added`.

**Audit log**, the 5 most recent rows:

| When | Transition | Actor | Reason |
|---|---|---|---|
| `25 Aug 14:02` | `reviewed → accepted` | `m.ross · human` | `Result type resolves the throw-on-expiry ambiguity.` |
| `25 Aug 11:40` | `implemented → reviewed` | `m.ross · human` | `Contract amended during review.` |
| `24 Aug 22:18` | `assigned → implemented` | `◇ agent · claude-sdd` | `All declared tests linked. 1 failing, flagged not asserted.` |
| `24 Aug 09:05` | `reviewed → specified` | `j.okonkwo · human` | `Bounced: skew tolerance was unspecified.` |
| `21 Aug 15:31` | `specified → assigned` | `j.okonkwo · human` | `Handed to agent.` |

Earlier rows precede these and complete the path per section 7.2.

**Rule registry:** 14 rows, so the `LINTER` counter reads `14 rules · 0 violations`.

### 16.2 The dense fixture

`fixtures/dense-service/` holds 1 service with 200 modules at containment depth 5 and 260 dependency edges, produced by `fixtures/generate.mjs`. Wave 3 asserts the 16 ms frame budget against it.

### 16.3 The stress fixture

`fixtures/stress-2000/` holds 2000 nodes across 20 services and 3000 edges, produced by `fixtures/generate.mjs`. Wave 1 asserts the 1000 ms load budget against it. Wave 7 asserts the 500 ms lint budget against it. Wave 8 asserts the 100 ms search budget against it.

### 16.4 Wireframe arithmetic conflicts

Two drawn counts disagree with the content drawn beside them. Section 0.4 makes the computed value the truth. Each row needs an owner decision.

| Drawn string | Drawn beside | Computed value | Open item |
|---|---|---|---|
| `6 services` on the Stack Schematic | 7 nodes of kind `service` | `7 services` | 19.11 |
| `layer backend · 4 facets` on the module root | 7 facet cards on the same Schematic | The full facet count | 19.12 |

Wave 1 builds the fixture from the named node lists. Wave 2 draws the computed counts. Where a computed count differs from a wireframe count, the build is correct and the wireframe carries the conflict.

---

## 17. Build waves

Each wave states its prerequisites, its scope, and its acceptance conditions. Each wave ends with a commit and a pull request.

### Wave 0 — Baseline audit

Prerequisites: none.

- Run the audit in section 14.2 and write `docs/audits/schematify-baseline.md`.
- Change no other file.

Acceptance: the audit names every path, every string occurrence, the reference machine, and every `pnpm verify` step. A conflict with section 14.3 is reported and the wave stops.

### Wave 1 — Rename, schemas, storage, fixtures

Prerequisites: Wave 0.

- Retire the names Forger and Journeyman across the repository, the documentation, and the product strings.
- Convert `forger://`, `journeyman://`, and `decision://` references to the `schematify://` form.
- Convert the `@forger:` marker token to `@veistra:`.
- Create `crates/schematify-core` and `packages/schematify-ui`.
- Build every schema in section 5, including the edge, rule, library, layout, and run schemas.
- Build UUIDv7 minting, slug uniqueness per section 3.2, and the atomic JSON writer.
- Build the graph loader from section 6.4, with quarantine on a dangling reference.
- Write `fixtures/generate.mjs` and the 3 fixtures in section 16.
- Add the terminology rows and acronym rows from section 2 to `core/terminology.csv`.

Acceptance: `pnpm verify` passes. The loader reads `fixtures/stress-2000/` in under 1000 ms. A dangling reference produces a quarantine record and no crash. The string `Forger` survives in no product string. Every named node in section 16.1 exists in `fixtures/saas-backend/`.

### Wave 2 — Shell, tokens, status bar

Prerequisites: Wave 1.

- Define every token in section 13 as a CSS custom property.
- Build the title bar, the application tab strip, the breadcrumb, and the toolbar.
- Build the Outline with its section switcher, the Schematic host, and the Inspector shell.
- Build the bottom dock frame and the status bar at the stated dimensions.
- Draw cell 1 and cell 2 of the status bar. Leave cell 3 and cell 4 empty until Wave 7 and Wave 9.
- Build the first-run empty state for the Stack Schematic.

Acceptance: `packages/schematify-ui` holds no literal hex value. The shell opens `fixtures/saas-backend/` and draws the Outline tree with its header, badges, triangles, and footer. Cell 1 reads `.veistra/ · 12 nodes · 9 edges`. Cell 2 reads `layout/auth-service.json clean`.

### Wave 3 — Schematic engine

Prerequisites: Wave 2.

- Build one Schematic engine, configured 3 ways.
- Build pan, zoom, box-select, multi-select, copy, paste, duplicate, undo, and redo under section 12.3.
- Build containment nesting, collapse with a child count, and edge roll-up to a collapsed border.
- Build orthogonal edge routing under the constraints in section 12.3.
- Build port-to-port edge creation with drag-time refusal and a cursor-anchored reason.
- Build groups and comments under section 12.4.
- Build the minimap, the zoom readout, and the edge legend.
- Persist positions to `layout/<schematic-slug>.json` through `schematify_write_layout`.

Acceptance: a node drag writes no semantic file. A semantic edge dropped on a comment is refused with the `Drop refused` text from section 11.3. A cycle edge is refused with the text in section 12.5. A duplicate mints a new UUIDv7. `fixtures/dense-service/` holds a 16 ms frame time, asserted from a test suite.

### Wave 4 — Node rendering

Prerequisites: Wave 3.

- Build the node anatomy in section 12.6, including the badge set, the count strings, the caption strings, and the wedge glyphs.
- Build the 8 lifecycle treatments in section 12.7.
- Build the 4 health wedges in section 12.8, including the service roll-up in words.
- Build the 3 zoom tiers in section 12.7.

Acceptance: every lifecycle state draws distinctly with color removed. The health wedge never overlaps the node menu. Border weight and overlay geometry survive at 22% zoom. Every badge, count, and caption that `fixtures/saas-backend/` can produce draws from that fixture. A unit test covers the `FRONTEND` badge and the `EXTERNAL` badge, because the fixture holds no such node.

### Wave 5 — The three Schematics

Prerequisites: Wave 4.

- Build the Stack Schematic under section 12.9, including the shared-node callout, the `CANVAS PROPERTIES` empty state, and the footer note.
- Build the Service Schematic under section 12.10, including the pinned entry point and the export strip with the `←` marker and row-to-module highlight.
- Build the Module Schematic under section 12.11, including the facet palette, the facet cards, the agent-draft controls, the `SATISFIES` callout, and the coverage readout.
- Build the Module Schematic empty state under section 12.20.
- Build click-to-drill and breadcrumb walk-up.
- Build `Auto-sort` and `Fit` on all 3 tiers.

Acceptance: one Schematic engine serves all 3 tiers. A click on a service opens its Service Schematic. A click on a module opens its Module Schematic. The module root node cannot be deleted. The coverage readout computes `7 of 8` on the fixture.

### Wave 6 — Inspector

Prerequisites: Wave 5.

- Build S-04 through S-11 with the `More` overflow tab under section 12.12.
- Draw the opaque identifier in a copy-on-click field, and nowhere else.
- Draw an unlinked test case and a failing test case as 2 different problems.
- Draw a budget with no probe with `Add probe` and `Drop budget`.
- Draw internal dependencies read-only, and external libraries with the license shown.
- Build the export-list editor on a service node.
- Build the Inspector empty state with the Schematic properties and the derived tech stack.
- Build the `Open module canvas` and `Assign` footer controls.

Acceptance: the Inspector edits a node and writes 1 file. The Contract tab draws an OpenAPI view for `api-gateway`, whose 11 exports resolve to 11 methods. Every Inspector string in section 12.12 draws from the fixture. Five flat tabs draw at 380 px, and 4 tabs plus `More` draw at 360 px.

### Wave 7 — Linter and Problems

Prerequisites: Wave 6.

- Build rules L01 through L13 in `crates/schematify-core`.
- Wire `schematify_lint`.
- Build the Problems panel with the 4 columns, the severity glyphs, severity grouping, and click-through.
- Draw status-bar cell 3.

Acceptance: the linter runs over `fixtures/stress-2000/` in under 500 ms, asserted from a test suite. `fixtures/saas-backend/` produces the 5 rows in section 16.1, with the same rule names, node cells, and location cells. Errors sort above warnings. Both badges stay visible on the collapsed strip.

### Wave 8 — Registries, rules, search

Prerequisites: Wave 7.

- Build the library registry with license blocking at add time.
- Build the rule registry, drawn as a document and not as a configuration dump.
- Build global search under section 12.16, behind an index boundary a shell adapter reaches later.

Acceptance: a library with a blocked license is refused with a stated reason. A module cannot whitelist a library missing from the registry. Search returns a first result in under 100 ms on `fixtures/stress-2000/`, asserted from a test suite.

### Wave 9 — Runs, dashboard, reconciliation

Prerequisites: Wave 8.

- Build the `veistra-bench-v1` reader against the schema in section 5.10.
- Wire `schematify_ingest_run` and build the Runs dock tab.
- Draw status-bar cell 4.
- Build `crates/schematify-reconcile` and the `veistra reconcile` command under section 9.3.
- Build the Module dashboard under section 12.13, with all 5 counters, every named column, and every section header.
- Declare the 6 budgets in section 14.7 inside Schematify's own `.veistra/` project, each with its probe command.
- Add the 6 `pnpm bench:*` scripts.

Acceptance: the dashboard holds no editable control. The actor column names human or agent on every row. A duplicate marker token produces an error and exit code 1. Every counter and every column cell draws the section 16.1 value.

### Wave 10 — Lifecycle, product layer, decisions, gates

Prerequisites: Wave 9.

- Build the transition table in section 7.2 and the audit append.
- Build the staleness cascade in section 7.4, with the caption row and its second line.
- Block the accept transition from an agent actor at the command boundary.
- Build the Project brief, the Screen registry, the Flow editor, and the Decision log.
- Build the screen chip, the module-root screen path, and the click-through to the Screen registry.
- Rewrite the `◈ NOT HERE` note to name the Screen registry.
- Build the Review queue, `Assign`, and `Pre-fill with agent`.
- Build S-25, the node-kind registration form.
- Add the CI gates in section 14.6 and write CODEOWNERS.
- Add the decision rows in section 20 to the Veistra decision log.

Acceptance: a contract change drops every dependent from `accepted` to `stale`. An agent call to the accept transition is rejected at the command boundary. A decision row cannot be edited or removed. The CI path-scope check blocks a mixed write and passes the lifecycle pair. A registered node kind joins the graph and draws on a Schematic.

---

## 18. Out of scope

- Schematify shall not execute a test, a code linter, or a benchmark against the target project.
- Schematify shall not write application code into the target project.
- Schematify shall not hold pixel-level visual design.
- Schematify shall not ship a light theme in this release.
- Schematify shall not ship the hosted `runs/` store in this release.
- Schematify shall not ship cross-repository version pinning in this release.
- Schematify shall not ship the shell search adapter in this release.

---

## 19. Open items

These items block no wave. Each item needs a decision before the release that follows this one.

1. The disposal rule for in-progress agent work when a node returns to `specified`.
2. The expiry rule for a `soft` budget sign-off.
3. The migration path for a node whose `kind` changes, such as a module promoted to a service.
4. The conflict rule when a hosted `runs/` store and local git history disagree on lifecycle state.
5. The shell search surface contract, and the survival of the term `HELVE App API`.
6. The repository rename path from `Firelight-Innovations/HELVE-ADE`.
7. The relation between the Schematify decision log and the Veistra `core/decisions/` CSV convention.
8. The edge routing algorithm, the auto-sort algorithm, and the bundling rule above 40 edges on one Schematic.
9. The icon set and the icon stroke width.
10. The layout filename rule if two Schematics ever share a slug across tiers.
11. The `6 services` count against 7 service nodes on the Stack Schematic.
12. The `4 facets` count against 7 facet cards on the Module Schematic.
13. The mono-only wireframe type against the proposed sans face for prose.
14. Whether the Module Schematic gains a toolbar, an Outline, a dock, and a status bar.

---

## 20. Decisions this document sets

Add each row to the Veistra decision log in Wave 10. Domain: `core/decisions/technical/schematify/`.

| Proposed id | Decision | Domain |
|---|---|---|
| SCH-SCO-001 | Schematify replaces Forger and Journeyman as one application | scope |
| SCH-SCO-002 | Schematify holds the product layer as screen and flow nodes with no visual design | scope |
| SCH-SCO-003 | Schematify holds the decision log as internal nodes, superseding `FORGER-SPEC.md` section 1 | scope |
| SCH-SCO-004 | The wireframes outrank every written source on visual and copy questions | scope |
| SCH-SCO-005 | Every drawn count is computed at draw time and never stored | scope |
| SCH-ARC-001 | The `schematify://` scheme replaces `forger://`, `journeyman://`, and `decision://` | architecture |
| SCH-ARC-002 | The marker token changes from `@forger:` to `@veistra:` | architecture |
| SCH-ARC-003 | The storage root changes from `sdd/` to `.veistra/` | architecture |
| SCH-ARC-004 | Schematify registers through 1 Tauri module and 1 `generate_handler!` line | architecture |
| SCH-ARC-005 | A layout file is keyed by Schematic slug, matching the wireframe status bar | architecture |
| SCH-ARC-006 | The `references_ui` edge is authoritative and `ui_refs` is a derived cache | architecture |
| SCH-API-001 | The `veistra reconcile` command runs marker scanning outside the interface process | api |
| SCH-API-002 | The `veistra-bench-v1` schema carries every ingested probe result | api |
| SCH-API-003 | Every Tauri command carries an `actor` argument holding `human` or `agent` | api |
