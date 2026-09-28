# OpenKaava Cloud infrastructure

Infrastructure for [kaava-cloud.md](../kaava-cloud.md). Each service is a separate Terraform root
with its own state and can be planned, applied or destroyed alone. Later stacks find earlier ones
by resource name, not by reading each other's state.

The data contracts that the UI reads and writes are in
[docs/cloud-services.md](../docs/cloud-services.md): the bucket layouts, manifest, canvas and
session record shapes, and authentication.

| Step | Holds |
|---|---|
| `terraform/bootstrap` | Project `veistra-prod`, APIs, Terraform state bucket, 150 USD budget alert |
| `terraform/foundation` | VPC, Cloud NAT, IAP-only firewall, private services access, the `kaava-agent` identity |
| `terraform/secrets` | `claude-oauth-token` (container only; the value is added by hand) |
| `terraform/registry` | Buckets `veistra-artifacts`, `veistra-prod-render-queue`, `veistra-prod-sessions` |
| `terraform/hindsight` | Hindsight on Cloud Run, Cloud SQL Postgres, and an Artifact Registry mirror of ghcr.io |
| `images/agent` | The agent VM image (Packer). `provision.sh` defines everything installed on it |
| `terraform/worker` | Agent VMs, one per entry in `agents`, all booting the agent image |
| `terraform/gpu` | Spot L4 render node, stopped at rest, with a queue agent and a 15-minute idle stop |

## Where configuration lives

| What | Where | Changed by |
|---|---|---|
| Software on agent VMs | `images/agent/provision.sh` (exact versions end up in `/etc/kaava/image.json`) | `deploy.sh image`, then recreate VMs |
| Per-deployment settings on agent VMs | Instance metadata set in `terraform/worker`, applied by `files/boot.sh` at each boot | `deploy.sh apply worker`, then reboot |
| Hindsight settings | Environment variables in `terraform/hindsight` | `deploy.sh apply hindsight` |
| Hindsight version | `hindsight_version` in `terraform/hindsight` (upstream tag, pinned) | same |
| Claude Code on agent VMs | `/etc/claude-code/managed-settings.json` (hooks) and `managed-mcp.json` (Hindsight) | image and boot |
| Secrets | Secret Manager only | `gcloud secrets versions add` |

## Services and how they are reached

- **Hindsight.** Any agent on any VM reaches it the same way. VMs run as `kaava-agent`, which has
  `run.invoker`. Claude Code's `headersHelper` gets a fresh ID token from the metadata server when
  it connects. Nothing about Hindsight is stored on a VM. Hindsight uses Vertex AI through its own
  service account, so no LLM key exists anywhere. Laptops connect as shown in
  [docs/cloud-services.md §8](../docs/cloud-services.md).
- **Agent VMs.** No public IP. SSH goes through IAP:
  `gcloud compute ssh kaava-worker --zone us-central1-a --tunnel-through-iap`. A VM stops itself
  after 30 idle minutes.
- **GPU node.** Agents call `kaava-render model.glb gs://…/screenshots/`. That queues a job and
  starts the node, and the node stops itself when the queue has been empty for 15 minutes.

## Standing it up

On a new Windows machine, run `infra/bootstrap.ps1` first. It installs gcloud, Terraform and
Packer and logs in. Then:

1. Copy `terraform/bootstrap/terraform.tfvars.example` to `terraform.tfvars`, and set an **open**
   billing account. That file is gitignored.
2. Run `infra/deploy.sh apply bootstrap`, then `infra/deploy.sh migrate-bootstrap`.
3. Run `infra/deploy.sh apply`. This runs every remaining step in order. Terraform shows each plan
   and asks before it changes anything, and the agent image is built when none exists yet.
4. Add the Claude token. It never touches disk:
   `claude setup-token`, then
   `gcloud secrets versions add claude-oauth-token --data-file=- --project veistra-prod`. Paste
   the token and press Ctrl-D.
5. Check an agent:
   `gcloud compute ssh kaava-worker --zone us-central1-a --project veistra-prod --tunnel-through-iap -- kaava-smoke-test`

The GPU stack needs a preemptible `NVIDIA_L4_GPUS` quota of 1 in `us-central1`. New projects start
at 0; request it under IAM & Admin > Quotas.

## Cost at idle

| Item | USD per month, approximate |
|---|---|
| Cloud SQL db-f1-micro, 10 GB SSD, backups | 10 |
| Stopped VM disks: 100 GB agent, 100 GB GPU node | 16 |
| Cloud NAT, when a VM is running | 1 per running day |
| Storage, Artifact Registry cache, agent image | 1 to 3 |
| Cloud Run, Vertex AI, Discovery Engine | usage only, no charge when idle |

Running costs: e2-standard-8 about 0.27 USD an hour; the Spot L4 node about 0.25 to 0.35 USD an
hour.

## Known gaps

- Hindsight's LLM is `gemini-3.1-flash-lite` at the Vertex `global` location, checked with a live
  call on 2026-09-27. It returns 404 from `us-central1`.
- The render queue expects one GPU node and does not claim jobs atomically. That is acceptable at
  the PRD's scale of one node.
