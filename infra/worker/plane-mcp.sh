#!/usr/bin/env bash
# Launches the Plane MCP server for a Claude Code session on an agent VM (Plane design 7.2).
#
# boot.sh registers this as the `plane` server in /etc/claude-code/managed-mcp.json. It wakes
# plane-vm if it is stopped, reads the agent's personal access token from Secret Manager into this
# process's environment only, and then becomes the server. stdout carries the MCP protocol, so
# everything else goes to stderr.

set -euo pipefail
exec 3>&1 1>&2

[ -r /etc/veistra/env ] && . /etc/veistra/env
url=${VEISTRA_PLANE_URL:?VEISTRA_PLANE_URL is not set in /etc/veistra/env}
project=${VEISTRA_PROJECT:?VEISTRA_PROJECT is not set in /etc/veistra/env}

# A cold start takes 3 to 4 minutes; Claude Code waits for it (MCP_TIMEOUT in managed settings).
/opt/veistra/bin/veistra-wake plane --project "$project" --quiet

token=$(curl -fsS -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" |
  jq -r .access_token)
PLANE_API_KEY=$(curl -fsS -H "Authorization: Bearer $token" \
  "https://secretmanager.googleapis.com/v1/projects/$project/secrets/plane-pat-agent/versions/latest:access" |
  jq -r .payload.data | base64 -d | tr -d '\r\n')
[ -n "$PLANE_API_KEY" ] || { echo "plane-mcp: secret plane-pat-agent is empty"; exit 1; }

export PLANE_API_KEY PLANE_BASE_URL="$url" PLANE_WORKSPACE_SLUG=veistra
exec 1>&3 3>&-
exec /opt/veistra/plane-mcp/bin/plane-mcp-server stdio
