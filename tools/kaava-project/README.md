# kaava-project

The link table between Plane and the other Veistra systems (Plane design §3). One JSON record per
project at `gs://veistra-projects/<profile>/projects/<slug>.json`; Plane holds the work itself.

| Command | Plane? |
|---|---|
| `list [--json] [--all]` | No. A bucket read, so it works while plane-vm is stopped. `--all` includes archived. |
| `create <slug> --name <n> [--game <g>] [--repo <url>] [--identifier <ABC>]` | Wakes it. Creates the project, the seven `ai:*` labels, an `In Review` state between In Progress and Done, and adds the owner (admin) and `agent` (member). Then the `gs://veistra-artifacts/<game>/.keep` placeholder and the record. If anything after the Plane project fails, the Plane project is deleted again. |
| `show <slug> [--json]` | Wakes it. The record plus the live project: issue count, states, labels. |
| `archive <slug>` | Wakes it. Archives the Plane project and sets `archived: true`. Never deletes. |

Every command takes `--profile prod|dev` (default `prod`). Plane project names allow letters,
digits and spaces only: `Torn Apart`, not `Torn-Apart`.

## Running it

Python 3.11 or later, standard library only. It authenticates as whoever `gcloud` is logged in as
(or the VM's service account) and reads `plane-pat-kaava` from Secret Manager into memory.

From the laptop, with the IAP tunnel open (see `infra/plane/README.md`):

```powershell
$env:KAAVA_PLANE_CONNECT = "http://127.0.0.1:8765"
python tools\kaava-project\kaava_project.py list
python tools\kaava-project\kaava_project.py create anomaly --name Anomaly --game anomaly --identifier ANOM --repo https://github.com/Firelight-Innovations/Anomaly
```

`--connect` (or `KAAVA_PLANE_CONNECT`) only changes where requests go; they still carry
`Host: plane.kaava.internal:8765`, so no hosts entry is needed. On the worker, leave it unset.

Waking uses `infra/common/kaava-wake`: start plane-vm if it is stopped, then wait for health. A
cold start takes 3 to 4.5 minutes.

## Prod projects

| Slug | Identifier | Game | Repo |
|---|---|---|---|
| `anomaly` | ANOM | `anomaly` | Firelight-Innovations/Anomaly |
| `torn-apart` | TORN | `torn-apart` | Firelight-Innovations/Torn-Apart |
| `openkaava` | KAAVA | none | Firelight-Innovations/OpenKaava |

## Tests

```sh
python -m unittest discover -s tools/kaava-project
```
