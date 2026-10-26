# Contributing to Veistra

This repository is the Veistra orchestrator: the shell that reads the stack
manifest, finds the tool checkouts, and hosts the first-party apps. Everything
else in the stack is its own repository and reaches this one through
`docs/tool-protocol.md`. `README.md` describes what the thing is and how it is
laid out; this document is how to work on it.

It is written for someone who has never seen the repo, because the conventions
here are stricter than most and two of them are genuinely unusual. Reading this
once is cheaper than having a pull request explained back to you.

## Windows is the only supported platform today

Say it before you spend an evening on it: **every prerequisite in this
repository is a Windows prerequisite** — winget, the MSVC build tools, the
WebView2 runtime — and nobody has built the orchestrator on macOS or Linux.

That is a statement about what has been tested, not a decision to exclude
anything. Tauri v2 supports all three platforms and nothing in the design is
Windows-only in principle; the release build produces MSI and NSIS installers
because those are the ones anyone has had a reason to produce. What does not
exist is a machine that runs the other two, so a change that breaks them would
not be noticed, and "it built for me" is the only evidence anyone could offer.

If you want to port it, that is welcome and it is a real piece of work rather
than a patch: the prerequisites, a CI runner that keeps it green, and someone
who notices when it goes red. Open an issue and say so before you write it.

## Getting a build

Prerequisites, all one-time, and all taken from the README's Development
section:

- **Rust** (stable) — `winget install Rustlang.Rustup`. Rustup's default profile
  installs `clippy` and `rustfmt`, which `pnpm lint` and `pnpm format:check`
  both need.
- **MSVC build tools** — Visual Studio Build Tools 2022 with the *Desktop
  development with C++* workload. Rust uses the MSVC linker on Windows.
- **WebView2 runtime** — preinstalled on Windows 11.
- **Node 20+** and **pnpm** — `npm i -g pnpm`.
- **Git**, if the machine does not already have it — `winget install Git.Git`.

Open a fresh terminal after installing those; the Rust and pnpm installers put
`cargo` and `pnpm` on `PATH` for new shells, not for the one you ran them from,
and "cargo is not recognized" at the end of a long install is otherwise the
first thing that happens.

Then:

```sh
git clone https://github.com/Firelight-Innovations/Veistra.git
cd Veistra
pnpm install
pnpm verify
```

`pnpm install` runs `generate:icons` on the way out, which writes about 1100
files under `public/icons/material/`. That is expected. The first `pnpm verify`
compiles the entire Tauri dependency tree and takes several minutes; every run
after it is incremental and takes well under a minute.

A green `pnpm verify` on a fresh clone is the definition of a working setup. If
you got one, you can contribute, and nothing else needs to be installed.

To run the desktop app rather than just build it:

```sh
pnpm app              # tauri dev
```

There is no separate "build the frontend" step for running the app — `pnpm dev`
and `pnpm build` are only the frontend half, and `tauri.conf.json` invokes them
itself through `beforeDevCommand` and `beforeBuildCommand`. Use the `app`
scripts.

**A fresh clone reports most of the stack as `not cloned`, and that is
correct.** `veistra.toml` pins each component repository and looks for it in a
sibling directory of this checkout; on a machine that has only this repo,
finding none of them is the accurate answer rather than a broken install. The
shell, Home and Files all run in that state, which is the state most work on the
orchestrator happens in.

## `pnpm verify` is a gate, not a suggestion

**Every commit and every pull request passes all four checks.** One command runs
them, in this order:

| Check | Command | Covers |
|---|---|---|
| Build | `pnpm build` | runs `tsc` first, so this covers types |
| Tests | `pnpm test` | vitest and `cargo test --workspace`, both halves |
| Lint | `pnpm lint` | ESLint, clippy, comment density |
| Format | `pnpm format:check` | Prettier and rustfmt; `pnpm format` applies |

While you are iterating, `pnpm verify:fast` runs the same four checks in about
half the time by swapping `pnpm build` for `pnpm typecheck` — the three
workspace packages plus `tsc`, without `vite build` or the icon generation step.
Bundling alone is most of the difference.

**The last run before you push is the full `pnpm verify`, never the fast one.**
This is the single most likely way a first pull request breaks `main`, so it is
worth being specific about what you skip. `vite build` is the only check that
catches:

- a new app missing its entry in `vite.config.ts` — `STANDARDS.md` §3 names this
  as the one piece of adding an app that cannot be inferred, and the failure is
  *silent*: the app simply is not in the bundle, and every other check passes;
- an asset referenced from CSS or HTML that does not resolve;
- anything that type-checks but cannot be bundled, such as a bad dynamic import.

None of those are type errors, so `tsc` passing tells you nothing about them.

Each half is available on its own when you want a narrower loop still —
`pnpm typecheck`, `pnpm test:js`, `pnpm test:rust`, `pnpm lint:js`,
`pnpm lint:rust`, `pnpm format`. One gotcha there: `cargo clippy` replays cached
diagnostics and will report "Finished" in under a second without rechecking
anything, so after changing a crate, `cargo clean -p <crate>` first if you want
to trust the result.

### Never run `pnpm baseline`

The three baseline files — `eslint-suppressions.json`, `clippy-baseline.json`,
`comment-baseline.json` — exist because each linter was switched on against a
codebase written without it. They record what already existed and fail when a
count goes *up*, which let the rules land without a flag day.

**All three are now empty.** From empty, `pnpm baseline` cannot bank an
improvement; it can only absorb whatever is currently broken, which is the exact
thing the ratchet exists to prevent. A violation today is a violation, not a
number to compare against, and the fix is the code.

`STANDARDS.md` §10 has the longer version, including the single-check form and
what it takes to justify using it. If you believe a rule is wrong, the honest
move is to say so in the pull request and argue for changing the rule — not to
widen a baseline quietly and hope it reads as housekeeping.

## `STANDARDS.md` is the rule book

Read it before your first change. It is the document a linter failure points at
and the one a review comment cites instead of relitigating a preference, and
most of it is descriptive — it was already true before it was written down.

Two sections decide most reviews.

### §1, layering: Rust owns everything that touches the machine

The frontend is a view. It never reads a path, never shells out, never decides
what is on disk; it renders a snapshot Rust produced and sends verbs back. §2
names the two files that exist purely to be chokepoints, whose whole value is in
being the *only* way through: `src/bindings.ts` is the one file that may call
Tauri's `invoke` or `listen`, and `src/shell/contract.ts` is the vocabulary the
shell's regions are built against. If the wrapper you need does not exist, add
one — that is the intended move, and reaching past the door is not.

ESLint enforces the region isolation with nothing grandfathered, so this one
usually fails before a human sees it.

### §4, comments: the rule outside code violates first, every time

**This codebase explains itself in prose, and the prose explains *why*, not
*what*.** Every module opens with a doc comment — `//!` in Rust, a `/** */`
block in TypeScript — saying what the module is for and what seam it sits on,
not restating its name. Beyond that, the three habits worth internalising:

1. **Record the alternative you rejected, and why.** This is the highest-value
   comment in the repo and there are dozens of them. Someone reconsiders that
   decision in a year, and the comment is what stops them relitigating it from
   scratch.
2. **Document what is deliberately absent.** Absence is a decision, and an
   undocumented decision reads as an oversight.
3. **Say when something is safe to call twice, capped, or lossy.**

Tone is plain declarative sentences. Being blunt about a limitation is fine;
being vague about one is not.

There is a counterweight, and it surprises people who take the above
enthusiastically: `scripts/check-comments.mjs` caps comment *concentration* — no
file more than half comment lines, no unbroken run over twenty. A header over
the cap gets three things done to it in order, and the order matters. It is
distributed onto the specific items each paragraph is about; then tightened; and
only then moved to `docs/design-notes/`, verbatim, with the source pointing at
the page. Nothing is summarised on the way out.

## A bug fix arrives with the test that would have caught it

`STANDARDS.md` §8 calls this the only test rule that is non-negotiable, and it
is the one thing most likely to send an otherwise good pull request back. The
test goes in the same commit as the fix, and it is written the way it would have
been written if it had caught the regression rather than been retrofitted to
pass.

Rust code is tested in a `#[cfg(test)]` module in the file it tests; the state
machines under `src-tauri/src/` are the worked examples. For the frontend, §8 is
the authority on which runner covers what and where a new test file goes — read
it rather than copying the nearest file, because the frontend half of the test
layout is younger than the Rust half and the nearest file may predate the
answer.

**A failing test is never fixed by deleting or skipping it.** If a test is
genuinely wrong, say so and explain why in the commit message, and change it in
a commit that is about that and nothing else.

## Commit messages

Nobody guesses this one, so it is written down: **a commit message is an
imperative sentence describing the change from the codebase's point of view.**
Real examples, from the history:

```
Give the shell panes, clusters, and many instances of one app
Answer the lock-poison question once instead of at forty call sites
Empty the last baseline: 103 files under the comment-concentration caps
Declare tools/list uncacheable, which is what makes a client accept it
```

Not `feat: add panes`. This repository does not use Conventional Commits, and a
pull request written in them will be asked to rewrite them. The reason is what
the log is for: read end to end, it should be a list of things the codebase
gained and why, in the words someone would use to explain the change out loud. A
prefix and a noun phrase cannot carry "which is what makes a client accept it",
and that clause is the entire value of the line.

If the subject cannot hold the reasoning, put it in the body. Long bodies are
normal here.

## Opening a pull request

`STANDARDS.md` §9 is the checklist, and it is three items:

1. `pnpm verify` passes — the full form.
2. New modules have doc comments; new decisions have their rejected alternative
   recorded.
3. **If it touches `docs/tool-protocol.md`, `src/bindings.ts`, or
   `src/shell/contract.ts`, say so explicitly in the description.** Those three
   are contracts that other code and other repositories are built against, and a
   change to one is reviewed as a change to an API rather than to a file.

Opening a pull request runs the full `pnpm verify` on Windows, as a check named
`verify`. That is the same command you ran before pushing rather than a
re-implementation of it, and the sameness is the point: a job that runs a
hand-assembled list *resembling* `pnpm verify` is a job that makes "passes
locally, fails in CI" into a category of problem, and here it is not one. A
supply-chain check over the dependency tree runs alongside it and is advisory
for now.

The template asks three questions rather than offering a checklist: which layer
the change touches (§1), whether the *full* `pnpm verify` passed rather than
`verify:fast`, and — if it is a bug fix — where the test that would have caught
it lives. All three are above, so it should read as a reminder rather than a new
demand. On the third: "no test" with a reason is fine, and "no test" on its own
is the thing that question exists to catch.

Small is better than complete. A pull request that fixes one thing and carries
the test for it gets reviewed the same evening; one that fixes one thing and
reformats four files it did not otherwise change gets reviewed slowly, because
the diff no longer says what happened.

## What will not be accepted

Stated up front, because the alternative is you finding out on your third
weekend.

**Some first-party tools are commercial and always will be.** Not every
component of the stack is going to become a public repository. This is the open
core model — an Apache-licensed core, proprietary first-party tools, one public
protocol that both use — and VS Code is the exact precedent.

**Schematify and the app download system are built by the maintainer.**
Not because outside help is unwelcome, but so nobody spends a weekend on a
foundation that is already half-written. Once each one exists, features and
quality-of-life work on top of it are exactly where an outside change lands
best. A roadmap and a set of starter issues are coming.

**The tool protocol is the license boundary, and nothing crosses it.**
`docs/tool-protocol.md` is what a tool may assume about the host and what the
host guarantees. A change that reaches around it — a private tool poking at
orchestrator internals, or the orchestrator growing a special case that only
makes sense for one tool — is declined **on principle rather than on quality**,
including when the code is good. It is not a judgment about the patch. It is
that "just this once, reach into core" is precisely how open core projects rot,
and the rule only works if it has no exceptions.

When something on either side genuinely needs more from the other, there are two
moves and no third: generalize it so that any tool could want it and land it in
this repository, or accept that it belongs in the tool rather than in core.

The other three, briefly, because they follow from what is above:

- A pull request that makes a check pass by widening a baseline, deleting a
  test, or skipping one.
- A rename of anything in the on-disk or wire vocabulary — the `veistra.toml`
  filename, the `.veistra` extension and `.veistra/` directory, the `veistra/*` RPC
  method namespace, the `veistra-tool://` scheme, the `@veistra/*` npm scope, the
  crate names. Those are contracts with every tool repository and every project
  already on disk, and renaming one stops existing projects opening.
- A change to `crates/` without tests. Other repositories depend on those, and a
  change without a test is a change no tool author can trust.

## License, conduct, and getting an answer

The source is Apache-2.0 — see `LICENSE` and `NOTICE` at the repository root.
Contributions are accepted under those same terms, which is what Apache-2.0 §5
says of any contribution submitted for inclusion; there is no separate
contributor agreement to sign.

`CODE_OF_CONDUCT.md` is the Contributor Covenant 2.1, unmodified, and reports go
to <braden.seaborn@firelightinnovations.com>.

If you are unsure whether something would be accepted — particularly anything
that touches the three contracts in §9 item 3, or anything large enough that you
would be disappointed to rewrite it — open an issue and ask first. That question
is always cheaper than the answer arriving as a review.
