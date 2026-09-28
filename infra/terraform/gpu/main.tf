# GPU node: one Spot g2-standard-8 with an NVIDIA L4 (PRD 4, Phase 4). Stopped at rest.
#
# Nobody logs in to render. The worker drops a job in the render queue bucket and starts this
# instance; infra/gpu/render-agent.sh drains the queue and powers the machine off after 15 idle
# minutes (P4-3). A powered-off instance reads TERMINATED, which is what P4-1 checks for, and
# costs only its disk.
#
# New projects have zero GPU quota. If apply fails on quota, request NVIDIA_L4_GPUS (preemptible)
# = 1 in us-central1 from the IAM & Admin > Quotas page and re-run.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "gpu"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "zone" { type = string }

variable "artifacts_bucket" {
  type    = string
  default = "veistra-artifacts"
}

variable "idle_minutes" {
  type    = number
  default = 15
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

data "google_compute_subnetwork" "kaava" {
  name   = "kaava-${var.region}"
  region = var.region
}

data "google_storage_bucket" "artifacts" {
  name = var.artifacts_bucket
}

data "google_storage_bucket" "render_queue" {
  name = "${var.project_id}-render-queue"
}

data "google_service_account" "agent" {
  account_id = "kaava-agent"
}

resource "google_service_account" "gpu" {
  account_id   = "kaava-gpu"
  display_name = "OpenKaava GPU node"
}

resource "google_project_iam_member" "gpu" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = google_service_account.gpu.member
}

resource "google_storage_bucket_iam_member" "gpu" {
  for_each = {
    artifacts    = data.google_storage_bucket.artifacts.name
    render_queue = data.google_storage_bucket.render_queue.name
  }
  bucket = each.value
  role   = "roles/storage.objectAdmin"
  member = google_service_account.gpu.member
}

resource "google_compute_instance" "gpu" {
  name                      = "kaava-gpu"
  machine_type              = "g2-standard-8" # the L4 comes with the machine type
  tags                      = ["iap"]
  allow_stopping_for_update = true
  desired_status            = "TERMINATED"
  labels                    = { stack = "gpu", role = "gpu" }

  boot_disk {
    initialize_params {
      # Ubuntu 24.04 with the NVIDIA driver already installed, so boot does not spend minutes
      # building a kernel module every time the node wakes.
      image = "ubuntu-os-accelerator-images/ubuntu-accelerator-2404-amd64-with-nvidia-580"
      size  = 100
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = data.google_compute_subnetwork.kaava.self_link
  }

  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "STOP"
  }

  service_account {
    email  = google_service_account.gpu.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = false # the NVIDIA module is not signed for Secure Boot
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin     = "TRUE"
    startup-script     = file("${path.module}/../../gpu/startup.sh")
    kaava-render-agent = file("${path.module}/../../gpu/render-agent.sh")
    kaava-turntable    = file("${path.module}/../../gpu/turntable.py")
    kaava-render-queue = data.google_storage_bucket.render_queue.name
    kaava-idle-minutes = tostring(var.idle_minutes)
  }
}

# Agent VMs start this node and nothing else. instanceAdmin on the one instance, not the
# project, and actAs on its service account because starting an instance runs it as that account.
resource "google_compute_instance_iam_member" "worker_starts_gpu" {
  instance_name = google_compute_instance.gpu.name
  zone          = var.zone
  role          = "roles/compute.instanceAdmin.v1"
  member        = data.google_service_account.agent.member
}

resource "google_service_account_iam_member" "worker_acts_as_gpu" {
  service_account_id = google_service_account.gpu.name
  role               = "roles/iam.serviceAccountUser"
  member             = data.google_service_account.agent.member
}

output "instance" {
  value = google_compute_instance.gpu.name
}
