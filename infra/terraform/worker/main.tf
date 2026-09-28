# Agent VMs (PRD 4, Phase 2). One entry in `agents` is one VM; the PRD's single worker is the
# default. Every one boots the `kaava-agent` image (images/agent/), runs as the shared kaava-agent
# identity (foundation/), and is told where the shared services are through metadata, so a new
# agent needs a line here and nothing else: Hindsight, the registry, the render queue and the
# session records already accept it.
#
# Agent VMs stop themselves after `idle_minutes` with no agent process and nobody logged in, since
# an always-on e2-standard-8 alone would cost more than the monthly budget. Start one with
# `gcloud compute instances start kaava-worker --zone us-central1-a`.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "worker"
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

variable "agents" {
  type = map(object({
    machine_type = optional(string, "e2-standard-8")
    disk_gb      = optional(number, 100)
    idle_minutes = optional(number, 30)
    memory_banks = optional(list(string), ["asset-build", "godot-build"])
  }))
  default = {
    worker = {}
  }
}

variable "artifacts_bucket" {
  type    = string
  default = "veistra-artifacts"
}

variable "gpu_instance" {
  type        = string
  description = "Name of the GPU node kaava-render starts. Must match gpu/."
  default     = "kaava-gpu"
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

data "google_compute_image" "agent" {
  family  = "kaava-agent"
  project = var.project_id
}

data "google_service_account" "agent" {
  account_id = "kaava-agent"
}

data "google_cloud_run_v2_service" "hindsight" {
  name     = "hindsight"
  location = var.region
}

resource "google_compute_instance" "agent" {
  for_each                  = var.agents
  name                      = "kaava-${each.key}"
  machine_type              = each.value.machine_type
  tags                      = ["iap"]
  allow_stopping_for_update = true
  labels                    = { stack = "worker", role = "agent" }

  boot_disk {
    initialize_params {
      image = data.google_compute_image.agent.self_link
      size  = each.value.disk_gb
      type  = "pd-balanced"
    }
  }

  # No access_config block: no external IP (PRD constraint 4).
  network_interface {
    subnetwork = data.google_compute_subnetwork.kaava.self_link
  }

  service_account {
    email  = data.google_service_account.agent.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin      = "TRUE"
    startup-script      = "#!/bin/bash\nexec /opt/kaava/boot.sh"
    kaava-artifacts     = var.artifacts_bucket
    kaava-render-queue  = "${var.project_id}-render-queue"
    kaava-sessions      = "${var.project_id}-sessions"
    kaava-gpu-instance  = var.gpu_instance
    kaava-hindsight-url = data.google_cloud_run_v2_service.hindsight.uri
    kaava-memory-banks  = join(",", each.value.memory_banks)
    kaava-idle-minutes  = tostring(each.value.idle_minutes)
  }

  # A new image does not replace running agents mid-session. Recreate one deliberately with
  # `terraform apply -replace='google_compute_instance.agent["worker"]'`.
  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }
}

output "ssh" {
  value = {
    for k, vm in google_compute_instance.agent :
    k => "gcloud compute ssh ${vm.name} --zone ${var.zone} --project ${var.project_id} --tunnel-through-iap"
  }
}
