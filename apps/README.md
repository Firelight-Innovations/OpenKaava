# Apps

The surfaces the orchestrator ships itself.

An app and a tool look identical in the shell — a tab in the switcher bar, an
iframe in the tool window, `@openkaava/bridge` in the frontend. The difference is
where the two halves come from, and it decides everything else:

| | Tool | App |
|---|---|---|
| Lives in | its own repository, cloned beside this one | `apps/` in this repo |
| Frontend built by | its own Vite project | this repo's `vite.config.ts` |
| Frontend served from | its dev server, or `kaava-tool://` | the shell's own origin |
| Rust half | a child process, over the standard streams | a module in `src-tauri/src/apps/` |
| Can be | missing, unbuilt, the wrong version | none of those — it is in the binary |

So a tool is code the orchestrator *finds*, and an app is code the orchestrator
*is*. Home and Files are apps because what they show is what the orchestrator
already owns: the stack it resolved at boot, the checkout it was pointed at, the
project it will one day open. Putting a process boundary between the shell and a
program that would only ask the shell for all of that again is shipping an IPC
hop in order to talk to ourselves.

`docs/tool-protocol.md` is still the contract for the half that matters to the
frontend. An app's UI calls `invoke("files/list")` through the bridge exactly as
the echo tool's UI calls `invoke("echo")`, and neither knows which kind of host
answered — which is what would let an app be extracted into a tool repo later, or
a tool be absorbed, without its interface code changing.

## Layout

```
apps/
  shared/app.css          the chrome every app draws inside
  home/ui/                Home's frontend
  files/ui/               File Explorer's frontend
  viewer/ui/              File Viewer's frontend
  tutorial/ui/            Tutorials' frontend
  agents/ui/              Agents' frontend: OpenKaava Cloud's agent machines and sessions
  costs/ui/               Cost Tracker's frontend: this month's Google Cloud spend and forecast
  projects/ui/            Projects' frontend: the project switcher and its embedded Plane workspace
  design/ui/              Design Mode's frontend
  schematify/ui/          Schematify's frontend
```

Each app's Rust half lives in `src-tauri/src/apps/<id>.rs`, and
`src-tauri/src/apps/mod.rs` is the registry that names it, describes it for the
switcher, and routes `invoke` to it. Adding an app means one entry there and one
`index.html` here — plus a line in `vite.config.ts`, which is the one piece that
cannot be inferred (Vite has to be told about every HTML entry point, or it
silently builds none of it).

There is no `package.json` under `apps/`. These are entry points of the
orchestrator's own frontend build, not workspace packages: `apps/home/ui/
index.html` is built to `dist/apps/home/ui/index.html` and served from there, so
one URL works under the Vite dev server and under Tauri's asset host alike.

## Running them

Nothing extra. `pnpm app` serves the apps from the same Vite server it serves the
shell from, and `pnpm dev:agent` does the same in a plain browser.

An app mounted in a browser draws itself and completes the `hello`/`ready`
handshake, because both of those are the shell's own work. What it cannot do is
reach Rust: there is no backend under a plain browser, so every `invoke` fails
and the app renders its failure path. A fixture answering those calls used to
live in `src/shell/state/fakeBackend.ts` and has been removed.

## Reporting in at startup

Every app owes the shell one thing beyond drawing itself: a call to
`reportPainted()` from `@openkaava/bridge` once its first meaningful content is
committed to the DOM.

The orchestrator's splash window stays up until every app in the registry has
sent one (`src-tauri/src/boot.rs`), which is what makes the first frame after
the splash the app itself rather than a boot overlay that resolves into it a
beat later. The apps are already loading the whole time — the main window is
created hidden and its iframes mount as soon as the app list arrives — so this
costs nothing except the discipline of reporting at the right moment.

The right moment is the *content*, not the call that fetched it: Home reports
when `home/state` has landed and been rendered, Files when the tree has rows.
An error state counts, and reporting it is not a failure — a screen saying it
could not read anything is finished, and holding the window back for one that
is never going to improve only makes the bad news slower to arrive.

An app that never reports is waited on for four seconds, logged, and left
behind. So forgetting the call costs a slow start, not a hang — but it does cost
a slow start, which is why it is in this list rather than in a comment.

## Apps talking to each other

An app's calls go *down* to its Rust half, and for a long time that was the only
direction there was. Two of them now need to reach each other instead: clicking
a file in File Explorer has to put it on screen in File Viewer, which is a
different app, in a different iframe, that the Explorer cannot see and must not
be able to address.

`kaava/open` and `kaava/publish` are that, and they are host business — the
shell routes them, exactly as it answers `kaava/painted` and `kaava/commands`,
and it does so without understanding either. An `appId` is matched against the
layout; a `topic` is a `Map` key. No payload is inspected and no intent is
enumerated, so two apps can agree on a new thing to say to each other without a
line changing in `src/shell/`. `docs/tool-protocol.md` §3 is the contract.

The rule that makes it safe is the one every message on this transport already
follows: the shell resolves *which frame is asking* from `event.source` against
its own map of mounted iframes, never from anything in the message. An app can
therefore only ever reach its own cluster, and can only name a **kind** of app
rather than a particular surface — which surface answers is a fact about the
layout that only the shell can see.

## The six apps

**Home** (`home/state`, plus the project verbs) — where a session starts: New,
Open and Clone on the left over a Recent list, tutorials on the right. It is the
one app the shell opens on, which is stated in `ShellState::default` rather than
left to whichever tab seeded first.

Clone is deliberately inert — cloning is a git operation with progress, auth and
partial-checkout failure, and this repo has git work in flight on its own branch
that the real one is built on rather than beside; the method exists and refuses,
and the button says "soon".

The tutorials column used to be dead too, and is not any more. `home/tutorials`
answers with the first few unfinished tutorials from `apps/tutorial.rs`'s
catalog, and a card calls `kaava/open` on the Tutorials app naming one. Home
holds no list of its own, which is the point: a second copy would be a second
place to add a tutorial.

The rules about what a project *is* are not here. They live in
`src-tauri/src/project/`, which takes paths and never opens a dialog — see the
README at the repo root.

**File Explorer** (`files/list`, `files/root`) — the project's folders and what
is in them, plus everything that changes the shape of it: create, rename,
duplicate, delete, trash. It does not show a file's contents. Clicking a row
asks the shell for a File Viewer in the same cluster (`kaava/open`) rather than
drawing the file itself.

**Agents** (`agents/overview`, `agents/transcript`, `agents/start`) — the agent
VMs in OpenKaava Cloud, every session each one has run, which workflow run a
session belongs to, and what the agent did in it. It reads the sessions bucket
and Compute Engine through `src-tauri/src/cloud/`, with the caller's own
`gcloud` sign-in, and polls only while visible. Its one write is starting a
stopped agent VM, which only a press of Start calls. Set
`KAAVA_CLOUD_FIXTURES` to the absolute path of `src-tauri/fixtures/cloud` to run it against the committed
fixture instead of the live project.

Agents is a **page**, not an app you open into a pane. It is left out of the
Apps menu, the add-app button, presets and `kaava/open`, and `open_instance`
refuses it by name. Its chip at the left of the cluster bar opens it into its
own dedicated cluster instead. `src-tauri/src/pages.rs` declares which apps are
pages. Making another app a page takes a row there, on top of the app's usual
three edits.

**Cost Tracker** (`costs/estimate`) — what OpenKaava Cloud has cost so far this
month at list price, and the month's forecast against its 150 USD budget
(`KAAVA_GCP_BUDGET` overrides it). It multiplies what exists (machines, disks,
reserved IPs, buckets, Cloud Run services) by how much each ran or held, from
Cloud Monitoring, by the public Cloud Billing Catalog price. The price lists
are cached for a day; the page refreshes every minute while visible. It only
reads. Egress, NAT, Secret Manager, logging, Artifact Registry, free tiers,
discounts and credits are left out, and the page lists them. The same
`KAAVA_CLOUD_FIXTURES` folder answers it, with `clock.json` fixing "now".
`src-tauri/fixtures/cloud/billing/` holds real catalog SKUs, trimmed. It is a
page, like Agents: its chip opens it, and the Apps menu does not list it.

Beside the estimate it shows what Google actually billed, net of credits, from
the Cloud Billing export to BigQuery (`cloud::bigquery`). The standard usage
cost export has to be switched on once in the Console, into the
`billing_export` dataset (`KAAVA_BILLING_DATASET` overrides it). Until then the
page says how, rather than failing. The export trails the estimate by a few
hours. Fixtures: `bigquery/tables.json` and `bigquery/billing.json`.

**Projects** (`projects/list`, `projects/wake-start`, `projects/plane-get`) —
every OpenKaava Cloud project's Plane workspace, picked from a switcher and
opened beside it. Selecting one wakes `plane-vm` if it was stopped
(`projects/wake-start`, polled by `projects/wake-status`), then lands a native
child webview over the pane — not an `<iframe>`, so Plane's own login session
survives a restart — positioned and resized by `src-tauri/src/plane_webview.rs`.
`projects/plane-get`/`-post`/`-patch` proxy the rest of Plane's REST API
through the backend's own PAT, out of Secret Manager, so nothing but that
same-origin webview ever needs one. Needs `plane.kaava.internal` resolving to
the tunnel's local port in the hosts file; the app surfaces the fix inline
when it does not. The same `KAAVA_CLOUD_FIXTURES` folder runs it against a
fixture project list instead of the live bucket.

Projects is a page too, like Agents and Cost Tracker: its chip opens it, and
the Apps menu does not list it.

**File Viewer** (`files/read`, `files/write`) — open files in tabs, and what
each one looks like. Reads are capped at 256 KiB and say so when they truncate.
Single-clicking a row in the Explorer opens a *preview* tab here, which the next
single click takes over unless something has been typed into it — VS Code's
rule, and the reason browsing a folder leaves one tab behind rather than forty.

The two are separate apps sharing **one Rust half** — both registry rows
dispatch to `apps/files.rs`. There is one filesystem, and `files::call` holds no
state: every method takes its root from the `CallContext` the caller resolved,
which is a fact about where the *frame* is placed rather than which app is in
it. So an Explorer and a Viewer in one cluster resolve the same project, and a
pair in the next cluster resolve theirs.

**Design Mode** (`design/target`, `design/arm`, `design/disarm`, `design/capture`,
`design/comment/*`) — a page you are building, in a frame, with a click on any
element in it capturing that element's markup, computed styles and a cropped
screenshot. You then say what you want changed, and the capture becomes a comment
with an id.

It is the only app whose output an agent reads over MCP rather than through the
shell. `mcp::servers::design` serves the comments and takes the agent's turns on
the same threads; the clipboard handoff is still there and is now the fallback.
`docs/design-notes/design-comments.md` is the account of that half.

It is the only app that mounts something this repository did not write, and the
only one whose Rust half is a security boundary rather than a data source: what
may be embedded is decided by `design::normalize`, not by the frontend, because
a page classified as *local* by Tauri's origin test would reach every command
the shell has. `docs/design-notes/design-mode.md` is the whole account,
including what a hostile page in that frame can and cannot do — it is the page
to read before changing anything under `capabilities/`.

Getting into that frame at all needs Rust too. Same-origin policy means no code
in the shell can put a listener inside it, so `design/arm` installs a probe
through WebView2's `AddScriptToExecuteOnDocumentCreated`, which reaches child
frames the DevTools Protocol's equivalent cannot. The probe answers over
`postMessage` and is inert in every frame but the one this app armed.

**Tutorials** (`tutorial/catalog`, `tutorial/complete`, `tutorial/reset`) — short
walkthroughs of what OpenKaava does today, with a tick against the ones you have
read. `docs/tutorials.md` is how to add one.

It is the only app that reads nothing on the machine: `tutorial::call` ignores
its `CallContext`, so a tutorial reads the same in a cluster with no project as
in one with a checkout — which is the state a person reading "your first project"
is most likely to be in. The catalog is in Rust because Home draws it too; the
prose is in the frontend because it is a view.

Like Home, it **covers** the cluster rather than taking a pane: no tab in the
switcher, no row in the Apps menu or the `+`, and gone as soon as you choose
something else. Home's cards are its door. It is still an ordinary registry entry
all the same — that is what resolves its frontend when `kaava/open` asks for one,
and the filtering is a fact about which menus offer it. `docs/tutorials.md` §8.

**Schematify** — the design layer of OpenKaava: draws the full-scale plan,
technical and product together, that coding agents build from. It replaces
two predecessor applications this scaffold was built from, folded into one
rather than two — see `docs/design/SCHEMATIFY-PRD.md` §1.3 for what each used
to own. It used to be planned as separate repositories, installed the way a
genuinely third-party tool is; it is an app instead for the same reason Home
and Files are — what it shows is what the orchestrator already resolved, and a
process boundary that only turns around and asks the shell for that again is
an IPC hop with nothing of its own on the other end. It is an ordinary pane
app — a tab in the switcher and a row in the Apps menu, like Files or the
Viewer. Scope grows wave by wave; `docs/design/SCHEMATIFY-PRD.md` §17 is
where that gets filled in.
