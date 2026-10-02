#!/usr/bin/env bash
# Plan or apply the OpenKaava cloud stacks, in dependency order.
#
#   infra/deploy.sh plan                  # every stack
#   infra/deploy.sh apply                 # every stack, in order; Terraform asks before each
#   infra/deploy.sh apply worker gpu      # just these
#   infra/deploy.sh image                 # rebuild the agent VM image (Packer)
#   infra/deploy.sh migrate-bootstrap     # once, after bootstrap's first apply
#   infra/deploy.sh apply kaava-api       # the Plane gateway: its repository, its image, then the rest
#   infra/deploy.sh kaava-api-image       # build and push the gateway image only
#
# `image` is a step in the order like the stacks are: `apply` builds the agent image only when
# the project has none yet, and `plan` skips it.
#
# `kaava-api` is a stack with an image of its own (services/kaava-api/). Its `apply` runs in three
# parts, each of which Terraform or Docker shows before it acts: create the Artifact Registry
# repository, build and push the image if that tag is not there yet (needs Docker), then apply the
# whole stack. The tag is a hash of the image's source, so an unchanged service is not rebuilt.
#
# Each stack is its own Terraform root with its own state, so one service can be changed,
# replaced or destroyed without planning the others. Later stacks find earlier ones' resources by
# name through data sources, not through each other's state.
#
# Credentials are Application Default Credentials: `gcloud auth application-default login`.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tf="$here/terraform"
order=(bootstrap foundation secrets registry hindsight image worker gpu plane kaava-api)

action=${1:-plan}
shift || true
stacks=("${@:-${order[@]}}")

project=$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' "$tf/common.tfvars")
region=$(sed -n 's/^region *= *"\(.*\)"/\1/p' "$tf/common.tfvars")
state_bucket="$project-tfstate"

init() {
  local stack=$1
  if [ "$stack" = bootstrap ] && [ ! -f "$tf/bootstrap/backend.tf" ]; then
    terraform -chdir="$tf/$stack" init -input=false >/dev/null
  else
    terraform -chdir="$tf/$stack" init -input=false -backend-config="bucket=$state_bucket" >/dev/null
  fi
}

has_image() {
  gcloud compute images describe-from-family kaava-agent --project "$project" >/dev/null 2>&1
}

build_image() {
  echo "=== image (packer build)"
  packer init "$here/images/agent"
  packer build -var "project_id=$project" "$here/images/agent"
}

# The same three files, in the same order, that terraform/kaava-api hashes for its image tag.
api_sources=("$here/../services/kaava-api/Dockerfile" "$here/../services/kaava-api/kaava_api.py"
  "$here/common/kaava-wake/kaava_wake.py")

api_image() {
  local tag
  tag=$(cat "${api_sources[@]}" | sha256sum | cut -c1-12)
  echo "$region-docker.pkg.dev/$project/kaava/kaava-api:$tag"
}

build_api_image() {
  local image context
  image=$(api_image)
  if gcloud artifacts docker images describe "$image" >/dev/null 2>&1; then
    echo "=== kaava-api image: $image is already pushed"
    return
  fi
  echo "=== kaava-api image: $image (docker build)"
  context=$(mktemp -d)
  cp "${api_sources[@]}" "$context/"
  docker build --platform linux/amd64 -t "$image" "$context"
  rm -rf "$context"
  gcloud auth configure-docker "$region-docker.pkg.dev" --quiet
  docker push "$image"
}

case "$action" in
  image)
    build_image
    ;;
  kaava-api-image)
    build_api_image
    ;;
  plan | apply)
    for stack in "${stacks[@]}"; do
      if [ "$stack" = image ]; then
        [ "$action" = apply ] && ! has_image && build_image
        continue
      fi
      if [ "$stack" = kaava-api ] && [ "$action" = apply ]; then
        echo "=== kaava-api (apply: repository, image, service)"
        init "$stack"
        terraform -chdir="$tf/$stack" apply -var-file="$tf/common.tfvars" \
          -target=google_artifact_registry_repository.kaava
        build_api_image
        terraform -chdir="$tf/$stack" apply -var-file="$tf/common.tfvars"
        continue
      fi
      echo "=== $stack ($action)"
      init "$stack"
      # No -input=false on apply: that is what makes Terraform show the plan and ask first.
      terraform -chdir="$tf/$stack" "$action" -var-file="$tf/common.tfvars"
    done
    ;;
  migrate-bootstrap)
    cat >"$tf/bootstrap/backend.tf" <<'EOF'
# Written by `deploy.sh migrate-bootstrap` once the state bucket existed. Before that, this stack
# kept its state locally, because it is the stack that creates the bucket.
terraform {
  backend "gcs" {
    prefix = "bootstrap"
  }
}
EOF
    terraform -chdir="$tf/bootstrap" init -input=false -migrate-state -force-copy \
      -backend-config="bucket=$state_bucket"
    rm -f "$tf/bootstrap/terraform.tfstate" "$tf/bootstrap/terraform.tfstate.backup"
    ;;
  *)
    echo "usage: deploy.sh plan|apply [stack...] | image | kaava-api-image | migrate-bootstrap" >&2
    exit 2
    ;;
esac
