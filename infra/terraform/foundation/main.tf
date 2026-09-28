# Foundation: the network every machine sits on.
#
# No VM gets a public IP (PRD constraint 4). Inbound traffic comes only from Google's IAP range;
# outbound goes through Cloud NAT so the machines can still reach apt, GitHub, PyPI and the Claude
# API. Private Google Access lets them reach Cloud Storage and Secret Manager without the NAT.

terraform {
  required_version = ">= 1.9"
  backend "gcs" {
    prefix = "foundation"
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

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_compute_network" "kaava" {
  name                    = "kaava"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "kaava" {
  name                     = "kaava-${var.region}"
  network                  = google_compute_network.kaava.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true
}

resource "google_compute_router" "kaava" {
  name    = "kaava-${var.region}"
  network = google_compute_network.kaava.id
  region  = var.region
}

resource "google_compute_router_nat" "kaava" {
  name                               = "kaava-${var.region}"
  router                             = google_compute_router.kaava.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# 35.235.240.0/20 is the fixed range IAP TCP forwarding connects from. SSH for every machine;
# 8888 and 9999 for Hindsight's API and UI on the worker, reached with `gcloud start-iap-tunnel`.
resource "google_compute_firewall" "iap_ingress" {
  name          = "kaava-allow-iap"
  network       = google_compute_network.kaava.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["iap"]

  allow {
    protocol = "tcp"
    ports    = ["22", "8888", "9999"]
  }
}

# Private services access: the peering Cloud SQL's private IP lives behind. Hindsight's database
# gets no public address; Cloud Run reaches it through Direct VPC egress on the subnet above.
resource "google_compute_global_address" "services" {
  name          = "kaava-google-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.kaava.id
}

resource "google_service_networking_connection" "services" {
  network                 = google_compute_network.kaava.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.services.name]
}

# One identity for every agent VM, whatever it runs. Services grant access to this account, not
# to a machine, so a second or third agent VM needs no grants of its own: it runs as kaava-agent
# and is already allowed to use Hindsight, the registry and the render queue.
resource "google_service_account" "agent" {
  account_id   = "kaava-agent"
  display_name = "OpenKaava agent VMs"
}

resource "google_project_iam_member" "agent" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = google_service_account.agent.member
}

output "agent_service_account" {
  value = google_service_account.agent.email
}

output "network" {
  value = google_compute_network.kaava.name
}

output "subnetwork" {
  value = google_compute_subnetwork.kaava.name
}
