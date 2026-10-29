# The suite's settings, for every script: read from .env, everything else
# derived from them. Source it:  . "$(dirname "$0")/lib/suite.sh"
#
# .env holds the only addresses the suite knows:
#   PUTER_DOMAIN    the organisation's web domain          (unifyworks.localhost, company1.unify.works)
#   PUTER_PROTOCOL  http (local) or https (staging, production)
#   MAIL_DOMAIN     the organisation's mail domain         (unify.works)
#   BRAND_NAME      the product name shown to people       ("Unify Works")
# and from them:
#   ORIGIN    <proto>://<domain>            the desktop
#   API       <proto>://api.<domain>        Puter's API
#   SDK_URL   <proto>://js.<domain>/v2/     puter.js
#   CHAT_API  <proto>://chat-api.<domain>   chat back end, call signaller, Meetings' rooms
#   SIGNAL    ws(s)://chat-api.<domain>/signal
#   app_url <host>  -> <proto>://<host>.<domain>   each app on its own sub-domain (suite-apps.json)
SUITE=${SUITE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
if [ -f "$SUITE/.env" ]; then
  set -a; . "$SUITE/.env"; set +a
fi
: "${PUTER_DOMAIN:?set PUTER_DOMAIN in .env (the organisation's web domain)}"
: "${MAIL_DOMAIN:?set MAIL_DOMAIN in .env (the organisation's mail domain)}"
PUTER_PROTOCOL=${PUTER_PROTOCOL:-http}
BRAND_NAME=${BRAND_NAME:-${CHAT_ORG_NAME:-Unify Works}}
ORIGIN="$PUTER_PROTOCOL://$PUTER_DOMAIN"
API="$PUTER_PROTOCOL://api.$PUTER_DOMAIN"
SDK_URL="$PUTER_PROTOCOL://js.$PUTER_DOMAIN/v2/"
CHAT_API="$PUTER_PROTOCOL://chat-api.$PUTER_DOMAIN"
WS_PROTOCOL=$([ "$PUTER_PROTOCOL" = https ] && echo wss || echo ws)
SIGNAL="$WS_PROTOCOL://chat-api.$PUTER_DOMAIN/signal"
BRAND_URL="$PUTER_PROTOCOL://brand.$PUTER_DOMAIN"
TURN_HOST=${TURN_HOST:-127.0.0.1}
export PUTER_DOMAIN PUTER_PROTOCOL MAIL_DOMAIN BRAND_NAME ORIGIN API SDK_URL CHAT_API SIGNAL BRAND_URL TURN_HOST
# Names older scripts and the chat server read.
export PUTER_ORIGIN="$ORIGIN" PUTER_API_ORIGIN="$API" PUTER_SDK_URL="$SDK_URL"

# Images the scripts run themselves (backups, the desktop build): pinned and
# mirrored like the suite's own (docker-compose.override.yml, scripts/mirror-images.sh).
ALPINE_IMAGE="${REGISTRY:-docker.io}/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
NODE_BUILD_IMAGE="${REGISTRY:-docker.io}/library/node:24@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a"

app_url() { echo "$PUTER_PROTOCOL://$1.$PUTER_DOMAIN"; }

# A field of one app in suite-apps.json:  app_field <name> <field>
app_field() {
  python3 - "$SUITE/suite-apps.json" "$1" "$2" <<'PY'
import json, sys
path, name, field = sys.argv[1:4]
for app in json.load(open(path))["apps"]:
    if app["name"] == name:
        v = app.get(field, "")
        print(json.dumps(v) if isinstance(v, (dict, list)) else ("true" if v is True else "" if v is False else v))
        break
else:
    sys.exit(f"no app named {name!r} in suite-apps.json")
PY
}

app_names() { python3 -c "import json,sys; print(' '.join(a['name'] for a in json.load(open(sys.argv[1]))['apps']))" "$SUITE/suite-apps.json"; }

# The internal secret, for calls from scripts to the suite's own endpoints.
internal_secret() { echo "${UNIFY_INTERNAL_SECRET:?set UNIFY_INTERNAL_SECRET in .env}"; }
