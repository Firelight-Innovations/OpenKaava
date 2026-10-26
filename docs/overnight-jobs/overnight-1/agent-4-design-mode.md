# Agent 4 — Design Mode

Read `00-PRIMARY-CONTEXT.md` in full before this. It has the license,
ground rules, and stack-mismatch guidance that apply to you too.

This is the hardest of the four tonight. Veistra has never hosted a webview of
arbitrary external content inside its own window before — this is new
architectural ground, not a port of an existing Veistra pattern. Treat it as a
stretch goal: land the largest *real, working* slice you can, in the
priority order below, and stop and document honestly rather than forcing a
later step to "look" done.

## Setup

```bash
cd Veistra
git worktree add ../Veistra-design-mode -b feat/design-mode origin/main
cd ../Veistra-design-mode
```

Then read, in order: `CONTRIBUTING.md`, `STANDARDS.md`,
`docs/dev/architecture.md` (especially "Apps" and "Tools" — the
apps-vs-tools distinction matters for where this code lives), `apps/README.md`,
`examples/echo-tool` (the shape of a self-contained app, even though this
won't be a full protocol-speaking tool), `capabilities/` (Tauri's permission
system — you'll need to reason about this directly).

## The feature

Orca's "Design Mode": click any UI element in an embedded Chromium window,
send its HTML, CSS, and a cropped screenshot straight into the agent's
prompt.

In `/tmp/orca-reference`, find the browser/CDP module (Orca's changelog
references browser-specific work — cookie handling, tab pairing, navigation
— search `src/` for `browser`, `design-mode`, `cdp`). Two things matter here:

- **The element-selection and capture logic** — how a click on a live page
  resolves to an element, how outerHTML/computed styles get extracted, how
  the crop is taken — is largely standard DOM/CDP concepts, not
  Electron-specific. This is your best reference material.
- **Everything about how Orca embeds and drives the browser itself** is
  Electron's `BrowserView`/CDP session management, and does not translate
  directly. Tauri's webview (WebView2 on Windows) does expose a CDP
  endpoint, but you reach it through Tauri/webview2's own APIs. Research
  this specifically — don't assume it works like Electron's until you've
  confirmed how Tauri actually exposes it.

## Scope, in priority order — stop when you run out of night

1. A new first-party app, following the `apps/` pattern (Vite entry under
   `apps/<name>/ui/`, Rust module under `src-tauri/src/apps/`), that hosts a
   webview pointed at a user-entered URL (e.g. a local dev server). This is
   genuinely new surface. Spend real time on whether Tauri's capability
   system safely allows an arbitrary-URL webview, and **write down what you
   conclude even if the answer is "not safely, without a capability change
   I'm not making tonight."**
2. Clicking an element in that webview captures its outerHTML and computed
   styles.
3. Clicking an element also captures a cropped screenshot of it.
4. A way to get the captured HTML/CSS/screenshot to an agent. Check whether
   `feat/drag-files-to-agent` has landed anything reusable for "insert text
   into a terminal" by the time you get here (`git log origin/main` or ask
   — but don't block on it; a clipboard-copy is a completely acceptable
   fallback and matches this feature's own scope tonight).

If real element-click capture inside Tauri's webview sandbox isn't working
cleanly by the time you need to stop, do not fake it or hard-code a demo
case. Land whichever earlier step is solid and say exactly where you
stopped.

## Out of scope

- `src-tauri/src/apps/home.rs`, `files.rs`, `trash.rs`, `tutorial.rs`.
- `pty.rs`, `src/shell/terminal/`, `src/shell/drag/`, `src/shell/diff/`,
  `src/shell/worktree/`, GitHub code — other agents own those tonight.
- Any Tauri capability widening beyond what this feature strictly needs.
  If you do widen one, say exactly which and why in your PR description —
  this is the one thing tonight that most needs a careful human read
  before merge.

## Conventions

- New Tauri commands: `src-tauri/src/commands.rs`, registered in
  `generate_handler!` in `lib.rs`, typed wrapper in `src/bindings.ts`.
- `pnpm verify` clean before opening the PR.

## Done means

- Whatever real slice you got working, on `feat/design-mode`, `pnpm verify`
  green, PR opened against `main` (not merged).
- An honest PR description: what actually works end to end, what you
  attempted and backed out of, what capability/security question you hit
  and didn't resolve, which Orca file(s) you drew from (for attribution),
  and your own read on whether this is realistically 0.2.0-ready or should
  be cut to 0.2.1. "I got partway and here's exactly where I stopped and
  why" is a fully acceptable PR tonight — do not stretch the scope to avoid
  saying that.
