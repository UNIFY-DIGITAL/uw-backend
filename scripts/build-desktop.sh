#!/usr/bin/env bash
# Build Puter's desktop (GUI) at the commit our image runs, with our desktop
# extensions (gui-extensions/: branding) bundled in. Output: vendor/puter/src/gui/dist,
# mounted over the image's copy by docker-compose.override.yml.
# Runs in a throwaway node:24 container; nothing is installed on the host.
set -euo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
. "$SUITE/scripts/lib/suite.sh"   # NODE_BUILD_IMAGE, PUTER_GIT_URL (and REGISTRY) from .env
# The commit the pinned image was built from (its revision label), so the
# desktop always matches the server: there is no second version to keep in step.
IMAGE=$(cd "$SUITE" && docker compose config --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['services']['puter']['image'])")
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null
PUTER_COMMIT=${PUTER_COMMIT:-$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')}
[ -n "$PUTER_COMMIT" ] || { echo "the image $IMAGE has no revision label; set PUTER_COMMIT"; exit 1; }
# A fresh checkout of the suite has no vendor/puter (not in git): clone Puter's
# source once, from .env PUTER_GIT_URL (our mirror on servers). A start before
# the first build leaves only Docker's empty, root-owned mount folder
# (vendor/puter/src/gui/dist), which git cannot clone into: clear it first.
if [ -e "$SUITE/vendor/puter" ] && [ ! -d "$SUITE/vendor/puter/.git" ]; then
  echo "clearing vendor/puter: Docker's empty mount folders, not a checkout"
  docker run --rm -v "$SUITE/vendor:/v" "$ALPINE_IMAGE" rm -rf /v/puter
fi
puter_source || { echo "cannot get Puter's source from $PUTER_GIT_URL (.env PUTER_GIT_URL)"; exit 1; }
git -C "$SUITE/vendor/puter" cat-file -e "$PUTER_COMMIT^{commit}" 2>/dev/null || puter_source fetch
git -C "$SUITE/vendor/puter" checkout -q "$PUTER_COMMIT"
echo "building the desktop at Puter ${PUTER_COMMIT:0:8} (the revision of $IMAGE)"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$SUITE/vendor/puter:/src" -v "$SUITE/gui-extensions:/ext:ro" -w /src "$NODE_BUILD_IMAGE" sh -c '
    set -e
    # Reinstall whenever the lockfile changed (a new Puter revision), not only when missing.
    want=$(sha256sum package-lock.json | cut -c1-16)
    if [ "$(cat node_modules/.unify-lock 2>/dev/null)" != "$want" ]; then
      rm -rf node_modules && npm ci --no-audit --no-fund --ignore-scripts >/dev/null && echo "$want" > node_modules/.unify-lock
    fi
    cd src/gui && PUTER_GUI_EXTENSION_PATHS=/ext node build.js'
ls -la "$SUITE/vendor/puter/src/gui/dist" | head
# The rebuild replaces dist/, so a running container still holds the old,
# deleted folder (blank desktop). Restart it so the mount points at the new one.
if docker ps --format '{{.Names}}' | grep -qx puter; then (cd "$SUITE" && docker compose restart puter); fi
