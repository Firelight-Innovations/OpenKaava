# OpenKaava Cloud: services and data contracts

Reference for anyone building OpenKaava UI on top of the cloud side: the agent views, the
registry app, and the design canvas. It describes what exists in Google Cloud, where each kind of
data lives, the exact shape of each record, and how the desktop app authenticates.

The infrastructure is in [`infra/`](../infra/README.md). The product plan is
[`kaava-cloud.md`](../kaava-cloud.md). If this document disagrees with the code in `infra/`, the
code wins. Fix this document in the same change.

> **Status, 2026-09-28.** Everything below is deployed and live in `veistra-prod`. Plane CE and
> the project records are in `docs/handoffs/plane-frontend.md`; the whole system, built and
> planned, is drawn in [`docs/design/CLOUD-SYSTEM-DIAGRAM.md`](design/CLOUD-SYSTEM-DIAGRAM.md).

## 1. What exists

| Service | What it is | Name |
|---|---|---|
| Project | Everything below | `veistra-prod`, region `us-central1`, zone `us-central1-a` |
| Artifact registry | Cloud Storage bucket, one folder per artifact version | `gs://veistra-artifacts` |
| Design store | The same bucket, under `design/` (§4) | `gs://veistra-artifacts` |
| Session records | Cloud Storage bucket that agent VMs write to | `gs://veistra-prod-sessions` |
| Render queue | Cloud Storage bucket between agents and the GPU node | `gs://veistra-prod-render-queue` |
| Hindsight | Agent memory, Cloud Run behind Google IAM | `https://hindsight-hsi6ckovra-uc.a.run.app` |
| Agent VMs | Compute Engine, label `role=agent`, named `kaava-<name>` | `kaava-worker` at first |
| GPU node | Compute Engine Spot L4, label `role=gpu`, stopped at rest | `kaava-gpu` |

Every machine and service here scales to zero or stops itself when idle, because the monthly
budget is 150 USD. **The UI must not keep things awake.** See §8.

## 2. Authentication from the desktop app

OpenKaava holds no keys. It uses the signed-in user's Google identity, through the Rust backend:

| To call | Send | Get it with |
|---|---|---|
| Cloud Storage JSON API, Compute Engine API | `Authorization: Bearer <access token>` | `gcloud auth print-access-token` |
| Hindsight (Cloud Run) | `Authorization: Bearer <ID token>` | `gcloud auth print-identity-token` |

- Both tokens last about an hour. Cache each one in memory. When a call returns 401, fetch a new
  token and retry once.
- Do not write either token to disk, logs, or `recent_errors`.
- If `gcloud` is missing or not logged in, show a state that says so and names the fix
  (`gcloud auth login`). Do not show a generic network error.
- The user is a project owner, so these tokens can read and write everything listed above. Agent
  VMs use their own service account (`kaava-agent`), not the user's identity.

## 3. Artifacts

This section restates PRD §4.1 with the field shapes filled in.

```
gs://veistra-artifacts/<game>/<kind>/<artifact-id>/v<n>/
  manifest.json
  files/          the deliverable (.glb, .png, .tscn, …)
  screenshots/    turntable_00.png … turntable_03.png for 3D assets
  source/         what regenerates the deliverable, e.g. the Blender script (TRU-004)
```

- `<game>` is a lowercase slug, for example `anomaly`.
- `<kind>` is one of `prop`, `character`, `environment`, `texture`, `audio`, `scene`, `spec`.
- `<artifact-id>` is a lowercase slug, unique within its game and kind.
- `<n>` starts at 1 and increases by one per review round.

`manifest.json` has exactly 11 fields:

```json
{
  "id": "chair-test",
  "game": "anomaly",
  "kind": "prop",
  "version": 1,
  "created": "2026-09-28T14:03:11Z",
  "author": "agent",
  "spec_ref": "gs://veistra-artifacts/anomaly/spec/chair-test/v1/manifest.json",
  "status": "review",
  "files": ["files/chair.glb"],
  "screenshots": ["screenshots/turntable_00.png", "screenshots/turntable_01.png"],
  "feedback": [
    { "at": "2026-09-28T15:10:00Z", "author": "human", "text": "Legs too thin; match the reference." }
  ]
}
```

- `status` takes one of four values: `building`, `review`, `accepted`, `rejected`.
- `author`, at the top level and in each feedback entry, is `human` or `agent` (SCH-API-003).
- `files` and `screenshots` hold paths relative to the version folder.

**Writing a manifest.** Accept, reject and feedback (P3-4) rewrite `manifest.json`. Another writer
may change it at the same time, so every write must be conditional:

1. Read the object and record its `generation`.
2. Write with `ifGenerationMatch=<generation>`.
3. If the write fails with 412, read again, reapply your change, and write again.

Object versioning is on, so an earlier manifest is always recoverable.

**Listing.** List with `delimiter=/` one level at a time: games, then kinds, then artifacts,
then versions. Do not list the whole bucket recursively.

**Screenshots.** Download them through the storage API with the access token. The bucket has no
public URLs.

## 4. Designs (design canvas)

> **Decision needed.** PRD P7-2 says each canvas is one JSON file in the game repository. The
> owner now wants canvases synced through the artifact store. This layout is the proposal for
> that. It needs a decision row that replaces P7-2 before code depends on it.

```
gs://veistra-artifacts/<game>/design/<canvas-id>/canvas.json
```

- `canvas.json` is an Excalidraw scene (`type`, `version`, `elements`, `appState`, `files`) plus
  one top-level `kaava` object:

  ```json
  {
    "type": "excalidraw",
    "version": 2,
    "elements": [],
    "appState": {},
    "files": {},
    "kaava": {
      "schema": 1,
      "id": "level-1",
      "game": "anomaly",
      "title": "Level 1 layout",
      "parent": "world-map",
      "updated": "2026-09-28T15:10:00Z",
      "updated_by": "human"
    }
  }
  ```

- **Nested canvases (P7-3).** A frame element links to a child canvas through
  `customData.kaava.child = "<canvas-id>"`. The child's `kaava.parent` points back, and the
  breadcrumb follows `parent` up to the root.
- **Asset spec cards (P7-4).** A spec card is an element with
  `customData.kaava.spec = { name, reference_images, size_m, triangle_budget, style_notes }`.
  Pressing Go exports the card as a `spec` artifact (§3). The asset list (P7-5) reads spec cards
  across every canvas of one game and joins each to the latest `status` of the artifact that
  names it in `spec_ref`.
- **Sync.** There is one object per canvas, written with the same generation precondition as
  manifests (§3). On a 412 conflict, merge instead of overwriting: Excalidraw's
  `reconcileElements` merges by element `version` and `versionNonce`. While a canvas is open,
  check the object's metadata no more than once every 5 seconds. Download the scene only when
  `generation` has changed.
- **History.** Object versioning keeps earlier saves; the bucket keeps 5 noncurrent versions.
  Store snapshots as `v<n>` artifacts only when the user asks for one.
- **Images** pasted into a canvas stay inside Excalidraw's `files`. If canvases grow past a few MB,
  move images to `design/<canvas-id>/files/<file-id>` and keep only references in the scene.

## 5. Agent sessions

A Claude Code hook on every agent VM writes one folder per session:

```
gs://veistra-prod-sessions/<agent>/<session-id>/status.json       replaced on every event
gs://veistra-prod-sessions/<agent>/<session-id>/transcript.jsonl  Claude Code's transcript
```

`<agent>` is the VM name, for example `kaava-worker`. Example `status.json`:

```json
{
  "schema": 1,
  "session_id": "0b6c1f7e-…",
  "agent": "kaava-worker",
  "user": "braden_seaborn_firelightinnovations_com",
  "cwd": "/home/…/anomaly",
  "state": "idle",
  "last_event": "Stop",
  "updated": "2026-09-28T15:12:40Z",
  "prompt": "Build the chair from spec chair-test",
  "workflow": { "name": "asset-build", "run": "chair-test-v2", "step": "render" }
}
```

| Field | Meaning |
|---|---|
| `state` | `running` (a turn is in progress), `idle` (waiting for input), `ended`, or `unknown` |
| `last_event` | The Claude Code hook that wrote this: `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop` or `SessionEnd` |
| `prompt` | Present only after `UserPromptSubmit`. The first 500 characters of that prompt |
| `end_reason` | Present only after `SessionEnd` |
| `workflow` | Present only when the runner set `KAAVA_WORKFLOW`, `KAAVA_WORKFLOW_RUN` and `KAAVA_WORKFLOW_STEP` |

- A field that has no value is left out; it is never written as `null`.
- `transcript.jsonl` is uploaded at every `Stop` and at `SessionEnd`, not during a turn. A
  running session's log is therefore at most one turn behind. Each line is one Claude Code
  transcript entry: user and assistant messages, tool calls, tool results. Treat unknown line
  types as opaque, because the format belongs to Claude Code and changes between versions.
- A session whose `state` is `running` and whose `updated` is older than 30 minutes probably
  died with its VM. Show it as `stale`. Never write to another agent's session folder.
- **Listing.** List `gs://veistra-prod-sessions/` with `delimiter=/` to get the agents, then each
  agent's prefix to get its sessions, then read `status.json`.

## 6. Workflow progress

Workflows do not have their own record yet. Phase 8 builds the Python orchestrator. Until then,
progress comes from the `workflow` field in `status.json`: a run is every session that shares
`workflow.run`, and its current step is the latest `step`.

When the orchestrator lands, it will write
`gs://veistra-prod-sessions/_workflows/<run>/run.json` with an ordered step list and per-step
state. The `_workflows/` prefix is reserved for it now, so skip that prefix when listing agents.

## 7. Agent machines and the render queue

- **List agent VMs** through the Compute Engine API, filtered by `labels.role=agent`. `status` is
  `RUNNING`, `STAGING`, `STOPPING` or `TERMINATED`, and `TERMINATED` means stopped.
- **Start** an agent with `POST …/instances/<name>/start`. Agent VMs stop themselves after 30
  minutes with no Claude, Godot or Blender process and nobody logged in, so a Start control
  belongs in the UI.
- **What an agent VM has installed** is in `/etc/kaava/image.json` on the VM, written when the
  image was built from `infra/images/agent/`.
- **Render queue.** `gs://veistra-prod-render-queue/jobs/<id>/` holds a job that is waiting or
  running. `done/<id>.json` records a finished one as `{"status": "ok"|"error", …}`. The GPU node
  is `kaava-gpu` and has the same status values.

## 8. Hindsight

Hindsight is shared agent memory: `retain`, `recall` and `reflect` over named banks. The banks so
far are `asset-build` and `godot-build`.

- **MCP.** `<url>/mcp/<bank>/`. Agent VMs are already configured. To use it from Claude Code on a
  laptop:

  ```sh
  claude mcp add-json hindsight-asset-build --scope user \
    '{"type":"http","url":"<url>/mcp/asset-build/","headersHelper":"echo {\"Authorization\":\"Bearer $(gcloud auth print-identity-token)\"}"}'
  ```

- **REST.** Look up the HTTP API in `<url>/openapi.json` after deploy; this document does not
  restate it. Health check: `GET <url>/health`.
- **Cost rule.** Every request keeps a Cloud Run instance, which is billed, alive for about 15
  minutes. Fetch memory when the user opens a view that shows it. **Never poll Hindsight on a
  timer, and never call it at startup.**

The same rule applies to everything else: poll storage objects only while their view is open, no
more than once every 5 seconds, and read metadata before downloading content.

## 9. Rules for UI code

- The repository `CLAUDE.md` still applies: port 1420 belongs to Braden, and agents use
  `pnpm dev:agent`. Every commit must pass `pnpm verify`.
- The UI starts nothing on its own. It may start an agent VM or the GPU node only when the user
  presses a control that says so.
- No secret goes in the frontend, in `localStorage`, or in any file.
- Every write to a shared object (manifests, canvases) uses a generation precondition.
