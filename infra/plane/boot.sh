#!/bin/bash
# plane-vm boot (Plane design, section 5.3). The startup script: runs as root on every boot.
#
# Everything it needs arrives as instance metadata written by terraform/plane: Plane's compose
# file, our env template, the renderer and kaava-idle. Nothing is baked into an image, and
# setup.sh is never run here, so the only place a secret is written is the tmpfs under /run.
#
# The first boot formats plane-data and installs Docker; every later boot goes straight to
# `compose up`. Docker's data-root is on plane-data, so pulled images and every Plane volume
# (Postgres, MinIO, Redis, RabbitMQ) survive a stop and a boot disk replacement.

set -euo pipefail
log() { echo "[plane-boot] $*"; }
md() {
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

started=$(date +%s)
data=/opt/plane
dev=/dev/disk/by-id/google-plane-data
conf=/opt/plane/compose

log "1/6 mount plane-data"
blkid "$dev" >/dev/null 2>&1 || mkfs.ext4 -q -m 0 -E lazy_itable_init=0,lazy_journal_init=0 "$dev"
mkdir -p "$data"
if ! grep -q " $data " /etc/fstab; then
  echo "UUID=$(blkid -s UUID -o value "$dev") $data ext4 discard,defaults,nofail 0 2" >>/etc/fstab
fi
mountpoint -q "$data" || mount "$data"

log "2/6 docker"
if ! command -v docker >/dev/null; then
  # Configure before installing, so the daemon's first start already uses plane-data, and never
  # starts before the disk is mounted on a later boot.
  mkdir -p /etc/docker /etc/systemd/system/docker.service.d
  cat >/etc/docker/daemon.json <<EOF
{
  "data-root": "$data/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
  printf '[Unit]\nRequiresMountsFor=%s\n' "$data" >/etc/systemd/system/docker.service.d/plane-data.conf
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends docker.io docker-compose-v2
fi
systemctl is-active -q docker || systemctl start docker

log "3/6 render plane.env"
mkdir -p "$conf" /run/plane
chmod 700 /run/plane
md plane-compose >"$conf/docker-compose.yaml"
md plane-compose-override >"$conf/compose.override.yaml"
md plane-env-tmpl >"$conf/plane.env.tmpl"
md plane-render-env >"$conf/render_env.py"
url=$(md plane-url)
port=${url##*:}
python3 "$conf/render_env.py" --template "$conf/plane.env.tmpl" --out /run/plane/plane.env \
  --prefix plane- --param "domain=$(md plane-domain)" --param "web_url=$url" \
  --param "port=$port" --param "https_port=8443"

log "4/6 compose up"
# --force-recreate rebuilds every container from the tmpfs env, so the secrets in Docker's
# container config last only as long as this boot (section 5.3, owner's default).
compose=(docker compose -p plane --env-file /run/plane/plane.env -f "$conf/docker-compose.yaml" -f "$conf/compose.override.yaml")
"${compose[@]}" up -d --force-recreate --remove-orphans --quiet-pull

log "5/6 plane-watch"
# Our own compose project on Plane's network (section 7.3). Its state (the poll cursor and the
# jobs in flight) lives on plane-data, so a stop and boot carries on where it left off.
watch=$data/plane-watch
mkdir -p "$watch/state"
md plane-watch >"$watch/plane_watch.py"
md plane-watch-compose >"$watch/compose.yaml"
KAAVA_WORKER=$(md kaava-worker) KAAVA_ZONE=$(md kaava-worker-zone) \
  docker compose -p plane-watch -f "$watch/compose.yaml" up -d --force-recreate --quiet-pull

log "6/6 kaava-idle"
md kaava-idle >/tmp/kaava_idle.py
cat >/etc/kaava-idle.conf <<EOF
# Written by infra/plane/boot.sh on every boot.
PORTS=$port
IDLE_MINUTES=$(md kaava-idle-minutes)
MIN_UPTIME_MINUTES=20
ACTIVITY_COMMAND=docker logs --since {minutes}m plane-proxy-1
EXTRA_CHECK=test -e $watch/state/busy
PRE_STOP=docker compose -p plane-watch stop; ${compose[*]} stop
EOF
python3 /tmp/kaava_idle.py install

log "compose up after $(($(date +%s) - started))s; Plane answers once the migrator finishes"
