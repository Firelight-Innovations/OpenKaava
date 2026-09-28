# OpenKaava Cloud PRD

Owner: Braden Seaborn. Date: 2026-09-27. State: DRAFT. Tracker: the OpenKaava Cloud Tracker artifact.

## 1. Purpose

OpenKaava becomes the control panel for Veistra game work. Agents work on cloud machines. Blender and Godot run headless on those machines. Every agent output lands in one registry for review. Anomaly work begins on 2026-10-05 on top of this stack.

## 2. Scope

### 2.1 In scope

1. Disable Schematify in the OpenKaava shell.
2. Move the company folder to Google Drive and every secret to Google Cloud. A new computer runs every workflow in 60 minutes or less.
3. One worker VM that runs Claude Code, Godot, and Blender headless.
4. One GPU node. The GPU node runs only while frames wait in its queue.
5. One artifact registry: a storage bucket plus a viewer app in OpenKaava.
6. Hindsight as the agent memory layer, hosted on Google Cloud.
7. A button in OpenKaava that opens a Godot project in the local Godot editor.
8. A design canvas for game design, with canvases nested inside canvases.
9. An asset pipeline: an asset spec, a Go button, an agent session, a review round.

### 2.2 Out of scope

1. Schematify feature work. The code stays in the repository. The shell hides the app.
2. Substance Painter on cloud machines.
3. A GUI desktop on cloud machines. Remote desktop access waits for a real need.
4. Multi-user access. Braden Seaborn is the one user.
5. Autoscaling beyond one worker VM and one GPU node.

## 3. Constraints

1. The workstation at the LIVE Lab belongs to the employer. No Veistra compute runs on the workstation.
2. Reuse existing tools before new code. Each phase names the tool it reuses.
3. AI-assisted assets come from agent-written scripts (TRU-004). The asset pipeline shall produce a Blender Python script for every asset, and the script shall regenerate the asset.
4. No VM carries a public IP. Access goes through Identity-Aware Proxy (IAP) tunnels.
5. No secret lives in a VM image, a repository, or a local file. Secret Manager holds every secret.
6. Monthly cloud spend stays below 150 USD at idle-heavy use. The GPU node uses Spot pricing and stops after 15 minutes idle.

## 4. Architecture

| Part | Reuses | Location |
|---|---|---|
| Company folder | Google Drive, read through the Google Drive connector (DEC-TEC-TOOL-010) | Drive folder `Veistra/company` |
| Writing linter | `ste100-linter` from PyPI | every agent environment |
| Secrets | Secret Manager | GCP project `veistra-prod` |
| Worker VM | Compute Engine, `e2-standard-8`, Ubuntu 24.04 | zone `us-central1-a` |
| GPU node | Compute Engine, `g2-standard-8` with 1 NVIDIA L4, Spot | zone `us-central1-a` |
| Machine setup | Startup script now; Packer image in Phase 7 | `infra/` in the OpenKaava repository |
| Agent auth | `claude setup-token`, one-year OAuth token | secret `claude-oauth-token` |
| Artifact storage | Cloud Storage | bucket `veistra-artifacts` |
| Artifact viewer | New OpenKaava app, `apps/registry/` | OpenKaava repository |
| Memory layer | Hindsight (`vectorize-io/hindsight`), Docker Compose, MCP server | worker VM, port 8888, IAP only |
| Design canvas | Excalidraw (MIT license) | new OpenKaava app, `apps/canvas/` |
| Orchestrator | Python 3.12 script, `claude -p` headless mode | worker VM |

### 4.1 Artifact layout

Every agent output uses one path shape:

```
gs://veistra-artifacts/<game>/<kind>/<artifact-id>/v<n>/
  manifest.json
  files/
  screenshots/
  source/
```

`manifest.json` carries 11 fields. Identity fields: `id`, `game`, `kind`, `version`, `created`, `author`. Content fields: `spec_ref`, `status`, `files`, `screenshots`, `feedback`. `status` takes one of four values: `building`, `review`, `accepted`, `rejected`. `author` takes one of two values: `human` or `agent`, matching SCH-API-003.

### 4.2 Asset pipeline flow

1. The owner writes an asset spec on the design canvas: name, reference images, size in meters, triangle budget, style notes.
2. The owner presses Go.
3. The orchestrator opens a headless Claude Code session on the worker VM. The session receives the spec and the Hindsight memory bank for asset work.
4. The agent writes a Blender Python script. Blender runs the script headless and exports a `.glb` file.
5. Blender Cycles on the GPU node draws 4 turntable screenshots at 1024 by 1024 pixels.
6. The orchestrator uploads the result to the registry with `status` set to `review`.
7. The owner reviews in the registry app, then accepts the version or writes feedback.
8. Feedback opens a new review round. The agent reads the feedback and produces `v<n+1>`.
9. On session end, the orchestrator writes one Hindsight `retain` entry with the spec, the feedback, and the outcome.

## 5. Phases

Each task carries an ID, a target date, and an acceptance condition. The tracker artifact mirrors these IDs.

### Phase 0: Clear the ground (2026-09-27)

| ID | Task | Acceptance condition |
|---|---|---|
| P0-1 | Approve the proposed terms in section 7 | Rows added to `core/terminology.csv` |
| P0-2 | Record the Schematify disable decision | New ACTIVE row in `core/decisions/technical/orchestrator/scope.csv` |
| P0-3 | Hide Schematify behind a Cargo feature `schematify`, off by default | Switcher bar shows no Schematify tab; `pnpm verify` passes |
| P0-4 | Hide the Schematify frontend entry in `vite.config.ts` behind the same flag | The `dist/` folder holds no `apps/schematify/` bundle |

### Phase 1: Cloud home (2026-09-27)

| ID | Task | Acceptance condition |
|---|---|---|
| P1-1 | Create GCP project `veistra-prod` with a billing budget alert at 150 USD | Budget alert email arrives at 50, 90, and 100 percent |
| P1-2 | Move the company folder to Google Drive | A Claude session reads `core/truths.csv` through the Google Drive connector |
| P1-3 | Install `ste100-linter` from PyPI in every agent environment | `ste100 --version` returns a version on the worker VM |
| P1-4 | Store every secret in Secret Manager | `gcloud secrets list` shows each secret; no secret sits on local disk |
| P1-5 | Write `bootstrap.ps1` for a new Windows machine | A clean machine authenticates and opens OpenKaava in 60 minutes or less |
| P1-6 | Point rule 0 of `SYSTEM-PROMPT.md` and the Project instructions at the Drive folder | A new session reads the company folder with no local path |

### Phase 2: Worker VM (2026-09-27)

| ID | Task | Acceptance condition |
|---|---|---|
| P2-1 | Write `infra/worker/startup.sh` to install Claude Code, Godot 4.5 headless, Blender 4.5, Python 3.12 | Each binary returns a version string over IAP SSH |
| P2-2 | Create the worker VM with no public IP | `gcloud compute ssh --tunnel-through-iap` connects |
| P2-3 | Load `CLAUDE_CODE_OAUTH_TOKEN` from Secret Manager at boot | `claude -p "reply ok"` returns `ok` |
| P2-4 | Run a smoke test: the agent scripts a chair in Blender and exports `.glb`; Godot imports the file headless | Godot import exits with code 0 |

### Phase 3: Artifact registry (2026-09-28)

| ID | Task | Acceptance condition |
|---|---|---|
| P3-1 | Create bucket `veistra-artifacts` and the layout in section 4.1 | The smoke-test chair sits at `anomaly/prop/chair-test/v1/` |
| P3-2 | Write the CLI `kaava-artifact push` | One command uploads files, screenshots, and `manifest.json` |
| P3-3 | Write the OpenKaava app `apps/registry/`: list, filter by game and review state, screenshot view | The chair shows with 4 screenshots in the app |
| P3-4 | Add accept, reject, and feedback controls that write to `manifest.json` | A feedback entry appears in the manifest within 5 seconds |

### Phase 4: GPU node (2026-09-28)

| ID | Task | Acceptance condition |
|---|---|---|
| P4-1 | Create the Spot `g2-standard-8` GPU node, stopped by default | Instance state reads `TERMINATED` at rest |
| P4-2 | Write `render.sh`: start the node, draw frames with Cycles on the GPU, upload, stop | 4 turntable frames at 1024 by 1024 pixels land in the registry |
| P4-3 | Add an idle stop at 15 minutes | Node stops 15 minutes after the last frame |

### Phase 5: Hindsight memory (2026-09-28)

| ID | Task | Acceptance condition |
|---|---|---|
| P5-1 | Deploy Hindsight with Docker Compose on the worker VM | API answers on port 8888 over IAP |
| P5-2 | Register the Hindsight MCP server in Claude Code on the worker | Claude Code lists the Hindsight tools |
| P5-3 | Create memory banks per workflow: `asset-build`, `godot-build` | Each bank returns a `recall` result after one `retain` call |
| P5-4 | Write one `retain` entry at each session end | Every closed session holds one `retain` entry |

### Phase 6: Godot launch (2026-09-28)

| ID | Task | Acceptance condition |
|---|---|---|
| P6-1 | Add a Godot entry to OpenKaava launch presets | A button opens the project in the local Godot editor |
| P6-2 | Add a Play button that runs the main scene | The game window opens in 10 seconds or less |

### Phase 7: Design canvas (2026-10-05 onward, beside Anomaly work)

| ID | Task | Acceptance condition |
|---|---|---|
| P7-1 | Write `apps/canvas/` on Excalidraw | Owner draws and saves one canvas |
| P7-2 | Store each canvas as one JSON file in the game repository | Canvas survives a clone on a second machine |
| P7-3 | Add nested canvases: a frame links to a child canvas | Double-click opens the child; a breadcrumb returns to the parent |
| P7-4 | Add an asset spec card with the fields in section 4.2 | A spec card exports valid JSON |
| P7-5 | Add an asset list view across all canvases of one game | The list shows every spec card with its review state |
| P7-6 | Bake the worker setup into a Packer image | A new worker boots ready in 90 seconds or less |

### Phase 8: Asset pipeline (2026-10-05 onward)

| ID | Task | Acceptance condition |
|---|---|---|
| P8-1 | Write the Python orchestrator for the flow in section 4.2 | One spec card becomes one registry entry with no manual step |
| P8-2 | Add the Go button on a spec card | Go opens a session on the worker VM |
| P8-3 | Add review rounds: feedback in the registry opens `v<n+1>` | Version 2 reflects the feedback text |
| P8-4 | Add a workflow report: rounds per asset, time per round, Hindsight recalls | Report shows the last 20 assets |

## 6. Decisions recorded

The owner approved these rows on 2026-09-27.

| ID | Decision |
|---|---|
| ORC-SCO-001 | Schematify is disabled in the shell; the code stays behind a Cargo feature |
| ORC-ARC-001 | Agent work runs on Google Cloud; no Veistra compute runs on employer hardware |
| ORC-ARC-002 | The artifact registry is a Cloud Storage bucket with one `manifest.json` per version |
| ORC-ARC-003 | Hindsight is the agent memory layer |
| ORC-ARC-004 | The design canvas reuses Excalidraw |
| DEC-TEC-TOOL-010 | The company folder moves to Google Drive, read through the Google Drive connector |

## 7. Terms added

The owner approved these terms on 2026-09-27: `worker VM`, `GPU node`, `artifact registry`, `asset spec`, `review round`, `agent session`, `design canvas`. `core/terminology.csv` holds the definitions.

`design canvas` names the new OpenKaava design surface. `schematic` stays defined for the disabled Schematify code.

## 8. Open items

1. `SYSTEM-PROMPT.md` names the linter at `tools/ste_lint.py`. The file sits at `tools/ste100-linter/ste_lint.py`. Task P1-3 replaces both paths with the `ste100` command.
2. The linter flags the `do_not_use` column of `core/terminology.csv` as 25 errors. The flag is a false positive: the column lists banned words on purpose.