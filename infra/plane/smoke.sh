#!/usr/bin/env bash
# The Plane smoke suite (Plane design A5.2). Run it before and after every upgrade.
#
#   infra/plane/smoke.sh                  # prod, through the IAP tunnel on 127.0.0.1:8765
#   infra/plane/smoke.sh --profile dev    # the local instance on :8766
#
# Checks, in order: health (both paths), API CRUD on a throwaway work item in KAAVA, one MCP
# round trip from the worker (plane-mcp-check), plane-watch running on plane-vm, and
# `kaava-project show`. Prod needs the tunnel open (infra/plane/README.md) and plane-vm awake;
# the MCP step starts kaava-worker if it is stopped. dev skips the two steps that need a VM.
#
# Leaves nothing behind: the work item is deleted even when a later step fails. Exits non-zero on
# the first failure. Tokens are read into variables, never printed.

set -euo pipefail

profile=prod
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile=$2; shift 2 ;;
    *) echo "usage: smoke.sh [--profile prod|dev]" >&2; exit 2 ;;
  esac
done

gcp=veistra-prod
zone=us-central1-a
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
if [ "$profile" = prod ]; then
  connect=${KAAVA_PLANE_CONNECT:-http://127.0.0.1:8765}
  host=plane.kaava.internal:8765
  secret=plane-pat-kaava
else
  connect=http://localhost:8766
  host=localhost:8766
  secret=plane-dev-pat-kaava
fi
api="$connect/api/v1/workspaces/veistra"
py=$(command -v python3 || command -v python)

pass() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }
json() { "$py" -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

token=$(gcloud secrets versions access latest --secret "$secret" --project "$gcp" 2>/dev/null) ||
  fail "cannot read $secret from Secret Manager"
call() { # method path [json body]
  curl -fsS -X "$1" -H "Host: $host" -H "X-API-Key: $token" -H "Content-Type: application/json" \
    ${3:+--data "$3"} "$api$2"
}

# 1. Health: the design's two paths (V1).
for path in / /api/instances/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: $host" "$connect$path" || true)
  [ "$code" = 200 ] || fail "health $path returned $code (is the tunnel open and plane-vm awake?)"
done
pass "health: / and /api/instances/"

# 2. API CRUD on a throwaway work item.
project=$(call GET /projects/ | json "next(p['id'] for p in d['results'] if p['identifier']=='KAAVA')") ||
  fail "project KAAVA not found"
item=$(call POST "/projects/$project/work-items/" '{"name":"smoke: delete me"}' | json "d['id']") ||
  fail "create work item"
trap 'call DELETE "/projects/$project/work-items/$item/" >/dev/null 2>&1 || echo "FAIL  could not delete smoke work item $item" >&2' EXIT
call PATCH "/projects/$project/work-items/$item/" '{"name":"smoke: updated"}' >/dev/null || fail "update work item"
name=$(call GET "/projects/$project/work-items/$item/" | json "d['name']") || fail "read work item"
[ "$name" = "smoke: updated" ] || fail "read back '$name' after update"
call POST "/projects/$project/work-items/$item/comments/" '{"comment_html":"<p>smoke</p>"}' >/dev/null ||
  fail "comment"
call DELETE "/projects/$project/work-items/$item/" >/dev/null || fail "delete work item"
trap - EXIT
pass "API: create, update, read, comment, delete"

if [ "$profile" = prod ]; then
  # 3. MCP from where agents use it.
  status=$(gcloud compute instances describe kaava-worker --zone "$zone" --project "$gcp" --format 'value(status)')
  if [ "$status" != RUNNING ]; then
    echo "      kaava-worker is $status; starting it for the MCP step"
    gcloud compute instances start kaava-worker --zone "$zone" --project "$gcp" --quiet >/dev/null
    for _ in $(seq 1 30); do
      gcloud compute ssh kaava-worker --zone "$zone" --project "$gcp" --tunnel-through-iap \
        --command true >/dev/null 2>&1 && break
      sleep 10
    done
  fi
  gcloud compute ssh kaava-worker --zone "$zone" --project "$gcp" --tunnel-through-iap \
    --command 'plane-mcp-check >/dev/null 2>&1 && echo plane-mcp-check-passed' 2>/dev/null |
    grep -q plane-mcp-check-passed ||
    fail "plane-mcp-check on kaava-worker"
  pass "MCP: plane-mcp-check on kaava-worker"

  # 4. plane-watch is up and polling.
  gcloud compute ssh plane-vm --zone "$zone" --project "$gcp" --tunnel-through-iap \
    --command 'sudo docker ps --filter name=plane-watch --filter status=running --format "{{.Names}}"' |
    grep -q plane-watch || fail "plane-watch is not running on plane-vm"
  pass "plane-watch running"
else
  echo "skip  MCP and plane-watch (no VM in the dev profile)"
fi

# 5. The project CLI, on the project each profile always has.
slug=openkaava
[ "$profile" = dev ] && slug=sandbox
KAAVA_PLANE_CONNECT=$connect "$py" "$repo/tools/kaava-project/kaava_project.py" \
  show "$slug" --profile "$profile" --json >/dev/null || fail "kaava-project show $slug"
pass "kaava-project show $slug"

echo "smoke: passed ($profile)"
