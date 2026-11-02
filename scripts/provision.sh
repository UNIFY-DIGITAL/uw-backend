#!/usr/bin/env bash
# From a fresh clone (or any later state) to a working suite, in order, each
# step checked: it stops at the first problem with the reason and the fix,
# instead of carrying on into errors that hide it. Safe to run again.
#
#   scripts/provision.sh            settings and DNS checks, build, start, accounts, apps, final checks
#   scripts/provision.sh --check    only the checks before anything starts
#   scripts/provision.sh --fresh    first delete puter/data (every account, file, message and the
#                                   database) and start empty: asks you to type the domain (--yes: no prompt)
#
# Needs: .env (from .env.production.example), Docker usable by you, and for
# TLS_MODE=auto the domain and *.domain pointing at this server.
set -euo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
cd "$SUITE"
CHECK_ONLY=0; FRESH=0; YES=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;; --fresh) FRESH=1 ;; --yes) YES=1 ;;
    *) echo "usage: scripts/provision.sh [--check] [--fresh [--yes]]"; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
note() { printf '    note: %s\n' "$*"; }
die()  { printf '\n!!  %s\n' "$1" >&2; shift; for l in "$@"; do printf '    %s\n' "$l" >&2; done; exit 1; }

# ------------------------------------------------------------------ checks
step "Settings"
[ -f .env ] || die ".env is missing" "cp .env.production.example .env && chmod 600 .env, then fill it in"
left=$(grep -E '^[A-Z0-9_]+=.*CHANGE_ME' .env | cut -d= -f1 | tr '\n' ' ' || true)
[ -z "$left" ] || die "still CHANGE_ME in .env: $left" "fill each in (secrets: openssl rand -hex 32), then run this again"
if [ ! -f puter/config/config.json ]; then
  cp puter/config/config.example.json puter/config/config.json && chmod 600 puter/config/config.json
  ok "puter/config/config.json made from the template (configure.sh fills it in)"
fi
. scripts/lib/suite.sh
ok "$PUTER_PROTOCOL://$PUTER_DOMAIN (${SUITE_MODE:-organisation}; TLS ${TLS_MODE:-off})"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  note "no ADMIN_PASSWORD in .env: admin keeps Puter's random password (docker logs puter 2>&1 | grep 'password for admin')"
fi

step "Docker"
docker info >/dev/null 2>&1 || die "cannot use Docker as $USER" "sudo usermod -aG docker $USER, then log out and in again"
ok "usable"
if [ -n "${REGISTRY:-}" ]; then
  host=${REGISTRY%%/*}
  grep -qF "\"$host\"" "$HOME/.docker/config.json" 2>/dev/null \
    || die "Docker cannot sign in to $host (.env REGISTRY)" "gcloud auth configure-docker $host"
  ok "signed in to $host"
fi

if [ "${TLS_MODE:-}" = auto ]; then
  step "DNS (Caddy needs it to get certificates)"
  ip=$(curl -s -m 2 -H Metadata-Flavor:Google \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)
  for name in "$PUTER_DOMAIN" "api.$PUTER_DOMAIN"; do
    got=$(getent ahostsv4 "$name" | awk 'NR==1 {print $1}')
    [ -n "$got" ] || die "$name does not resolve" "point $PUTER_DOMAIN and *.$PUTER_DOMAIN at ${ip:-this server} (DuckDNS / DNS), wait a minute, run again"
    if [ -n "$ip" ] && [ "$got" != "$ip" ]; then
      die "$name points at $got, this server is $ip" "change it (DuckDNS / DNS) to $ip, wait a minute, run again"
    fi
    ok "$name -> $got"
  done
fi
[ "$CHECK_ONLY" = 0 ] || { printf '\nchecks passed\n'; exit 0; }

# ------------------------------------------------------------------ fresh start
if [ "$FRESH" = 1 ]; then
  step "Fresh start: deleting puter/data"
  if [ "$YES" != 1 ]; then
    read -r -p "    Type $PUTER_DOMAIN to delete every account, file and message on this server: " answer
    [ "$answer" = "$PUTER_DOMAIN" ] || die "not confirmed; nothing deleted"
  fi
  docker compose --profile smtp down >/dev/null 2>&1 || true
  # Root-owned (the containers made it): removed from a throwaway container.
  docker run --rm -v "$SUITE/puter:/p" "$ALPINE_IMAGE" rm -rf /p/data
  ok "puter/data removed"
fi

# ------------------------------------------------------------------ build
step "Configuration"
scripts/configure.sh | sed 's/^/    /' || die "configure.sh refused the settings" "its reason is printed above; fix .env and run again"
scripts/fix-permissions.sh | sed 's/^/    /' || die "fix-permissions.sh failed" "read its output above"

step "Database"
docker compose up -d mariadb >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' puter-mariadb 2>/dev/null)" = healthy ] && break; sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' puter-mariadb 2>/dev/null)" = healthy ] \
  || die "MariaDB did not start" "$(docker logs --tail 15 puter-mariadb 2>&1)"
# MariaDB takes its database, user and password from .env only at its first
# start (into puter/data/mariadb); a value changed later is refused.
if ! docker compose exec -T mariadb sh -c 'mariadb -h127.0.0.1 -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "select 1"' >/dev/null 2>&1; then
  die "the database refuses .env's MARIADB_USER / MARIADB_PASSWORD / MARIADB_DATABASE" \
      "MariaDB set them at its first start and ignores later changes to .env." \
      "No data worth keeping (a new install): scripts/provision.sh --fresh" \
      "Real data: put the old values back in .env, or change them inside MariaDB (ALTER USER)."
fi
ok "MariaDB accepts the .env login"

step "Desktop and page patch (follow the pinned image; a few minutes)"
scripts/patch-puter.sh | sed 's/^/    /' || die "patch-puter.sh failed" "read its output above"
build_log=$(scripts/build-desktop.sh 2>&1) || die "the desktop build failed" "$(tail -15 <<<"$build_log")"
tail -2 <<<"$build_log" | sed 's/^/    /'
[ -f vendor/puter/src/gui/dist/index.html ] || [ -n "$(ls -A vendor/puter/src/gui/dist 2>/dev/null)" ] \
  || die "the desktop build left nothing in vendor/puter/src/gui/dist" "run scripts/build-desktop.sh and read its errors"

# ------------------------------------------------------------------ start
step "Start"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # only this start's log, not an earlier run's
docker compose --profile smtp up -d >/dev/null 2>&1 || true   # waits on Puter's health below, with its log
state=""
for _ in $(seq 1 60); do
  state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' puter 2>/dev/null || echo missing)
  [ "$state" = healthy ] && break
  # A crash that will not go away: stop waiting.
  if docker logs --since "$since" puter 2>&1 | tail -60 | grep -qE 'ER_ACCESS_DENIED_ERROR|EISDIR|SyntaxError: .*JSON'; then break; fi
  sleep 5
done
if [ "$state" != healthy ]; then
  log=$(docker logs --since "$since" puter 2>&1 | tail -60)
  printf '%s\n' "$log" | tail -25 | sed 's/^/    | /' >&2
  hint="read the log above"
  grep -q ER_ACCESS_DENIED_ERROR <<<"$log" && hint="database login refused: see the Database step (a new install: scripts/provision.sh --fresh)"
  grep -q EISDIR <<<"$log" && hint="a mounted file is a folder: run scripts/patch-puter.sh and scripts/build-desktop.sh again"
  grep -qE 'SyntaxError: .*JSON' <<<"$log" && hint="puter/config/config.json is not valid JSON: check your edits, then scripts/configure.sh"
  die "Puter did not become healthy (state: $state)" "$hint"
fi
ok "Puter healthy"

if [ "$PUTER_PROTOCOL" = https ]; then
  step "HTTPS (Caddy's certificates)"
  code=000
  for _ in $(seq 1 36); do
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$API/" || true)
    case "$code" in 000|502|503|504) sleep 5 ;; *) break ;; esac
  done
  case "$code" in
    000|502|503|504)
      docker logs puter-caddy 2>&1 | grep -iE 'error|challenge' | tail -8 | sed 's/^/    | /' >&2
      die "$API does not answer over HTTPS (last: $code)" \
          "000: no certificate yet: DNS for *.$PUTER_DOMAIN, and ports 80 and 443 open to the internet (firewall)" \
          "502: Caddy is up but cannot reach Puter" ;;
  esac
  ok "$API answers ($code)"
fi

# ------------------------------------------------------------------ accounts
step "Accounts"
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  scripts/seed-admin.sh 2>&1 | sed 's/^/    /' || die "could not set admin's password" "read its output above"
fi
if out=$(scripts/create-user.sh --chat-service 2>&1); then
  printf '%s\n' "$out" | sed 's/^/    /'
elif grep -q "already in use" <<<"$out"; then
  ok "chat service account ${CHAT_SERVICE_USER} exists"
else
  die "could not create the chat service account" "$out"
fi
docker compose restart chat >/dev/null
for _ in $(seq 1 15); do docker logs --since 60s puter-chat 2>&1 | grep -q listening && break; sleep 2; done
docker logs --since 60s puter-chat 2>&1 | grep -q listening \
  || die "the chat server did not start" "$(docker logs --tail 10 puter-chat 2>&1)"
ok "chat server listening"

# ------------------------------------------------------------------ apps
step "Apps (about 15 minutes on a new server)"
scripts/deploy-apps.sh 2>&1 | sed 's/^/    /' || die "deploy-apps.sh failed" "read its output above"

# ------------------------------------------------------------------ final checks
step "Final checks"
bad=0
check() { # check <url> <what>
  local c; c=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$1" || true)
  if [ "$c" = 200 ]; then ok "$2 ($1)"; else printf '    FAIL: %s %s -> %s\n' "$2" "$1" "$c"; bad=1; fi
}
check "$ORIGIN/" "desktop"
check "$BRAND_URL/logo.svg" "logo"
for host in $(python3 -c "import json; print(' '.join(sorted({a['host'] for a in json.load(open('suite-apps.json'))['apps']})))"); do
  check "$(app_url "$host")/" "app"
done
[ "$bad" = 0 ] || die "some addresses do not answer" "see FAIL above"
printf '\nready: %s (%s)\n' "$ORIGIN" "${SUITE_MODE:-organisation}"
[ -z "${ADMIN_PASSWORD:-}" ] || printf 'sign in as admin with .env ADMIN_PASSWORD\n'
