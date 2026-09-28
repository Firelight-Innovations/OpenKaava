# Hindsight: the shared agent memory service (PRD Phase 5, ORC-ARC-003).
#
# One service for every agent, wherever it runs: agent VMs, the GPU node's jobs, Claude Code on
# a laptop, and OpenKaava itself. It is a Cloud Run service in front of a Cloud SQL database:
#
#   image      Upstream ghcr.io/vectorize-io/hindsight, pinned, pulled through an Artifact
#              Registry mirror (Cloud Run cannot pull from ghcr.io directly). We build nothing;
#              every setting is an environment variable below.
#   models     Vertex AI for the LLM and embeddings, Discovery Engine for reranking. All three
#              authenticate as the service's own account, so there is no API key anywhere.
#              That is also why the slim image fits: no model runs inside the container.
#   database   Cloud SQL PostgreSQL 17 with pgvector, db-f1-micro, private IP only.
#   access     Google IAM. Callers send a Google ID token; Cloud Run rejects anything else before
#              Hindsight sees it. Agent VMs get theirs from the metadata server, and a laptop from
#              `gcloud auth print-identity-token`.
#
# Cost at idle is the database (about 9 USD a month) plus storage. Cloud Run scales to zero; it
# keeps CPU while an instance is up, because Hindsight's retain and consolidation run in a
# background worker after the request that queued them has already returned.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "hindsight"
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

variable "hindsight_version" {
  type        = string
  description = "Upstream release tag. The -slim variant carries no local models."
  default     = "0.10.1-slim"
}

variable "llm_model" {
  type        = string
  description = "Vertex AI model for retain, recall and reflect. Cheapest capable Gemini at the time of writing; 2.5 Flash retires on 2026-10-16."
  default     = "gemini-3.1-flash-lite"
}

variable "llm_location" {
  type        = string
  description = "Vertex AI location for the LLM. Gemini 3.x answers only at the global endpoint, not in a region."
  default     = "global"
}

variable "db_tier" {
  type    = string
  default = "db-f1-micro"
}

variable "invokers" {
  type        = list(string)
  description = "Extra IAM members allowed to call Hindsight. Project owners and kaava-agent already can."
  default     = []
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_compute_network" "kaava" {
  name = "kaava"
}

data "google_compute_subnetwork" "kaava" {
  name   = "kaava-${var.region}"
  region = var.region
}

# --- Image -------------------------------------------------------------------------------------

resource "google_artifact_registry_repository" "ghcr" {
  repository_id = "ghcr"
  location      = var.region
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  description   = "Pull-through cache of ghcr.io"

  remote_repository_config {
    description = "ghcr.io"
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
  }

  # A cache, not a store: drop anything not pulled for a month so old versions stop costing.
  cleanup_policies {
    id     = "expire-cache"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }
}

locals {
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.ghcr.repository_id}/vectorize-io/hindsight:${var.hindsight_version}"
}

# --- Database ----------------------------------------------------------------------------------

resource "google_sql_database_instance" "hindsight" {
  name                = "kaava-hindsight"
  database_version    = "POSTGRES_17"
  region              = var.region
  deletion_protection = true

  settings {
    # PostgreSQL 16 and later default to Enterprise Plus, which has no shared-core tiers.
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.kaava.id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = false
      backup_retention_settings {
        retained_backups = 7
      }
    }

    insights_config {
      query_insights_enabled = false
    }
  }
}

resource "google_sql_database" "hindsight" {
  name     = "hindsight"
  instance = google_sql_database_instance.hindsight.name
}

# Alphanumeric so it needs no escaping inside the connection URL.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "hindsight" {
  name     = "hindsight"
  instance = google_sql_database_instance.hindsight.name
  password = random_password.db.result
}

# The password is in this stack's state (in the private state bucket) and in this secret. It is in
# no file, image or repository (PRD constraint 5).
resource "google_secret_manager_secret" "database_url" {
  secret_id = "hindsight-database-url"
  labels    = { managed-by = "terraform", stack = "hindsight" }
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${google_sql_user.hindsight.name}:${random_password.db.result}@${google_sql_database_instance.hindsight.private_ip_address}:5432/${google_sql_database.hindsight.name}"
}

# --- Service -----------------------------------------------------------------------------------

resource "google_service_account" "hindsight" {
  account_id   = "kaava-hindsight"
  display_name = "Hindsight memory service"
}

resource "google_project_iam_member" "hindsight" {
  for_each = toset(["roles/aiplatform.user", "roles/discoveryengine.user"])
  project  = var.project_id
  role     = each.value
  member   = google_service_account.hindsight.member
}

resource "google_secret_manager_secret_iam_member" "hindsight" {
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.hindsight.member
}

resource "google_cloud_run_v2_service" "hindsight" {
  name     = "hindsight"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.hindsight.email
    max_instance_request_concurrency = 40
    timeout                          = "300s"

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    vpc_access {
      network_interfaces {
        network    = data.google_compute_network.kaava.id
        subnetwork = data.google_compute_subnetwork.kaava.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.image

      ports {
        container_port = 8888
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      # Migrations run on startup, so the first boot against an empty database is the slow one.
      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 5
        failure_threshold = 60
      }

      env {
        name = "HINDSIGHT_API_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      dynamic "env" {
        for_each = {
          # The bundled web UI listens on a second port, and Cloud Run serves one. OpenKaava is
          # the UI.
          HINDSIGHT_ENABLE_CP = "false"

          HINDSIGHT_API_LLM_PROVIDER                   = "vertexai"
          HINDSIGHT_API_LLM_MODEL                      = var.llm_model
          HINDSIGHT_API_LLM_VERTEXAI_PROJECT_ID        = var.project_id
          HINDSIGHT_API_LLM_VERTEXAI_REGION            = var.llm_location
          HINDSIGHT_API_EMBEDDINGS_PROVIDER            = "google"
          HINDSIGHT_API_EMBEDDINGS_GEMINI_MODEL        = "gemini-embedding-001"
          HINDSIGHT_API_EMBEDDINGS_VERTEXAI_PROJECT_ID = var.project_id
          HINDSIGHT_API_RERANKER_PROVIDER              = "google"
          HINDSIGHT_API_RERANKER_GOOGLE_PROJECT_ID     = var.project_id

          # db-f1-micro allows 25 connections. Two instances at 8 each leaves room for a psql.
          HINDSIGHT_API_DB_POOL_MIN_SIZE = "1"
          HINDSIGHT_API_DB_POOL_MAX_SIZE = "8"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.hindsight,
    google_secret_manager_secret_version.database_url,
    google_project_iam_member.hindsight,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(concat(
    ["serviceAccount:kaava-agent@${var.project_id}.iam.gserviceaccount.com"],
    var.invokers,
  ))
  name     = google_cloud_run_v2_service.hindsight.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}

output "url" {
  value = google_cloud_run_v2_service.hindsight.uri
}
