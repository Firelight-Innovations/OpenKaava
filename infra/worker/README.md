# Plane MCP on agent VMs

Agents read and write Plane through the official
[`plane-mcp-server`](https://github.com/makeplane/plane-mcp-server) in stdio mode (Plane design
§7.2). The agent image carries it; nothing is installed at session time.

| File | On the VM | What it does |
|---|---|---|
| `requirements-mcp.in` | | The one direct dependency, `plane-mcp-server==0.3.3` |
| `requirements-mcp.txt` | `/opt/kaava/plane-mcp/` (a venv) | Every package pinned by hash, compiled from the `.in` file; the image installs it with `pip --require-hashes` |
| `plane-mcp.sh` | `/opt/kaava/bin/plane-mcp` | The launcher: `kaava-wake plane`, then the `plane-pat-agent` token from Secret Manager into its own environment, then `exec plane-mcp-server stdio` |
| `plane_mcp_check.py` | `/opt/kaava/bin/plane-mcp-check` | The verify-first test (V2) and the MCP step of the smoke suite |

`boot.sh` registers the launcher as the `plane` server in `/etc/claude-code/managed-mcp.json`,
beside the Hindsight servers, when the worker stack sets `kaava-plane-url` (it does by default).
The design says `claude mcp add plane`, but `managed-mcp.json` takes exclusive control of MCP on
an agent VM, so a server added that way would be ignored.

A stopped plane-vm takes 3 to 4.5 minutes to answer. Claude Code waits for the launcher because
the image's managed settings set `MCP_TIMEOUT=300000` (5 minutes); the default is 30 seconds.

## AI jobs (kaava-jobs)

plane-watch (`services/plane-watch/`) queues a job when a work item gets an `ai:*` label.
`kaava-jobs.timer` runs `kaava-jobs run` every minute while the worker is up:

1. It closes as failed any job this worker claimed but never finished. That happens when the VM
   stopped mid-job.
2. It claims the oldest file in `gs://veistra-projects/prod/jobs/pending/`. It copies the file to
   `claimed/` with `ifGenerationMatch=0`, so only one worker gets each job.
3. It wakes plane-vm, then runs `claude -p` as the `kaava-jobs` user. The prompt is
   `prompts/protocol.md` plus the kind's own prompt, the job and the project record. Plane must be
   awake first, because `claude -p` does not wait for MCP servers; the first live job failed that
   way.
4. It reads the outcome from the item's labels. If the agent set neither `ai:done` nor
   `ai:failed`, kaava-jobs sets `ai:failed` and comments why. Either way the job moves to `done/`
   with the session's result.

| File | On the VM |
|---|---|
| `kaava_jobs.py` | `/opt/kaava/bin/kaava-jobs` (`run`, `status`) |
| `prompts/*.md` | `/opt/kaava/prompts/` |

Only `do` jobs get Bash and file tools; the others get Plane and the project's Hindsight banks.
Each job times out after one hour. An empty queue costs two bucket listings and never wakes Plane.

On the worker, `kaava-jobs status` lists the queue, and
`sudo journalctl -u kaava-jobs` shows the runs. Unit tests: `python infra/worker/test_kaava_jobs.py`.

## Checking it

On the worker:

```sh
plane-mcp-check                 # tool list, then create/read/update/comment/delete in KAAVA
claude mcp list                 # shows plane beside hindsight-*
```

`plane-mcp-check` leaves nothing behind: it deletes its work item even when a step fails.

## Verify-first result (V2)

2026-09-28: `plane-mcp-server` 0.3.3 against Plane CE v1.4.2 passes. It lists 30 tools, and
create, retrieve, update, comment and delete all work. The CE 404s in upstream issue
[#126](https://github.com/makeplane/plane-mcp-server/issues/126) came from CE v1.0.0, which lacked
the `/work-items/` routes; v1.4.2 has them. The community `plane-mcp-server-ce` fork is not needed.
Tools for Plane's paid features (milestones, initiatives, customers, releases) will return errors
on CE; agents should not use them.

## Upgrading

Change the version in `requirements-mcp.in`, compile again with the command at the top of
`requirements-mcp.txt`, run `plane-mcp-check` from a laptop against the tunnel, then rebuild the
image (`infra/deploy.sh image`) and recreate the worker. Then apply `terraform/plane` again:
recreating the worker drops plane-vm's permission to wake it.
