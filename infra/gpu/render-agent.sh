#!/usr/bin/env bash
# Render agent (PRD P4-2, P4-3). Runs on the GPU node as kaava-render-agent.service.
#
# Drains the render queue one job at a time, then powers the machine off after KAAVA_IDLE_MINUTES
# with nothing to do. The idle clock starts at boot, so a node started by mistake also stops.
# See render.sh for the queue layout.

set -uo pipefail
. /etc/kaava/env

queue="gs://$KAAVA_RENDER_QUEUE"
idle_limit=$((KAAVA_IDLE_MINUTES * 60))
last_work=$(date +%s)

log() { echo "[kaava-render-agent] $*"; }

finish() {
  local id=$1 body=$2
  echo "$body" | gcloud storage cp --quiet - "$queue/done/$id.json"
  gcloud storage rm --quiet --recursive "$queue/jobs/$id/" || true
}

run_job() {
  local job_url=$1 id work job output frames res
  id=$(basename "$(dirname "$job_url")")
  work=$(mktemp -d)
  log "job $id"

  gcloud storage cp --quiet "$job_url" "$work/job.json" || return
  gcloud storage cp --quiet "$queue/jobs/$id/input.glb" "$work/input.glb" || return
  output=$(jq -r .output "$work/job.json")
  frames=$(jq -r .frames "$work/job.json")
  res=$(jq -r .resolution "$work/job.json")

  local started=$SECONDS
  if blender -b --python /opt/kaava/turntable.py -- "$work/input.glb" "$work/out" "$frames" "$res" \
    >"$work/blender.log" 2>&1 && gcloud storage cp --quiet "$work"/out/*.png "$output"; then
    finish "$id" "$(jq -n --arg out "$output" --argjson s $((SECONDS - started)) \
      '{status: "ok", output: $out, seconds: $s}')"
    log "job $id ok in $((SECONDS - started))s"
  else
    finish "$id" "$(jq -n --arg log "$(tail -20 "$work/blender.log")" '{status: "error", log: $log}')"
    log "job $id failed"
  fi
  rm -rf "$work"
}

while true; do
  job=$(gcloud storage ls "$queue/jobs/*/job.json" 2>/dev/null | head -1)
  if [ -n "$job" ]; then
    run_job "$job"
    last_work=$(date +%s)
  elif [ $(($(date +%s) - last_work)) -ge "$idle_limit" ]; then
    log "idle for ${KAAVA_IDLE_MINUTES}m; powering off"
    shutdown -h now
    exit 0
  fi
  sleep 15
done
