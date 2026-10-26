# Schematify overnight build — morning summary

Written by the orchestrating session as the night ran. Everything below is
current as of the last line; the "Still open" section is the part that changes.

## What landed

Twenty-four pull requests merged to `main`, each one its own worktree and its own
branch, every one reviewed by a separate agent before merge except where noted.

| PR | Wave | What it built |
|---|---|---|
| #76 | 0 | Baseline audit — resolved where Schematify lives against existing conventions |
| #77 | — | Wireframe extraction: all 6 screens distilled, 19 binding rulings |
| #78 | 1a | Retired Forger and Journeyman, scaffolded Schematify |
| #79 | 9a | `@veistra:` marker scanning and the `veistra reconcile` command |
| #80 | 1b | Core schemas, storage, loader, fixtures — 159 tests |
| #81 | 2 | Shell, design tokens, status bar |
| #82 | 3 | The Schematic engine |
| #83 | 7a | The graph linter, rules L01–L13 |
| #84 | 4 | Node rendering — badges, lifecycle treatments, health wedges |
| #85 | 10a | Path-scope boundary enforcement in CI |
| #86 | — | Wired the application to the core crate |
| #87 | 8a | Registries, rules, and the search index |
| #88 | 5 | The three Schematics |
| #89 | 9c | Benchmark scripts and budget nodes |
| #90 | 9b | The run artifact reader and ingestion |
| #91 | 7b | The Problems panel and status-bar cell 3 |
| #92 | 6 | The Inspector — 8 tabs, export-list editor, footer controls |
| #94 | 10b | Lifecycle enforcement at the command boundary, staleness cascade |
| #97 | — | Fixed two test-infrastructure flakes (see below) |
| #96 | 9d | The Runs tab, the Module dashboard, and run ingestion |
| #95 | 7c | Drill-through scope routing and the Dock badges' loading state |
| #93 | 10c | The product layer — screens, flows, decisions, project brief |
| #98 | 11b | The `ui_refs` write — the derived cache nothing ever wrote |

## Two things needing your decision

### 1. The Inspector's 380px tab strip

At 380px all five tabs draw flat with no `More` tab, which leaves Dependencies,
Docs and References unreachable. Two agents read §12.12 independently and both
concluded this is what the PRD literally says — its wording is parallel, "4 tabs
plus `More`" at 360px against "5 flat tabs" at 380px, and the wave 6 acceptance
condition repeats the phrasing verbatim. No wireframe contradicts it.

It is dead code today: §12.1 fixes the Inspector at 360px with no splitter, so
the 380px branch is reachable only from tests. It matters the moment you add a
splitter.

### 2. Two repository settings only you can change

From wave 10a, still outstanding:

- Add `veistra-boundary` to the required checks. It runs on every PR and passes,
  but nothing enforces it.
- Enable "Require review from Code Owners". `.github/CODEOWNERS` already exists
  and wave 10a built it out to PRD §14.6, including the `.veistra/` nodes-vs-runs
  -vs-layout split; it was checked against `check-veistra-boundary.mjs` and the two
  agree, lifecycle-pair exception included. `required_pull_request_reviews` is
  simply absent from the branch protection, so this is a bare toggle blocked on
  nothing.

## What a human must verify on screen

**No browser was available to any agent all night.** Every visual claim below is
read-verified only. This is the single largest gap in the night's work.

- The Problems panel: badges reading 3/2 against `fixtures/saas-backend/`, five
  rows in two groups with a blank-row break, severity glyphs in the right accents.
- The collapsed dock strip: both badges still visible, 28px reading as a strip.
- The Inspector at 360px with `More` present — the only tab state reachable in
  the shipped app.
- The Module dashboard: layout and spacing, two real sparklines plus one
  "No probe declared" caption, the `← Back` button navigating.
- The Runs tab's single row, and status-bar cell 4's live relative time.
- The staleness caption row and its second line on a `stale` node.

This app's vitest runs `environment: "node"` with no rendering library, so no
`.tsx` behaviour anywhere has automated coverage. That is a pre-existing repo
decision, not something this build introduced.

## The defect pattern worth knowing about

**Tests that cannot fail.** Reviewers caught nine across the night, in six
different waves: a performance test measuring nothing, a lint rule matching
nothing, a geometry proof of a function nothing rendered from, a version test
whose fixture had no unknown fields, a filter test whose fixture made a broken
filter indistinguishable from a working one, and two write tests that checked a
file's path but never its contents.

The countermeasure that worked, and is now in every agent's brief: before
committing a test, break the production code on purpose, watch the test fail,
restore it, and say so in the commit message. Reviewers reproduce the mutation
rather than believing it. Several of the fixes above exist only because a
reviewer ran the mutation and the test stayed green.

## Two infrastructure defects fixed (PR #97)

Both cost multiple agents real time before being diagnosed.

**A 5 ms wall-clock assertion.** `atomic.rs`'s rename test asserted
`started.elapsed() < RENAME_BACKOFF` to prove no sleep happened, but the measured
window included the failing `fs::rename` syscall. On a loaded runner it measured
the runner. Now counts attempts instead.

**Stale paths across worktrees.** Tests resolving fixtures through
`env!("CARGO_MANIFEST_DIR")` bake an absolute path at compile time. All the
worktrees hold identical source, so Cargo reused whichever binary compiled first
and carried its path inside; when that worktree was deleted, five integration
binaries failed in whatever worktree ran next, naming a directory it had never
touched. It never reproduced in CI, which has one checkout.

At its worst this aborted `cargo test --workspace` before the run reached
`schematify-core` or `src-tauri` at all, so a red workspace result said nothing
about any Schematify code. Now every `manifest_dir()` helper reads the variable
at runtime and, if the path is missing, says it looks like a stale cross-worktree
build rather than leaving the next reader to guess.

## A process trap, for next time

**A green check on a PR whose base has moved proves nothing.** GitHub does not
re-run when the base advances. Four PRs merged tonight while others were open,
and one PR carried four green checks against a base two merges old — it failed to
compile the instant `main` was merged in, because a field it used had been
deleted meanwhile as a §0.4 breach. Its own handoff claimed `tsc` passed.

Compounding it: `pnpm test` does not typecheck. 711 green vitest tests sat on top
of code that would not build.

## Still open

Nothing. Every PR opened tonight is merged and no branch is outstanding. `main`
is at `339bd99`.

### What #98 found in its own inherited code

Worth reading, because it is the clearest example of the night's dominant
defect pattern and of why the mutation rule earns its cost.

The session that started the `ui_refs` write was killed before it committed, so
a second agent inherited 224 uncommitted lines. Auditing rather than shipping
them, it found two things:

- **A silent data-loss defect.** The sync rebuilt the module node from
  `Node::new(envelope)` — an empty field map — so caching a screen reference
  would have deleted every module-node key `ModuleFields` does not model.
  `Node::fields` is an open map precisely so PRD §11.2's unregistered kinds
  survive a round trip, and `Store::write_node` is a plain atomic overwrite, so
  nothing downstream would have caught it.
- **A test that could not fail** — the tenth of the night. Deleting the
  production call left the supersede test green, because it asserted only that
  `ui_refs` ended up empty, which is trivially true when the sync never runs.

It also found that a clean `git merge` proved nothing here: the merge silently
combined two `sample_screen` test helpers into a duplicate definition that did
not compile. It only surfaced on the next build.

### What #96 changed after review, because it matters (now merged)

Wave 9d's Module dashboard drew three rows of contract history that were
**fabricated** — hardcoded values gated on the module slug `"token-verifier"`,
reachable with real data through `RunsPanel.tsx` → `schematify/module-dashboard`.
Any project whose module happened to carry that slug would have drawn invented
history as if it were its own.

It is now removed rather than gated more tightly: `contractHistory()` takes no
parameter and returns empty for every module, and the dashboard draws an honest
empty state, until a schema actually backs the table. The cost is that §16.1's
three contract-history rows are the one cell of the reference fixture this build
does not cover, and the handoff says so plainly instead of claiming coverage.

### Scope not built

The review queue, `Assign`, and `Pre-fill with agent`; S-25, the node-kind
registration form; §12.15 registries-as-document and §12.16's search UI beyond
what wave 8a's index already covers. These were left rather than started late —
a large UI surface landing unreviewed as you woke was the worse trade.

Wave 11 added the §20 decision rows — 11 of them, in
`core/decisions/technical/schematify/`, which is outside the repo and so shows
up in no diff. Two rows record divergences rather than papering over them:
SCH-ARC-004 (the PRD's proposed `generate_handler!` line was never needed, since
every app already routes through the shared `app_call` dispatch) and SCH-ARC-006
(the `ui_refs` rule shipped its read side only).

Its CODEOWNERS half turned out to be already built, which is how the two gaps
below were found.

### One gap found by reading main, now being built

Checking the decision rows against the code turned up two suspected gaps. The
first, `schematify_ingest_run` not being wired, turned out to have landed in #96
an hour earlier — the check had been made against a pre-#96 `main`. It is fully
wired, dispatched and tested. The second is real:

- **`ui_refs` is never written on edge change.** §20 makes `references_ui`
  authoritative and `ui_refs` derived, and the lint check and loader
  dangling-check both exist — but `schematify/write-edge` never updates
  `ui_refs`, so the derived field drifts silently.
