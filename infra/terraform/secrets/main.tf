# Secrets: the containers only, never the values (PRD constraint 5, P1-4).
#
# Terraform state is readable by anyone who can read the state bucket, so a value applied here
# would sit in plain text in it. Values go in by hand, one command each, and never touch disk:
#
#   claude setup-token                   # prints a one-year OAuth token
#   gcloud secrets versions add claude-oauth-token --data-file=-   # paste it, then Ctrl-D
#
# Hindsight has no secret here: it reaches Vertex AI as its own service account, and its database
# password is generated and stored by the hindsight stack.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "secrets"
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

variable "secrets" {
  type = map(string)
  default = {
    "claude-oauth-token" = "CLAUDE_CODE_OAUTH_TOKEN for headless Claude Code on agent VMs (claude setup-token)."
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_secret_manager_secret" "this" {
  for_each  = var.secrets
  secret_id = each.key
  labels    = { managed-by = "terraform", stack = "secrets" }

  annotations = {
    purpose = each.value
  }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

# Every agent VM runs as kaava-agent (foundation/), so this one grant covers all of them.
resource "google_secret_manager_secret_iam_member" "agent_claude" {
  secret_id = google_secret_manager_secret.this["claude-oauth-token"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:kaava-agent@${var.project_id}.iam.gserviceaccount.com"
}

output "secret_ids" {
  value = [for s in google_secret_manager_secret.this : s.secret_id]
}
