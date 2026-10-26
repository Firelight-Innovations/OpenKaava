#!/usr/bin/env bash
# Provisions the agent image. Runs once, as root, inside the Packer build VM.
#
# This file is the answer to "what is on an agent VM". Change a version here, run
# `infra/deploy.sh image`, and recreate the VMs.

set -euo pipefail

GODOT_VERSION="4.5.2"
BLENDER_VERSION="4.5.14"
NODE_MAJOR="22"

export DEBIAN_FRONTEND=noninteractive
log() { echo "[veistra-image] $*"; }

log "base packages"
apt-get update -q
# Blender links the X and GL client libraries at load time, even with -b. Godot loads fontconfig
# at start-up, headless or not.
apt-get install -yq --no-install-recommends \
  ca-certificates curl gnupg jq unzip xz-utils git tmux ripgrep \
  python3 python3-venv python3-pip pipx \
  libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libgl1 libegl1 libglu1-mesa \
  libfontconfig1
command -v gcloud >/dev/null || snap install google-cloud-cli --classic

log "Node.js $NODE_MAJOR and Claude Code"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
apt-get install -yq nodejs
npm install -g @anthropic-ai/claude-code

log "Godot $GODOT_VERSION"
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/godot.zip" \
  "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip"
unzip -q "$tmp/godot.zip" -d "$tmp"
install -D -m 755 "$tmp"/Godot_v*_linux.x86_64 "/opt/godot/$GODOT_VERSION/godot"
ln -sfn "/opt/godot/$GODOT_VERSION/godot" /usr/local/bin/godot
rm -rf "$tmp"

log "Blender $BLENDER_VERSION"
mkdir -p "/opt/blender/$BLENDER_VERSION"
curl -fsSL "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
  | tar -xJ -C "/opt/blender/$BLENDER_VERSION" --strip-components=1
ln -sfn "/opt/blender/$BLENDER_VERSION/blender" /usr/local/bin/blender

# Vendored from tools/ in this repository (stdlib Python, no install step). PRD P1-3 names a PyPI
# package `ste100-linter`; no such package exists.
log "ste100 linter (P1-3)"
rm -rf /opt/ste100 && cp -r /tmp/veistra-files/ste100 /opt/ste100
find /opt/ste100 -name __pycache__ -prune -exec rm -rf {} +
printf '#!/bin/sh\nexec python3 /opt/ste100/ste_lint.py "$@"\n' >/usr/local/bin/ste100
chmod 755 /usr/local/bin/ste100
ste100 --help >/dev/null

log "Veistra tools"
install -d /opt/veistra/bin /etc/veistra /etc/claude-code
install -m 755 /tmp/veistra-files/boot.sh /opt/veistra/boot.sh
for tool in veistra-render veistra-smoke-test veistra-session-hook veistra-hindsight-headers veistra-idle-check veistra-wake; do
  install -m 755 "/tmp/veistra-files/$tool" "/opt/veistra/bin/$tool"
  ln -sfn "/opt/veistra/bin/$tool" "/usr/local/bin/$tool"
done

# Plane MCP (Plane design 7.2): its own venv, every package pinned by hash. boot.sh registers the
# launcher as the `plane` MCP server; plane-mcp-check is the verify-first test and smoke step.
log "Plane MCP server"
python3 -m venv /opt/veistra/plane-mcp
/opt/veistra/plane-mcp/bin/pip install -q --no-deps --require-hashes \
  -r /tmp/veistra-files/worker/requirements-mcp.txt
/opt/veistra/plane-mcp/bin/python -c "import plane_mcp, mcp"
install -m 755 /tmp/veistra-files/worker/plane-mcp.sh /opt/veistra/bin/plane-mcp
{
  echo '#!/opt/veistra/plane-mcp/bin/python'
  tail -n +2 /tmp/veistra-files/worker/plane_mcp_check.py
} >/opt/veistra/bin/plane-mcp-check
chmod 755 /opt/veistra/bin/plane-mcp-check
ln -sfn /opt/veistra/bin/plane-mcp-check /usr/local/bin/plane-mcp-check

# AI jobs (Plane design 8.1): veistra-jobs claims queued jobs and runs each as `claude -p`, one at a
# time, as its own user so a session never runs as root. The timer ticks every minute while the
# VM is up; an empty queue costs two bucket listings.
log "veistra-jobs"
install -m 755 /tmp/veistra-files/worker/veistra_jobs.py /opt/veistra/bin/veistra-jobs
ln -sfn /opt/veistra/bin/veistra-jobs /usr/local/bin/veistra-jobs
rm -rf /opt/veistra/prompts && install -d /opt/veistra/prompts
install -m 644 /tmp/veistra-files/worker/prompts/*.md /opt/veistra/prompts/
id veistra-jobs >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/veistra-jobs --shell /usr/sbin/nologin veistra-jobs
cat >/etc/systemd/system/veistra-jobs.service <<'EOF'
[Unit]
Description=Run queued AI jobs from Plane
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=veistra-jobs
Environment=VEISTRA_JOBS_PROMPTS=/opt/veistra/prompts
ExecStart=/opt/veistra/bin/veistra-jobs run
EOF
cat >/etc/systemd/system/veistra-jobs.timer <<'EOF'
[Unit]
Description=Look for queued AI jobs every minute

[Timer]
OnBootSec=30s
OnUnitInactiveSec=1min

[Install]
WantedBy=timers.target
EOF
systemctl enable veistra-jobs.timer

# Every login shell: deployment config from boot.sh, and the Claude token read fresh from Secret
# Manager into the environment only. An empty secret leaves the variable unset.
cat >/etc/profile.d/veistra.sh <<'EOF'
[ -r /etc/veistra/env ] && { set -a; . /etc/veistra/env; set +a; }
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${VEISTRA_PROJECT:-}" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(gcloud secrets versions access latest --secret=claude-oauth-token \
    --project="$VEISTRA_PROJECT" 2>/dev/null) && export CLAUDE_CODE_OAUTH_TOKEN || unset CLAUDE_CODE_OAUTH_TOKEN
fi
EOF

# Claude Code settings every user on the VM gets and cannot override. The hooks record each
# session to the sessions bucket for Veistra's agent views; each returns at once and uploads in
# the background, so an agent never waits on them. The Hindsight MCP servers are written at boot
# by boot.sh, because their URL is per deployment. MCP_TIMEOUT covers the Plane MCP launcher
# waking a stopped plane-vm, which takes up to 4.5 minutes; the default is 30 seconds.
hook='{ "hooks": [{ "type": "command", "command": "/opt/veistra/bin/veistra-session-hook", "timeout": 5 }] }'
jq -n --argjson h "$hook" '{
  env: { MCP_TIMEOUT: "300000" },
  hooks: {
    SessionStart: [$h], UserPromptSubmit: [$h], Stop: [$h], SubagentStop: [$h], SessionEnd: [$h]
  }
}' >/etc/claude-code/managed-settings.json

cat >/etc/systemd/system/veistra-idle.service <<'EOF'
[Unit]
Description=Stop this agent VM when nothing has run for a while

[Service]
Type=oneshot
ExecStart=/opt/veistra/bin/veistra-idle-check
EOF
cat >/etc/systemd/system/veistra-idle.timer <<'EOF'
[Unit]
Description=Check for agent VM idleness every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
systemctl enable veistra-idle.timer

jq -n \
  --arg built "$(date -u +%FT%TZ)" \
  --arg claude "$(claude --version 2>/dev/null | head -1)" \
  --arg godot "$GODOT_VERSION" --arg blender "$BLENDER_VERSION" \
  --arg node "$(node --version)" --arg python "$(python3 --version | cut -d' ' -f2)" \
  --arg ste100 "vendored tools/ste_lint.py" \
  --arg plane_mcp "$(/opt/veistra/plane-mcp/bin/pip show plane-mcp-server | awk '/^Version/{print $2}')" \
  '{built: $built, claude: $claude, godot: $godot, blender: $blender, node: $node, python: $python, ste100: $ste100, plane_mcp: $plane_mcp}' \
  >/etc/veistra/image.json
cat /etc/veistra/image.json

apt-get clean
rm -rf /tmp/veistra-files /var/lib/apt/lists/*
