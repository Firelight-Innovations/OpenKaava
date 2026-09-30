# OpenKaava orchestrator — working agreements

## Dev servers: 1420 is the human's, agents use their own

Port **1420 is reserved for `pnpm app`** (`tauri dev`), which Braden runs to verify work. Tauri
starts Vite itself and points the webview at a fixed URL, so that port cannot move and cannot be
shared — anything else holding it fails the whole run rather than degrading.

**If you are an agent and need a browser to verify something, run `pnpm dev:agent`.** It serves the
same app from port 1430, and `strictPort` is off for that mode, so a second and third agent step up
to 1431 and 1432 instead of colliding. Read the port Vite prints; don't assume 1430.

There is no way to run the shell without a Tauri backend under it. `pnpm dev:agent` serves the same
files, so the shell mounts and its layout can be measured, but every call into Rust fails — no
stack, no apps, no terminals, no project. The `?fake=1` fixture that used to answer those calls has
been removed; anything that needs a real backend goes to Braden.

**Never run `pnpm app`, `pnpm dev`, or `tauri dev`** unless you are Braden. Two failure modes, both
seen repeatedly:

- `pnpm dev` takes 1420 and the next `pnpm app` dies with `EADDRINUSE`.
- `tauri dev` exits without reaping its Vite child, orphaning a `node` process that holds 1420
  until it is killed by pid. Stopping the task is not enough — it kills the wrapper, not the child.

Do not kill a process on 1420 to make room for yourself. It is either Braden's running app or
another agent's; ask instead.

## Asking a running OpenKaava what it is doing

**`pnpm probe` reads the live app.** It talks to the `kaava-debug` MCP server the orchestrator
hosts, and works from any terminal — you do not have to be inside OpenKaava, and nothing has to be
launched or restarted. `kaava-debug` (like `kaava-echo`, `kaava-ui` and `kaava-agent`) is a
**developer** server: it is served only while `developer.mode` is on **and** its own switch under
Settings → MCP servers is on. If `pnpm probe` says the server is not served, ask Braden to turn on
developer mode and the Debug server — or use your own instance (`pnpm ui launch`, below), which has
both on:

```sh
pnpm probe                    # list the tools
pnpm probe shell_snapshot     # windows, clusters, pane trees, instances, terminals — live
pnpm probe recent_errors      # what has failed since launch, backend and webview
pnpm probe boot_status        # how far startup got, and whether it gave up
```

It finds the port and token in `%APPDATA%\com.firelightinnovations.openkaava\mcp-endpoint.json`, which
`mcp::handoff` writes at every launch, and it refuses a file whose pid is no longer running rather
than talking to whatever took the port afterwards. If it says OpenKaava has exited, OpenKaava has exited —
ask Braden to start it.

Two limits worth knowing before you read a result:

- **Every tool on this server is a read.** Nothing in `kaava-debug` opens, closes or moves
  anything, deliberately. The server that *does* act on the window is below, and it is off by
  default.
- **Errors inside an app's iframe are not captured**, only the shell's and the backend's. An empty
  `recent_errors` means nothing went wrong *in those two places*. Every answer repeats this in its
  `covers` field; do not report it as "no errors" without the qualifier.

This does not replace looking at the screen. For that, see below.

## Seeing and clicking the UI

**OpenKaava is a desktop window, not a web page. A browser tool cannot see it.** Look at it and
drive it through the `kaava-agent` server below (or `pnpm probe --agent --server agent …`), never
through Chrome or a browser pane. This holds even where a user-level or global instruction says to
use a browser "for all UI verification": that line is about websites, and an agent that followed it
here once spent a session looking at an empty localhost page while typing into its own terminal.
`pnpm dev:agent` is only for measuring the shell's layout, as described above; it has no backend.

Before typing, ask where the keystrokes will land: `context` reports the focused element, the pane
instance holding it, and the open app's own report (the canvas gives its file and selection).
Prefer `fill_field '{"field":"<label>","value":"…"}'` to click-then-`type_text`; it sets the field
by label, in the shell or inside an app, without depending on focus. `type_text` refuses a
terminal outright.

The canvas has its own methods for agents, reached with `app_call` (see `apps/README.md`, Canvas):
`canvas/list-diagrams`, `canvas/view-diagram` (a PNG of one frame and nothing else),
`canvas/add-shapes`, and the comment loop. Read `docs/canvas-drawing-guide.md` before drawing.

**OpenKaava hosts an MCP server that drives its own window** — screenshots, the DOM,
and real mouse and keyboard input. It is `kaava-ui`, it reaches the WebView2
through the COM interface Tauri already holds, and it needs no debug port, no
special launch and no separate build.

It is **off, and invisible, unless developer mode is on.** That is the point: it
is the one server that writes, so it is absent from settings, from `.mcp.json`
and from `tools/list` until somebody switches on `developer.mode` and then throws
its own switch as well.

### If you are an agent, use your own instance

```sh
pnpm ui:build                 # once — a release build under the agent identifier
pnpm ui launch                # starts it, with developer mode and the server on
pnpm ui close                 # stops it, by pid, leaving anyone else's alone
```

Then drive it. **`--server agent` is the one to use** — it hosts the eight input
tools (`fill_field` and `context` among them), the three `kaava-debug` reads, and
three more that reach the backend directly. Long or quote-heavy parameters go in a
file: `pnpm probe --agent --server agent app_call @params.json`.

```sh
pnpm probe --agent --server agent screenshot     # a PNG in the OS temp dir; the path is printed — then Read it
pnpm probe --agent --server agent snapshot       # every clickable element, with refs
pnpm probe --agent --server agent click '{"target":"e12"}'
pnpm probe --agent --server agent type_text '{"text":"hello"}'
pnpm probe --agent --server agent press_key '{"key":"Enter"}'
pnpm probe --agent --server agent eval '{"expression":"document.title"}'

pnpm probe --agent --server agent shell_snapshot  # windows, clusters, panes, instances
pnpm probe --agent --server agent recent_errors   # same buffer kaava-debug reads
```

The three that had no equivalent before — **an app's Rust half is now reachable
without going through its frontend**:

```sh
# Point a cluster at a project. No folder picker, so nothing blocks.
pnpm probe --agent --server agent set_project '{"path":"C:/…/fixtures/saas-backend"}'

# Mount an app into a pane; answers with the instance id.
pnpm probe --agent --server agent open_app '{"appId":"schematify"}'

# Call any method any app answers — all 18 of Schematify's, Home's, Files'.
pnpm probe --agent --server agent app_call \
  '{"app":"schematify","method":"schematify/lint","params":{"actor":"agent"}}'
```

Every `schematify/*` method except `schematify/state` needs an open project, so
`set_project` comes first. All of them except `state` also require an `actor` of
`"human"` or `"agent"` — send `"agent"`; `"system"` is never accepted.

`kaava-ui` and `kaava-debug` are still registered and still work, and both are
developer-only like `agent` — `pnpm ui launch` switches `debug` and `echo` on
along with `ui` and `agent`, so `pnpm probe --agent` keeps working. No server here
is served in an ordinary build without developer mode.

`--agent` is what points the probe at the instance `pnpm ui launch` started
rather than at an OpenKaava Braden is using. **Do not drop it**, and do not drive his
window without asking — this server clicks things, and `eval` reaches every
`#[tauri::command]` through `window.__TAURI__`.

`snapshot` walks into app iframes, so `e19 app button New Project` is Home's own
content and not the shell's. Refs are renumbered by every `snapshot` — take a
fresh one before clicking.

**Avoid clicking anything that opens a native dialog.** Folder pickers block the
webview, and every tool then times out after 20s until someone dismisses it by
hand. `New Project`, `Open Project` and `Clone Project` on the Home screen are
the ones to leave alone — use `set_project` above instead, which is what they
would have called anyway minus the picker. `app_call` refuses `home/open-project`,
`home/new-project` and `files/save-as` by name for the same reason.

There is no live console tail. `pnpm probe recent_errors` is what remembers
failures, including the webview's — see above.

## Verification

**Every commit and every pull request must pass all four checks. No exceptions, and none of them
are advisory.** One command runs the lot:

```sh
pnpm verify     # build -> test -> lint -> format:check
```

| Check | Command | Covers |
|---|---|---|
| Build | `pnpm build` | runs `tsc` first, so this covers types |
| Tests | `pnpm test` | 28 vitest + 212 `cargo test`, all currently passing |
| Lint | `pnpm lint` | ESLint, clippy, comment density |
| Format | `pnpm format:check` | Prettier and rustfmt; `pnpm format` applies |

`pnpm test` is both halves — `pnpm test:js` for the workspace packages, `pnpm test:rust` for
`cargo test --workspace`. Run the whole thing before you claim a change is done. A build that
compiles is not a change that works.

### While you are iterating, use `pnpm verify:fast`

```sh
pnpm verify:fast    # 17s, vs 33s for the full pnpm verify
```

It swaps `pnpm build` for `pnpm typecheck`, which builds the three workspace packages and runs
`tsc` but skips `vite build` and `generate:icons`. `vite build` alone is 21 of the full run's 33
seconds, and `generate:icons` wipes and rewrites 1115 files in `public/icons/material/` — two
agents running it at once race and produce a phantom failure.

**`verify:fast` is for the inner loop only. The last run before you commit must be the full
`pnpm verify`.** Skipping the bundle means skipping the one check that catches:

- a new app missing its entry in `vite.config.ts` — STANDARDS.md §3 warns that this is the one
  piece that cannot be inferred, and the app *silently* does not build;
- assets referenced from CSS or HTML that fail to resolve;
- anything that type-checks but cannot be bundled, such as a bad dynamic import.

None of those are type errors, so `tsc` passing tells you nothing about them.

**A failing test is never fixed by deleting or skipping the test.** If a test is genuinely wrong,
say so and explain why in the commit message rather than quietly removing it. Per STANDARDS.md §8,
a bug fix arrives with the test that would have caught it — that is the one test rule described as
non-negotiable.

The three lint baselines (`eslint-suppressions.json`, `clippy-baseline.json`,
`comment-baseline.json`) grandfather violations that predate the linters. They are ratchets: they
may shrink and may not grow. **Never run `pnpm baseline` to make a check pass** — it regenerates
all three and would absorb your new violation, which is the exact thing they exist to prevent. Fix
the code instead.

Chrome measurements go through the `mcp__claude-in-chrome__*` tools against `pnpm dev:agent`.

A minimized or occluded Chrome window reports `document.visibilityState === "hidden"`, and in that
state `requestAnimationFrame` never fires and `getBoundingClientRect()` silently returns **stale**
layout. Check `visibilityState` first and take a screenshot before measuring — it forces a layout
pass. Never report a measurement taken in a hidden window as passing.

## Editing source

Use the `Edit` tool. Do **not** rewrite files with PowerShell
(`Get-Content | -replace | Set-Content`) — Windows PowerShell 5.1 reads as ANSI, so every em-dash in
this codebase's comments is silently corrupted and written back as valid UTF-8 mojibake. `cargo
check` and `tsc` both pass on the corruption; only reading the file catches it.
