# Wave 8a handoff: registries, rules, and the search index

The Rust half of PRD wave 8, in `crates/schematify-core`. Three pieces: the
library registry with a design-time licence gate, the rule registry arranged as
a document, and global search behind an index boundary.

Nothing in `apps/`, nothing in `src-tauri/`, no Tauri command, no interface
file. The registry tables, the rule document page and the `Ctrl+K` palette are
the interface half.

Branch `schematify/w8a-registries`, pull request
<https://github.com/Firelight-Innovations/Veistra/pull/87>.

**Everything here is additive.** No type, function or field that existed before
this branch changed its shape or its signature. The branch wiring the
application to this crate compiles against it unchanged. Section 7 lists the
one internal refactor, which is private and does not cross the crate boundary.

---

## 1. The library registry, and the licence gate

```rust
registry.add(entry, &policy) -> Result<(), RegistryError>
whitelist_library(&mut module, &registry, library) -> Result<(), RegistryError>
```

### The refusal states the reason

PRD section 12.15 asks the registry to block an add "and state the reason at
the point of the add". So the refusal carries the reason rather than merely
failing, in the same spirit as the evidence a linter finding carries:

```
readline 8.2 is licensed GPL-3.0-or-later, which this project blocks
under GPL: GPL is copyleft: linking it in can oblige the whole work to
be released under the GPL.
```

`RegistryError::BlockedLicense` carries `name`, `version`, `license`, the
`pattern` that matched and the `reason` as separate fields, so a surface can
draw them in its own layout instead of parsing that sentence back apart. The
`Display` above is the fallback for a log line.

### The policy

`LicensePolicy` holds a deny-list of `BlockedLicense { pattern, reason }`, and
an optional `allowed` list that switches it to allow-list mode. `Default` is
the three copyleft families, GPL, AGPL and LGPL, each with its own reason.
`LicensePolicy::permissive()` blocks nothing.

Matching is by family, and it takes three spellings. The bare name, `GPL`. The
name and a separator, which is canonical SPDX: `GPL-3.0-or-later`, `GPL+`,
`GPL 2.0`. And the name with the version written straight onto it, which is how
somebody not reading SPDX writes it: `GPLv2`, `GPL2`, `AGPLv3`.

**The third spelling was missing until review caught it, and it was a hole
rather than a tidiness point.** A registry that blocks `GPL-2.0` and admits
`GPLv2` blocks a spelling rather than a licence, and the hand-typed spelling is
the one most likely to get in. Every fixture and every canonical identifier
uses a separator, which is exactly why the first round of tests did not catch
it. Two tests cover it now, one on the policy and one on the add.

A version suffix is a digit, optionally behind a `v`, which is what keeps
`GPLish-1.0` and `GPLv` out. A different family stays out on the prefix alone,
since `LGPL-3.0` does not begin with `GPL`. That is also why the default names
the three families separately rather than relying on one prefix.

**The default is a deny-list, and this repository's own `deny.toml` argues for
an allow-list.** That argument is sound where the set of licences is knowable,
which is true of one repository's dependency tree and false of every project
Schematify is ever pointed at. A default allow-list would refuse `Unlicense`
the first time somebody added a library under it, and what a person does when a
check refuses something obviously fine is switch the check off. A project that
wants the stricter shape sets `allowed` and gets exactly `deny.toml`'s
behaviour. The reference fixture ships `MIT`, `Apache-2.0` and `Unlicense`, and
a test asserts every one of them survives the default.

### A module cannot whitelist what the registry lacks

`whitelist_library` refuses at the moment of the write, which is the only place
the acceptance condition's "cannot" can be a refusal rather than a report. It
also refuses a node that is not a module, and adding a library the module
already holds succeeds and changes nothing, so a caller retrying a write does
not have to check first.

**Linter rule L04 is not redundant with this.** A `.veistra/` tree arrives by
`git merge` and by hand as well as through this function, and a rule that
guards one of three doors guards nothing. This one refuses; L04 finds what got
in anyway. Both are tested against the reference fixture.

---

## 2. The rule registry as a document

`RuleDocument::build(graph.rules())` is the model half of PRD section 12.15's
"reads as a document and not as a configuration dump".

### What the panel reads

```rust
RuleDocument { sections: Vec<RuleSection> }
RuleSection { severity, heading: &str, caption: &str, rules: Vec<RuleRow> }
RuleRow { id, slug, statement, command, marker, last_change: Option<AuditRow> }
```

- **`sections`** are in severity order and are the page's structure. A severity
  no rule carries is absent rather than empty, so the page holds no heading
  with nothing under it.
- **`heading`** reads `MUST`, `SHOULD` or `UNDER REVIEW`.
- **`caption`** is one sentence saying what that severity means, drawn under
  the heading, so the document explains its own arrangement instead of assuming
  the reader knows the severity vocabulary.
- **`statement`** is the body of a row and the thing a reader is there for. It
  is prose, one sentence, and the page should set it as prose rather than as a
  table cell. That is the whole difference between a document and a dump.
- **`command`** and **`marker`** are secondary: where to enforce it and where
  it lives in code.
- **`last_change`** is the newest row of that rule's own audit history, which
  is what dates a standard on the page.
- **`rule_count()`** is the left half of the dashboard `LINTER` card.

The arrangement is by severity because what a violation costs is what a reader
is deciding about when they scan a standards document. Within a section the
order is by slug, so the page does not reshuffle between loads.

Nothing here is stored. PRD section 0.4 makes a count a draw-time computation,
and this whole type is one: built from the rules the graph already holds and
thrown away after the page renders.

### The `LINTER` card carries two different numbers

The wireframe draws `14 rules · 0 violations`. The 14 is `rule_count()`, this
registry, the standards an agent follows on the target project. The violations
number is **not** from here and not from the graph linter either: PRD section
10.4's 13 rules are a different set entirely. The wave 7a handoff raised this
and it is still open, recorded in section 6 below.

---

## 3. Search, and the index boundary

### The boundary is the `SearchIndex` trait

```rust
pub trait SearchIndex {
    fn search(&self, query: &str, limit: usize) -> Vec<SearchHit>;
    fn entry_count(&self) -> usize;
    fn is_empty(&self) -> bool;
}
```

**A shell adapter takes `&dyn SearchIndex` and names nothing else.** That is
the boundary the wave asked for, and it is a trait rather than a struct
because neither the storage nor the matching is settled: `GraphIndex` is a flat
vector scanned linearly, and the obvious next step is an inverted index. Behind
the trait that is a private change. An inverted index is not built now because
2000 entries scan in a fraction of the budget and an index nobody has measured
against is a guess.

`GraphIndex::build(&graph)` is the only other public entry point, and it exists
because something has to construct the thing. PRD section 12.16 says the index
builds on project load and updates on every semantic write; the build is here
and the incremental update is not, which section 7 records.

### What a hit carries

```rust
SearchHit { kind: HitKind, subject: Uri, slug, title, breadcrumb: String, rank: MatchRank }
```

- **`kind`** is what section 12.16's "results group by kind" groups on.
  `HitKind::Node { kind }` carries the node kind, because section 12.16 lists
  nodes, contract methods and test cases as separate groups and all three are
  nodes. `heading()` gives the drawn group name.
- **`subject`** is a `schematify://` reference, so a screen hit and a node hit
  are addressable in one field and the palette does not have to know which
  collection to look in.
- **`breadcrumb`** is section 12.16's "breadcrumb path to each hit", already
  drawn. For a node it comes from `location_of`, **the same function the
  Problems panel uses**, so search results and lint rows cannot disagree about
  where one node lives. For the other collections it reads `Rules`,
  `Libraries`, `Product` or `Decision Log`.
- **`rank`** is why it matched, which is also why it sorts where it does.

### What is indexed, and how it ranks

Everything section 12.16 names: every node, and its description; a test case's
`impl_ref` marker token; every rule, its statement and its marker; every
library, its name and version; every screen, flow and decision.

`MatchRank` is section 12.16's ranking in its order: `ExactSlug`,
`ExactMarker`, `TitlePrefix`, `TitleSubstring`, `DescriptionSubstring`. It
derives `Ord` in that order, so sorting is the ranking.

**One tier was added: `SlugSubstring`, last.** Section 12.16 says search matches
the slug, and its ranking names only an *exact* slug, so a partial slug would
have been matched by nothing. It sits below all five stated tiers, so the five
keep their stated order. This is an addition to the PRD and section 6 records
it as an open item.

Ties break on slug, so a rerun over an unchanged graph returns the same order
and the keyboard selection does not move under the user.

---

## 4. Acceptance conditions

| Condition | Result | Evidence |
|---|---|---|
| A library with a blocked licence is refused with a stated reason | **Pass** | `tests/registries.rs::a_blocked_licence_is_refused_against_the_real_registry_and_states_why`, which asserts the drawn message names the library, the licence and the reason, and that nothing was added |
| A module cannot whitelist a library missing from the registry | **Pass** | `tests/registries.rs::a_module_cannot_whitelist_a_library_the_registry_does_not_hold`, which also asserts the same call succeeds for a registered library, so the refusal is the registry check and not the function failing outright |
| Search returns a first result in under 100 ms on `fixtures/stress-2000/` | **Pass** | `tests/registries.rs::search_returns_a_first_result_inside_the_wave_eight_budget`. **543 µs** measured against a 100 ms hard budget, in the unoptimised `cargo test` build, so about 0.5% of the budget |
| The rule registry is renderable as a document | **Pass** | `tests/registries.rs::the_rule_registry_reads_as_a_document_of_the_fourteen_rows` |
| `pnpm verify` passes | **Pass** | Section 5 |

### The search budget assertion, and why it cannot pass vacuously

The failure mode the reviewers have flagged twice on this build is a timing
assertion over an empty result. This one states its input and its output before
it times anything:

- the fixture loaded 2000 nodes and the load report is clean;
- the index holds 2000 entries, asserted against a named constant, so a
  fixture change is a loud failure rather than a quietly smaller budget;
- the query returns a first hit, and that hit is `stress-module-7-42`, the
  node the query asked for, at rank `ExactSlug`, of kind module, with a
  breadcrumb that starts `Stack › `.

Only then is the elapsed time asserted, and the message reports **microseconds
rather than whole milliseconds**. The query costs 543 µs against a 100 ms
budget, so at millisecond resolution a healthy run and a regression to forty
milliseconds both print `0` and a later reader learns nothing about the margin
they are spending. The comparison was nanosecond-precise either way; it was the
message that was uninformative.

A second test,
`the_stress_index_really_searches_rather_than_answering_from_one_lucky_row`,
closes the remaining gap: a query no entry satisfies comes back empty, a broad
query is truncated at the limit with every hit at the substring rank, and a
query that is an exact slug *and* a substring of nineteen others puts the exact
one first. The index is discriminating, not returning whatever it holds.

---

## 5. Verification

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

**New tests: 31.** Twenty-two unit tests, twelve in `registry.rs` and ten in
`search.rs`, and nine integration tests in `tests/registries.rs`. The whole
workspace is 847 and all pass.

---

## 6. Assumptions, and what an owner should look at

**The `SlugSubstring` rank is an addition to PRD section 12.16.** Its ranking
names five tiers and none of them matches a partial slug, while the sentence
above it says search matches the slug. Rather than reorder the five, the sixth
tier sits under them. If the owner wants the literal five, delete the variant
and the two lines that produce it; a query that is a fragment of a slug then
finds nothing unless it also appears in a title or a description.

**A deny-list default for licences, against `deny.toml`'s allow-list
argument.** Reasoning in section 1. This is the decision in this wave most
worth a second opinion, because it is a security-shaped default and the
repository already argues the other way for its own tree.

**One entry per library name.** PRD section 10.1 says the registry holds
"name, version pin", one pin per library, so `add` refuses a second entry for a
name already held and says which version is pinned. A project needing two
versions of one package side by side cannot express that, and would have to be
given a compound name. Nothing in the PRD asks for it.

**The rule document groups by severity.** PRD section 12.15 asks for a document
and does not say how it is arranged. Severity is the arrangement because it is
what a reader is deciding about, and it uses only fields section 10.2 already
defines. No schema field was added; `Rule` is untouched.

**Search matching is case-insensitive on both sides and does not tokenise.**
A query is one string, matched whole. `token verifier` does not find
`token-verifier`. Section 12.16 does not ask for tokenising and the palette
opens on a slug more often than on a sentence.

**Library hits carry a `schematify://node/` reference.** `UriKind` has four
values and none of them names a registry entry. Rather than add a variant to a
public enum that a shell branch may already match on, a library and a rule hit
carry their identifier under the node scheme, and `HitKind` is what tells a
caller which collection to look in. A `UriKind::Library` and `UriKind::Rule`
would be tidier and are a one-line change whenever the interface wants them.

---

## 7. Left undone

- **The registry tables, the rule document page and the `Ctrl+K` palette.**
  Interface work, scoped out. Sections 1 to 3 are what they are built against.
- **The index does not update on a semantic write.** PRD section 12.16 asks for
  both a build on load and an incremental update. The build is here; the update
  needs a write path to hook, and every write still goes through `Store`
  without an index in scope. Rebuilding `GraphIndex::build` costs a few
  milliseconds on the stress fixture, so a caller can rebuild on write until
  the incremental path exists. The trait boundary means adding it changes
  nothing above.
- **No Tauri command is wired.** Deliberate; PRD section 14.5 requires the
  `actor` argument every command carries, and that belongs with the surface.
- **The licence policy is not persisted.** `LicensePolicy` serialises, but
  nothing reads or writes it from `.veistra/`. PRD sections 5.10 and 6.1 give the
  registry directory one file, `libraries.json`, and adding a second file to a
  storage layout other waves are already reading felt like the wrong thing to
  do unasked. Callers pass `LicensePolicy::default()` today. If it should
  persist, `registry/license-policy.json` beside the library list is the
  obvious place and is a small change.
- **The tech-stack derivation of PRD section 10.3 is not a function here.** The
  wave brief named 10.3 as reading, not as a deliverable, and wave 1b's test
  already derives those counts inline from `allowed_libraries` against the
  registry. If the Inspector wants it as one call rather than as a fold, it is
  a small addition to `registry.rs` and nothing about it is unclear.
- **The `LINTER` card's violation count is still unresolved**, carried over
  from wave 7a. Section 2 above states the problem: the card draws
  `14 rules · 0 violations`, the 14 is this registry, and the violations number
  has no source that counts the same rules.

### The one internal refactor

`Scan::location` in `lint.rs` moved its body to a crate-private free function,
`location_of(&Graph, Uuid) -> Location`, so the search index draws the same
breadcrumb as the Problems panel. `Scan::location` still exists and still
returns the same thing, `Location` is unchanged, and nothing outside the crate
can see the difference. Two answers to "where is this drawn" would have
drifted, and a search result disagreeing with a lint row about one node is the
kind of bug nobody reports because each screen looks right on its own.
