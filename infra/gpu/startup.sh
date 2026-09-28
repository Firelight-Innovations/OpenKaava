#!/usr/bin/env bash
# GPU node startup script (PRD P4-1, P4-2, P4-3).
#
# Runs as root on every boot. Installs Blender once (the boot disk survives a stop), then starts
# the render agent, which drains the queue and powers the node off when idle. The NVIDIA driver
# comes with the image.

set -euo pipefail

BLENDER_VERSION="4.5.14"

log() { echo "[kaava-gpu] $*"; }
meta() {
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

export DEBIAN_FRONTEND=noninteractive
if [ ! -f /var/lib/kaava/apt-done ]; then
  apt-get update -q
  apt-get install -yq --no-install-recommends ca-certificates curl jq xz-utils \
    libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libgl1 libegl1 libglu1-mesa
  mkdir -p /var/lib/kaava && touch /var/lib/kaava/apt-done
fi
command -v gcloud >/dev/null || snap install google-cloud-cli --classic

if [ ! -x "/opt/blender/$BLENDER_VERSION/blender" ]; then
  log "installing Blender $BLENDER_VERSION"
  mkdir -p "/opt/blender/$BLENDER_VERSION"
  curl -fsSL "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C "/opt/blender/$BLENDER_VERSION" --strip-components=1
fi
ln -sfn "/opt/blender/$BLENDER_VERSION/blender" /usr/local/bin/blender

nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || log "WARNING: no GPU visible; renders fall back to CPU"

mkdir -p /etc/kaava /opt/kaava
cat >/etc/kaava/env <<EOF
KAAVA_RENDER_QUEUE=$(meta kaava-render-queue)
KAAVA_IDLE_MINUTES=$(meta kaava-idle-minutes)
EOF
meta kaava-render-agent >/opt/kaava/render-agent.sh
meta kaava-turntable >/opt/kaava/turntable.py
chmod 755 /opt/kaava/render-agent.sh

cat >/etc/systemd/system/kaava-render-agent.service <<'EOF'
[Unit]
Description=OpenKaava render queue agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/kaava/render-agent.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kaava-render-agent.service
systemctl restart kaava-render-agent.service
log "render agent running"
