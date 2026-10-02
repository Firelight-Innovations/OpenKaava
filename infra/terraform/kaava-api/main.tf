# kaava-api: the gateway between the OpenKaava desktop app and Plane (services/kaava-api/).
#
# Before this, the app reached Plane with the owner's gcloud: an IAP tunnel for the REST API, a
# hosts-file entry, and the Plane token read from Secret Manager onto the laptop. Now the app sends
# a Google ID token to this Cloud Run service and the service does the rest:
#
#   access     Google IAM. Only the members in `invokers` hold run.invoker, and the service can
#              narrow them further by email (`allowed_emails`). Nothing is unauthenticated.
#   network    Direct VPC egress onto the kaava subnet, tagged `kaava-api`, and one firewall rule
#              that lets that tag reach plane-vm's port 8765. No load balancer, no NAT, no public
#              IP on plane-vm. Only private ranges go through the VPC; Google APIs go direct.
#   identity   Its own service account, which holds exactly: the Plane token (one secret), the
#              kaavaWaker role on plane-vm (get and start, nothing else), and read access to the
#              project records bucket.
#   image      Built from services/kaava-api/ by `infra/deploy.sh kaava-api` into the
#              Artifact Registry repository below, tagged by the hash of its source.
#
# Cost: nothing always-on. Cloud Run scales to zero (min 0 instances) and bills CPU only while a
# request is in flight; at the app's volume that is inside the free tier. The image repository
# keeps the last three images, about 50 MB each, which is well under a cent a month. Direct VPC
# egress has no hourly charge. See services/kaava-api/README.md, "Cost".
#
# Plane is not changed (design rule 1): this is a client of its REST API like plane-watch is.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "kaava-api"
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

variable "invokers" {
  type        = list(string)
  description = "IAM members allowed to call kaava-api, such as user:braden.seaborn@firelightinnovations.com. Project owners are not added implicitly."
  default     = ["user:braden.seaborn@firelightinnovations.com"]
}

variable "allowed_emails" {
  type        = list(string)
  description = "A second check inside the service: the email in the caller's ID token must be one of these. Empty leaves it to IAM alone."
  default     = ["braden.seaborn@firelightinnovations.com"]
}

variable "oauth_client_ids" {
  type        = list(string)
  description = "OAuth client IDs whose ID tokens Cloud Run accepts as an audience (custom audiences). The OpenKaava desktop sign-in client goes here; see services/kaava-api/README.md."
  default     = []
}

variable "image_tag" {
  type        = string
  description = "Override the image tag. Empty means the hash of the source, which is what deploy.sh builds."
  default     = ""
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  # The same three files, in the same order, that deploy.sh hashes for the tag.
  source_hash = substr(sha256(join("", [
    file("${path.module}/../../../services/kaava-api/Dockerfile"),
    file("${path.module}/../../../services/kaava-api/kaava_api.py"),
    file("${path.module}/../../common/kaava-wake/kaava_wake.py"),
  ])), 0, 12)
  tag   = var.image_tag != "" ? var.image_tag : local.source_hash
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.kaava.repository_id}/kaava-api:${local.tag}"

  plane_port  = 8765
  plane_host  = "plane.kaava.internal:${local.plane_port}"
  network_tag = "kaava-api"
}

data "google_compute_network" "kaava" {
  name = "kaava"
}

data "google_compute_subnetwork" "kaava" {
  name   = "kaava-${var.region}"
  region = var.region
}

# plane-vm's reserved internal address (plane/). The service connects to the address and sends the
# Plane host name as the Host header, so it does not depend on Cloud Run resolving the private
# kaava.internal zone.
data "google_compute_address" "plane" {
  name   = "plane-vm"
  region = var.region
}

data "google_secret_manager_secret" "pat" {
  secret_id = "plane-pat-kaava"
}

# --- Image -------------------------------------------------------------------------------------

resource "google_artifact_registry_repository" "kaava" {
  repository_id = "kaava"
  location      = var.region
  format        = "DOCKER"
  description   = "Images OpenKaava builds itself (kaava-api)"

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }
  cleanup_policies {
    id     = "delete-older"
    action = "DELETE"
    condition {
      tag_state = "ANY"
    }
  }
}

# --- Identity ------------------------------------------------------------------------------------

resource "google_service_account" "api" {
  account_id   = "kaava-api"
  display_name = "kaava-api: the OpenKaava gateway to Plane"
}

resource "google_secret_manager_secret_iam_member" "pat" {
  secret_id = data.google_secret_manager_secret.pat.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api.member
}

# kaavaWaker (plane/): compute.instances.get and .start, on plane-vm only.
resource "google_compute_instance_iam_member" "wake_plane" {
  instance_name = "plane-vm"
  zone          = var.zone
  role          = "projects/${var.project_id}/roles/kaavaWaker"
  member        = google_service_account.api.member
}

# The project records (design §3.1). Read only; kaava-project and plane-watch write them.
resource "google_storage_bucket_iam_member" "projects" {
  bucket = "veistra-projects"
  role   = "roles/storage.objectViewer"
  member = google_service_account.api.member
}

# --- Network -------------------------------------------------------------------------------------

# Cloud Run instances on Direct VPC egress carry the `kaava-api` tag. The Plane rules in plane/
# target plane-vm's service account, which cannot be combined with source tags, so this one targets
# the `plane` tag that plane-vm also carries.
resource "google_compute_firewall" "api_to_plane" {
  name        = "kaava-api-to-plane"
  network     = data.google_compute_network.kaava.self_link
  direction   = "INGRESS"
  source_tags = [local.network_tag]
  target_tags = ["plane"]
  allow {
    protocol = "tcp"
    ports    = [tostring(local.plane_port)]
  }
}

# --- Service -------------------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "api" {
  name     = "kaava-api"
  location = var.region
  # The laptop calls it over the internet; IAM, not the network, is the gate.
  ingress             = "INGRESS_TRAFFIC_ALL"
  custom_audiences    = var.oauth_client_ids
  deletion_protection = false

  template {
    service_account = google_service_account.api.email
    # A wake request waits for nothing (the app polls status), and a proxied call is bounded by
    # Plane's own 30 s timeout in the service.
    timeout                          = "60s"
    max_instance_request_concurrency = 20

    scaling {
      min_instance_count = 0
      # One instance, so the in-memory rate limiter is the whole budget for plane-pat-kaava.
      max_instance_count = 1
    }

    vpc_access {
      network_interfaces {
        network    = data.google_compute_network.kaava.id
        subnetwork = data.google_compute_subnetwork.kaava.id
        tags       = [local.network_tag]
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        # CPU only while a request is in flight: nothing runs between requests.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 2
        failure_threshold = 15
      }

      env {
        name = "PLANE_PAT"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.pat.secret_id
            version = "latest"
          }
        }
      }

      dynamic "env" {
        for_each = {
          KAAVA_PROJECT   = var.project_id
          KAAVA_ZONE      = var.zone
          PLANE_INSTANCE  = "plane-vm"
          PLANE_URL       = "http://${data.google_compute_address.plane.address}:${local.plane_port}"
          PLANE_HOST      = local.plane_host
          PROJECTS_BUCKET = "veistra-projects"
          ALLOWED_EMAILS  = join(",", var.allowed_emails)
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.pat,
    google_compute_instance_iam_member.wake_plane,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.invokers)
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}

output "url" {
  description = "Paste into OpenKaava: Settings, Cloud, Gateway URL."
  value       = google_cloud_run_v2_service.api.uri
}

output "image" {
  value = local.image
}

output "repository" {
  description = "Where deploy.sh pushes the image."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.kaava.repository_id}"
}
