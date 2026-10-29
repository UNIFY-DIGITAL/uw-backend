#!/usr/bin/env bash
# Move the suite to another Puter release, safely and in one go.
#
#   scripts/upgrade-puter.sh check              what we run, and what the newest release is
#   scripts/upgrade-puter.sh upgrade [TARGET]   back up, re-pin, rebuild, restart, run every check
#   scripts/upgrade-puter.sh rollback BACKUP    put a backup (data + pin) back
#
# TARGET: a tag of ghcr.io/heyputer/puter (default: main, the newest build) or
# an exact image digest (sha256:...). Staging upgrades to `main`; production
# then takes the exact digest staging passed with, never a tag:
#
#   staging$    scripts/upgrade-puter.sh upgrade                 # prints the digest it pinned
#   production$ scripts/upgrade-puter.sh upgrade sha256:<that digest>
#
# What an upgrade does:
#   1. stops the suite and backs up puter/data, config, .env and the pin to backups/
#   2. regenerates docker-compose.yml from that release's own file, pinned by digest
#      (our only change to it is the pin)
#   3. checks out the release's source in vendor/puter and rebuilds the desktop
#      with our branding (scripts/build-desktop.sh), and re-makes our patch to the
#      page template (scripts/patch-puter.sh)
#   4. starts everything, waits for it, and runs scripts/check-suite.sh
# It stops at the first problem and says how to roll back.
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"   # the organisation's addresses, from .env
cd "$SUITE"
REPO=ghcr.io/heyputer/puter          # where releases come from
MIRROR=${REGISTRY:-ghcr.io}/heyputer/puter   # where this machine takes them from (.env REGISTRY)
VENDOR="$SUITE/vendor/puter"

current_image() { docker compose config --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['services']['puter']['image'])"; }
revision_of() { docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null; }
created_of() { docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.created"}}' 2>/dev/null || true; }

# The multi-platform digest a tag points to now (or a digest, as given).
resolve() {
  local target=${1:-main}
  if [[ $target == sha256:* ]]; then echo "$MIRROR@$target"; return; fi
  local digest
  digest=$(docker buildx imagetools inspect "$REPO:$target" 2>/dev/null | awk '/^Digest:/ {print $2; exit}')
  [ -n "$digest" ] || { echo "cannot resolve $REPO:$target" >&2; exit 1; }
  echo "$REPO@$digest"
}

upstream_changes() { # files of the release that our setup copies or follows
  local from=$1 to=$2
  git -C "$VENDOR" diff --stat "$from" "$to" -- docker-compose.yml Caddyfile config.template.jsonc doc/self-hosting.md 2>/dev/null | tail -6 || true
}

cmd_check() {
  local cur new cur_rev new_rev
  cur=$(current_image); docker image inspect "$cur" >/dev/null 2>&1 || docker pull -q "$cur" >/dev/null
  cur_rev=$(revision_of "$cur")
  new=$(resolve "${1:-main}"); docker pull -q "$new" >/dev/null
  new_rev=$(revision_of "$new")
  git -C "$VENDOR" fetch -q origin
  echo "running:  ${cur#*@}  Puter ${cur_rev:0:8}  ($(git -C "$VENDOR" log -1 --format=%cd --date=short "$cur_rev" 2>/dev/null))"
  echo "newest:   ${new#*@}  Puter ${new_rev:0:8}  ($(git -C "$VENDOR" log -1 --format=%cd --date=short "$new_rev" 2>/dev/null))"
  if [ "$cur_rev" = "$new_rev" ]; then echo "up to date"; return; fi
  echo "commits:  $(git -C "$VENDOR" rev-list --count "$cur_rev..$new_rev")"
  echo "setup files changed upstream (review before upgrading production):"
  upstream_changes "$cur_rev" "$new_rev" | sed 's/^/  /'
}

backup() {
  local rev=$1 name
  name="backups/puter-$(date +%Y%m%d-%H%M%S)-${rev:0:8}.tgz"
  mkdir -p backups && chmod 700 backups
  # As root in a throwaway container: the database files belong to container users.
  docker run --rm -v "$SUITE:/s" -w /s "$ALPINE_IMAGE" sh -c \
    "tar czf '$name' puter/data puter/config puter/patches docker-compose.yml .env && chown $(id -u):$(id -g) '$name' && chmod 600 '$name'"
  echo "$name"
}

wait_up() {
  local i
  for i in $(seq 1 120); do
    # A server that keeps crashing will not come up by waiting.
    if [ "$(docker inspect puter --format '{{.RestartCount}}' 2>/dev/null || echo 0)" -ge 3 ]; then return 1; fi
    if curl -sf -o /dev/null "$API/peer/signaller-info" \
       && docker logs --since 5m puter-chat 2>&1 | grep -q "listening on"; then return 0; fi
    sleep 3
  done
  echo "the suite did not come up in 6 minutes: docker compose ps; docker logs puter" >&2
  return 1
}

cmd_upgrade() {
  local cur cur_rev new new_rev bk
  cur=$(current_image); cur_rev=$(revision_of "$cur" || true)
  new=$(resolve "${1:-main}")
  if [ -n "${REGISTRY:-}" ] && [[ $new == "$REPO@"* ]]; then
    echo "==> copying ${new#*@} to $REGISTRY"
    scripts/mirror-images.sh "$new"
    new="$MIRROR@${new#*@}"
  fi
  echo "==> pulling $new"
  docker pull -q "$new" >/dev/null
  new_rev=$(revision_of "$new")
  [ -n "$new_rev" ] || { echo "the image has no revision label"; exit 1; }
  git -C "$VENDOR" fetch -q origin
  git -C "$VENDOR" cat-file -e "$new_rev^{commit}" || { echo "Puter commit $new_rev not found upstream"; exit 1; }
  if [ "${cur#*@}" = "${new#*@}" ]; then echo "already on ${new#*@}"; exit 0; fi
  echo "    Puter ${cur_rev:0:8} -> ${new_rev:0:8}"
  [ -n "$cur_rev" ] && upstream_changes "$cur_rev" "$new_rev" | sed 's/^/    /'

  echo "==> stopping the suite and backing up"
  docker compose --profile smtp stop >/dev/null
  bk=$(backup "${cur_rev:-unknown}")
  echo "    $bk"
  trap 'echo; echo "!! upgrade stopped. To go back: scripts/upgrade-puter.sh rollback '"$bk"'"' ERR

  echo "==> pinning docker-compose.yml to ${new#*@} (from the release's own file)"
  git -C "$VENDOR" show "$new_rev:docker-compose.yml" > docker-compose.yml.new
  local count
  count=$(grep -c "image: $REPO:main\$" docker-compose.yml.new || true)
  [ "$count" -ge 1 ] || { rm docker-compose.yml.new; echo "the release's docker-compose.yml no longer uses $REPO:main; merge it by hand"; false; }
  sed -i "s#image: $REPO:main\$#image: \${REGISTRY:-ghcr.io}/heyputer/puter@${new#*@}  \# Puter ${new_rev:0:8}; managed by scripts/upgrade-puter.sh#" docker-compose.yml.new
  mv docker-compose.yml.new docker-compose.yml

  echo "==> desktop and page patch for ${new_rev:0:8}"
  scripts/patch-puter.sh
  scripts/build-desktop.sh >/dev/null

  echo "==> starting"
  if ! docker compose --profile smtp up -d >/dev/null 2>&1 || ! wait_up; then
    echo "!! Puter did not start on ${new_rev:0:8}. Its last words:"
    docker logs --tail 25 puter 2>&1 | sed 's/^/   /'
    false
  fi
  trap - ERR

  echo "==> checks"
  if scripts/check-suite.sh; then
    echo
    echo "UPGRADED to Puter ${new_rev:0:8}: ${new#*@}"
    echo "Production: scripts/upgrade-puter.sh upgrade ${new#*@}"
    echo "Back out:   scripts/upgrade-puter.sh rollback $bk"
  else
    echo
    echo "Upgraded, but checks failed (above). Fix forward, or: scripts/upgrade-puter.sh rollback $bk"
    exit 1
  fi
}

cmd_rollback() {
  local bk=${1:?which backup? ls backups/}
  [ -f "$bk" ] || { echo "no such backup: $bk"; exit 1; }
  echo "==> stopping and restoring $bk"
  docker compose --profile smtp stop >/dev/null
  docker run --rm -v "$SUITE:/s" -w /s "$ALPINE_IMAGE" sh -c \
    "rm -rf puter/data && tar xzf '$bk' && chown -R $(id -u):$(id -g) puter/config puter/patches docker-compose.yml .env"
  echo "==> desktop for the restored pin"
  scripts/build-desktop.sh >/dev/null
  docker compose --profile smtp up -d >/dev/null
  wait_up
  echo "restored: $(current_image)"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  upgrade) shift; cmd_upgrade "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
