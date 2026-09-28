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

hindsight_url=$(attr kaava-hindsight-url)

cat >/etc/kaava/env <<EOF
KAAVA_PROJECT=$(md project/project-id)
KAAVA_ZONE=$(md instance/zone | awk -F/ '{print $NF}')
KAAVA_AGENT=$(md instance/name)
KAAVA_ARTIFACTS=$(attr kaava-artifacts)
KAAVA_RENDER_QUEUE=$(attr kaava-render-queue)
KAAVA_SESSIONS=$(attr kaava-sessions)
KAAVA_GPU_INSTANCE=$(attr kaava-gpu-instance)
KAAVA_HINDSIGHT_URL=$hindsight_url
KAAVA_IDLE_MINUTES=$(attr kaava-idle-minutes 30)
KAAVA_PLANE_URL=$(attr kaava-plane-url)
KAAVA_PROJECTS_BUCKET=$(attr kaava-projects veistra-projects)
KAAVA_PROFILE=prod
EOF

# One MCP server per memory bank (P5-3), each authenticated with a fresh Google ID token at
# connect time. managed-mcp.json takes exclusive control of MCP on this machine, which on an
# agent VM is what we want: agents get exactly these servers. Plane (Plane design 7.2) is a stdio
# server whose launcher wakes plane-vm and reads the agent's token itself.
banks=$(attr kaava-memory-banks "asset-build,godot-build")
plane_url=$(attr kaava-plane-url)
if [ -n "$hindsight_url$plane_url" ]; then
  jq -n --arg url "${hindsight_url%/}" --arg banks "$banks" --arg plane "$plane_url" '{
    mcpServers: (
      (if $url == "" then {} else $banks | split(",") | map({
        key: "hindsight-\(.)",
        value: {
          type: "http",
          url: "\($url)/mcp/\(.)/",
          headersHelper: "/opt/kaava/bin/kaava-hindsight-headers"
        }
      }) | from_entries end)
      + (if $plane == "" then {} else {plane: {type: "stdio", command: "/opt/kaava/bin/plane-mcp"}} end)
    )
  }' >/etc/claude-code/managed-mcp.json
else
  rm -f /etc/claude-code/managed-mcp.json
fi

echo "[kaava-boot] $(jq -c . /etc/kaava/image.json)"
