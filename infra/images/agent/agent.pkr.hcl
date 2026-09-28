# The agent VM image (PRD P7-6, brought forward). Every agent VM boots from image family
# `kaava-agent`, so what an agent has is exactly what this template and provision.sh put there,
# and a new VM is ready in about a minute instead of the fifteen a from-scratch install takes.
#
#   infra/deploy.sh image        # build a new image; VMs pick it up when recreated
#
# What is on it: see provision.sh, which also writes the exact versions to /etc/kaava/image.json
# on the image. What is NOT on it: anything per-deployment (bucket names, the Hindsight URL) or
# secret. Those come from instance metadata and Secret Manager at boot (files/boot.sh), so one
# image serves every VM and every project.
#
# The build VM has no public IP, like every other machine here; Packer reaches it through IAP.

packer {
  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = ">= 1.1.0"
    }
  }
}

variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

source "googlecompute" "agent" {
  project_id              = var.project_id
  zone                    = var.zone
  source_image_family     = "ubuntu-2404-lts-amd64"
  source_image_project_id = ["ubuntu-os-cloud"]
  image_name              = "kaava-agent-{{timestamp}}"
  image_family            = "kaava-agent"
  image_description       = "OpenKaava agent: Claude Code, Godot, Blender, Hindsight MCP, session hooks"
  image_labels            = { built-by = "packer" }
  machine_type            = "e2-standard-4"
  disk_size               = 30
  disk_type               = "pd-balanced"
  subnetwork              = "kaava-${var.region}"
  omit_external_ip        = true
  use_internal_ip         = true
  use_iap                 = true
  tags                    = ["iap"]
  ssh_username            = "packer"
  service_account_email   = "kaava-agent@${var.project_id}.iam.gserviceaccount.com"
  scopes                  = ["https://www.googleapis.com/auth/cloud-platform"]
}

build {
  sources = ["source.googlecompute.agent"]

  # A directory upload copies into its destination and does not create it; without this the
  # first upload leaves /tmp/kaava-files as a plain file.
  provisioner "shell" {
    inline = ["mkdir -p /tmp/kaava-files/ste100"]
  }

  provisioner "file" {
    source      = "${path.root}/files/"
    destination = "/tmp/kaava-files"
  }

  provisioner "file" {
    source      = "${path.root}/../../gpu/render.sh"
    destination = "/tmp/kaava-files/kaava-render"
  }

  # The STE writing linter, vendored in this repository. It is not on PyPI, whatever PRD P1-3
  # assumed, so the image carries the copy the repository already lints with.
  provisioner "file" {
    source      = "${path.root}/../../../tools/"
    destination = "/tmp/kaava-files/ste100"
  }

  provisioner "shell" {
    script          = "${path.root}/provision.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }
}
