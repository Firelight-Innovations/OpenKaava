# Registry: the artifact bucket every agent output lands in (PRD 4.1, P3-1, ORC-ARC-002), the
# render queue the worker hands frames to the GPU node through, and the session records.
#
# The queue is its own bucket rather than a prefix inside the registry so the registry app lists
# only artifacts, and so queue objects can expire on a lifecycle rule without one ever touching
# an artifact.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "registry"
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
  type        = string
  description = "Bucket names are global. PRD 4.1 names veistra-artifacts; override here if it is taken."
  default     = "veistra-artifacts"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_storage_bucket" "artifacts" {
  name                        = var.artifacts_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = { stack = "registry" }

  # Accept, reject and feedback rewrite manifest.json in place (P3-4). Versioning keeps the
  # previous manifest recoverable; the rule below stops old copies piling up forever.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket" "render_queue" {
  name                        = "${var.project_id}-render-queue"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = { stack = "registry" }

  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }
}

# What every agent session did, for the OpenKaava views that show agent activity, session logs and
# workflow progress. Claude Code hooks on every agent VM write here (images/agent/files/
# kaava-session-hook); infra/README.md documents the layout, which is the contract the UX reads.
# Transcripts are text and small, so they stay in Standard storage and move to Nearline, not away.
resource "google_storage_bucket" "sessions" {
  name                        = "${var.project_id}-sessions"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = { stack = "registry" }

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }
}

# Project records and the AI job queue (Plane design, section 3). Each record links one Plane
# project to its artifacts, repository and Hindsight banks, so OpenKaava lists projects from here
# without waking plane-vm. prod/ and dev/ split the cloud and local Plane instances.
resource "google_storage_bucket" "projects" {
  name                        = "veistra-projects"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = { stack = "registry" }

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

# GCS has no directories. A placeholder makes both prefixes show in a listing before the first
# record lands.
resource "google_storage_bucket_object" "projects_prefix" {
  for_each = toset(["prod", "dev"])
  bucket   = google_storage_bucket.projects.name
  name     = "${each.value}/.keep"
  content  = "\n"
}

# Every agent VM runs as kaava-agent (foundation/), so these grants cover all of them.
resource "google_storage_bucket_iam_member" "agent" {
  for_each = {
    artifacts    = google_storage_bucket.artifacts.name
    render_queue = google_storage_bucket.render_queue.name
    sessions     = google_storage_bucket.sessions.name
    projects     = google_storage_bucket.projects.name
  }
  bucket = each.value
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:kaava-agent@${var.project_id}.iam.gserviceaccount.com"
}

output "sessions_bucket" {
  value = google_storage_bucket.sessions.name
}

output "artifacts_bucket" {
  value = google_storage_bucket.artifacts.name
}

output "projects_bucket" {
  value = google_storage_bucket.projects.name
}

output "render_queue_bucket" {
  value = google_storage_bucket.render_queue.name
}
