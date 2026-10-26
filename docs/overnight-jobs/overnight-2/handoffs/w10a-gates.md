# Wave 10a: boundary enforcement in CI — handoff

Scope: PRD §14.6 (`docs/design/SCHEMATIFY-PRD.md`), also read §6.1 and §6.3. Built
in worktree `sch-w10a-gates`, branch `schematify/w10a-gates`, off `main` at
`3a30391`. Nothing here touches Rust source, so `pnpm test:rust` / `pnpm
lint:rust` were not run — only the Node/CI surface changed.

## 1. Path-scope check: `runs/` and `nodes/` never move together

**Files:** `scripts/check-veistra-boundary.mjs`, `scripts/check-veistra-boundary.test.mjs`,
`.github/workflows/veistra-boundary.yml`.

**What it blocks:** a pull request where, for the same `.veistra/` root, both a
`nodes/<uuid>.json` and a `runs/<uuid>/...` file are touched, *unless* the
touch is exactly the lifecycle pair from §6.3: one `nodes/<uuid>.json` and
that same uuid's `runs/<uuid>/audit.json`, nothing else in either tree.

**What it deliberately allows:** any number of files moving in `nodes/` alone,
or `runs/` alone, in one pull request; multiple `.veistra/` roots each judged
independently (regenerating one fixture's `runs/` and another fixture's
`nodes/` in one PR is two single-tree writes, not a mixed one); every other
semantic tree (`edges/`, `rules/`, `screens/`, `flows/`, `decisions/`,
`registry/`, `brief.json`) is untouched by this check — CODEOWNERS covers
those, see §3 below.

**Why unanchored `.veistra/` matching.** The repository holds three `.veistra/`
trees today, all under `crates/schematify-core/fixtures/`, not one at the
repository root — see the script's own header for the regex reasoning. The
check groups by whatever text precedes `.veistra/` in a changed path, so it
covers all three today and any future one (including a project opened at the
repository root) without editing the script.

**Tests:** 13 vitest cases in `check-veistra-boundary.test.mjs` — clean on
nodes-only, clean on runs-only, clean on exactly the lifecycle pair, blocked on
a different uuid, an extra file in either tree, or a runs/ file that isn't
`audit.json`, and two roots judged independently in both directions. All 13
pass (`npx vitest run scripts/check-veistra-boundary.test.mjs`).

**Proved against real branches:**
- `origin/main` vs itself: 0 files changed, clean, exit 0.
- `origin/main` vs `origin/schematify/w7a-linter` (the one other open PR,
  #83): 8 files changed, 3 of them under `.veistra/edges/` (not nodes/ or
  runs/), clean, exit 0. This branch also carries no TypeScript changes, so
  it is unaffected by item 2 below as well.

**Not made required.** The workflow exists and passes; branch protection was
not touched (see the warning in my prompt — that is explicitly the owner's
call). To turn it on: Settings → Branches → main → Require status checks to
pass → add `veistra-boundary`.

## 2. TypeScript import boundary: extended the existing ESLint mechanism, not dependency-cruiser

**Checked first, per instructions:** the repository already has an equivalent
mechanism. `eslint.config.js` uses flat-config `no-restricted-imports`
patterns for two things: routing every Tauri call through `src/bindings.ts`
(`TAURI_RESTRICTION`), and forbidding a relative reach into
`packages/bridge/src/`. On top of that, `regionIsolation` uses the same
machinery to stop one `src/shell/<region>` importing another's source. Adding
`dependency-cruiser` alongside this would be a second tool enforcing the same
kind of rule through a second config file and a second CI step — two sources
of truth for "which imports are illegal." I extended the existing one instead.

**What I added:** `APPS` (the six `apps/<name>/ui` surfaces) and
`appIsolation`, one config block per app, blocking any import whose specifier
contains another app's `<other>/ui/` path segment. This makes mechanical what
`apps/README.md`'s "Apps talking to each other" section already states in
prose: an app reaches another only through the shell-routed `veistra/open` /
`veistra/publish` topics, never a source import.

**One real bug caught while proving it works:** my first version anchored the
pattern on `**/apps/<other>/ui/**`, copying `BRIDGE_RESTRICTION`'s shape. That
fails silently for apps, because two apps share the `apps/` parent — a
relative import between siblings (e.g. from `apps/schematify/ui/src/x` into
`apps/files/ui/src/y`) never re-writes the literal text `apps/` on the way
back down, so the pattern never matched. Fixed by also matching
`**/<other>/ui/**` with no `apps/` prefix required. Verified with a throwaway
file under `apps/schematify/ui/src/__eslint_probe__/` importing
`apps/files/ui/src/explorer/useTree` by relative path — it now fails
`no-restricted-imports` with the app-isolation message, and the probe file was
deleted afterward (not part of this commit).

**Proved clean:** `npx eslint .` is unchanged — 0 errors, the same 8
pre-existing `react-hooks/exhaustive-deps` warnings as before this branch, on
`main` and confirmed the one other open branch (#83) carries no `.ts`/`.tsx`
changes so cannot be affected by this rule either way.

## 3. CODEOWNERS: the design/audit split

**File:** `.github/CODEOWNERS`.

Added five owned patterns — `.veistra/brief.json`, `.veistra/nodes/`,
`.veistra/edges/`, `.veistra/rules/`, `.veistra/screens/`, `.veistra/flows/`,
`.veistra/decisions/`, `.veistra/registry/` — all to `@braden-seaborn`, and two
unowned patterns, `.veistra/runs/` and `.veistra/layout/`, with no owner listed
(GitHub CODEOWNERS treats a pattern with no name after it as removing
ownership for that path — the existing file's `apps/ @octocat` example in
GitHub's own docs is the same unanchored-pattern shape I used here).

**Handle confirmed, not guessed:** `@braden-seaborn` already appears seven
times in the existing `.github/CODEOWNERS` (the blanket `*` rule and four
guarded paths) and again in `scripts/check-catalog.mjs`'s `MAINTAINER`
constant, and matches the git log author (Braden Seaborn) and the
`Firelight-Innovations` GitHub org this repo lives under. Reused as-is.

**Why unanchored, and why placed after `/crates/`:** same reasoning as the
path-scope check — `.veistra/` is a project root, not a fixed repository path,
and today all three instances sit under `crates/schematify-core/fixtures/`,
which the pre-existing `/crates/ @braden-seaborn` rule already blankets.
CODEOWNERS resolves each path against the *last* matching line in the file, so
the two unowned lines are placed after `/crates/` specifically so they win for
`runs/` and `layout/`, while every other path under `crates/` (including the
seven owned `.veistra/` trees) keeps the owner from either rule agreeing.

**Not validated against GitHub's own parser tonight** — I have no way to hit
`GET /repos/.../codeowners/errors` for a ref that only exists locally before
pushing. I did push (see below) and the syntax should be checked once GitHub
has it: `gh api repos/Firelight-Innovations/helve/codeowners/errors?ref=schematify/w10a-gates`.
If that reports an error, the two unowned lines are the ones to look at first —
they are the unusual part of this file.

**No branch protection change.** "Require review from Code Owners" is still
off, per the existing file's own header (`required_pull_request_reviews` is
`null` as of 2026-08-21) — this pull request only adds patterns to a file that
currently requests nothing from anybody. Turning required review on is the
owner's call, same as making `veistra-boundary` a required check.

## 4. cargo-deny: already sufficient, nothing changed

PRD §14.6 names `cargo-deny` as already gating Rust dependencies. Confirmed:
`Cargo.toml`'s workspace `members` includes the glob `crates/*`, which already
covers `crates/schematify-core` and `crates/schematify-reconcile` — they are
ordinary workspace members, not opted in specially. `deny.toml` carries no
`[graph]` section, and its own header states that omission is deliberate:
every target is resolved, not just the one the app builds for, so nothing
about being Windows-only or Rust-only exempts the two Schematify crates.

Ran `cargo deny check` (background, `CARGO_TARGET_DIR` pointed at the shared
target dir) against the full workspace: `advisories ok, bans ok, licenses ok,
sources ok`, exit 0. `.github/workflows/deny.yml` already runs this same
command on every pull request and push to `main`. No file changed for this
item.

## Verification run tonight

Foreground, all green: `pnpm build`, `pnpm test:js` (32 files / 490 tests,
plus `packages/bridge`'s 28), `pnpm lint:js`, `pnpm lint:comments`,
`pnpm lint:version`, `pnpm lint:identity`, `pnpm lint:branding`,
`pnpm format:check`, plus `npx vitest run scripts/check-veistra-boundary.test.mjs`
directly. Background: `cargo deny check` (item 4). Not run: `pnpm test:rust`,
`pnpm lint:rust` — no Rust file changed this wave.

## Assumptions

- The path-scope check groups by literal text preceding `.veistra/` in a changed
  path (a "root"), and judges each root independently. The PRD does not say
  explicitly whether "a pull request" in §14.6 means the whole diff or each
  project separately; per-root reads truer to §6.2's reasoning ("the two
  writes never conflict") and avoids failing a PR that touches two unrelated
  fixtures for unrelated reasons.
- `dependency-cruiser` was not added, in favor of extending the existing
  ESLint mechanism — see §2. If the owner wants `dependency-cruiser`
  specifically (e.g. for a boundary shape ESLint's `no-restricted-imports`
  cannot express, such as detecting a cycle rather than a named forbidden
  edge), that is a deliberate escalation, not an oversight here.
- CODEOWNERS ownership for `.veistra/brief.json` is a single-file pattern, not a
  directory — PRD §14.6 says "brief.json" by name, not "brief/".

## Left undone / owner's call in the morning

- Neither new check (`veistra-boundary`, or CODEOWNERS via "Require review from
  Code Owners") is required in branch protection. Turn `veistra-boundary` on at
  Settings → Branches → main → require status checks → add it by name.
  Require Code Owner review the same way, in the same screen.
- CODEOWNERS syntax not confirmed against GitHub's own validator — see §3.

## Pull request

`gh pr create --draft --base main --title "Schematify wave 10a: boundary enforcement in CI"`,
marked ready with `gh pr ready` once this handoff and all four commits above
were pushed.
