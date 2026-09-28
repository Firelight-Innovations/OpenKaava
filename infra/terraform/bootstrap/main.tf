# Bootstrap: the project itself, the APIs every other stack needs, the bucket that holds every
# other stack's state, and the 150 USD budget (PRD P1-1, constraint 6).
#
# This is the one stack that starts on local state, because the bucket it would store state in
# does not exist until it has run. After the first apply, `deploy.sh migrate-bootstrap` writes
# backend.tf and moves the state into the bucket.

terraform {
  required_version = ">= 1.9"
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

variable "org_id" {
  type        = string
  description = "Google Cloud organization that owns the project (firelightinnovations.com)."
  default     = "537325420599"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID, XXXXXX-XXXXXX-XXXXXX. Null creates the project unbilled; no other stack can apply until it is set."
  default     = null
}

variable "budget_usd" {
  type    = number
  default = 150
}

provider "google" {
  region = var.region
}

# The Budgets API insists on a quota project. It cannot be the default provider's, because the
# project it would name does not exist until this stack has created it.
provider "google" {
  alias                 = "billed"
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

resource "google_project" "this" {
  project_id      = var.project_id
  name            = var.project_id
  org_id          = var.org_id
  billing_account = var.billing_account
  deletion_policy = "PREVENT"
}

locals {
  services = [
    "aiplatform.googleapis.com",       # Hindsight's LLM and embeddings (Vertex AI)
    "artifactregistry.googleapis.com", # the ghcr.io mirror Cloud Run pulls Hindsight from
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "discoveryengine.googleapis.com", # Hindsight's reranker
    "dns.googleapis.com",             # the kaava.internal private zone (plane/)
    "iam.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "oslogin.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com", # Cloud SQL on a private IP
    "serviceusage.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ]
  # Every API but these needs a billing account attached before it will enable.
  free_services = ["cloudbilling.googleapis.com", "cloudresourcemanager.googleapis.com", "serviceusage.googleapis.com", "iam.googleapis.com"]
  enabled       = var.billing_account == null ? local.free_services : local.services
}

resource "google_project_service" "this" {
  for_each           = toset(local.enabled)
  project            = google_project.this.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "tfstate" {
  count                       = var.billing_account == null ? 0 : 1
  project                     = google_project.this.project_id
  name                        = "${var.project_id}-tfstate"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 20
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.this]
}

# Alerts go to the billing account's admins and users by email, which is the default recipient
# list when no notification channel is named. PRD P1-1 asks for 50, 90 and 100 percent.
resource "google_billing_budget" "monthly" {
  provider        = google.billed
  count           = var.billing_account == null ? 0 : 1
  billing_account = var.billing_account
  display_name    = "${var.project_id} monthly"

  budget_filter {
    projects = ["projects/${google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }

  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }

  depends_on = [google_project_service.this]
}

output "project_number" {
  value = google_project.this.number
}

output "state_bucket" {
  value = one(google_storage_bucket.tfstate[*].name)
}
