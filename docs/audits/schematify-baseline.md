# Schematify baseline audit

Wave 0 of the Schematify overnight job. This audit changes no file but itself.
Every path and line number below was read directly from the repository at
branch `schematify/w0-audit`, off `main` at commit `d2bf4f8`. Every later wave
should prefer this document over PRD section 14.3 where the two disagree.

## 1. The Tauri crate and its shared registration files

| What | Path | Notes |
|---|---|---|
| Tauri crate | `src-tauri/` | Cargo workspace member, package name inferred from `src-tauri/Cargo.toml` |
| Command bridge | `src-tauri/src/commands.rs` | 1,499 lines. Every `#[tauri::command]` function body |
| App entry point | `src-tauri/src/lib.rs` | 707 lines. Builds the Tauri app, registers state and commands |
| `generate_handler!` site | `src-tauri/src/lib.rs:405`–`498` | One macro call, one command per line, 90 commands today |
| Generic app dispatch command | `src-tauri/src/commands.rs:1145` (`app_call`) | Already registered in `generate_handler!` at `lib.rs:462`. Every first-party app's JSON-RPC methods route through this **one** command — see section 6 |
| App registry | `src-tauri/src/apps/mod.rs` | 32,288 bytes. `REGISTRY` constant at lines 157–238 |

## 2. The front-end workspace and current package list

| Workspace | Path | Declared in |
|---|---|---|
| pnpm workspace | repo root | `pnpm-workspace.yaml`: `packages/*`, `examples/*/ui` |
| Cargo workspace | repo root | `Cargo.toml`: `src-tauri`, `crates/*`, `examples/echo-tool` |

`packages/*` (npm packages, each has its own `package.json`, published under `@veistra/*`):

| Package | Path |
|---|---|
| `@veistra/bridge` | `packages/bridge/` |
| `@veistra/file-icons` | `packages/file-icons/` |
| `@veistra/monaco-languages` | `packages/monaco-languages/` |

`apps/*` (first-party surfaces — **not** pnpm workspace packages; no `package.json` under `apps/`, they are Vite entry points of the root build):

| App id | Path |
|---|---|
| `home` | `apps/home/ui/` |
| `files` (and `viewer`, same Rust half) | `apps/files/ui/`, `apps/viewer/ui/` |
| `design` | `apps/design/ui/` |
| `forger` | `apps/forger/ui/` |
| `tutorial` | `apps/tutorial/ui/` |
| `journeyman` | `apps/journeyman/ui/` |
| shared chrome, no app of its own | `apps/shared/app.css` |

`crates/*` (Rust libraries shared with tool repositories, already a workspace-member glob):

| Crate | Path |
|---|---|
| `veistra-tool-manifest` | `crates/veistra-tool-manifest/` |
| `veistra-rpc` | `crates/veistra-rpc/` |

## 3. The module that draws the application tab strip

There is no single "tab strip" component left. `src/shell/toolwindow/ToolWindow.tsx:315`–`330`
records that panes used to each draw their own tab strip and no longer do:
*"The strips are gone — every tab in the window is in the cluster bar now."*

The tab strip is drawn by **`src/shell/switcher/ClusterBar.tsx`**, at the `member.title`
render (`ClusterBar.tsx:896`). What it draws is not literal — it renders
`instance.title`, a runtime field.

The literal strings live one hop upstream, in **`src-tauri/src/apps/mod.rs:157`–`238`**
(the `REGISTRY` constant). Trace:

1. `REGISTRY[i].name` — e.g. `"Forger"` at `mod.rs:207`, `"Journeyman"` at `mod.rs:229` — is a `&'static str` compiled into the binary.
2. `apps::display_name(&app, &app_id)` (called from `src-tauri/src/commands.rs:208`, inside `open_instance`) reads it from `REGISTRY`.
3. `open_instance` passes it as `title` into `ShellState::open_instance` (`shell_state.rs:1047`, field at line 1140), which becomes `SurfaceInstance.title`.
4. The frontend reads that off `shell:state`, and `ClusterBar.tsx` renders it as the tab label. A frame can later override its own title via `veistra/title` (`ToolWindow.tsx:797`–`802`), but the initial, and for these two apps the only, label comes from `REGISTRY`.

**So: the strings a new app's tab shows are edited in exactly one place,
`src-tauri/src/apps/mod.rs`'s `REGISTRY` constant — `name` and `description` fields.**

## 4. Presence of veistra.toml, .veistra, veistra-tool://, @veistra/*

| Item | Present | Where |
|---|---|---|
| `veistra.toml` | Yes | Repo root. The **stack manifest** — pins other Veistra repositories and their versions, unrelated to a Schematify project. `[[tool]]` array is empty today (see section 7) |
| `.veistra` extension | Yes | `src-tauri/src/project/marker.rs`. Names a **project** manifest, `<name>.veistra`, distinct from `veistra.toml`. `TRACE_DIR` constant (`marker.rs:32`) names the sibling `.veistra/` directory Veistra writes into |
| `veistra-tool://` | Yes | `src/shell/state/toolFrontend.ts`, `src-tauri/src/apps/design.rs`, `src-tauri/src/tool_frontend.rs` — the scheme a *tool's* frontend is served from in a release build. Apps are not served this way; they load from the shell's own origin (`apps::entry_url`, `mod.rs:444`: `/apps/<id>/ui/index.html`) |
| `@veistra/*` npm scope | Yes | `packages/bridge/package.json` (`@veistra/bridge`), plus `@veistra/file-icons` and `@veistra/monaco-languages` (section 2) |

Two names exist and must not be confused: `veistra.toml` (this orchestrator's own
stack manifest, one per orchestrator checkout) and `<name>.veistra` (a project
manifest, one per project a user opens). Schematify's `.veistra/` project
directory (PRD section 6) is the second kind.

## 5. Every step `pnpm verify` runs

```
verify = build && test && lint && format:check
```

| Top-level step | Script | Expands to |
|---|---|---|
| `build` | `pnpm run build` | `build:bridge` (`pnpm --filter @veistra/bridge build`) → `generate:icons` (`node scripts/generate-file-icons.mjs`) → `generate:branding` (`node scripts/generate-branding.mjs`) → `build:file-icons` (`pnpm --filter @veistra/file-icons build`) → `build:monaco-languages` (`pnpm --filter @veistra/monaco-languages build`) → `tsc` → `vite build` |
| `test` | `pnpm run test` | `test:js` (`vitest run` **and** `pnpm --filter "./packages/**" --filter "./examples/**" --if-present test`) → `test:rust` (`cargo test --workspace`) |
| `lint` | `pnpm run lint` | `lint:version` (`node scripts/check-version.mjs`) → `lint:identity` (`node scripts/check-identity.mjs`) → `lint:branding` (`node scripts/check-branding.mjs`) → `lint:js` (`eslint .`) → `lint:rust` (`node scripts/clippy-baseline.mjs`) → `lint:comments` (`node scripts/check-comments.mjs`) |
| `format:check` | `pnpm run format:check` | `prettier --check .` **and** `cargo fmt --all -- --check` |

`verify:fast` swaps `build` for `typecheck` (`build:bridge` → `generate:branding` →
`build:file-icons` → `build:monaco-languages` → `tsc`, no `vite build`, no
`generate:icons`), keeping `test`, `lint`, `format:check` unchanged.

### The comment-density linter (`scripts/check-comments.mjs`)

Two independent caps, both must pass, checked against `comment-baseline.json`
(a ratchet — may shrink, may not grow):

- **RATIO**: a file over 40 non-blank lines (`MIN_LINES_FOR_RATIO`) fails if more than 50% (`MAX_RATIO`) of its non-blank lines are comments.
- **RUN**: any file fails if it has more than 20 (`MAX_RUN`) consecutive comment lines.

Scanned roots: `src`, `apps`, `packages`, `src-tauri/src`, `crates`, `examples`,
`scripts`. `node_modules`, `target`, `dist`, `dist-ssr`, `.git`, `public` are
skipped. Every new Schematify file under `apps/schematify/`, `crates/schematify-*`
is in scope.

## 6. How a Tauri command is registered end to end (worked example: `boot_status`)

1. **Rust function**, `#[tauri::command]`, in `src-tauri/src/commands.rs:98`–`105`:
   ```rust
   pub fn boot_status(state: State<'_, AppState>) -> boot::BootStatus { ... }
   ```
2. **Registered** in the `generate_handler!` list, `src-tauri/src/lib.rs:411`:
   `commands::boot_status,`
3. **Typed wrapper**, `src/bindings.ts:913`–`914`:
   ```ts
   export function bootStatus(): Promise<BootStatus> {
     return invoke<BootStatus>("boot_status");
   }
   ```
   `src/bindings.ts` is the backend boundary (STANDARDS.md §2): one wrapper per
   command, hand-mirrored against the Rust struct, with a `Mirrors
   \`module::Type\`` comment.

**This is the shell's own door.** An *app's* frontend does not call
`src/bindings.ts` at all — see section 8. `src/bindings.ts:341` does hold the
shell's own wrapper around the generic `app_call` command, which is what
`ToolWindow.tsx`'s `callApp` (`src/shell/state/apps.ts`) uses to relay a
frame's `invoke` into Rust.

### The generic app-dispatch path (what Schematify will actually use)

Every first-party app's calls do **not** get individual `#[tauri::command]`
entries. They go through one already-registered command:

1. App frontend calls `invoke("schematify/open-project", params)` via `@veistra/bridge` (postMessage, transport B — not a Tauri IPC call).
2. `ToolWindow.tsx:897` relays it to `callApp(frame.appId, method, params, {instanceId})`.
3. That calls the Tauri command `app_call` (`commands.rs:1145`), already in `generate_handler!` at `lib.rs:462`.
4. `app_call` spawns a blocking worker, resolves a `CallContext`, and calls `apps::call(&app, &context, &id, &method, params)` (`mod.rs:461`).
5. `apps::call` matches `id` against `REGISTRY` and forwards to that app's `Dispatch` function — e.g. `forger::call` (`mod.rs:215`).
6. That function matches on `method` — e.g. `"forger/state" => state(context)` (`forger.rs:59`).

**Conflict with PRD section 14.4/14.5 — see section 11.**

## 7. How an app reaches Rust from the frontend

Two patterns coexist today, both valid, neither enforced:

- **`apps/files/ui/src/rpc.ts`** (`apps/files/ui/src/rpc.ts:1`–`324`): every call the app makes is wrapped in one file. Method-name strings (`"files/list"`, `"files/read"`, …) appear nowhere else. Types mirror `src-tauri/src/apps/files.rs`, restated rather than imported — `apps/` may not import from `src/`.
- **`apps/home/ui/src/App.tsx`**: no `rpc.ts`. `invoke<T>("home/state")` etc. called directly from `@veistra/bridge`, inline in the component (`App.tsx:153,170,190,216`).

Both import `invoke` from `@veistra/bridge` (never from `src/bindings.ts` —
that import is reserved for the shell, see STANDARDS.md §2). Given Schematify
has 10 commands (PRD §14.5), the `rpc.ts` pattern is the closer analog and is
recommended.

## 8. Resolved placement (binding on every later wave)

The PRD's author did not know this repository (`00-AGENT-CONTEXT.md`). Per the
owner's standing override, existing convention wins over PRD section 14.3 in
every row below.

| | PRD §14.3 proposal | Resolved placement | Basis |
|---|---|---|---|
| React surface | `packages/schematify-ui` | `apps/schematify/ui/` | Matches `apps/home/ui`, `apps/files/ui`. `packages/` is reserved for npm libraries shared with external tool repos (bridge, file-icons, monaco-languages) — an app is not that (section 2) |
| Rust registration | `src-tauri/src/apps/schematify/mod.rs` (directory module) | `src-tauri/src/apps/schematify.rs` (single file), **unless** the crate's size argues otherwise — see below | Every existing app (`home.rs`, `files.rs`, `forger.rs`, `journeyman.rs`) is one file, including `design.rs` at 37,298 bytes (the largest). Only `design.rs` has a sibling non-Rust file (`design_probe.js`, embedded via `include_str!`), still not a directory module |
| Crates | `crates/schematify-core`, `crates/schematify-reconcile` | Confirmed as proposed | `Cargo.toml:17` already globs `crates/*` as workspace members; `crates/veistra-rpc/Cargo.toml` is the pattern to copy (`version.workspace = true` etc., `[lints] workspace = true`) |
| Registry entry | (unstated) | `src-tauri/src/apps/mod.rs`: add `mod schematify;` beside line 20, a `Registered { id: "schematify", name: "Schematify", ... }` row appended to `REGISTRY` (currently closes at line 238) | Sole registration point (STANDARDS.md §3) |
| Vite entry | (unstated) | `vite.config.ts`: add `schematify: resolve(__dirname, "apps/schematify/ui/index.html"),` after line 72 (`journeyman:`), before the closing `}` at line 73 | "The one piece that cannot be inferred" (STANDARDS.md §3, `vite.config.ts:49`–`52`) |
| `catalog.toml` entry | (unstated) | **No entry.** `catalog.toml` is empty and is the *tool* install library. Forger and Journeyman were removed from it when they became first-party apps (`catalog.toml:51`–`54`). Home, Files and Tutorials never appeared there and do not today — confirmed by reading the file, which lists zero apps | Direct contradiction of the task brief's assumption that Home/Files/Tutorial "appear" in `catalog.toml`; they do not |

### On the single-file-vs-directory-module question

Every existing app's Rust half is one file. The largest, `design.rs`, is 37,298
bytes and still a single file. Schematify's Rust half (10 commands across
graph load/write/lint/search/reconcile/lifecycle, PRD §14.5) is likely to
exceed that. **Recommendation, not yet forced by convention:** start as
`src-tauri/src/apps/schematify.rs` like every other app; if it is still one
file past roughly 1,500–2,000 lines, split internal concerns into private
sibling modules `included via `mod` from that file (e.g. `schematify/graph.rs`,
`schematify/lint.rs`) the way `src-tauri/src/project/` splits `mod.rs`,
`marker.rs`, `store.rs` — but keep exactly one entry in `apps::mod::REGISTRY`
regardless. This is a judgment call for whichever wave writes the first line
of that file, not a fact this audit can settle by reading.

## 9. STANDARDS.md §3 — the three edits to add an app

Quoted directly (`STANDARDS.md:161`–`164`):

> Adding an app means three edits and no more: a registry entry in
> `src-tauri/src/apps/mod.rs`, an `index.html` under `apps/<id>/ui/`, and a
> line in `vite.config.ts`. The Vite entry is the one piece that cannot be
> inferred — miss it and the app silently does not build.

Exact sites today:

1. `src-tauri/src/apps/mod.rs` — `mod schematify;` near line 20; a `Registered { .. }` entry appended inside `REGISTRY`, which spans lines 157–238.
2. `apps/schematify/ui/index.html` — new file, following `apps/files/ui/index.html`'s shape (palette `<link>`, inline `background: var(--bg)` style, `<div id="root">`, `<script type="module" src="./src/main.tsx">`).
3. `vite.config.ts` — new `schematify: resolve(__dirname, "apps/schematify/ui/index.html"),` inside the `input` object, lines 63–73.

`catalog.toml` is **not** a fourth edit — see section 8.

## 10. Design tokens today

| File | Role |
|---|---|
| `src/tokens.css` | The palette and resets. 43 CSS custom properties. Header states every value is lifted from `docs/handoffs/shell-spec.html` and none is a free choice |
| `apps/shared/app.css` | The chrome every first-party app draws inside (pane header, rows, scrollbar, error blocks). Imported by every app's `main.tsx` after `tokens.css` |
| Per-app stylesheet | e.g. `apps/files/ui/src/files.css`, `apps/forger/ui/src/forger.css` — an app that needs more than the shared sheet adds its own, imported in `main.tsx` |

PRD §13's "no literal hex colors, tokens only" rule maps directly onto this:
Schematify's CSS must consume `var(--...)` from `src/tokens.css`/`apps/shared/app.css`
and add a `apps/schematify/ui/src/schematify.css` of its own for anything
neither shared file covers, exactly as Files and Forger do.

## 11. Conflicts between the PRD and the repository

1. **§14.3 paths — resolved.** Covered fully in section 8. `packages/schematify-ui` and `src-tauri/src/apps/schematify/mod.rs` are both replaced by the existing convention (`apps/schematify/ui/` and, provisionally, `src-tauri/src/apps/schematify.rs`).

2. **§14.4/14.5 — the "1 line in `generate_handler!`" claim does not match how apps are dispatched today, and the fix is better than the PRD's plan.** §14.5 lists 10 items as "Tauri commands" (`schematify_open_project`, `schematify_load_graph`, …) each with "a typed wrapper in `bindings.ts`". But no existing app registers its own `#[tauri::command]`s at all — every one of them (`home`, `files`, `viewer`, `design`, `forger`, `journeyman`) is dispatched through the single, already-registered `app_call` command (`commands.rs:1145`, in `generate_handler!` since before this wave, `lib.rs:462`), which routes by JSON-RPC method string to the app's own `Dispatch` function (section 6). Under that convention, adding Schematify requires **zero** new `generate_handler!` lines and **zero** new entries in `src/bindings.ts` — the 10 operations become match arms on a method string inside `schematify.rs`'s own dispatch function (e.g. `"schematify/open-project"`, `"schematify/load-graph"`, mirroring `forger/state`), and the typed wrapper for each lives in `apps/schematify/ui/src/rpc.ts` (section 7), not `src/bindings.ts`. This is *stronger* than §14.4's own goal — §14.4 wants to minimize collisions on shared files by capping Schematify at 1 line; the existing convention caps it at 0. **Resolution: follow the existing `app_call`/`REGISTRY` pattern. `src/bindings.ts` and `generate_handler!` are not touched by any Schematify wave.** This changes what "shared registration files" means for Schematify: only `src-tauri/src/apps/mod.rs` (one `mod` line plus one `REGISTRY` entry) and `vite.config.ts` (one `input` line) are shared files Schematify must touch, and per §14.4 a wave touching either "shall merge alone."

3. **§14.2's own catalog.toml assumption is not in the PRD text, but the orchestrator's brief describing this audit's job asked to "check how home, files, tutorial appear there" — they do not appear there at all.** See section 8's `catalog.toml` row. No conflict with the PRD itself (which never mentions `catalog.toml`), but worth recording so Wave 1+ does not add a spurious entry.

No other conflict was found. Every other §14 claim (crate placement, boundary
enforcement tools, performance budget structure) matches what exists or names
something that does not exist yet and is not contradicted by anything in the
repository.

## 12. Every occurrence of Forger, Journeyman, forger://, journeyman://, @forger:

Case-sensitive `forger://`, `journeyman://` and `@forger:` do not appear
anywhere in product code or documentation — every hit for those three exact
strings is inside the planning material at `docs/overnight-jobs/overnight-2/`
(the PRD, `FORGER-SPEC.md`, and the wireframe export), which is source
material this audit read rather than product code to rename.

`Forger` and `Journeyman` (and their lowercase forms, used in method names,
ids and test fixtures) are pervasive. Full count, **excluding**
`docs/overnight-jobs/` (planning source, not product code):

| Term | Case-sensitive lines | + lowercase-only lines | Files touched |
|---|---|---|---|
| Forger / forger | 85 | 55 | 30 |
| Journeyman / journeyman | 51 | 19 | 15 |

Files (deduplicated, both terms, any case), by area:

**App surfaces to delete outright** (Wave 1's literal scope):
- `apps/forger/ui/index.html`, `App.tsx`, `forger.css`, `main.tsx`, `rpc.ts`
- `apps/journeyman/ui/index.html`, `App.tsx`, `journeyman.css`, `main.tsx`, `rpc.ts`
- `src-tauri/src/apps/forger.rs`, `src-tauri/src/apps/journeyman.rs`

**Registration to remove:**
- `src-tauri/src/apps/mod.rs` — lines 18, 20 (`mod` declarations), 206–215 (Forger `Registered` row), 228–236 (Journeyman `Registered` row), plus test fixtures at 408, 651, 658, 672, 675, 679 using `"forger.specs"` as a generic example id (these test an unrelated general mechanism — `compose_openables`/`is_app` — and only *incidentally* use the string `forger`; they need a replacement example id, not deletion of the test)
- `vite.config.ts:71`–`72` — the two `input` entries
- `catalog.toml:51`–`54` — historical comment, safe to reword or drop

**Test/example fixtures using "forger" as a generic placeholder id** (not the app — these exercise MCP routing, plugin installs, and address parsing in general; each needs a replacement placeholder, e.g. `"acme"` or `"widget"`, so the underlying mechanism keeps a test):
- `src-tauri/src/mcp/config.rs:181,186,282,285`
- `src-tauri/src/mcp/registry.rs:111,587,615,616`
- `src-tauri/src/mcp/store.rs:105,107`
- `src-tauri/src/plugins/broker.rs:331`
- `src-tauri/src/plugins/install.rs:407,408,414,415,425`
- `src-tauri/src/plugins/mod.rs:544,549`
- `src-tauri/src/plugins/remote.rs:412,414,421,424–430,468,486`
- `src-tauri/src/plugins/store.rs:175,177,195`
- `crates/veistra-tool-manifest/src/lib.rs:939,941,961,968`

**Prose referencing Forger/Journeyman as a fact about the product** (needs
rewriting, not just string deletion, once both are real Schematify surfaces):
- `README.md:77,218,292,316–317,337–338`
- `CONTRIBUTING.md:269`
- `TODO.md:113,131,179,196,198,200,214,219,221`
- `.github/release-preamble.md:18`
- `apps/README.md:40–41,188,197–199`
- `apps/tutorial/ui/src/content/mcpServers.ts:50`
- `apps/tutorial/ui/src/content/theStack.ts:11,38,70,88`
- `apps/tutorial/ui/src/mocks/stackList.tsx:18`
- `docs/branding.md:17`
- `docs/design-notes/app-library.md:21`
- `docs/dev/app-releases.md:8,40,42`
- `docs/mcp-server-manager.md:28,53,61,62,69,79,88,92,199,306`
- `docs/user/README.md:15,20`
- `docs/user/tutorials/mcp-servers.md:42`
- `docs/user/tutorials/the-stack.md:30,61,82`
- `docs/user/tutorials/the-window.md:52`
- `packages/bridge/README.md:22` (an example `invoke` call using `"forger/list-specs"`)
- `veistra.toml:29` (comment)
- `src-tauri/src/discovery.rs:41,197` (comments)
- `src-tauri/src/mcp/servers/mod.rs:14` (comment)
- `src-tauri/src/plugins/catalog.rs:105,106` (comment)
- `src-tauri/src/tool_frontend.rs:51` (comment)
- `src/shell/keys/useKeyboard.ts:23`, `src/shell/toolwindow/BootOverlay.tsx:15`, `src/shell/toolwindow/toolwindow.css:5,110` (comments referencing a "Starting Forger" design-handoff screenshot crop — the crop reference itself does not need to change, only the words)

**File and directory names containing `forger`/`journeyman`:**
- `apps/forger/` (directory), `apps/forger/ui/src/forger.css`
- `apps/journeyman/` (directory), `apps/journeyman/ui/src/journeyman.css`
- `src-tauri/src/apps/forger.rs`, `src-tauri/src/apps/journeyman.rs`

**Planning-source occurrences, not product code** (counted, not enumerated
line-by-line — these are the PRD's own inputs and stay as-is):

| File | Lines |
|---|---|
| `docs/overnight-jobs/overnight-2/00-AGENT-CONTEXT.md` | 4 |
| `docs/overnight-jobs/overnight-2/Forger Wireframes.html` | 9 occurrences across 394 lines |
| `docs/overnight-jobs/overnight-2/FORGER-SPEC.md` | 18 |
| `docs/overnight-jobs/overnight-2/FORGER-UI.md` | 6 |
| `docs/overnight-jobs/overnight-2/OpenKaava-naming-decision.md` | 1 |
| `docs/overnight-jobs/overnight-2/SCHEMATIFY-PRD.md` | 28 |

## 13. Reference machine

| | |
|---|---|
| Processor | Intel(R) Core(TM) Ultra 9 275HX, 24 cores / 24 logical processors, 2700 MHz base reported by WMI |
| Memory | 33,777,467,392 bytes (31.46 GiB) |
| Operating system | Microsoft Windows 11 Home, version 10.0.26200, build 26200, 64-bit |

Captured via PowerShell `Get-CimInstance Win32_Processor`, `Win32_ComputerSystem`,
and `Win32_OperatingSystem` on this worktree's host, 2026-09-02.

## 14. Assumptions this audit made

- "Existing conventions win" (00-AGENT-CONTEXT.md) was read to license overriding PRD §14.3's two paths and to resolve the §14.4/§14.5 command-registration mismatch (section 11, item 2) the same way, since both are instances of the same fact: this repo already has a cheaper, established mechanism for what the PRD assumed needed inventing.
- "Complete" for the Forger/Journeyman table (section 12) was read as file-and-line for every hit outside `docs/overnight-jobs/`, with that directory's hits counted per file rather than enumerated, since it is the PRD's own source material and Wave 1 has no reason to edit it.
- The single-file-vs-directory recommendation for `schematify.rs` (section 8) is a recommendation, not a resolved fact — no existing app is large enough to have tested the boundary, so this audit says what the pattern implies rather than asserting a rule the repository does not yet contain.
