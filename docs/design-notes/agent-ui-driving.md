# Agent UI driving

How an agent sees and clicks OpenKaava's actual interface, and why the obvious
approaches did not work.

The answer is an MCP server OpenKaava hosts, `kaava-ui`, whose tools are
`screenshot`, `snapshot`, `click`, `type_text`, `press_key` and `eval`. It lives
in `src-tauri/src/mcp/servers/ui.rs`; the protocol layer under it is
`src-tauri/src/devtools.rs`.

## Why not a browser

The first attempt served the frontend to Chrome. That gives a DOM, and nothing
else: every `invoke` fails, so there is no stack, no apps, no terminals and no
project — the shell mounts over an empty backend. What it shows is a layout, not
the software. The `?fake=1` fixture that once answered those calls was 3930 lines
of second backend and was deleted for being one.

This drives the WebView2 that OpenKaava already runs, so what is on screen is the
real shell over the real Rust. Nothing is simulated and nothing is served twice.

## Why the DevTools Protocol, and why through COM

WebView2 is Chromium, and it speaks the same protocol Chrome exposes over
`--remote-debugging-port`. The interesting part is that it does not need the
port: `ICoreWebView2::CallDevToolsProtocolMethod` takes a method name and a JSON
string, which is the whole protocol, and Tauri already holds the
`ICoreWebView2Controller` that reaches it.

That is what makes this a server rather than a script. Nothing is launched
differently, no socket is opened, and there is no second process to point at
anything. The tools work against an OpenKaava somebody is already using, which the
port approach could not do — the flag is read when the WebView2 environment is
created, so it cannot be turned on for a webview that already exists.

`Page.captureScreenshot` gives the picture, `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent` give real input, and `Runtime.evaluate` runs the DOM
walking. One transport for all six tools.

### What the earlier version did, and why it is gone

`scripts/kaava-ui.mjs` used to set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` at
launch and talk to the resulting debug port over a WebSocket. It worked, and it
had three costs the COM route does not:

- **A port.** `withGlobalTauri` is on and `csp` is null, so anything holding that
  port could call every `#[tauri::command]` through `window.__TAURI__.core.invoke`
  — a standing hole for as long as the process lived, guarded only by the promise
  never to launch a real build with the variable set.
- **A separate process.** It could only drive an instance it had started itself.
- **A second implementation.** Snapshot, click and type existed once in
  JavaScript out there and would now exist again in Rust in here.

Two alternatives were rejected before that one, and both remain rejected.
`additionalBrowserArgs` in `tauri.conf.json` is compile-time, and per Tauri's own
docs it *replaces* wry's default `--disable-features=msWebOOUI,msPdfOOUI,
msSmartScreenProtection` rather than appending to it; two open Tauri issues also
report it causing blank windows. The HKLM registry policy works but applies to
every future launch of the named executable, which is a standing debug channel on
somebody's daily driver.

## Why it is developer-only

Every other server OpenKaava hosts is a read, deliberately: the endpoint is reachable
by anything on the machine holding the token, so a leaked token should cost
knowledge of a window layout and not control of it. This one clicks, and `eval`
reaches the whole backend through `window.__TAURI__`.

So `SERVER.dev_only` is true, which means the server is absent — not disabled —
until `developer.mode` is switched on: no row in settings, no key in `.mcp.json`,
no tools listed, and a `tools/call` that says there is no such server.
`docs/mcp-server-manager.md` §11 has the mechanism and the three properties that
matter more than the flag itself.

The gate is checked on every request rather than cached, so switching developer
mode off takes the server away from an already-connected client on its next call.
That is verified by hand as well as by test: with a session open, the toggle in
settings turned `snapshot` into "no MCP server with id `ui`" while the debug
server beside it went on answering.

## What the protocol turned out to give

Verified against a running build rather than assumed:

- **Screenshots** of the composited window, including app iframe content.
- **DOM across frames.** Apps mount as iframes on `tauri.localhost`, which is the
  same origin as the shell, so `contentDocument` reads straight through. An agent
  sees app content, not just the shell around it. This was the open question; it
  could easily have gone the other way. A live `snapshot` returns rows marked
  `app` for the File Explorer's own buttons and tree.
- **Real input.** `Input.dispatchMouseEvent` at an element's centre, rather than
  a synthetic `el.click()`. OpenKaava's menus and drag handles listen for pointer
  events and for focus moving, and a dispatched DOM click skips both.
- **The whole backend, incidentally.** `Runtime.evaluate` can call
  `window.__TAURI__.core.invoke(...)`, which is why `eval` is described to the
  model as doing considerably more than click, and why the section above exists.

## Refs, and not stamping the DOM

`snapshot` numbers elements `e0`, `e1`, … and keeps them in an array on `window`
rather than writing `data-` attributes onto the app's own elements. A tool that
marks up the DOM changes the thing it is meant to be observing, and a stray
attribute surviving into a screenshot or a CSS selector sends someone chasing a
bug that belongs to the tooling.

Refs are renumbered by every `snapshot`, so a stale ref from two snapshots ago
points somewhere arbitrary. Every answer says so, and `click` also accepts a
plain CSS selector for cases where that matters.

## The agent's own instance

`scripts/kaava-ui.mjs` is what remains of the old driver, and it does one thing
the server cannot do for itself: start an instance that is not the user's.

`pnpm ui:build` compiles the binary under the identifier
`com.firelightinnovations.openkaava.agent`. `tauri-plugin-single-instance` builds its
mutex name as `{identifier}-sim`, so a second launch under the same identifier
relays its argv to the first process and exits — and, worse, the surviving
process is the user's, so anything that then "cleans up its own instance" kills
their window. Every store also resolves its path through `app_config_dir()`,
which derives from the same field, so that one override buys both a second
process and a private `%APPDATA%` tree.

`pnpm ui launch` writes `developer.mode` and the UI server's switch into that
private tree before starting the process. The chicken and egg is that the server
is what an agent would otherwise use to click those switches. Both files are ones
OpenKaava writes itself, and both are merged rather than replaced.

`pnpm ui close` kills by pid, read from the endpoint file that instance wrote.
The earlier `taskkill /IM openkaava-orchestrator.exe` would have closed an OpenKaava
somebody was using, since both run from a binary of that name.

## Relationship to the MCP debug server

`kaava-debug` and `kaava-ui` answer different questions. The debug server reads
Rust-side truth — the state the backend holds and the failures it recorded — and
is developer-only like the UI server (it was on by default in every build until
`echo` and `debug` were moved behind developer mode; it is still compiled into
release, so turning developer mode on is enough to diagnose a shipped build). The UI server sees pixels
and the DOM, and can act on them.

The debug server's ring buffer also keeps failures from *before* a tool connected,
which the DevTools Protocol cannot: `Runtime.consoleAPICalled` only delivers what
happens while a client is attached. That is why the old `pnpm ui console` has no
replacement here — `recent_errors` is the thing that remembers, and
`src/shell/diagnostics.ts` already forwards the webview's failures into it.
