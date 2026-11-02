#!/usr/bin/env bash
# A new server, from git clone to a working suite: asks a few questions (or
# none, with a .env already there), then does everything else in order, each
# step checked. It stops at the first problem with the reason and the fix,
# instead of carrying on into errors that hide it. Safe to run again.
#
#   git clone https://github.com/UNIFY-DIGITAL/uw-backend.git ~/unify-suite && ~/unify-suite/scripts/provision.sh
#
#   scripts/provision.sh            (questions if no .env) machine, settings, DNS, build, start, accounts, apps, checks
#   scripts/provision.sh --setup    ask the questions again (current values as defaults; secrets kept), then all
#   scripts/provision.sh --check    only the checks before anything starts
#   scripts/provision.sh --fresh    first delete puter/data (every account, file, message and the
#                                   database) and start empty: asks you to type the domain (--yes: no prompt)
set -euo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
cd "$SUITE"
ARGS=("$@")
CHECK_ONLY=0; FRESH=0; YES=0; SETUP=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;; --fresh) FRESH=1 ;; --yes) YES=1 ;; --setup) SETUP=1 ;;
    *) echo "usage: scripts/provision.sh [--setup] [--check] [--fresh [--yes]]"; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
note() { printf '    note: %s\n' "$*"; }
die()  { printf '\n!!  %s\n' "$1" >&2; shift; for l in "$@"; do printf '    %s\n' "$l" >&2; done; exit 1; }
META=http://metadata.google.internal/computeMetadata/v1/instance
meta() { curl -sf -m 2 -H Metadata-Flavor:Google "$META/$1" 2>/dev/null || true; }
ON_GCP=$([ -n "$(meta id)" ] && echo 1 || echo 0)

# ------------------------------------------------------------------ machine
step "Machine"
if ! command -v docker >/dev/null; then
  # A new VM installs Docker from its startup script (scripts/vm-startup.sh) during its first minutes.
  [ "$ON_GCP" = 1 ] || die "Docker is not installed" "install Docker Engine with the compose plugin (scripts/vm-startup.sh does it on Ubuntu)"
  printf '    waiting for the startup script to install Docker'
  for _ in $(seq 1 60); do command -v docker >/dev/null && break; printf .; sleep 10; done; echo
  command -v docker >/dev/null || die "Docker was not installed within 10 minutes" "sudo journalctl -u google-startup-scripts | tail -30"
fi
if ! docker info >/dev/null 2>&1; then
  if ! id -nG | tr ' ' '\n' | grep -qx docker; then
    sudo -n usermod -aG docker "$USER" 2>/dev/null || die "cannot use Docker as $USER" "sudo usermod -aG docker $USER, then log out and in again"
    echo "    joined the docker group; carrying on with it (no need to log out)"
    # Re-run in the new group, without the questions already answered.
    rest=(); for a in "${ARGS[@]}"; do [ "$a" = --setup ] || rest+=("$a"); done
    exec sg docker -c "$(printf '%q ' "$SUITE/scripts/provision.sh" "${rest[@]}")"
  fi
  die "Docker does not answer" "sudo systemctl status docker"
fi
ok "Docker usable"
if [ "$ON_GCP" = 1 ]; then
  # The firewall rules (80, 443, calls, mail) apply to VMs with this network tag.
  tags=$(meta tags)
  grep -q '"unify-suite"' <<<"$tags" || die "this VM lacks the network tag unify-suite: the firewall keeps 80/443 (certificates), calls and mail closed" \
    "from your laptop: gcloud compute instances add-tags $(meta name) --tags unify-suite --zone $(meta zone | awk -F/ '{print $NF}') --project unifyworks"
  ok "firewall: network tag unify-suite (ports 80, 443, 3478, 49160-49200/udp, 25)"
  # GitHub (the apps', logos' and Puter's source): the deploy token from Secret Manager.
  if ! git config --global --get credential.https://github.com.helper >/dev/null; then
    git config --global credential.https://github.com.helper \
      '!f() { [ "$1" = get ] || exit 0; echo username=x-access-token; echo "password=$(gcloud secrets versions access latest --secret=github-deploy-token --project unifyworks)"; }; f'
    ok "git: GitHub token from Secret Manager (github-deploy-token)"
  fi
fi

# ------------------------------------------------------------------ settings
step "Settings"
if [ ! -f .env ] || [ "$SETUP" = 1 ]; then
  [ -t 0 ] || [ -f .env ] || die "no .env, and no terminal to ask in" "run scripts/provision.sh in a terminal, or copy .env.production.example to .env and fill it in"
  python3 scripts/lib/setup_env.py "$SUITE" || die "settings not written" "run scripts/provision.sh again"
fi
left=$(grep -E '^[A-Z0-9_]+=.*CHANGE_ME' .env | cut -d= -f1 | tr '\n' ' ' || true)
[ -z "$left" ] || die "still CHANGE_ME in .env: $left" "fill each in (secrets: openssl rand -hex 32), or scripts/provision.sh --setup"
if [ ! -f puter/config/config.json ]; then
  cp puter/config/config.example.json puter/config/config.json && chmod 600 puter/config/config.json
  ok "puter/config/config.json made from the template (configure.sh fills it in)"
fi
. scripts/lib/suite.sh
ok "$PUTER_PROTOCOL://$PUTER_DOMAIN (${SUITE_MODE:-organisation}; TLS ${TLS_MODE:-off})"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  note "no ADMIN_PASSWORD in .env: admin keeps Puter's random password (docker logs puter 2>&1 | grep 'password for admin')"
fi
if [ -n "${REGISTRY:-}" ]; then
  host=${REGISTRY%%/*}
  if ! grep -qF "\"$host\"" "$HOME/.docker/config.json" 2>/dev/null; then
    command -v gcloud >/dev/null && gcloud auth configure-docker "$host" --quiet >/dev/null 2>&1 || true
  fi
  grep -qF "\"$host\"" "$HOME/.docker/config.json" 2>/dev/null \
    || die "Docker cannot sign in to $host (.env REGISTRY)" "gcloud auth configure-docker $host"
  ok "images from $host"
fi

if [ "${TLS_MODE:-}" = auto ]; then
  step "DNS (Caddy needs it to get certificates)"
  ip=$(meta network-interfaces/0/access-configs/0/external-ip)
  for name in "$PUTER_DOMAIN" "api.$PUTER_DOMAIN"; do
    got=""; waited=0
    for i in $(seq 1 12); do   # a DNS change just made takes a minute to show
      got=$(getent ahostsv4 "$name" | awk 'NR==1 {print $1}')
      if [ -n "$got" ] && { [ -z "$ip" ] || [ "$got" = "$ip" ]; }; then break; fi
      [ "$i" = 1 ] && printf '    waiting for %s to point at %s' "$name" "${ip:-this server}"
      printf .; waited=1; sleep 10
    done
    [ "$waited" = 0 ] || echo
    [ -n "$got" ] || die "$name does not resolve" "point $PUTER_DOMAIN and *.$PUTER_DOMAIN at ${ip:-this server} (DuckDNS / DNS), then run again"
    if [ -n "$ip" ] && [ "$got" != "$ip" ]; then
      die "$name points at $got, this server is $ip" "change it (DuckDNS / DNS) to $ip, then run again"
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
  if docker logs --since "$since" puter 2>&1 | tail -60 | grep -qE 'ER_ACCESS_DENIED_ERROR|EISDIR|SyntaxError: .*JSON|UnrecognizedClientException'; then break; fi
  sleep 5
done
if [ "$state" != healthy ]; then
  log=$(docker logs --since "$since" puter 2>&1 | tail -60)
  printf '%s\n' "$log" | tail -25 | sed 's/^/    | /' >&2
  hint="read the log above"
  grep -q ER_ACCESS_DENIED_ERROR <<<"$log" && hint="database login refused: see the Database step (a new install: scripts/provision.sh --fresh)"
  grep -q EISDIR <<<"$log" && hint="a mounted file is a folder: run scripts/patch-puter.sh and scripts/build-desktop.sh again"
  grep -q UnrecognizedClientException <<<"$log" && hint="the key-value store refused config.json dynamo.aws keys: scripts/configure.sh makes valid ones (letters and digits)"
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

# ------------------------------------------------------------------ apps
step "Apps (about 15 minutes on a new server)"
scripts/deploy-apps.sh 2>&1 | sed 's/^/    /' || die "deploy-apps.sh failed" "read its output above"

# The chat server runs Chat's and Meetings' back ends, which deploy-apps.sh
# builds (chat-server/teamchat-worker.js, meetings-rooms.js): only now can it start.
step "Chat server"
for f in chat-server/teamchat-worker.js chat-server/meetings-rooms.js; do
  [ -f "$f" ] || die "$f is missing" "deploy-apps.sh builds it from the Chat / Meetings app: scripts/deploy-apps.sh teamchat meetings"
done
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose restart chat >/dev/null
for _ in $(seq 1 15); do docker logs --since "$since" puter-chat 2>&1 | grep -q listening && break; sleep 2; done
docker logs --since "$since" puter-chat 2>&1 | grep -q listening \
  || die "the chat server did not start" "$(docker logs --since "$since" --tail 10 puter-chat 2>&1)"
ok "chat server listening"

# Onboarding again, now that Email, Calendar and the chat server exist: accounts
# made earlier (admin above, on a new server) got their mailbox but no app
# permissions or Chat seat. Safe to repeat.
step "Onboarding"
python3 - "$API" "$(internal_secret)" <<'PY' || die "some accounts are not fully onboarded" "see INCOMPLETE above; run scripts/provision.sh again"
import json, sys, urllib.request
api, secret = sys.argv[1:3]
req = urllib.request.Request(f"{api}/unify/internal/onboard-all", data=b"{}", method="POST",
                             headers={"Content-Type": "application/json", "x-unify-secret": secret})
with urllib.request.urlopen(req, timeout=120) as r:
    results = json.loads(r.read()).get("results", {})
bad = 0
for user, o in sorted(results.items()):
    chat = o.get("chat") or {}
    good = bool(o.get("mailbox") and o.get("grants") and (chat.get("ok") or chat.get("skipped")))
    bad += not good
    print(f"    {'ok' if good else 'INCOMPLETE'}: {user}: mailbox {'yes' if o.get('mailbox') else 'no'}; "
          f"apps {', '.join(o.get('grants', [])) or 'none'}; "
          f"chat {'yes' if chat.get('ok') else chat.get('skipped') or chat.get('error') or chat.get('status')}")
sys.exit(1 if bad else 0)
PY

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
