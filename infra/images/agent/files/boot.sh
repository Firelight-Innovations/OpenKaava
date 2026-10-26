#!/usr/bin/env bash
# Per-boot configuration for an agent VM. The instance's startup-script runs this.
#
# The image carries the software; this writes what differs per deployment, all of it read from
# instance metadata that the worker stack sets. Nothing secret passes through here.

set -euo pipefail

md() {
  curl -fsS -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"
}
attr() { md "instance/attributes/$1" 2>/dev/null || echo "${2:-}"; }

hindsight_url=$(attr veistra-hindsight-url)

cat >/etc/veistra/env <<EOF
VEISTRA_PROJECT=$(md project/project-id)
VEISTRA_ZONE=$(md instance/zone | awk -F/ '{print $NF}')
VEISTRA_AGENT=$(md instance/name)
VEISTRA_ARTIFACTS=$(attr veistra-artifacts)
VEISTRA_RENDER_QUEUE=$(attr veistra-render-queue)
VEISTRA_SESSIONS=$(attr veistra-sessions)
VEISTRA_GPU_INSTANCE=$(attr veistra-gpu-instance)
VEISTRA_HINDSIGHT_URL=$hindsight_url
VEISTRA_IDLE_MINUTES=$(attr veistra-idle-minutes 30)
VEISTRA_PLANE_URL=$(attr veistra-plane-url)
VEISTRA_PROJECTS_BUCKET=$(attr veistra-projects veistra-projects)
VEISTRA_PROFILE=prod
EOF

# One MCP server per memory bank (P5-3), each authenticated with a fresh Google ID token at
# connect time. managed-mcp.json takes exclusive control of MCP on this machine, which on an
# agent VM is what we want: agents get exactly these servers. Plane (Plane design 7.2) is a stdio
# server whose launcher wakes plane-vm and reads the agent's token itself.
banks=$(attr veistra-memory-banks "asset-build,godot-build")
plane_url=$(attr veistra-plane-url)
if [ -n "$hindsight_url$plane_url" ]; then
  jq -n --arg url "${hindsight_url%/}" --arg banks "$banks" --arg plane "$plane_url" '{
    mcpServers: (
      (if $url == "" then {} else $banks | split(",") | map({
        key: "hindsight-\(.)",
        value: {
          type: "http",
          url: "\($url)/mcp/\(.)/",
          headersHelper: "/opt/veistra/bin/veistra-hindsight-headers"
        }
      }) | from_entries end)
      + (if $plane == "" then {} else {plane: {type: "stdio", command: "/opt/veistra/bin/plane-mcp"}} end)
    )
  }' >/etc/claude-code/managed-mcp.json
else
  rm -f /etc/claude-code/managed-mcp.json
fi

echo "[veistra-boot] $(jq -c . /etc/veistra/image.json)"
