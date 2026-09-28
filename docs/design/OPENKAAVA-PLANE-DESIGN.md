# OpenKaava + Plane CE: Design and Build Plan

Owner: Braden Seaborn. Date: 2026-09-27. State: APPROVED DIRECTION, BUILD PENDING.
Readers: **Agent A** (cloud, scale-to-zero, project system) and **Agent B** (OpenKaava embedded app).
Related: `docs/design/OPENKAAVA-CLOUD-PRD.md`, `docs/design/OPENKAAVA-TRACKER-SURVEY.md`.

---

## 0. Rules for both agents

1. **Do not modify Plane.** Plane CE runs from the official, unmodified container images at one pinned release. No fork, no patch, no rebuilt image, no edits to files inside Plane containers. All new features go *around* Plane through its REST API, its MCP server, webhooks or polling, extra containers we own, and the OpenKaava UI.
2. **Configuration is allowed; code changes are not.** Setting values in `plane.env`, adding our own containers beside Plane's, and settings in Plane's instance admin (`/god-mode`) all count as configuration.
3. **Cost is a hard requirement.** Every always-on resource needs a written reason. Do not add a load balancer, Cloud SQL, Memorystore, NAT gateway, or GKE without owner approval. §4 has the budget.
4. **No secrets in images, repositories, or files on the laptop** (Cloud PRD constraint 5). Secret Manager holds every secret.
5. **No public IPs** (Cloud PRD constraint 4). Access goes through IAP or the VPC.
6. **AI runs on Claude Code only.** Plane's built-in AI settings stay empty. See §8.
7. The Veistra company rules (`SYSTEM-PROMPT.md`) still apply. The owner has waived the `ste_lint.py` pass for this document only.
8. If a verify-first item in §12 fails, stop and report it. Don't work around it by changing Plane.

---

## 1. Decisions this plan implements

The owner gave this direction on 2026-09-27. It's recorded in `core/decisions/technical/orchestrator/architecture.csv`.

| ID | Decision |
|---|---|
| ORC-ARC-005 | Plane Community Edition is the AGDP work tracker, self-hosted on Google Cloud at a pinned release |
| ORC-ARC-006 | OpenKaava integrates with Plane through its API, MCP, webhooks or polling, and an embedded webview; Plane code stays unmodified |
| ORC-ARC-007 | AI features on Plane data run as Claude Code agent sessions on the subscription OAuth token |
| ORC-ARC-008 | Cloud services scale to zero: each VM stops when idle and starts on demand |

**AGDP** (Agentic Game Development Platform) names OpenKaava's role as Veistra's central platform. The term is in `core/terminology.csv`.

Other Veistra systems (orchestrator, artifact registry, agent sessions) get their work context from Plane.

---

## 2. Architecture

```
 Owner laptop (Windows)                         GCP project veistra-prod, us-central1-a
 ┌──────────────────────────────┐               ┌──────────────────────────────────────────┐
 │ OpenKaava (Tauri v2)         │  IAP TCP      │ plane-vm  (e2-standard-2, no public IP)  │
 │  apps/projects/              │  tunnel       │  ┌─ Plane CE containers (unmodified) ──┐ │
 │   - project switcher         │──:8765───────►│  │ proxy:8765 web space admin live api │ │
 │   - Plane child webview      │               │  │ worker beat-worker migrator         │ │
 │   - native views (REST API)  │               │  │ plane-db plane-redis plane-mq minio │ │
 │  Rust: tunnel, wake, PAT     │               │  └─────────────────────────────────────┘ │
 │  hosts: plane.kaava.internal │               │  plane-watch (ours): polls/receives,     │
 │         -> 127.0.0.1         │               │    queues AI jobs, wakes worker          │
 └──────────────┬───────────────┘               │  kaava-idle (ours): stops VM when idle   │
                │ GCE API: instances.start      │  disk plane-data (Postgres, MinIO)       │
                ▼                               └───────────────▲──────────────────────────┘
          Compute Engine API                                    │ VPC, Cloud DNS private zone
                                                                │ plane.kaava.internal:8765
                                                ┌───────────────┴──────────────────────────┐
                                                │ existing worker VM                       │
                                                │  orchestrator, claude -p sessions        │
                                                │  plane-mcp-server (stdio) per session    │
                                                │  kaava-wake plane before MCP starts      │
                                                └──────────────────────────────────────────┘
          gs://veistra-projects/   project records + AI job queue (no server)
          gs://veistra-artifacts/  existing artifact registry
```

**One URL everywhere:** `http://plane.kaava.internal:8765`.
- On the worker VM, a Cloud DNS private zone resolves the name to plane-vm's internal IP.
- On the laptop, a hosts-file entry resolves it to `127.0.0.1`, where the IAP tunnel listens.
- Plane's `WEB_URL` and `CORS_ALLOWED_ORIGINS` use this URL, so cookies and links work from both places.
- Traffic is plain HTTP inside an encrypted IAP tunnel or the private VPC. No TLS certificate or load balancer is needed.

---

## 3. Shared contracts (both agents build against these)

Agent A creates these resources. Agent B codes against the names. Change a name only in this table, then tell the other agent.

| Item | Value |
|---|---|
| GCP project / zone | `veistra-prod` / `us-central1-a` |
| Plane VM | `plane-vm`, network tag `plane` |
| Plane data disk | `plane-data`, pd-balanced, 20 GB, mounted at `/opt/plane` |
| Plane release | `APP_RELEASE=v1.4.2` (latest CE tag on 2026-08-23; Agent A checks for a newer stable tag at build time, then pins it) |
| Canonical URL | `http://plane.kaava.internal:8765` |
| Local dev URL | `http://localhost:8766` |
| Health check | `GET <url>/` returns 200 **and** `GET <url>/api/instances/` returns 200 (Agent A confirms the second path against the pinned release and updates this row) |
| Plane workspace slug | `veistra` |
| Plane users | `braden` (owner, human), `agent` (bot for all agent sessions), `kaava` (bot for the OpenKaava backend and plane-watch) |
| Secret names | `plane-secret-key`, `plane-live-secret-key`, `plane-postgres-password`, `plane-rabbitmq-password`, `plane-minio-secret`, `plane-pat-agent`, `plane-pat-kaava`, `plane-dev-*` (local-dev copies) |
| Project records | `gs://veistra-projects/prod/projects/<slug>.json` (local dev: `gs://veistra-projects/dev/projects/`) |
| AI job queue | `gs://veistra-projects/prod/jobs/{pending,claimed,done}/<job-id>.json` |
| Project CLI | `kaava-project` (Python 3.12, `tools/kaava-project/` in the OpenKaava repository), JSON output with `--json` |
| Wake CLI | `kaava-wake <service>` (`infra/common/kaava-wake/`), exits 0 when the health check passes |
| Idle stop | `kaava-idle` (`infra/common/kaava-idle/`), systemd timer, generic across VMs |
| Custom IAM role | `kaavaWaker`: `compute.instances.get`, `compute.instances.start` only |

### 3.1 Project record schema (`<slug>.json`)

```json
{
  "schema": 1,
  "slug": "anomaly",
  "name": "Anomaly",
  "game": "anomaly",
  "plane": { "workspace": "veistra", "project_id": "<uuid>", "identifier": "ANOM" },
  "artifacts": "gs://veistra-artifacts/anomaly/",
  "repo": "https://github.com/<org>/<repo>",
  "hindsight_banks": ["asset-build", "godot-build"],
  "created": "2026-09-28T00:00:00Z",
  "archived": false
}
```

- `game` is `null` for non-game projects, such as OpenKaava itself. When set, it matches the `<game>` segment of the artifact registry path.
- Plane is the source of truth for work (issues, cycles, modules, states). The project record is the link table between Plane and the other Veistra systems.
- **Listing projects never wakes Plane.** The list is a bucket read, so OpenKaava shows every project while plane-vm is stopped.

### 3.2 `kaava-project` commands

| Command | Effect |
|---|---|
| `kaava-project list [--json] [--profile prod\|dev]` | Reads the bucket prefix. No Plane call. |
| `kaava-project create <slug> --name <n> [--game <g>] [--repo <url>] [--identifier <ABC>]` | Wakes Plane, creates the Plane project through the API with the default states and the `ai:*` labels (§8), writes the record, creates the artifact prefix placeholder. Rolls back the Plane project if the record write fails. |
| `kaava-project show <slug> [--json]` | Record plus a live Plane summary (wakes Plane) |
| `kaava-project archive <slug>` | Archives the Plane project and sets `archived: true`. Never deletes. |

### 3.3 Wake contract

`kaava-wake plane`:
1. `instances.get`. If the state is `RUNNING`, go to step 3.
2. `instances.start`, then poll `instances.get` every 3 s until `RUNNING` (timeout 120 s).
3. Poll the health check every 3 s until it passes (timeout 240 s).
4. Exit 0. On timeout, exit 1 with the last error.

The laptop has no route to the VPC, so the OpenKaava desktop app runs steps 1–2 through the Compute Engine REST API (or `gcloud`) using the owner's credentials. It runs step 3 through the tunnel.

**Target:** cold start to healthy in 180 s or less. Agent A measures it and records the result in §12.

---

## 4. Cost model

us-central1 on-demand list prices. Agent A re-checks them at build time.

| Resource | Basis | Monthly |
|---|---|---|
| plane-vm e2-standard-2 compute | 0.067 USD/h × about 60 h of use per month | about 4.00 |
| Same VM, always on (for comparison) | 730 h | 48.91 |
| Boot disk 20 GB + `plane-data` 20 GB, pd-balanced | 0.10 USD/GB-month | 4.00 |
| Snapshot schedule, daily, keep 7 | incremental, 0.05 USD/GB-month | under 1.00 |
| Cloud DNS private zone `kaava.internal` | 0.20 USD/zone | 0.20 |
| IAP TCP forwarding, VPC traffic in one zone | none | 0.00 |
| `veistra-projects` bucket (JSON records, job files) | tiny | under 0.10 |
| **Expected total** | | **about 9–10 USD** |

Excluded because they would add always-on cost:
- Load balancer (about 18 USD/month).
- Cloud SQL (bills while running; has a floor).
- Memorystore (no scale to zero).
- No new egress path: plane-vm reuses the path the existing worker VM already uses to download packages (see §10 task A2.3).

**Spot vs on-demand:** use on-demand for plane-vm. At about 60 h per month, Spot saves under 3 USD per month, and preemption would interrupt planning sessions. The GPU node keeps Spot (Cloud PRD).

**Right-sizing:** after one week of use, Agent A records peak `docker stats` memory. If the peak stays under 3 GB, test `e2-medium` (4 GB, about half the compute cost) and report back. Plane's documented floor is 2 vCPU and 4 GB.

---

## 5. Scale to zero

### 5.1 `kaava-idle` (generic; plane-vm first, other VMs reuse it)

A systemd timer runs every 5 minutes. Settings live in `/etc/kaava-idle.conf`:

```
PORTS=8765            # ports whose traffic counts as activity
IDLE_MINUTES=30       # stop after this long with no activity
MIN_UPTIME_MINUTES=20 # never stop sooner than this after boot
EXTRA_CHECK=          # optional command; exit 0 means "busy"
```

The VM counts as **busy** if any of these is true:
- An established TCP connection exists on a listed port. Plane's live WebSocket keeps one open while the Plane view is open in OpenKaava.
- The access log shows any request in the last `IDLE_MINUTES`. On plane-vm, read the `proxy` container logs.
- `EXTRA_CHECK` exits 0. For the worker VM later, this checks for running agent sessions or pending jobs.

When the VM is idle, the script:
1. Writes one line to Cloud Logging.
2. Runs the pre-stop hook. On plane-vm, `docker compose stop` for a clean Postgres shutdown.
3. Runs `shutdown -h now`.

The VM enters `TERMINATED`, and only its disks bill.

Other existing VMs adopt `kaava-idle` by installing the unit and writing their own config. Rolling it out to other VMs is out of scope here; the interface is built to be reused.

### 5.2 Wake paths

| Caller | How |
|---|---|
| OpenKaava desktop | Rust: GCE REST `start` → open IAP tunnel → health check → show webview. The UI shows "Starting Plane…" with elapsed seconds. |
| Agent session on the worker VM | The MCP launcher script runs `kaava-wake plane`, then `exec`s the Plane MCP server (§7.2). |
| `kaava-project create/show` | Calls `kaava-wake plane` first |
| plane-watch waking the worker | Calls GCE `start` on the worker VM when it queues a job (needs `kaavaWaker` on the worker) |

### 5.3 Boot sequence on plane-vm (`infra/plane/boot.sh`, run by the startup script)

1. Mount `plane-data` at `/opt/plane`.
2. Fetch the `plane-*` secrets from Secret Manager. Render `/run/plane/plane.env` (tmpfs, mode 600) from `infra/plane/plane.env.tmpl`.
3. `docker compose --env-file /run/plane/plane.env -f infra/plane/compose/docker-compose.v1.4.2.yaml up -d`
4. Start plane-watch (separate compose project, §7.3).
5. Enable the `kaava-idle` timer.

**Caveat for the owner:** Docker stores the environment of created containers in its container config on disk. The secrets never enter the image or the repository, but they do sit on the VM disk while containers exist. Removing this requires recreating containers on every boot (`up -d --force-recreate`), which adds about 20–40 s to cold start. Default: recreate on every boot. The owner decides if the time cost is too high.

---

## 6. Plane configuration

### 6.1 Compose file

1. Download the CE release's `setup.sh` once on a scratch machine.
2. Run install to generate `docker-compose.yaml` and `plane.env`.
3. Commit the generated compose file **byte-for-byte unchanged** as `infra/plane/compose/docker-compose.v<release>.yaml`.
4. Commit `plane.env` as a template with every secret replaced by a `${SECRET:name}` placeholder.

Don't use `setup.sh` on the VM. `boot.sh` replaces it so secrets stay in tmpfs.

### 6.2 `plane.env.tmpl` values that differ from the defaults

| Variable | Value |
|---|---|
| `APP_RELEASE` | pinned release (§3) |
| `WEB_URL` | `http://plane.kaava.internal:8765` |
| `CORS_ALLOWED_ORIGINS` | `http://plane.kaava.internal:8765` |
| `LISTEN_HTTP_PORT` | `8765` |
| `LISTEN_HTTPS_PORT` | unused; don't expose it |
| `POSTGRES_PASSWORD`, MinIO keys, `SECRET_KEY`, live-server secret | from Secret Manager |
| Data paths | Postgres, Redis, RabbitMQ, and MinIO volumes bind under `/opt/plane/data/` so everything persists on `plane-data`. If the compose file uses named volumes, set Docker's `data-root` to `/opt/plane/docker` instead of editing the compose file. |
| API rate limit | Plane's API limit is 60 requests/minute per key. If the pinned release exposes `API_KEY_RATE_LIMIT`, set `300/minute`. If it doesn't, keep separate PATs per consumer (§3) and have plane-watch back off on HTTP 429. |

### 6.3 Instance admin (`/god-mode`) settings

- Leave every AI / LLM provider field **empty**. Plane AI is a Commercial Edition feature; any CE assistant setting stays off.
- Turn off public sign-up once the three users exist.
- Turn on password login. Turn off magic-link email. Leave SMTP unset (no email is needed).
- Create workspace `veistra`. Add `agent` and `kaava` as members with the Member role.

### 6.4 Upgrades

Upgrade the local instance first (§9), then run the smoke suite (A5.2). For the cloud instance:
1. Snapshot `plane-data`.
2. Commit the new compose file and bump `APP_RELEASE`.
3. Reboot plane-vm.

Never skip releases that include database migrations without reading the release notes.

---

## 7. Integration surfaces (how we add features without touching Plane)

### 7.1 REST API

- Base: `<url>/api/v1/`. Auth header: `X-API-Key: <PAT>`. Cursor pagination (`per_page` max 100).
- The OpenKaava backend (Rust) holds `plane-pat-kaava` in memory only. It loads the PAT from Secret Manager at app start. The frontend never sees the token; it calls Tauri commands (`plane_get`, `plane_post`, …).
- Native OpenKaava views read and write through these commands.

### 7.2 MCP for agents

- Server: the official `plane-mcp-server` (Python, MIT) in **stdio** mode, with its version pinned in `infra/worker/requirements-mcp.txt`.
- Env: `PLANE_BASE_URL=http://plane.kaava.internal:8765`, `PLANE_API_KEY=<plane-pat-agent>`, `PLANE_WORKSPACE_SLUG=veistra`.
- The launcher `infra/worker/plane-mcp.sh` runs `kaava-wake plane`, loads the PAT from Secret Manager, then `exec plane-mcp-server stdio`. Register it in Claude Code on the worker VM with `claude mcp add plane -- /opt/kaava/plane-mcp.sh`.
- **Verify first (§12):** some MCP server releases called endpoints that older CE builds lack. List the tools, then run create, read, update, and comment on a test issue against the pinned CE. If calls return 404, try the community `plane-mcp-server-ce` fork before anything else, and report the result.
- The owner's local Claude Code uses the same launcher pattern through the tunnel.

### 7.3 plane-watch (our container, on plane-vm, runs only while Plane runs)

`services/plane-watch/`: a small Python service in its own compose project that joins Plane's Docker network.
- **Baseline trigger: polling.** Every 60 s, query issues whose labels include `ai:*` and whose `updated_at` is newer than the last cursor. Store the cursor in `/opt/plane/plane-watch/state.json`.
- **Optional trigger: webhooks.** If Plane CE accepts a webhook to an internal address (`http://plane-watch:8790/hook`), subscribe to issue events and verify `X-Plane-Signature` (HMAC-SHA256 of the raw body) with a secret from Secret Manager. Keep polling as the fallback. Plane can refuse private-network webhook URLs, and it disables a webhook after 5 failed deliveries.
- For each trigger:
  1. Write a job file to `jobs/pending/`.
  2. Comment "Queued for agent: job `<id>`" on the issue.
  3. Swap the trigger label for `ai:queued`.
  4. Start the worker VM.
- plane-watch also reports "busy" to `kaava-idle` while jobs are in flight.

### 7.4 Embedded UI

See §11 (Agent B).

---

## 8. AI features on Claude Code

**Rule:** every AI feature is a headless Claude Code session (`claude -p`) on the worker VM, authenticated with `CLAUDE_CODE_OAUTH_TOKEN` from Secret Manager (the subscription token from `claude setup-token`). It uses the Plane MCP server for reads and writes.
- No Anthropic API key.
- No `--bare` mode (it ignores the OAuth token).
- No LLM key inside Plane.

These sessions share usage limits with the owner's own Claude use. The orchestrator runs **one AI job at a time** by default (setting `MAX_AI_JOBS=1`).

### 8.1 Job flow

1. The owner adds a label in Plane or clicks an OpenKaava button (both paths write the same job file).
2. The worker orchestrator claims the job: it moves the file from `pending/` to `claimed/` with a GCS generation precondition, so only one worker gets it.
3. It starts `claude -p` with a prompt template from `infra/worker/prompts/<kind>.md`, the job JSON, and the project record.
4. The agent does the work through Plane MCP. When done, it posts one summary comment on the issue and swaps `ai:queued` for `ai:done`, or `ai:failed` with the error.
5. The orchestrator moves the job to `done/` and writes the Hindsight `retain` entry (Cloud PRD P5-4).

### 8.2 First features (labels created in every new project by `kaava-project create`)

| Label | Agent action |
|---|---|
| `ai:breakdown` | Split the issue into child issues with acceptance conditions and size estimates. Place them in the issue's module when it has one. |
| `ai:plan-cycle` | On an issue in the current cycle: review the cycle's open issues against their estimates, and comment a proposed cut list for work that won't fit. The agent doesn't move issues. |
| `ai:context` | Collect linked artifact registry entries, the design canvas references, and recent Hindsight recalls into one comment. |
| `ai:do` | Assign to `agent` and run the matching orchestrator workflow (the asset pipeline, for example). Link the artifact registry path in a comment and move the issue to `In Review`. |

New features follow the same pattern: one label, one prompt template, no Plane changes.

---

## 9. Local development instance

The purpose: Agent B and the owner develop against a real Plane without waking or touching the cloud one.

- Host: the owner's laptop with Docker Desktop on the WSL2 backend. Give WSL 6 GB of memory or more in `.wslconfig`.
- `infra/plane/local/up.sh` (run inside WSL):
  1. Fetch the `plane-dev-*` secrets with `gcloud`.
  2. Render `plane.env` into `/run/user/$UID/plane/` (tmpfs).
  3. Run the **same pinned compose file** with `WEB_URL=http://localhost:8766` and `LISTEN_HTTP_PORT=8766`.
  4. Keep data in local Docker volumes. They hold test data only.
- `infra/plane/local/down.sh` stops the containers. `reset.sh` deletes the volumes after a confirmation prompt.
- `infra/plane/local/seed.sh` runs the first-run steps the API can't do:
  1. It prints the `/god-mode` and sign-up URLs for the manual steps (admin, workspace `veistra`, three users, one PAT each), then waits.
  2. After the PATs are stored as `plane-dev-pat-*` secrets, it runs `kaava-project create sandbox --profile dev`.
- OpenKaava has a profile switch (`prod` / `dev`). `dev` uses `http://localhost:8766`, the `plane-dev-*` secrets, the `dev/` bucket prefix, and no tunnel or wake.

---

## 10. Agent A: cloud, scale-to-zero, project system

Order matters. Finish A1 first; Agent B needs a local Plane.

### A1 — Local Plane (target: same day)
| ID | Task | Acceptance |
|---|---|---|
| A1.1 | Generate and commit the pinned compose file and `plane.env.tmpl` (§6.1) | The file matches the release artifact byte-for-byte (`sha256` recorded in the commit message) |
| A1.2 | Create the `plane-dev-*` secrets | `gcloud secrets list --filter=name~plane-dev` shows them |
| A1.3 | Write `infra/plane/local/{up,down,reset,seed}.sh` | `up.sh` then the health check at `:8766` passes |
| A1.4 | Complete the first run: workspace `veistra`, three users, PATs saved as secrets | `curl -H "X-API-Key: …" :8766/api/v1/workspaces/veistra/projects/` returns 200 |
| A1.5 | Tell Agent B the local instance is ready | Message sent with the confirmed health-check path |

### A2 — Cloud Plane
| ID | Task | Acceptance |
|---|---|---|
| A2.1 | Create disk `plane-data` and VM `plane-vm` (e2-standard-2, Ubuntu 24.04, no public IP, tag `plane`, service account `plane-vm-sa`) | `gcloud compute ssh plane-vm --tunnel-through-iap` connects |
| A2.2 | Firewall: tcp 8765 and 22 from `35.235.240.0/20` (IAP) to tag `plane`; tcp 8765 from the worker VM's tag | Tunnel and worker `curl` both reach the port; nothing else does |
| A2.3 | Image pulls with no public IP: reuse the existing worker VM's egress path (Cloud NAT, if the network has one). If there is none, mirror the pinned images to Artifact Registry through Private Google Access. Report which path you used and its monthly cost. | `docker compose pull` succeeds on plane-vm |
| A2.4 | Cloud DNS private zone `kaava.internal`, A record `plane` → plane-vm internal IP (reserve a static internal IP) | `dig plane.kaava.internal` from the worker returns the IP |
| A2.5 | Create the `plane-*` secrets; grant `plane-vm-sa` access to those secrets only | IAM shows secret-level bindings, not project-level |
| A2.6 | Write `infra/plane/boot.sh` (§5.3) and set it as the startup script | A reboot comes back healthy with no manual step |
| A2.7 | First-run setup on the cloud instance (same as A1.4, production PATs) | API returns 200 through the tunnel |
| A2.8 | Snapshot schedule on `plane-data`: daily, keep 7 | Schedule is attached; first snapshot exists the next day |

### A3 — Scale to zero
| ID | Task | Acceptance |
|---|---|---|
| A3.1 | Write `infra/common/kaava-idle/` (script, systemd unit and timer, config) | Unit tests cover the busy and idle decisions; installs with one command |
| A3.2 | Install on plane-vm with the §5.1 config | VM reaches `TERMINATED` 30–35 min after the last request; a clean Postgres shutdown shows in the logs |
| A3.3 | Write `infra/common/kaava-wake/` (CLI + library) and the `kaavaWaker` role | `kaava-wake plane` from the worker starts a stopped VM and exits 0 |
| A3.4 | Measure cold start 5 times and record the median in §12 | Median is 180 s or less, or a written reason plus the fix options |

### A4 — Project system and agent access
| ID | Task | Acceptance |
|---|---|---|
| A4.1 | Create the bucket `veistra-projects` (uniform access, versioning on, no public access) | `gsutil ls` shows `prod/` and `dev/` |
| A4.2 | Write `tools/kaava-project/` (§3.2) with `--profile` | `create sandbox`, `list`, `show`, `archive` all work on dev, then on prod |
| A4.3 | Create prod projects `anomaly`, `torn-apart`, and `openkaava` | Three records exist; three Plane projects carry the `ai:*` labels |
| A4.4 | Write `infra/worker/plane-mcp.sh` and register it in Claude Code on the worker (§7.2) | `claude mcp list` shows `plane`; the verify-first MCP test passes |

### A5 — plane-watch and AI jobs
| ID | Task | Acceptance |
|---|---|---|
| A5.1 | Write `services/plane-watch/` (polling first; test webhooks second, §7.3) | Adding `ai:breakdown` on a test issue creates a job file within 90 s |
| A5.2 | Write the smoke suite `infra/plane/smoke.sh` (health, API CRUD, MCP tool call, `kaava-project show`) | Passes on dev and prod; runs before every upgrade |
| A5.3 | Add the job claim and run loop to the worker orchestrator with prompts for the four §8.2 labels | `ai:breakdown` on a test issue produces child issues and one summary comment |
| A5.4 | Record the results of every §12 item in this document | §12 has no open verify-first rows |

---

## 11. Agent B: OpenKaava embedded app

OpenKaava is a Tauri v2 / Rust / React monorepo. Existing apps live under `apps/` (`apps/registry/`, `apps/canvas/`). Build **`apps/projects/`**: the project switcher plus the embedded Plane view. The larger projects feature grows from this app later.

Start with B1 while Agent A builds the cloud side. Use the local instance (§9) for all development.

### Design points

- **Embed with a Tauri child webview, not an `<iframe>`.** A cross-origin iframe inside the Tauri window runs into third-party cookie blocking in WebView2, so the Plane login session breaks. It can also run into framing headers. Tauri v2 multi-webview sits behind the `unstable` Cargo feature.
  - If the owner rejects `unstable`, the fallback is a separate `WebviewWindow` docked beside the main window.
  - An iframe is allowed only if a test on Windows shows the login cookie survives a restart.
- The webview uses a dedicated data directory (`<app data>/plane-webview/`), so the owner signs in to Plane once and the session persists.
- Plane pages are Plane's own UI and stay unchanged. OpenKaava adds chrome **around** the webview: project switcher, "Open in Plane" deep links, the wake status, and later native panels. Don't inject scripts or CSS into Plane pages; that would change Plane's behavior.
- Deep links: derive URL patterns from the pinned Plane UI, such as `/<workspace>/projects/<project_id>/issues/`. Keep them in one TypeScript module (`apps/projects/src/planeRoutes.ts`) so an upgrade touches one file.

### Tasks
| ID | Task | Acceptance |
|---|---|---|
| B1.1 | Scaffold `apps/projects/` and add it to the shell switcher | The app tab opens; `pnpm verify` passes |
| B1.2 | Profile switch `prod`/`dev` in OpenKaava settings (§9) | Switching changes the URL, the secrets, and the bucket prefix with no restart |
| B1.3 | Project list from `kaava-project list --json` (or a direct bucket read in Rust) | The list shows while plane-vm is stopped, with no wake |
| B1.4 | Child webview pointed at the local Plane; persistent session | After sign-in and an app restart, Plane opens signed in |
| B1.5 | Selecting a project navigates the webview to that Plane project | Deep link lands on the project's issue list |
| B2.1 | Rust `plane` module: fetch the PAT from Secret Manager into memory; Tauri commands `plane_get`/`plane_post`/`plane_patch` | The frontend has no access to the token (grep the built bundle for the token prefix: no match) |
| B2.2 | Rust IAP tunnel manager: spawn `gcloud compute start-iap-tunnel plane-vm 8765 --local-host-port=localhost:8765 --zone=us-central1-a --project=veistra-prod`; restart it on exit; kill it with the app | Tunnel is up while the app runs; no `gcloud` process remains after exit |
| B2.3 | `bootstrap.ps1` step: add `127.0.0.1 plane.kaava.internal` to the hosts file (admin once; skip if the entry exists) | `ping plane.kaava.internal` resolves to 127.0.0.1 |
| B2.4 | Wake flow in Rust (§3.3) with a "Starting Plane… Ns" state in the UI and a cancel button | From a stopped VM, the Plane view appears with no manual step |
| B3.1 | "New project" dialog → `kaava-project create` | A new project appears in both the list and Plane |
| B3.2 | "Run AI" menu on a selected issue (native panel beside the webview) that writes a job file for the §8.2 kinds | The job appears in `jobs/pending/`; the issue shows the queued comment |
| B3.3 | Native "Work blocks" panel: current and next cycle per project, with open/done counts through the REST API | Counts match the Plane UI for the same cycle |

---

## 12. Verify-first items (record results here)

| # | Item | Owner | Result |
|---|---|---|---|
| V1 | Health-check path `/api/instances/` exists in the pinned release | A | |
| V2 | Official `plane-mcp-server` works against the pinned CE (tool list plus create/read/update/comment); if not, test `plane-mcp-server-ce` | A | |
| V3 | CE accepts a webhook to an internal Docker-network URL; `X-Plane-Signature` present | A | |
| V4 | `API_KEY_RATE_LIMIT` (or equivalent) exists in the pinned release | A | |
| V5 | Plane works with `WEB_URL` on a non-standard port through the IAP tunnel, including the live WebSocket (collaborative page editing) | A | |
| V6 | Cold start median (target 180 s or less) | A | |
| V7 | Tauri v2 child webview keeps the Plane session across restarts on Windows (WebView2) | B | |
| V8 | Peak memory of all Plane containers after one week (right-sizing, §4) | A | |

---

## 13. Open items for the owner

1. **Conflict to resolve:** the owner stated on 2026-09-27 that Kaava is an internal tool, not external. `TRU-003` says OpenKaava is open-sourced at `github.com/Firelight-Innovations/OpenKaava`. Both can be true, since an internal tool can have public source code, but the truth row needs a decision.
   - This plan has no AGPL exposure either way: OpenKaava calls Plane over HTTP and ships no Plane code.
   - No decision row for "internal only" is recorded until the owner resolves this.
2. **Container-config secrets** (§5.3 caveat): accept the 20–40 s cold-start cost of recreating containers on every boot, or accept secrets in Docker's container config on the VM disk.
3. **Tauri `unstable` feature** for the child webview (§11): approve it, or take the separate-window fallback.
4. **Terms:**
   - The Plane nouns in this document (`issue`, `cycle`, `module`, `state`, `label`, `workspace`, `project`) are Plane API names, not Veistra terms.
   - The survey's proposed terms (`work block`, `feature group`, `task`) still wait for approval.
   - Agent B's "Work blocks" panel name depends on that approval.
   - "Plane module" collides with the Schematify term "module".
5. **Worker VM idle stop:** the worker VM needs `kaava-idle` with an `EXTRA_CHECK` for running sessions and pending jobs. Without it, AI jobs keep the worker up. This is a separate change to the existing worker; owner approval is needed before it's rolled out.

---

## Sources

1. Plane Docker Compose install (CE and Commercial): https://developers.plane.so/self-hosting/methods/docker-compose
2. Self-hosted Plane production guide: https://plane.so/blog/self-hosted-plane-on-docker-a-production-guide
3. Plane CE Docker Compose reference (setup.sh, services, env): https://mintlify.wiki/makeplane/plane/self-hosting/docker
4. Plane editions: https://developers.plane.so/self-hosting/editions-and-versions
5. Plane API introduction (auth header, rate limit, pagination): https://developers.plane.so/api-reference/introduction
6. Plane webhooks: https://developers.plane.so/dev-tools/intro-webhooks
7. Plane AI configuration (Commercial Edition): https://developers.plane.so/self-hosting/govern/plane-ai/configure-plane-ai
8. Plane MCP server: https://developers.plane.so/dev-tools/mcp-server
9. Plane MCP CE compatibility issue 126: https://github.com/makeplane/plane-mcp-server/issues/126
10. Plane release list: https://releasealert.dev/github/makeplane/plane