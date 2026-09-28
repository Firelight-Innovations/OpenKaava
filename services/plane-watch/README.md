# plane-watch

Turns Plane labels into AI jobs (Plane design 8.1). It runs as a container on plane-vm, next to
Plane, and polls the Plane API over the compose network every minute. Polling that way never
touches the host port, so it never keeps plane-vm awake on its own.

## What it does

For every non-archived project record under `prod/projects/` in the projects bucket:

1. Reads the work items updated since its cursor (`order_by=-updated_at`; Plane ignores
   `updated_at__gt`).
2. For each item carrying `ai:breakdown`, `ai:plan-cycle`, `ai:context` or `ai:do`, writes a job
   file to `jobs/pending/<id>.json`, unless that id already exists in pending, claimed or done.
3. Swaps the trigger label for `ai:queued` and comments "Queued for agent: job ...".
4. Starts kaava-worker while any job is pending. kaava-jobs on the worker claims and runs it.

While one of its jobs is still pending or claimed it writes `/state/busy`, which plane-vm's idle
check reads, so Plane stays up until the agent has reported back.

## Job file

```json
{
  "schema": 1,
  "id": "KAAVA-5-breakdown-20260928T023536147391",
  "kind": "breakdown",
  "profile": "prod",
  "project": "openkaava",
  "plane": {
    "workspace": "veistra", "project_id": "...", "identifier": "KAAVA",
    "work_item_id": "...", "sequence_id": 5, "name": "..."
  },
  "requested_by": "plane-watch",
  "created": "2026-09-28T02:35:36Z"
}
```

## Running and testing

`infra/plane/boot.sh` writes `plane_watch.py` and `compose.yaml` from instance metadata and
starts the container at every boot. The script is stdlib Python and reads everything from its
environment (see `compose.yaml`).

```sh
python services/plane-watch/test_plane_watch.py      # unit tests, no network
python services/plane-watch/plane_watch.py once      # one poll, for debugging on plane-vm
```
