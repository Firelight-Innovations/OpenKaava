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
