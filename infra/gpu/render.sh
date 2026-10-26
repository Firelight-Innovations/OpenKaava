#!/usr/bin/env bash
# Render client (PRD P4-2). Runs on the worker as /usr/local/bin/veistra-render.
#
#   veistra-render <model.glb> <gs://veistra-artifacts/<game>/<kind>/<id>/v<n>/screenshots/>
#
# Puts the model and a job file in the render queue bucket, starts the GPU node if it is not
# already running, and waits for the node to report the job done. The node stops itself once the
# queue has been empty for 15 minutes, so this script never stops it; a second render inside that
# window reuses the warm machine.
#
# The queue protocol, which render-agent.sh is the other half of:
#   jobs/<id>/input.glb   the model
#   jobs/<id>/job.json    written last; its presence is what makes the job visible
#   done/<id>.json        written by the node: {"status": "ok"|"error", ...}

set -euo pipefail
. /etc/veistra/env

if [ $# -ne 2 ]; then
  echo "usage: veistra-render <model.glb> <gs://.../screenshots/>" >&2
  exit 2
fi
input=$1
output=${2%/}/
frames=${VEISTRA_RENDER_FRAMES:-4}
resolution=${VEISTRA_RENDER_RESOLUTION:-1024}
timeout_min=${VEISTRA_RENDER_TIMEOUT_MIN:-30}

id="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
queue="gs://$VEISTRA_RENDER_QUEUE"

gcloud storage cp --quiet "$input" "$queue/jobs/$id/input.glb"
jq -n --arg id "$id" --arg output "$output" --argjson frames "$frames" --argjson res "$resolution" \
  '{id: $id, output: $output, frames: $frames, resolution: $res}' \
  | gcloud storage cp --quiet - "$queue/jobs/$id/job.json"
echo "queued $id"

status=$(gcloud compute instances describe "$VEISTRA_GPU_INSTANCE" --zone "$VEISTRA_ZONE" \
  --project "$VEISTRA_PROJECT" --format='value(status)')
if [ "$status" != "RUNNING" ]; then
  echo "starting $VEISTRA_GPU_INSTANCE (was $status)"
  gcloud compute instances start "$VEISTRA_GPU_INSTANCE" --zone "$VEISTRA_ZONE" --project "$VEISTRA_PROJECT" --quiet
fi

deadline=$(($(date +%s) + timeout_min * 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if result=$(gcloud storage cat "$queue/done/$id.json" 2>/dev/null); then
    echo "$result"
    [ "$(jq -r .status <<<"$result")" = "ok" ]
    exit
  fi
  sleep 10
done
echo "timed out after ${timeout_min}m waiting for $id" >&2
exit 1
