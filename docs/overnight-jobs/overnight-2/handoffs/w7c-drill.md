# Wave 7c handoff — drawing the scope a drill-through asks for

Branch `schematify/w7c-drill`, off `main`. Follow-on to wave 7b: fixes the
gap that handoff flagged rather than fixed — `graph/backend.ts`'s
`loadRealGraph` ignored `tier` and `slug` entirely, so a Problems row's
click-through onto a Module-location finding opened an empty canvas. Went
through 2 review rounds; both are recorded below rather than only the final
state, since the 2nd round's findings are exactly the kind of thing a future
reader should know were caught and how.

## 1. The defect, and why it was silent

`createBackendSeam().loadGraph` was assigned `loadRealGraph`, a **0-argument**
function, against `SchematifySeamLike.loadGraph(): Promise<ServiceGraph>` — a
0-argument interface. `engine/index.ts`'s `openSchematic` has called
`seam.loadGraph(config.tier, config.layoutSlug)` since wave 5, but JavaScript
never enforces arity: the extra 2 arguments were silently dropped at every
call site, and `loadRealGraph` always answered the same `auth-service`
Service Schematic no matter which tier or slug asked. Nothing in the type
system caught it because `SchematifySeamLike`'s own restatement of the real
`SchematifySeam` interface (`./index.ts`) had drifted to `(): …` right along
with the implementation — the interface never disagreed with the bug.

Round 2 found the identical shape 1 layer up — see §3.

## 2. What was built

- **`graph/backend.ts`** — `loadRealGraph(tier?, slug?)` now routes by tier:
  `service` → `projectServiceGraph` (already generic across any slug, just
  never called with the real one); `module` → the new
  `projectModuleGraph`; `stack` → an honest empty graph (see §6).
  `SchematifySeamLike.loadGraph` widened to match the real interface it was
  supposed to restate.
- **`graph/project.ts`** — `projectModuleGraph(raw, moduleSlug)`, the tier-3
  counterpart of `projectServiceGraph`. Draws the module root as its own
  node (`parentId: null`) plus every facet under it (`contract-method`,
  `test-case`, `budget`, `doc-block`, `external-dep`), each with its
  kind-specific fields read off the flat wire node
  (`schematify_core::Node`'s `#[serde(flatten)]` envelope-plus-fields
  shape): a contract method's `signature`/`returns`/`exported`; a budget's
  `tier`/threshold text/probe command (`budgetValueText` stays `undefined`
  — `BudgetFields` has no "last measured value" field at all, so this
  doesn't invent one); a test case's status, narrowed to
  `passing`/`failing`; a doc block's audience and body; an external dep's
  version and license, resolved against the `libraries` registry
  `schematify/load-graph` already returns (a new `RawGraph.libraries`
  field, and a new `RawLibraryEntry` type). Real `covers`/`satisfies`/
  `documents` edges between included facets are kept, matching tier 3's
  closed edge vocabulary (PRD §11.1) — a contract method's own covers
  *count* is deliberately not a field on the node; see §3.
  `isDescendantOfService` renamed to the tier-generic `isDescendantOf`,
  `badge`/`staleReason` factored into a shared `staleFields` helper — both
  walks were already tier-agnostic, only their names weren't.
- **`graph/backend.test.ts`**, new — the direct proof of the fix: mocks
  `@veistra/bridge`'s `invoke` and asserts both `createBackendSeam()
  .loadGraph(tier, slug)` and, since round 2, `defaultSeam.loadGraph`
  actually draw the requested scope (see §3).
- **`graph/project.test.ts`** — 18 new cases under `projectModuleGraph`,
  shaped after PRD §16.1's own `token-verifier` paragraph (a
  `cold_start_p95` budget with no probe — the exact node an L03 Problems
  row has to land on).

## 3. Round 2: what the reviewer found, and the fixes

**The fix was unreachable from the real app.** `backend.ts`'s
`loadRealGraph` was correct — and dead. `graph/index.ts`'s `defaultSeam`,
the seam `App.tsx`'s real click-through actually calls (1 layer above
`createBackendSeam`), still had:

```ts
loadGraph: () => getBackendSeam().then((seam) => seam.loadGraph()),
```

The identical bug, 1 layer up: a 0-argument arrow dropping `tier`/`slug`
before they ever reached the now-fixed function underneath it. The reviewer
reproduced it directly: `defaultSeam.loadGraph("module", "token-verifier")`
returned `tier: "service", slug: "auth-service"`. **No interface signature
would have caught either instance** — TypeScript permits a function with
fewer declared parameters to satisfy a type requiring more, unconditionally,
so the backstop has to be a test through the real path, not a type. Fixed:
`defaultSeam.loadGraph` now forwards both arguments. `backend.test.ts`
gained a 2nd `describe` block exercising `defaultSeam.loadGraph` itself
(imported from `./index`, still against the same `@veistra/bridge` mock),
proving the real path, not just `createBackendSeam` 1 layer below it where
the bug no longer lived. Made to fail on purpose the same way as round 1 —
see §5.

**Round 3 pushed on that test's own strength.** `backend.test.ts`'s
`defaultSeam` cases assert on the *returned graph's* `tier`/`serviceSlug` —
correct proof, but indirect: it passes because the whole pipeline
(`defaultSeam` → `createBackendSeam` → `projectModuleGraph`) happens to
agree, not because any one assertion pins what `defaultSeam.loadGraph`
itself does with its arguments. Asked for a direct one: assert the backend
*received* the exact values, not that it was called or that something
plausible came back. New file, `graph/index.defaultSeam.test.ts`, mocks
`./backend` itself (not `@veistra/bridge` — the mocked `createBackendSeam`
never reaches the real bridge, so nothing there needs faking) with a
`vi.fn()` standing in for the whole backend seam's `loadGraph`, calls
`defaultSeam.loadGraph("module", "token-verifier")`, and asserts
`loadGraphSpy` was called exactly once, with exactly `("module",
"token-verifier")` — a claim that can only be true if `index.ts`'s own
wrapper forwarded both arguments unchanged, independent of anything
`backend.ts` or `project.ts` do with them afterward. Made to fail on
purpose — see §5.

**The branch didn't compile against current `main`.** Wave 6 (PR #92)
merged while this branch was open, and deleted `GraphNode.coversCount` as
the PRD §0.4 breach it was — a stored count that could drift from the real
edges. `project.ts`'s `facetFields` had reintroduced exactly that field,
independently, with its own 3rd computation of the same number
(`inboundCovers`, a hand-rolled map wave 6's own consolidation had just
finished eliminating). Fixed: `coversCount` dropped from `facetFields`
entirely, `inboundCovers` deleted, and the corresponding test rewritten to
assert `coversCountFor(id, graph.edges)` (`engine/anatomy.ts`, wave 6's own
sanctioned function) against the real `covers` edges `projectModuleGraph`
already returns — the one place this number is computed now, at draw time,
by every caller (`engine/frame.ts`, `engine/inspector.ts` both already call
it this way).

**Why local verify had looked green.** PR checks had run against the base
commit at open time; `main` advanced past it (wave 6 merged) without a
re-run, so a green check proved nothing once the base moved. Separately,
the round-1 "made to fail on purpose" pass only ran vitest, which doesn't
typecheck — 711 tests can pass on code that doesn't build. Fixed process,
not just code: merged `origin/main` into this branch first (a clean
auto-merge — no conflicts landed in any file this branch touches, confirmed
`git show --stat` and grepped for `<<<<<<<` afterward), then reran
`npx tsc -p tsconfig.json --noEmit` as its own explicit step, separate from
`pnpm verify`'s bundled one, before doing anything else.

## 4. A second, unrelated fix folded in: the Dock badges' loading state

Caught in post-merge review of wave 7b, not by this branch's own tests.
`shell/Dock.tsx` computed `problemBadges(findings ?? [])` and rendered
`{badges.errors}`/`{badges.warnings}` unconditionally. `findings` is `null`
from mount until `schematify/lint` resolves, and stays `null` forever on a
failed call (`error` is set instead) — either way `findings ?? []` collapsed
to `[]`, so the tab drew `Problems 0 0`: a placeholder claiming the project
is clean when it is really "not loaded yet" or "failed to load".
`StatusBar.tsx`'s cell 3 already handled this correctly
(`{findings ? statusCell3(findings) : ""}`) — the Dock badges just never got
the same treatment when wave 7b built both in the same PR.

Fixed to match: `badges` is now `findings === null ? null : problemBadges(findings)`,
and each badge span renders `{badges?.errors ?? ""}` / `{badges?.warnings ?? ""}`
— blank while loading or on failure, the 2 real numbers once `findings`
resolves.

**Read-verified only.** This app's vitest suite runs `environment: "node"`
with no rendering library (a repo-wide, pre-existing limit, not one this fix
introduces), so nothing here exercises `Dock.tsx`'s JSX directly. The change
was checked by reading the render tree, the same standard the file's own
"badges stay visible on the collapsed strip" claim already rested on.

## 5. Made to fail on purpose

**`backend.test.ts`'s `createBackendSeam` cases, round 1.** Reverted
`loadRealGraph` to its pre-fix, 0-argument body, reran the suite: 3 of 4
failed — "draws the requested service" (`no service named "auth-service"`
— the mock graph in that test has no `auth-service` at all, correctly),
"draws the requested module" (`tier` came back `"service"`, not
`"module"`), and "draws an honest empty graph for the stack tier" (crashed
reading `.graph` off an unmocked response, since the old code called
`invoke` unconditionally). Reverted back to the fix, reran clean.

**`backend.test.ts`'s `defaultSeam` cases, round 2.** Same technique, 1
layer up: reverted `defaultSeam.loadGraph` to `() => getBackendSeam()
.then((seam) => seam.loadGraph())`, reran — both new cases failed
("draws the requested module through the full seam" got back
`tier: "service"`; "draws the requested service through the full seam" hit
the same `no service named "auth-service"` error the round-1 case did, one
layer further out). Reverted back to the fix, reran clean.

**`index.defaultSeam.test.ts`, round 3 — the direct assertion.** Same
revert, same `defaultSeam.loadGraph` 0-argument body, reran just this file:
```
AssertionError: expected "vi.fn()" to be called with arguments: [ 'module', 'token-verifier' ]
Received:
  1st vi.fn() call:
- [ "module", "token-verifier" ]
+ []
```
The spy's own call record shows the arguments never arrived — the exact
shape of the defect, independent of any projection logic. Reverted back to
the fix, reran clean.

**`project.test.ts`, the contract-method covers case, round 1 → replaced in
round 2.** Round 1 hardcoded `coversCount` to `0` and watched an assertion
on that field fail. Round 2 deleted the field along with the assertion
(§3) — the replacement test asserts `coversCountFor("verify", graph.edges)`
instead; breaking it now means breaking `projectModuleGraph`'s edge
filtering itself (temporarily excluding the `covers` edges from
`MODULE_EDGE_KINDS`), which was run and reverted the same way, confirming
the new assertion still catches a real regression in the thing it now
actually tests.

## 6. The stack tier, deliberately left out

The task named "opening a Service or Module Schematic" — not Stack. No rule
in `crates/schematify-core/src/lint.rs` produces a `Location::Stack` finding
on the reference fixture (none of the 5 rows does), so no Problems-panel
click-through exercises it either. Building a real `projectStackGraph`
(services, the `platform-core` group, the derived tech stack) is comparable
in size to `projectModuleGraph` and wasn't asked for — `loadRealGraph`
answers the stack tier with the same honest empty graph
(`{tier, serviceSlug: slug, serviceTitle: slug, nodes: [], edges: []}`)
`graph/index.ts`'s stand-in loader already returns for a slug it has no
fixture for, rather than silently drawing the wrong service (the exact
defect this branch fixes) or crashing. Flagged here rather than worked
around quietly, the same way the wave 7b handoff flagged the original gap.
The round 2 review checked this ruling against `location_of` in `lint.rs`
directly and confirmed it: `Location::Stack` is a distinct variant, and the
5 reference rows' `Stack › Auth Service` cells are all `Location::Service`.

## 7. Acceptance

| Condition | Result |
|---|---|
| `loadRealGraph` honours tier and slug for Service and Module Schematics, through the real `defaultSeam` path | **Pass.** `backend.test.ts`'s 6 cases (4 `createBackendSeam`, 2 `defaultSeam`) plus `index.defaultSeam.test.ts`'s 1 direct-assertion case (asserts the exact arguments the backend seam's `loadGraph` was called with, not just the returned shape); §5 records the deliberate-break proof against the real pre-fix code at all 3. |
| The Problems-panel click-through lands on the right node | **Pass, for what a real project can serve.** `resolveClickThrough` (wave 7b, untouched) already computed the correct `NavigationTarget`/`select` id — the missing piece was 2 layers of the target Schematic drawing nothing once opened, both now fixed. Not re-verified against a live browser — see §8. |
| The merged tree typechecks | **Pass**, `npx tsc -p tsconfig.json --noEmit` run explicitly against the tree after merging `origin/main`, as its own step — see §3. |

## 8. What a human must check by eye

No browser was available (`00-AGENT-CONTEXT.md`'s standing limit). Once a
real `.veistra/` project is open in Veistra:

1. Drill from the Stack Schematic (or the breadcrumb) into a service other
   than `auth-service` — confirm its own modules draw, not `auth-service`'s.
2. From the Service Schematic, click a module box — confirm the Module
   Schematic that opens draws that module's own facets (contract methods,
   test cases, budgets, doc blocks, external deps), not an empty canvas.
3. Click a Problems row whose location is `› <some module>` — confirm the
   app navigates to that module's real Module Schematic and the offending
   facet ends up selected (`kv-node--selected`, per the export-strip
   precedent wave 5 already verified this same selection mechanism against).
4. An external-dep card — confirm its version/license line reads the real
   registry values, not blank, when the project's library registry holds
   the dependency.
5. A budget card with no probe (PRD §16.1's `cold_start_p95` is the
   canonical one) — confirm its "last value" line draws `—`, not a stale
   placeholder.
6. A contract-method card's covers line — confirm it reads the live
   `coversCountFor` number, not a blank or stale one, now that the count is
   computed at draw time rather than stored.

## 9. Verification

| Step | Result |
|---|---|
| `git merge origin/main` | 2 merges as `main` advanced during review (2c67cf6 → 8a21c79 → 16da505); 1 conflict, in `shell/Dock.tsx` against wave 9d's own independent fix for the same Dock-badges defect (§4) — resolved by keeping wave 9d's already-merged version, functionally identical to this branch's |
| `npx tsc -p tsconfig.json --noEmit` (explicit, separate from `pnpm verify`) | Pass, on the fully merged tree |
| `npx vitest run apps/schematify` | Pass — 361 tests |
| `npx eslint apps/schematify/ui/src` | Pass, 0 errors |
| `npx prettier --check apps/schematify/ui/src` | Pass |
| `node scripts/check-comments.mjs` | Pass, 0 above limit, 0 grandfathered |
| `pnpm verify` (full, on the merged and fixed tree) | Pass — see the PR for this run's own output |

No Rust file was edited by this branch's own commits — every defect and fix
is in `apps/schematify/ui/src/graph/`. Rust files changed only via the 2
merges above, carrying in `main`'s own work (including the atomic-rename
flake fix, PR #97) unmodified.

`pnpm baseline` was never run. No test was deleted or skipped — the 1 test
that changed shape (§5's covers-count case) was replaced with a stronger
assertion of the same underlying claim, not removed.

## 10. Left undone

- A real Stack Schematic projector (§6) — separately scoped, not this
  branch's.
- No live-browser verification (§8).
- `budgetValueText` stays permanently `undefined` for every real budget —
  not a gap this branch introduced; `schematify_core::node::BudgetFields`
  has no field to read one from at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016X8PJJ3xTD4BTuNBLSJyTQ
