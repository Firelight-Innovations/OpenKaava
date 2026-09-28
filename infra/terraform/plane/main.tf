# Plane CE, the AGDP work tracker (docs/design/OPENKAAVA-PLANE-DESIGN.md, ORC-ARC-005..008).
#
# One small VM runs Plane's release images, unmodified, from Plane's own compose file. It has no
# public IP: the laptop reaches it through an IAP tunnel and agent VMs through the VPC, both at
# http://plane.kaava.internal:8765. It stops itself when nobody has used it for 30 minutes and
# anyone with the kaavaWaker role starts it again (kaava-wake plane), so it bills for about the
# hours it is used plus two small disks.
#
# Nothing about Plane is in an image. The VM boots stock Ubuntu; boot.sh arrives as the startup
# script and installs Docker once, and every file it needs comes from this stack as metadata.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "plane"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "zone" { type = string }

variable "machine_type" {
  type        = string
  description = "Plane's documented floor is 2 vCPU and 4 GB. Try e2-medium after a week of docker stats (section 4)."
  default     = "e2-standard-2"
}

variable "idle_minutes" {
  type    = number
  default = 30
}

variable "worker_instance" {
  type        = string
  description = "The agent VM plane-watch starts when it queues an AI job (section 5.2)."
  default     = "kaava-worker"
}

locals {
  domain = "plane.kaava.internal"
  port   = 8765
  url    = "http://${local.domain}:${local.port}"

  # Generated here, so no person ever sees them. Each lives in Secret Manager and in this stack's
  # state, which is in the private tfstate bucket, as the Hindsight database password already is.
  # plane-dev-* are the local instance's own copies (section 9), never shared with the cloud.
  generated = ["secret-key", "live-secret-key", "postgres-password", "rabbitmq-password", "minio-secret"]
  # Sign-in passwords for the three Plane users (section 3), used by first_run.py. Only the owner
  # can read them; plane-vm is not granted these.
  accounts = ["owner-password", "agent-password", "kaava-password"]
  # Personal access tokens only exist after first-run setup; first_run.py adds their values.
  tokens = ["pat-agent", "pat-kaava"]

  secrets = merge(
    { for s in concat(local.generated, local.accounts) : "plane-${s}" => true },
    { for s in concat(local.generated, local.accounts) : "plane-dev-${s}" => true },
    { for s in local.tokens : "plane-${s}" => false },
    { for s in local.tokens : "plane-dev-${s}" => false },
  )
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

data "google_compute_network" "kaava" {
  name = "kaava"
}

data "google_compute_subnetwork" "kaava" {
  name   = "kaava-${var.region}"
  region = var.region
}

data "google_service_account" "agent" {
  account_id = "kaava-agent"
}

resource "google_service_account" "plane" {
  account_id   = "plane-vm-sa"
  display_name = "plane-vm: Plane CE and plane-watch"
}

resource "google_project_iam_member" "plane" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = google_service_account.plane.member
}

# --- Secrets (A2.5): access is granted per secret, never project-wide -----------------------

resource "random_password" "plane" {
  for_each = { for k, generated in local.secrets : k => k if generated }
  length   = 48
  special  = false # they go into URLs (DATABASE_URL, AMQP_URL) unescaped
}

resource "google_secret_manager_secret" "plane" {
  for_each  = local.secrets
  secret_id = each.key
  labels    = { stack = "plane" }
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_version" "plane" {
  for_each    = random_password.plane
  secret      = google_secret_manager_secret.plane[each.key].id
  secret_data = each.value.result
}

# plane-vm reads its own settings and plane-watch's token; agent VMs read the agent token for the
# Plane MCP server. The owner reads plane-dev-* as project owner.
resource "google_secret_manager_secret_iam_member" "plane_vm" {
  for_each  = toset(concat([for s in local.generated : "plane-${s}"], ["plane-pat-kaava"]))
  secret_id = google_secret_manager_secret.plane[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.plane.member
}

resource "google_secret_manager_secret_iam_member" "agent" {
  secret_id = google_secret_manager_secret.plane["plane-pat-agent"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = data.google_service_account.agent.member
}

# --- Network (A2.2, A2.4) -------------------------------------------------------------------

resource "google_compute_address" "plane" {
  name         = "plane-vm"
  address_type = "INTERNAL"
  subnetwork   = data.google_compute_subnetwork.kaava.self_link
}

# Rules target the service account, not the `plane` tag: a rule that admits agent VMs by their
# service account must name its target the same way.
resource "google_compute_firewall" "plane_iap" {
  name                    = "kaava-plane-iap"
  network                 = data.google_compute_network.kaava.self_link
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.plane.email]
  allow {
    protocol = "tcp"
    ports    = ["22", tostring(local.port)]
  }
}

resource "google_compute_firewall" "plane_agents" {
  name                    = "kaava-plane-agents"
  network                 = data.google_compute_network.kaava.self_link
  source_service_accounts = [data.google_service_account.agent.email]
  target_service_accounts = [google_service_account.plane.email]
  allow {
    protocol = "tcp"
    ports    = [tostring(local.port)]
  }
}

resource "google_dns_managed_zone" "internal" {
  name        = "kaava-internal"
  dns_name    = "kaava.internal."
  description = "Private names for OpenKaava services on the kaava VPC"
  visibility  = "private"
  private_visibility_config {
    networks {
      network_url = data.google_compute_network.kaava.id
    }
  }
}

resource "google_dns_record_set" "plane" {
  managed_zone = google_dns_managed_zone.internal.name
  name         = "${local.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.plane.address]
}

# --- Disk and VM (A2.1, A2.6, A2.8) -----------------------------------------------------------

resource "google_compute_disk" "data" {
  name   = "plane-data"
  type   = "pd-balanced"
  size   = 20
  labels = { stack = "plane" }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_resource_policy" "daily" {
  name = "plane-data-daily"
  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "08:00" # UTC; 03:00 in Texas, when nobody is planning
      }
    }
    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      labels            = { stack = "plane" }
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "daily" {
  name = google_compute_resource_policy.daily.name
  disk = google_compute_disk.data.name
}

resource "google_compute_instance" "plane" {
  name                      = "plane-vm"
  machine_type              = var.machine_type
  tags                      = ["plane"]
  allow_stopping_for_update = true
  labels                    = { stack = "plane" }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 20
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "plane-data"
  }

  # No access_config: no external IP. Images pull through the VPC's existing Cloud NAT (A2.3).
  network_interface {
    subnetwork = data.google_compute_subnetwork.kaava.self_link
    network_ip = google_compute_address.plane.address
  }

  service_account {
    email  = google_service_account.plane.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE"
    startup-script         = file("${path.module}/../../plane/boot.sh")
    plane-compose          = file("${path.module}/../../plane/compose/docker-compose.v1.4.2.yaml")
    plane-compose-override = file("${path.module}/../../plane/compose.override.yaml")
    plane-env-tmpl         = file("${path.module}/../../plane/plane.env.tmpl")
    plane-render-env       = file("${path.module}/../../plane/render_env.py")
    kaava-idle             = file("${path.module}/../../common/kaava-idle/kaava_idle.py")
    kaava-idle-minutes     = tostring(var.idle_minutes)
    plane-watch            = file("${path.module}/../../../services/plane-watch/plane_watch.py")
    plane-watch-compose    = file("${path.module}/../../../services/plane-watch/compose.yaml")
    kaava-worker           = var.worker_instance
    kaava-worker-zone      = var.zone
    plane-url              = local.url
    plane-domain           = local.domain
  }

  # The VM stops itself when idle; Terraform must not start it again on the next apply.
  lifecycle {
    ignore_changes = [desired_status]
  }

  depends_on = [google_secret_manager_secret_version.plane, google_secret_manager_secret_iam_member.plane_vm]
}

# --- Waking (A3.3) --------------------------------------------------------------------------

resource "google_project_iam_custom_role" "waker" {
  role_id     = "kaavaWaker"
  title       = "Kaava waker"
  description = "Start a stopped OpenKaava VM and read its state. Nothing else."
  permissions = ["compute.instances.get", "compute.instances.start"]
}

# Agent sessions wake Plane before the Plane MCP server starts.
resource "google_compute_instance_iam_member" "agents_wake_plane" {
  instance_name = google_compute_instance.plane.name
  zone          = var.zone
  role          = google_project_iam_custom_role.waker.id
  member        = data.google_service_account.agent.member
}

# plane-watch wakes the worker when it queues an AI job.
resource "google_compute_instance_iam_member" "plane_wakes_worker" {
  instance_name = var.worker_instance
  zone          = var.zone
  role          = google_project_iam_custom_role.waker.id
  member        = google_service_account.plane.member
}

# plane-watch writes job files; kaava-agent's grant on this bucket is in registry/.
resource "google_storage_bucket_iam_member" "projects" {
  bucket = "veistra-projects"
  role   = "roles/storage.objectAdmin"
  member = google_service_account.plane.member
}

output "url" {
  value = local.url
}

output "internal_ip" {
  value = google_compute_address.plane.address
}

output "tunnel" {
  value = "gcloud compute start-iap-tunnel plane-vm ${local.port} --local-host-port=localhost:${local.port} --zone ${var.zone} --project ${var.project_id}"
}

output "ssh" {
  value = "gcloud compute ssh plane-vm --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
}
