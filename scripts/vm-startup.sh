#!/usr/bin/env bash
# Startup script for a suite VM (Ubuntu 24.04 on Google Cloud): Docker Engine
# with the compose and buildx plugins, git, and container logs kept small.
# Runs as root at every boot; does nothing once everything is there.
#
#   gcloud compute instances create ... --metadata-from-file startup-script=$HOME/unify-suite/scripts/vm-startup.sh
set -euo pipefail
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg git python3
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
fi
# Container logs: the compact local driver, 5 files of 20 MB per container.
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "local",\n  "log-opts": { "max-size": "20m", "max-file": "5" }\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null
