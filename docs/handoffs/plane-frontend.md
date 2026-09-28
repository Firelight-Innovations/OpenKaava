# Handoff: Plane CE is live, build `apps/projects/` (Agent B)

From Agent A (cloud), 2026-09-28. Read `docs/design/OPENKAAVA-PLANE-DESIGN.md` §3, §7.1 and §11
first: that is your spec. This note says what is real today, what is not, and every name you code
against. Change a name in §3 of the design only, then tell Agent A.

## What is live

| Piece | State |
|---|---|
| Plane CE **v1.4.2** on `plane-vm` (us-central1-a, no public IP) | Running; stops itself after 30 idle minutes |
| Canonical URL | `http://plane.kaava.internal:8765` |
| Health check (V1, confirmed) | `GET /` → 200 **and** `GET /api/instances/` → 200 |
| Workspace | slug `veistra` |
| Users | owner `braden.seaborn@firelightinnovations.com` (Admin); bots `agent@plane.kaava.internal`, `kaava@plane.kaava.internal` (Member) |
| PATs in Secret Manager | `plane-pat-kaava` (yours: the OpenKaava backend), `plane-pat-agent` (agent sessions; do not use) |
| Owner password | `plane-owner-password` (to sign in to the embedded webview) |
| Rate limit (V4, confirmed) | 300 requests/minute per key |
| Cold start, stopped → healthy | 163 s from the worker, 259 s from the laptop through the tunnel (target 180 s; median of 5 still to come). Give up at 300 s, not 240 |
| Project records | `gs://veistra-projects/prod/projects/{anomaly,torn-apart,openkaava}.json` (§3.1 schema); `dev/projects/` is empty. `openkaava` has `game: null` and `artifacts: null` |
| Plane projects | `ANOM`, `TORN`, `KAAVA`, each with the seven `ai:*` labels and an `In Review` state. `VEIST` is Plane's own demo project, not ours: it has no record, so it never shows in the list |
| Project CLI | `tools/kaava-project/` (see its README). "New project" (B3.1) can shell out to `create`, or make the same calls in Rust |

The owner's `gcloud` login can read every secret above. Read them from Rust into memory at app
start; never into the frontend, a file, or a log (B2.1).

## Connecting from the laptop

1. **Hosts entry** (B2.3), once, admin: `127.0.0.1 plane.kaava.internal` in
   `%SystemRoot%\System32\drivers\etc\hosts`. Plane's `WEB_URL` and CORS are that exact origin, so
   `http://localhost:8765` loads but sign-in cookies and links break. Use the name.
2. **Wake** (B2.4, design §3.3): Compute Engine REST with the owner's token.
   - `GET https://compute.googleapis.com/compute/v1/projects/veistra-prod/zones/us-central1-a/instances/plane-vm`
     → `status`
   - If `TERMINATED`: `POST …/instances/plane-vm/start`, then poll the GET every 3 s until
     `RUNNING` (about 10 s). If `STOPPING`, wait for `TERMINATED` first.
   - Then poll both health paths through the tunnel every 3 s. Expect `connection refused` or
     **HTTP 502** for about 2 minutes while containers start and migrations run; that is normal,
     not an error. Give up at 300 s.
3. **Tunnel** (B2.2):
   `gcloud compute start-iap-tunnel plane-vm 8765 --local-host-port=localhost:8765 --zone=us-central1-a --project=veistra-prod`.
   Start it once the VM reports `RUNNING` (untested whether it starts against a stopped VM), and
   restart it if it exits. On Windows `gcloud` is `gcloud.cmd`, a script that launches Python:
   spawn it through `cmd /c` and kill the whole process tree on exit, not just the wrapper.
4. **REST** (§7.1): base `http://plane.kaava.internal:8765/api/v1/`, header `X-API-Key: <PAT>`,
   cursor pagination, `per_page` at most 100. Quick check:
   `GET /api/v1/workspaces/veistra/projects/` → 200.

A reference implementation of the wake loop is `infra/common/kaava-wake/kaava_wake.py` (stdlib
Python, with tests); mirror its state handling in Rust.

## AI jobs (B3.2)

The job loop is live (PRs #132, #134). **To request a job, put a label on the work item** through
the Plane API: `ai:breakdown`, `ai:plan-cycle`, `ai:context` or `ai:do`. plane-watch picks the
label up within a minute and swaps it for `ai:queued`. It then writes the job file, starts
kaava-worker, and keeps plane-vm awake until the job finishes. The agent reports back on the item
itself: one summary comment, then `ai:done` or `ai:failed` in place of `ai:queued`. A breakdown
took 62 s end to end.

Don't write job files yourself. plane-watch starts the worker only for jobs it queued, so a file
written by the app waits until something else wakes the worker.

To show progress, read the item's labels, or the job files in
`gs://veistra-projects/prod/jobs/{pending,claimed,done}/<job-id>.json`:

```json
{
  "schema": 1,
  "id": "KAAVA-5-breakdown-20260928T143146106415",
  "kind": "breakdown",
  "profile": "prod",
  "project": "openkaava",
  "plane": {"workspace": "veistra", "project_id": "…", "identifier": "KAAVA",
            "work_item_id": "…", "sequence_id": 5, "name": "…"},
  "requested_by": "plane-watch",
  "created": "2026-09-28T14:31:46Z",
  "claimed_by": "kaava-worker", "claimed_at": "…",
  "finished_at": "…",
  "result": {"outcome": "done", "result": "one-sentence summary", "session_id": "…",
             "num_turns": 14, "seconds": 62}
}
```

`claimed_*` appears once a worker takes the job, and `finished_at` and `result` only in `done/`.
`result.outcome` is `done` or `failed`. `result.session_id` is the Claude session, which the
sessions bucket records like any other.

## Not built yet (plan around these)

| Missing | Affects | Until then |
|---|---|---|
| Local dev instance (§9, `:8766`) | B1.2, B1.4 | Develop against the cloud instance. The `dev` profile's names are reserved and its secrets exist (`plane-dev-*`), but nothing listens on `:8766`. |
| V5: live WebSocket through the IAP tunnel | collaborative pages | Untested. If page editing misbehaves in the webview, report it rather than work around it. |

V7 (the child webview keeping the Plane session across restarts on WebView2) is yours.

## Rules that bite

- **Don't change Plane, and don't inject into its pages** (design rule 1, §11). Chrome goes around
  the webview only.
- **Don't run `infra/plane/first_run.py`** or anything under `infra/`. The instance is set up;
  rerunning is harmless but unnecessary, and infrastructure is Agent A's.
- Listing projects **never wakes Plane**: it is a bucket read.
- The Plane nouns (`issue`, `cycle`, `module`, …) are API names, not approved Veistra terms
  (design §13 item 4). Don't name UI after them until the owner decides.
- Deep-link URL patterns: take them from the running v1.4.2 UI, not from Plane's docs, and keep
  them in `apps/projects/src/planeRoutes.ts` (§11).

## Where things are

- `infra/plane/README.md`: operating the VM (logs, reboot, upgrade).
- `infra/terraform/plane/main.tf`: every resource name above.
- `docs/cloud-services.md`: the existing GCS contracts (artifacts, sessions).
