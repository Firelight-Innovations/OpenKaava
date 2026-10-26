# Wave 2 handoff — shell, tokens, status bar

Branch `schematify/w2-shell`. PR #81, retargeted from `schematify/w1a-retire`
to `main` once Wave 1a merged; `main` has since been merged into this branch.

## CI verify failure — local `pnpm verify` is not proof for `apps/schematify/`

CI failed 5 TypeScript errors in `noLiteralHex.test.ts` that never appeared
locally: `node:fs`, `node:path`, and `__dirname` unresolved, plus 2 downstream
implicit-`any` parameters. Cause: `C:/Users/bjsea/node_modules/@types/node`
— a stray package in the user's home directory, several levels above this
checkout — is on the ambient-types search path every local `tsc` run walks,
and this repo's own `tsconfig.json` (`apps/schematify/ui/` included) declares
no Node types at all, correctly, since every first-party app is browser-only.
CI's checkout has no such stray directory, so it saw the truth.

**No existing file under any other first-party app's `ui/src/` used
`node:fs`, `node:path`, or `__dirname`** — searched before picking a fix, per
instruction; there was no precedent to copy. Fixed by removing the Node
dependency entirely rather than adding `@types/node` anywhere: the file now
reads every candidate through `import.meta.glob("./**/*.{ts,tsx,css}", {
query: "?raw", import: "default", eager: true })`, a Vite feature that
inlines each matched file's raw text at transform time. No Node builtin is
imported, and the typing comes free from `vite/client`
(`src/vite-env.d.ts`, already part of the program) — nothing about
`tsconfig.json` changed, so no other app's checking loosened. The 2
implicit-`any` parameters (a downstream consequence of `readFileSync`
resolving to `any` once `node:fs` failed to resolve) are now explicitly
typed (`line: string, index: number`) regardless.

**Verified the way CI does, not the way local `pnpm verify` does**: local
`tsc` still has the stray home-directory types available and would pass
either version of this file, proof or not. To reproduce CI's clean state
without touching anything outside the repo, ran
`npx tsc -p tsconfig.json --noEmit --typeRoots ./__no_types__` (a
nonexistent directory, which makes TypeScript skip its default ambient-types
walk entirely). Confirmed the technique first: checked out this file's
pre-fix version from commit `646c77e` and reran the same command — it
reproduced the exact 5 errors CI reported, byte for byte. Then confirmed the
fixed version passes it clean (exit 0), alongside the full `pnpm build`,
`pnpm test:js` (387 + 28 passing), `pnpm lint:js`, `pnpm lint:comments`,
`pnpm lint:version`/`lint:identity`/`lint:branding`, and `pnpm format:check`.

## Review round 2 — an Opus review of PR #81 came back APPROVE-WITH-FIXES

Three findings blocked the merge; all 3 are fixed:

1. **The Outline drew titles where the wireframe draws slugs.** Fixed:
   `Outline.tsx` now renders `graph.serviceSlug` for the root row and
   `node.slug` for every tree row, matching WIREFRAME-EXTRACT.md §1.1's
   Outline listings (`auth-service`, `http-entry`, `token-verifier`, …).
2. **The lifecycle dots were invented and belong to Wave 4.** Fixed: removed
   the dot `<span>` from `Outline.tsx` and its 5 `.kv-outline__dot*` rules
   from `shell.css`. No wireframe Outline row carries a lifecycle dot; the
   wireframe extraction's own ruling assigns dot rendering to Wave 4, and
   `graph/types.ts`'s comment on `Lifecycle` already said as much.
3. **`loadGraph()` had no rejection path.** Fixed: `App.tsx` now catches a
   rejected `loadGraph()`, stores the message in an `error` state, renders
   it (`.kv-shell__error`), and calls `reportPainted()` either way — the same
   shape as `apps/home/ui/src/App.tsx` line 246 and `apps/files/ui/src/App.tsx`
   line 78. Harmless today (`loadGraph()` always resolves a local fixture) but
   would have hung the splash screen the moment the seam becomes a real
   `invoke` call, which is exactly the change the wiring wave makes.

Four more, all addressed:

- **Widened the hex regression test.** `noLiteralHex.test.ts` now also
  catches `rgb()`/`rgba()`/`hsl()`/`hsla()`/`color-mix()` and CSS named
  colors (in value position only, to avoid flagging this file's own prose —
  see the test's header comment), plus a positive-control suite proving the
  new patterns actually catch each form and don't flag `transparent` or
  `white-space`. Still exactly 1 file exempt (`tokens.css`).
- **`computeDepth()` now has a cycle guard.** `graph/index.ts`: an in-progress
  visiting set throws `containment cycle at node <id>` instead of recursing
  forever; a dangling `parentId` (no such node) is still treated as
  top-level, which is a separate, intentional choice documented at the
  function. Both paths are unit-tested in `graph/index.test.ts`.
- **`EmptyStack.tsx`'s lead string is recorded as an invention** — see
  assumption 9 below, alongside the 9 invented edges.
- **`tokens.css`'s provenance header was wrong.** It claimed every value but
  2 was `[W]`; in fact PRD §13 itself already marks `--kv-info`,
  `--kv-font-sans`, and `--kv-radius-frame` `[P]` (proposals, never claimed
  as read from a wireframe) — 3 more than the header said. Fixed: the header
  now names all 5 `[P]` tokens and why, and each is marked at its own line.

**`rpc.ts` is resolved: replaced by `graph/backend.ts`, under the `graph/`
seam rather than a sibling of it.** `fetchState`/`reasonForFailure` (wrapping
the one Tauri command this app has, `schematify/state`) moved there, unused
by any component yet. This is **not** the same file as `graph/index.ts`: an
initial attempt folded them into `index.ts` directly and broke
`index.test.ts` (`ReferenceError: window is not defined` — `@veistra/bridge`'s
root export touches `window` at module load, and `index.ts` is imported by a
plain-Node vitest suite that has none). Splitting them keeps `index.ts` pure
and testable while `backend.ts` stays the one file in this app that calls
`invoke`. There is exactly 1 path from this app to Rust:
`apps/schematify/ui/src/graph/backend.ts`. `index.ts`'s `loadGraph()` names it
as the file its real `invoke` call will go through once wired; a future file
making its own separate `invoke` call would be a second door.

**One ruling, on the sans-vs-mono question the reviewer left open.**
`shell.css` set a sans face across the whole shell; WIREFRAME-EXTRACT.md
§13.4 records mono throughout the wireframe and sans nowhere inside a
screen. The team lead ruled: the wireframe wins on this visual question, so
`.kv-shell`'s base `font-family` is now `--kv-font-mono`, reaching the tabs,
buttons, labels, the Outline, the breadcrumb, and the status bar by
inheritance (3 `<button>` elements needed an explicit override added
alongside it — `.kv-outline__switcher-tab`, `.kv-toolbar__button`,
`.kv-empty-stack__action` — since form controls don't inherit `font-family`
from an ancestor by default). Sans stays reserved for PRD §13.4's own
carve-out — titles, descriptions, and prose Wave 4 draws from the graph —
which this wave draws none of. **This is PRD open item 13; the owner may
overrule it, and doing so is the 1-line token swap back to
`var(--kv-font-sans)` in `shell.css`'s `.kv-shell` rule.**

## What was built

All under `apps/schematify/ui/src/`:

- **`tokens.css`** — every PRD §13 token (13.1 through 13.5) as a CSS custom
  property, scoped to this document's `:root` (this app is its own iframe
  document, so it collides with nothing in `/src/tokens.css`). 2 values —
  `--kv-bg-root` and `--kv-accent-hover` — are derived rather than `[W]`, per
  `WIREFRAME-EXTRACT.md`'s Resolutions 7.3a/7.3b: neither hex value occurs
  inside any of the 6 product screens, only in the wireframe tool's own page
  chrome. `--kv-bg-root` is `--kv-bg-app` extended one step darker along the
  existing 3-step surface ladder (`#0d0e10`); `--kv-accent-hover` is
  `--kv-accent` blended 18% toward white (`#e2a35f`). Both are documented at
  the point of definition.
- **`graph/`** — the graph module. `types.ts` is the vocabulary
  (`GraphNode`, `GraphEdge`, `ServiceGraph`), `fixture.ts` is the hand-typed
  `auth-service` Service Schematic reproducing PRD §16.1's 12-node,
  9-edge, depth-3 fixture, and **`index.ts` is the module a later wiring
  wave replaces** — its `loadGraph()` function is the only place that reads
  `fixture.ts`; every caller reads the graph through `index.ts`'s exports
  (`loadGraph`, `countNodes`, `countEdges`, `statusCell1`, `statusCell2`,
  `computeDepth`, `outlineFooter`, `buildOutlineRows`) and never imports
  `fixture.ts` directly. Swapping `loadGraph`'s body for a real
  `invoke("schematify/load-graph", …)` call once `crates/schematify-core`
  merges is the entire wiring change; nothing else in `apps/schematify/ui/`
  needs to move. All counts are computed from the graph at call time (PRD
  §0.4) — none is stored. `graph/backend.ts` now carries `fetchState` and
  `reasonForFailure`, replacing the deleted `rpc.ts` (see the review round 2
  section below) — this app's one existing Tauri call and its error
  formatter, unused by any component yet.
- **`shell/`** — `Breadcrumb`, `Toolbar`, `Outline` (with its 3-entry
  `Design`/`Product`/`Decisions` section switcher), `SchematicHost` (an
  empty frame — Wave 3 builds the engine inside it), `InspectorShell` (the
  5-tab frame, no tab content — Wave 6), `Dock` (the 4-tab frame, no tab
  content — Waves 7 through 9), `StatusBar`, and `EmptyStack` (the Stack
  Schematic first-run state, PRD §12.20).

  **No title bar and no application tab strip.** An earlier version of this
  wave built both inside Schematify's own iframe, following PRD §17 Wave 2's
  literal bullet list. The team lead ruled that out after checking the real
  shell directly: it already draws a title bar
  (`src/shell/titlebar/TitleBar.tsx`), the application tab strip
  (`src/shell/switcher/ClusterBar.tsx`), and its own status bar
  (`src/shell/statusbar/StatusBar.tsx`), and Schematify runs inside a frame
  that already sits under all three. The PRD's author did not know this
  repository, and the standing rule for this whole build is that existing
  convention wins — a second title bar and a second tab strip drawn inside
  an application frame is not a feature anyone wants, so both were deleted
  rather than hidden behind a flag. **Wave 3 and Wave 5 should not rebuild
  either.** Schematify's own `StatusBar` stays: unlike the title bar and tab
  strip, it is not the shell's status bar wearing a different hat — its
  cells carry Schematify's own content (the `.veistra/` node/edge counts, the
  layout file's clean state), the acceptance conditions name the exact
  strings, and every count is computed from the graph. It is an
  application-local strip at the bottom of Schematify's own frame, the same
  way the Problems dock and the Outline are application-local.
- **`App.tsx`** — composes the shell around `loadGraph()`'s result. A
  `?view=empty-stack` query param swaps the whole body for `EmptyStack`
  instead, since this wave builds no tier switch to reach it otherwise (see
  "What a human should look at").

`apps/schematify/ui/src/schematify.css` (the Wave 1a placeholder empty-state
stylesheet) was deleted — its one class is unused now that the shell draws
real chrome; `main.tsx` no longer imports it.

## The module the wiring wave replaces

**`apps/schematify/ui/src/graph/index.ts`**, specifically its `loadGraph()`
function. Everything else in `graph/` and `shell/` is written against that
function's return type (`ServiceGraph`) and is unaffected by the swap.

## Acceptance conditions (PRD §17 Wave 2)

| Condition | Result |
|---|---|
| No literal hex value in the Schematify UI | **Pass.** `src/noLiteralHex.test.ts` scans every `.ts`/`.tsx`/`.css` file under `apps/schematify/ui/src/` except `tokens.css` (the one documented exception) for a literal color — hex, `rgb()`/`rgba()`/`hsl()`/`hsla()`/`color-mix()`, and CSS named colors in value position; 0 offenders, enforced as a regression test with a positive-control suite proving the patterns actually catch each form. |
| The shell opens the fixture and draws the Outline tree with its header, badges, triangles, and footer | **Pass.** `App.tsx` calls `loadGraph()` and renders `Outline`, which draws `OUTLINE — CONTAINMENT`, each row's slug (not its title — fixed in review round 2), the `ENTRY` badge on `http-entry`, the `STALE` badge on `audit-emitter`, `▾`/`▸` triangles, and the footer. `graph/index.test.ts` asserts the row shape (10 rows drawn, `session-store`'s 2 children hidden with a trailing count of 2, `token-verifier`'s 2 children drawn in full) since no DOM renderer is wired into this repo's Vitest config (`environment: "node"`, no jsdom — see `vitest.config.ts`'s own header). A human needs to look at the actual pixels; see below. |
| Status bar cell 1 reads exactly `.veistra/ · 12 nodes · 9 edges` | **Pass**, asserted in `graph/index.test.ts`. |
| Status bar cell 2 reads exactly `layout/auth-service.json clean` | **Pass**, asserted in `graph/index.test.ts`. |
| `pnpm verify` passes | **Pass.** `pnpm build`, `pnpm test:js`, `pnpm lint:js`, `pnpm lint:comments`, `pnpm lint:version`, `pnpm lint:identity`, `pnpm lint:branding`, and `pnpm format:check` all ran clean in the foreground. `pnpm test:rust` and `pnpm lint:rust` ran in the background (no Rust file touched this wave) — see the PR for their result if this line was written before they finished. |

## Assumptions, all recorded because a source was silent or in tension

1. **The 9 `auth-service` dependency edges' exact topology.** PRD §16.1 states
   the count (9) and names 1 edge (`session-codec → token-issuer`, part of
   the cycle finding) but never enumerates all 9. **All 9 were invented by
   this agent, not read from any specification** — the wiring wave must
   treat every one as a placeholder, not as fixture-specified data. The full
   list, all `depends_on`, all in `graph/fixture.ts`:
   `http-entry → token-issuer`, `http-entry → token-verifier`,
   `token-issuer → crypto-primitives`, `token-verifier → crypto-primitives`,
   `password-hasher → crypto-primitives`, `rate-limiter → token-verifier`,
   `audit-emitter → crypto-primitives`, `session-codec → token-issuer` (the
   1 edge PRD §16.1 names directly), and `token-issuer → session-store`.
   No acceptance condition this wave checks the topology, only
   `countEdges() === 9`. A real loader (Wave 1b → wiring wave) replaces this
   with whatever `fixtures/saas-backend/` actually encodes.
2. **Containment depth counts the service root as level 1.** PRD §16.1 says
   "containment depth 3" for a service whose deepest nodes sit exactly 1
   level under a top-level module. `computeDepth()` in `graph/index.ts`
   documents this convention at the point of definition.
3. **`--kv-bg-root` and `--kv-accent-hover` are derived, not `[W]`.** Per
   `WIREFRAME-EXTRACT.md` Resolutions 7.3a/7.3b — taken as binding per that
   document's own status, not re-argued here.
4. **Resolved: no title bar, no application tab strip, drawn by Schematify
   itself.** See the "No title bar and no application tab strip" note above
   — the team lead ruled this after checking the real shell directly. The
   breadcrumb and toolbar stay, drawn by Schematify, because neither
   duplicates a piece of real shell chrome.
5. **Status bar cell 2's "clean" is unconditional.** No layout file writer
   exists yet (Wave 3 builds `schematify_write_layout`), so there is no dirty
   state to report; `statusCell2()` takes a `clean` parameter (default
   `true`) so Wave 3 only needs to pass a real value through, not rewrite the
   function.
6. **`Product` and `Decisions` outline-switcher entries draw a named
   placeholder** ("Product — not built yet.") rather than nothing, so the
   switcher is honestly wired (PRD §12.1 marks the switcher itself `[P]` and
   Wave 2's ruling in `WIREFRAME-EXTRACT.md` §10.3 says build it).
7. **Dock and Inspector draw their tab labels but no tab content.** PRD §17
   Wave 2 says "the Inspector shell" and "the bottom dock frame" — read as
   frame-only, since every tab's content (S-04 through S-14) is named as a
   later wave's scope in section 12.2's wireframe-coverage note and in
   Waves 6 through 9's own bullet lists.
8. **The Stack Schematic empty state (`EmptyStack`) is reachable by
   `?view=empty-stack`, not the default view.** The default view is the
   populated `auth-service` Service Schematic, since every acceptance
   condition this wave names (Outline tree, status bar cells) is about that
   view. Building the tier switch that would show `EmptyStack` on an actually
   empty project is Wave 5 scope ("click-to-drill and breadcrumb walk-up").
9. **`EmptyStack.tsx`'s lead string, `"A new project. Nothing is drawn yet."`,
   is invented, not read from any source.** PRD §12.20 states only "A new
   project opens on an empty Stack Schematic with 1 action: create the first
   service" — it names the 1 action (`EMPTY_STACK_ACTION`, `"Create the first
   service"`, itself lifted verbatim from that sentence) but supplies no lead
   copy. No wireframe screen draws this state either (WIREFRAME-EXTRACT.md
   covers 6 screens, none of them the Stack Schematic's true empty state — the
   closest, §4.7, is the Module Schematic's first-run state, a different
   surface). A later wave should treat `EMPTY_STACK_LEAD` as a placeholder a
   human or a wireframe should replace, not as specified copy.

## What a human should look at in the morning

No browser was available this wave (`00-AGENT-CONTEXT.md` forbids
`pnpm dev:agent`/`pnpm ui launch` for this job; `pnpm build` was the only
render-adjacent check run). Once safe to do so:

1. Open Schematify (`pnpm app`, the `Schematify` tab) and confirm the shell
   renders as described inside the real shell's own frame: breadcrumb/toolbar
   row, Outline (with the section switcher, tree, badges, triangles, footer),
   an empty dotted Schematic frame, an inert Inspector frame, an inert dock
   frame, and a status bar with cells 1 and 2 filled and cells 3 and 4 blank
   — with no second title bar or tab strip drawn inside it.
2. Load `?view=empty-stack` in the same window and confirm the Stack
   Schematic first-run empty state draws (assumption 8 above).
3. Sanity-check the Outline tree's visual density and the disabled-control
   styling (search field, `Auto-sort`, `Fit`, tab labels) against the
   wireframe screenshots in `Forger Wireframes.html` / `WIREFRAME-EXTRACT.md`
   §1 — this wave verified strings and counts by unit test, never by eye.
4. Confirm the whole shell now reads in IBM Plex Mono, not IBM Plex Sans —
   the mono ruling above — and decide whether that stands (PRD open item 13).
5. The Outline tree now draws each row's slug, with no lifecycle dot beside
   it — confirm that reads correctly against WIREFRAME-EXTRACT.md §1.1's
   Outline listing.

## Left undone, on purpose

- Schematic engine content (Wave 3), lifecycle/health rendering (Wave 4),
  the other 2 Schematics (Wave 5), Inspector tab content (Wave 6), Problems
  panel and status-bar cell 3 (Wave 7), registries/rules/search (Wave 8),
  runs/dashboard/status-bar cell 4 (Wave 9) — all out of this wave's scope
  per PRD §17 and the task brief.
