# Veistra 0.2.0 — Primary Context (read this first)

You are one of four agents working overnight, each in your own git worktree,
each on your own branch, each with no human available until morning. Another
agent's own prompt has its own scope — do not read ahead into it, do not
touch its files, and do not try to coordinate live with it. Everything you
need to work independently is in this document plus your own task prompt.

## What we're building

Veistra (`Firelight-Innovations/Veistra`) is a Tauri v2 desktop app: Rust
backend in `src-tauri/`, React 19 + TypeScript frontend in `src/`. It's an
Agentic Development Environment for game development — a shell that coding
agents run inside, currently pre-alpha, Windows-only.

We're adding four features for 0.2.0, each inspired by (and in places
directly adapted from) `stablyai/orca` — an open-source, MIT-licensed
Electron app that does the same "run coding agents in worktrees" job. Orca is
mature and these features already work there. We are not designing from
scratch; we are porting working ideas, and in places working code, into a
different stack.

## The stack mismatch — read this before you touch Orca's source

Orca is Electron + Node.js + TypeScript. Veistra is Tauri v2: Rust owns
everything that touches the machine (filesystem, processes, the OS webview),
and the React frontend reaches Rust only through typed commands
(`src/bindings.ts` → `src-tauri/src/commands.rs`). This means:

- **Directly portable, usually close to copy-paste-and-adjust:** Orca's React
  UI components, their props/state shape, their interaction logic (click
  handlers, drag handlers, comment threading data model, DOM element
  selection logic for Design Mode — all of that is plain web tech and
  transfers to Veistra's React frontend with import-path and styling changes.
- **Not portable, needs a real Rust rewrite:** anything built on Electron's
  `ipcMain`/`ipcRenderer`, `child_process`, `BrowserView`/`webContents`, or
  direct Chrome DevTools Protocol (CDP) sessions. Tauri has its own command
  system and its own webview (WebView2 on Windows, which *does* expose a CDP
  endpoint, but you reach it through Tauri/webview2 APIs, not Electron's).
  Treat every Electron API call in Orca's source as a description of *what*
  needs to happen, not code you can paste into a `.rs` file.

Read `docs/dev/architecture.md` in Veistra before writing anything — it
explains the actual command-registration pattern (`commands.rs` →
`generate_handler!` in `lib.rs` → typed wrapper in `bindings.ts`), the shell
region layout under `src/shell/`, and the apps-vs-tools distinction. Do not
invent a different pattern because Orca does it differently.

## Studying Orca's source

Clone it read-only into a scratch directory outside the Veistra repo — do
not add it as a submodule, do not commit any of its files into Veistra:

```bash
git clone --depth 1 https://github.com/stablyai/orca.git /tmp/orca-reference
```

Explore `src/` for the module relevant to your feature (search for the
feature name — e.g. `design-mode`, `diff`/`annotat`, `drag`, `github`,
`linear`, `worktree` — Orca's own changelog groups worktree/github/linear
code together under a `shared/` area, so start there and in whatever
directory holds the browser/CDP code for Design Mode). Read for the
*approach and data model* first. Then decide, file by file, whether it's
frontend logic you can adapt directly or backend plumbing you need to
redesign for Rust.

## License

Orca is MIT-licensed. Veistra is Apache-2.0. That combination is fine —
Apache-2.0 projects routinely include MIT-licensed code — but you must carry
the attribution forward correctly:

- Any file with code adapted from Orca gets a short header comment: the
  Orca file it's adapted from, and a note that the original is MIT-licensed,
  © Stably AI.
- Add or extend a `THIRD-PARTY-NOTICES` (or equivalent — check if one exists
  already; `NOTICE` in the repo root is the existing precedent for this kind
  of thing) entry recording that Veistra incorporates MIT-licensed code
  from `stablyai/orca`.
- Do not copy Orca's own branding, logos, or the word "Orca" into any
  user-facing string, file name, or comment beyond the attribution above.

## Ground rules — you're unsupervised until morning

1. **Stay in your own worktree and branch.** Never touch `main`, never touch
   another agent's branch or worktree.
2. **Open a pull request when you're done. Do not merge it, and do not push
   directly to `main`.** `main` is protected (the `verify` and `deny` CI
   checks are required); a human reviews and merges everything in the
   morning. Green CI on your PR is the goal, not permission to self-merge.
3. **Run `pnpm verify` before opening the PR**, and again after your last
   commit if you keep working past that point. It gates build, test, lint,
   and format. The lint baselines (`clippy-baseline.json`,
   `comment-baseline.json`, `eslint-suppressions.json`) are all empty — a new
   violation is a violation. Do not edit a baseline file to make one pass.
4. **Commit frequently, with clear messages**, so a crash or a timeout loses
   you the least possible work. Don't sit on one giant uncommitted diff.
5. **If you hit a real blocker** — a design decision you can't resolve
   alone, a security/capability question, a conflict between this feature
   and something already in the codebase — **stop, write down exactly what
   you hit and why, commit what you have, and leave it in your PR
   description.** Do not guess at a resolution and do not work around it by
   touching code outside your scope. A well-documented partial result is a
   good outcome tonight; a guessed-at hack is not.
6. **Do not touch:**
   - `src-tauri/src/apps/` modules that aren't yours (home.rs, files.rs,
     trash.rs, tutorial.rs)
   - `examples/echo-tool/`
   - anything under the other three agents' feature areas (see each task
     prompt's "out of scope" section)
   - Tauri capability scopes (`capabilities/`) beyond the minimum your
     feature strictly needs — and if you widen one, say exactly why in your
     PR description
7. **Expect merge overlap on shared files** — `commands.rs`, the
   `generate_handler!` list in `lib.rs`, and `bindings.ts` will all get
   touched by more than one of us tonight, since every new feature registers
   a new command there. That's expected and fine; it gets resolved at merge
   time tomorrow, not by you trying to avoid it.

## Your specific task

Your own prompt (not this document) tells you which of the four features is
yours, what to build, what's explicitly out of scope, and what "done" looks
like. Read it now.
