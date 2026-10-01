# Handoff: the UI/UX session, 2026-09-28 to 2026-10-01

From the agent that ran the UI/UX rework. Read this before you start the backend session. It
tells you what was built, how the work was run, what is still open, and the traps that cost us
time. The live task list is the tracker artifact
(https://claude.ai/artifact/3szpbcc9WkJ9QECJ7Gs29b). Its rows carry the detail per task.

## TL;DR

- About 75 PRs (#143 to #220) merged into `ux/rework`. `main` last took `ux/rework` at #191
  (`b6648279`). `ux/rework` is now about 85 commits ahead of `main`. A `ux/rework` -> `main` PR
  is still to do before the Friday release (GO-1).
- The shell is reworked: one title bar, a cluster switcher, a right-hand rail of pages, rounded
  pane cards, one titlebar search bar, and a command palette.
- Clusters have environments. `main` is read-only for every write. Worktree clusters are where
  edits happen.
- Agents get context: drag or Ctrl+V into a terminal, a Context strip, and an "agent saw"
  gallery. Godot, Blender, the File Viewer and the canvas send items to the agent.
- The Godot viewer has a three.js 3D preview with markup. Markup is a JSON context kind, with
  auto-send that types `@path` at the prompt without pressing Enter.
- The Canvas app (Excalidraw) stores one JSON file per canvas in the repo. It has typed frames,
  custom types, nested canvases, and 35 MCP tools on `kaava-canvas`.
- Two MCP servers are on in every build: `kaava-canvas` and `kaava-workspace`. `kaava-workspace`
  also pushes focus changes as a subscribable resource. The `agent`, `debug`, `echo` and `ui`
  servers exist only in developer mode.
- Cloud work is out of scope for the UI side. WR-2 (cloud clusters on `kaava-worker`) is parked
  until there is a design for the canvas, Blender and Godot in cloud sessions, and for source
  control of large art next to game source.

## What was built, by area

| Area | PRs | Notes |
|---|---|---|
| Design system | #143, #160, #162, #167 | Tokens, theme and accent broadcast, `k-*` components. The default accent is Plane blue. Light theme gaps are being fixed in UX-38 |
| Shell chrome | #147, #156, #157, #196, #204, #206 | Title bar, rail pages that pull out of the rail, cluster pill and rail strip |
| Panes | #148, #161, #209, #210 | Tab strips, five drop zones, an app picker, one file per File Viewer |
| Pop-out windows | #220 | Plane webview follows its window, a detached app keeps its environment, page width clamps to the window |
| Search | #154, #176, #193, #194, #213 | Command palette surface. One titlebar search with a claim stack (`src/shell/titlebarSearch.ts`, `docs/design-notes/titlebar-search.md`) |
| Clusters and workspace | #150, #163, #165, #181, #195 | Environments, read-only main, persisted layout, terminals follow the cluster's project |
| Git | #157, #159, #192 | Git rail page, lane-based commit graph |
| Context for agents | #153 (spec), #170, #173, #179, #199, #200 | `.kaava/context/` store, Context strip, consent-gated Claude Code Read hook |
| Godot | #172, #177, #202, #203, #215, #219 | Detect, Open, Play, scene tree, 3D preview, markup, shared Markup settings |
| Blender | #171, #174, #198 | Detect, Open, headless `.glb` export and renders. No 3D preview or markup yet |
| Canvas | #183 to #188, #207, #211, #216, #217 | See `docs/canvas-objects.md` and section 13 of `docs/mcp-server-manager.md` |
| MCP | #197, #212, #214, #217, #218 | Settings lists every tool with its signature. `kaava://workspace/focus` resource |
| Rail pages | #164, #175, #182 | Cost (ECharts), Plane, Cloud agents and Hindsight mount their apps or show a setup note |
| Splash | #160, #169 | Assembly concept |

## Open at handoff

Agents were still working on these when this note was written. Check the tracker for their state.

- **UX-38, light theme:** the code editor, terminal and canvas stay dark in light mode. The
  same PR removes the remaining hardcoded amber colours.
- **Canvas follow-ups:** link a frame to an existing canvas, a link badge, named diagrams and
  typed frames on one element, `view_diagram` and `add_shapes` aimed at the named canvas.
- **UX-36:** an end-to-end run. A Sonnet agent designs a Minecraft clone on a new demo-game
  canvas through the UI and through Claude Code over `kaava-canvas`. A report follows.
- **Blender markup:** the Blender viewer needs the 3D preview and the markup layer. Then move
  `apps/godot-viewer/ui/src/markupFlow.ts` and `sendMarkup` into `apps/shared/`.
- **Then:** an agent sweeps the whole UI for defects. Braden reviews a fresh build. One more
  UI/UX round follows.

Deferred by Braden: Schematify work (including its search claim), CX-5 (Context strip scrolls
with the chat), CX-6 (video context), and dropping a tab onto another window to dock it there.

## How the work was run

- One worktree per PR under `helve/.worktrees/<name>`, branched from `origin/ux/rework`.
- Agents share a build directory: `CARGO_TARGET_DIR=C:/Users/bjsea/Documents/Viestra/code/helve/target-shared`.
- The review instance lives in the worktree `.worktrees/review-build`, detached at
  `origin/ux/rework`. It builds into `helve/target-ux-clusters`. To rebuild it:
  1. `pnpm ui close`
  2. Check out the new head.
  3. `pnpm install --frozen-lockfile`
  4. `pnpm ui:build`
  5. `pnpm ui launch`
  6. `node scripts/kaava-probe.mjs --agent --server agent set_project '{"path":".../demo-game"}'`
- Agent instances share one identifier with the review instance. Agents must not run
  `pnpm ui launch` or `pnpm ui close` while it is in use, or they take over its window.
- Merge procedure for each PR:
  1. Scan the diff for attribution lines, mojibake, `.skip`/`.only`, ES2022 APIs and deleted tests.
  2. Check that it does not touch the lint baselines.
  3. Comment "Reviewed — merging."
  4. Wait for the 4 green checks.
  5. Merge with `gh pr merge --merge`.

## Traps

- **Rust 1.99 in CI** (since 2026-09-28) adds clippy lints that older local toolchains miss. Run
  `cargo +1.99.0 clippy --workspace --all-targets` with
  `CARGO_TARGET_DIR=.../helve/target-clippy199`. Install the toolchain with
  `rustup toolchain install 1.99.0 --profile minimal --component clippy --no-self-update`.
- **CI's TypeScript lib is ES2021, even in tests.** `.at()`, `findLast` and `toSorted` pass
  locally and fail CI. Use `.slice(-1)[0]` instead.
- **Disk:** every debug Cargo target is about 10 GB. Per-worktree `target-*` folders filled the
  drive (666 GB in `Viestra`). Use the shared target. Delete a `target-*` folder once its agent
  has finished.
- **Port 1420 belongs to `pnpm app`.** Agents use `pnpm dev:agent` (1430 and up) and stop what
  they start.
- **`pnpm probe` mangles JSON arguments** on Windows. Call `node scripts/kaava-probe.mjs` directly.
- **Native dialogs block the webview.** Use `set_project` and `app_call` instead of the Home
  buttons.
- **Background agents** re-send their reports and get handed back while a verify runs. Ask for
  one final report. Resume them with a message.
