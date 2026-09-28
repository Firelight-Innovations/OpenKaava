# Design Mode

> **Disabled, 2026-09-27.** Design Mode exists to point an agent at elements of
> a *web* UI. OpenKaava now targets game development through OpenKaava Cloud
> (`kaava-cloud.md`), so web UIs are out of scope. The code stays in the tree,
> compiled out by default:
>
> - `cargo build --features design-mode` restores the app, the comment store
>   (`design_comments`) and the `kaava-design` MCP server.
> - `KAAVA_DESIGN_MODE=1` restores the `apps/design/` Vite entry.
>
> Turn on both, or neither. Do not confuse this app with the **design canvas**
> (PRD P7), which is a different feature.

Long-form rationale moved out of the source files under `apps/design/` and
`src-tauri/src/apps/design*`. See `docs/design-notes/README.md` for why these
pages exist and what is guaranteed about them.

Design Mode hosts a page the shell did not write, lets somebody click an element
in it, and hands that element's markup, computed styles and a cropped screenshot
to a coding agent. It is the first surface in OpenKaava to embed arbitrary external
content, so most of what follows is about the two questions that raises: what
may be loaded, and how anything gets *into* a frame the shell cannot script.

The feature is adapted from Design Mode in
[`stablyai/orca`](https://github.com/stablyai/orca) (MIT, © Stably AI). The
element-selection and extraction approach is theirs; the embedding and injection
are not, and could not be — Orca is Electron and reaches its guest through
`BrowserView` and `webContents.executeJavaScript`, neither of which has an
equivalent here. `THIRD-PARTY-NOTICES.md` records the attribution.

## `src-tauri/src/apps/design.rs`

### What the three methods are for

The app hosts an iframe pointed at a URL somebody types — their own dev server,
usually — and clicking an element in it hands the element's markup, its computed
styles and a cropped screenshot to a coding agent. That is new ground for this
shell. Every other frame it mounts is either its own build (`apps::entry_url`)
or a tool it resolved from a manifest; this is the first that is neither, and
the three methods there are the three things that required Rust rather than a
component.

**`design/target` decides what may be loaded at all**, and it is a security
boundary rather than a convenience. See `normalize` and the `.localhost` rule in
it — a page reaching OpenKaava's own commands is one bad hostname away without that
check, and the reason is a detail of Tauri's origin test rather than anything
visible from here.

**`design/arm` installs the probe** through `devtools::install_script`, because
same-origin policy means no code in the shell can reach into a frame showing
somebody else's origin. `design_probe.js` is what gets installed and its own
header covers what happens next.

**`design/capture` crops a screenshot** out of the window with the DevTools
Protocol, from coordinates the app resolved. It holds no opinion about which
element those coordinates belong to.

The module holds **no state**, like `files::call` and for the same reason: a
second Design Mode in a second cluster is a second frame with its own probe, and
anything remembered there would be shared between them by accident. The script
id from `design/arm` is handed to the caller and passed back to
`design/disarm`.

### The rules in `normalize`, and why each one is there

**A scheme is added when one is missing**, because nobody types `http://`.
`localhost:5173` parses as a URL with scheme `localhost` otherwise, which is a
refusal for a thing the person got right.

**Only http and https are allowed.** `file:` reads the disk, `data:` and
`javascript:` inherit the embedding document's origin — which here is an app
frame, same-origin with the shell — and a custom scheme is somebody else's
protocol handler.

**A host under `.localhost` is refused.** Tauri decides whether an IPC message
may reach a command by asking whether its origin is the app's own, and on
Windows that test takes the first label of a `*.localhost` host and looks it up
among the registered custom protocols (`tauri::webview`'s `is_local_url`). The
port is not part of the test. So a page served from
`http://kaava-tool.localhost:5173` answers that question *yes* and is treated as
local — with the full command surface behind it. Refusing the whole suffix is
broader than the hole and much easier to keep true than a list of registered
scheme names that grows.

**The shell's own origin is refused too.** In a release build the `.localhost`
rule has already covered it, since the shell is served from `tauri.localhost`;
in development it is `localhost:1420` and nothing above would stop it. It
matters because the frame carries `sandbox="… allow-same-origin"`, which a page
genuinely same-origin with its embedder can use to take its own sandbox off.
`None` means the origin could not be read, and the rule is skipped rather than
guessed at — the other rules still apply.

### What a hostile page in that frame can and cannot do

This is the part worth a careful read before merge, because the answer rests on
one property of Tauri's that nothing in this repository enforces.

**wry gives every frame `window.ipc.postMessage`.** It installs that with
WebView2's `AddScriptToExecuteOnDocumentCreated`, and its own documentation
notes that *on Windows, scripts are always added to subframes regardless of the
`for_main_frame_only` option* (`wry/src/lib.rs`). Tauri asks for main-frame-only
for its IPC bootstrap and does not get it. So the assumption that an embedded
page has no route to the IPC channel is **false**, and no code here can make it
true.

**Tauri's ACL is what stops it.** `Webview::on_message`
(`tauri/src/webview/mod.rs`) classifies each message's origin with
`is_local_url` and, for anything that is not local, requires a resolved ACL
entry before the command runs — the comment there says so directly: *"or when
the request comes from a non-local (remote) origin. This ensures remote content
can never reach custom commands unless an explicit `remote` capability has been
configured for them."* A capability grants remote access only by carrying a
`remote: { urls: [...] }` block.

**So the whole defence is that no capability in `src-tauri/capabilities/`
declares `remote`.** That is true today and this feature does not change it.
`capabilities_grant_no_remote_access` in `design.rs` is a test that reads the
capability files and fails if one ever does, so the property is checked rather
than remembered.

`normalize`'s `.localhost` and own-origin rules are the other half: they close
the two ways a page could be classified *local* despite not being ours.

### Why the screenshot comes from the focused window

`design/capture` photographs the focused window, not a named one. `app_call`
carries the cluster a call came from, but nothing maps a cluster to an operating
system window, and inventing that mapping is a change to the shell's own model
rather than to this app. The frontend closes the gap from its side instead: it
refuses to ask while `document.hasFocus()` is false, so the window being
photographed is the window the click happened in. A second OpenKaava window holding
a second Design Mode while this one has focus is the case that would otherwise
be answered with a picture of the wrong screen.

## `src-tauri/src/devtools.rs`

### Why `install_script` is not a DevTools Protocol call

`install_script` reaches into child frames, including cross-origin ones, which
is the entire reason it exists: same-origin policy means no amount of JavaScript
in the shell can put a listener inside an iframe pointed at somebody else's dev
server, and Design Mode's whole feature is a click inside one of those.

The DevTools Protocol has a near-namesake,
`Page.addScriptToEvaluateOnNewDocument`, which `devtools::call` could reach with
no new plumbing at all. It was tried and rejected: a CDP method is scoped to one
*target*, and Chromium puts a cross-**site** iframe in a target of its own. In a
release build the shell is served from `tauri.localhost` and a user's dev server
is not, so exactly the frame this needs to reach is the one that method cannot.
WebView2 applies `AddScriptToExecuteOnDocumentCreated` at the webview, above the
target split, and the proof it does is in the tree already: wry defines
`window.ipc` with it, and its own documentation notes that on Windows the
`for_main_frame_only` flag is ignored.

`remove_script` undoes one install. Documents already loaded keep the script they
were given — it stops the next one getting it, and nothing more, which is why
Design Mode reloads the frame it is finished with rather than trusting that call
to clean a live page.

## `src-tauri/src/apps/design_probe.js`

Three things about where the probe runs decide everything in it.

It runs in **every** frame the webview loads, the shell's own included, and
before any of that frame's code. So it must cost nothing until spoken to: one
listener, one shape check, no DOM.

It runs in a document that may be **hostile**. Nothing in it trusts the page —
but nothing in it can be hidden from the page either, so it is not a sandbox and
must not be read as one. What keeps a page from turning the probe on itself is
that arming is only accepted from the frame's own parent, and that the top frame
never arms at all.

It runs **cross-origin**, which is why every reply goes to `"*"`. A child cannot
read its parent's origin, so it cannot name one. The reply is the page's own DOM
going to the frame that deliberately embedded the page, which is the one party
already able to see it.

### The token that is not there

An earlier draft gave each install a random token, generated in Rust, that the
app had to present before a probe would arm. It was removed, and the reason is
worth keeping: the app can only deliver that token by posting it *into the page*,
so the one party it would have to be kept from is the party that receives it.

`event.source === window.parent` does the job the token was supposed to do and
cannot be leaked. A page can post to `window.top` and to any frame it can name
through `parent.frames[…]`, but it cannot make itself be some other frame's
parent. Combined with the top frame refusing to arm at all, that closes both
directions: an embedded page cannot arm the shell's own document, and it cannot
arm a sibling app's frame either.

## `apps/design/ui/src/probe.ts`

The two halves of the probe conversation cannot import each other. The probe is
`src-tauri/src/apps/design_probe.js`, compiled into the binary and injected by
WebView2 into a document on somebody else's origin; `probe.ts` is TypeScript in
the shell's own build. Nothing links them but `window.postMessage` and the
declared shapes, so the shapes are restated for the same reason
`apps/files/ui/src/rpc.ts` restates its backend's — a drift is caught by reading
two files, and there is no third place claiming to be authoritative.

Everything arriving is **untrusted**. It comes from a frame this shell did not
write, running a page it did not choose, and a page can post whatever it likes
to its parent. So the module's real job is not decoding, it is refusing:
`readProbeMessage` returns `null` for anything it cannot fully account for, and
the app treats `null` as silence.

What it deliberately does **not** do is decide whether the sender is allowed to
be heard. That is `event.source === iframe.contentWindow`, checked at the
listener against the shell's own reference to the frame it mounted — the same
rule `ToolWindow.tsx` uses, and the only one a message body cannot forge.

## `apps/design/ui/src/handoff.ts`

**The clipboard, deliberately, and for now.** The thing this feature wants is to
put the text straight into whichever terminal an agent is running in, and the
shell has no verb for that yet — inserting into a pty is `pty.rs` and
`src/shell/terminal/`, which is another branch's work. A clipboard write needs no
Tauri capability, no new command and no protocol change, and `Ctrl+V` is one
keystroke away from where the text is wanted. When "insert into the active
terminal" exists, `handoff.ts` is the one place that changes.

`navigator.clipboard` rather than a Tauri plugin for the same reason: the
clipboard-manager plugin would be a new dependency and a new grant in
`capabilities/`, handed to every frame in the window, in order to do what the
platform already does from a click handler.

One `ClipboardItem` holds both flavours rather than two writes, because a
clipboard holds one thing at a time and the second write would erase the first.
A paste target then takes whichever flavour it understands — a terminal takes the
text, a chat window that accepts images takes both. The image half is
best-effort by design: writing an image needs a secure context and permission
that a text write does not, so a refusal there falls back to text rather than
failing the handoff, and what is reported back says which happened.

### What replaced it

`design_comments` and `mcp::servers::design` did, and the argument above is now
about a *fallback*. The clipboard still works, still costs one button, and is
still what a chat client wants; what it cannot do is reach an agent in a
terminal, which was always the case this feature was for. `docs/design-notes/
design-comments.md` is the record of the replacement.

The paragraph about inserting into the active terminal is still true and is now
much less interesting. An MCP tool call reaches an agent whether or not it is in
a terminal OpenKaava spawned, so the verb that would have been needed is one this
no longer waits on.
