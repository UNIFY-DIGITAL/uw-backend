#!/usr/bin/env bash
# Create an account from the server, for DevOps (people are otherwise added in
# the Admin app). No admin password needed: it uses the suite's internal
# secret (.env UNIFY_INTERNAL_SECRET), so it also creates the first
# administrators of a new organisation.
#
#   create-user.sh <username> [options]
#     --admin              make it an administrator
#     --name "Full Name"   shown to colleagues
#     --email address      default: <username>@<MAIL_DOMAIN>
#     --password secret    default: a temporary password, printed once, changed at first sign-in
#     --chat-service       the chat server's service account: CHAT_SERVICE_USER with
#                          CHAT_SERVICE_PASSWORD, both from .env (no mailbox or Chat seat)
#
#   create-user.sh priya --admin --name "Priya Shah"
#   create-user.sh --chat-service                                  # once per installation
#
# The account is confirmed, its mailbox exists, Email and Calendar may use it,
# and it is in the organisation's Chat: colleagues can reach it before its
# first sign-in.
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
if [ "${1:-}" = --chat-service ]; then
  set -- "${CHAT_SERVICE_USER:?set CHAT_SERVICE_USER in .env}" --password "${CHAT_SERVICE_PASSWORD:?set CHAT_SERVICE_PASSWORD in .env}"
fi
USER_NAME=${1:?usage: create-user.sh <username> [--admin] [--name "Full Name"] [--email address] [--password secret] | --chat-service}; shift
ADMIN=false; NAME=""; EMAIL=""; PASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --admin) ADMIN=true; shift ;;
    --name) NAME=${2:?}; shift 2 ;;
    --email) EMAIL=${2:?}; shift 2 ;;
    --password) PASS=${2:?}; shift 2 ;;
    *) # the old form: create-user.sh <username> <password> [email]
       if [ -z "$PASS" ]; then PASS=$1; elif [ -z "$EMAIL" ]; then EMAIL=$1; fi; shift ;;
  esac
done
python3 - "$API" "$(internal_secret)" "$USER_NAME" "$ADMIN" "$NAME" "$EMAIL" "$PASS" <<'PY'
import json, sys, urllib.request
api, secret, username, admin, name, email, password = sys.argv[1:8]
body = {"username": username, "admin": admin == "true"}
if name: body["name"] = name
if email: body["email"] = email
if password: body["password"] = password
req = urllib.request.Request(f"{api}/unify/internal/users", data=json.dumps(body).encode(), method="POST",
                             headers={"Content-Type": "application/json", "x-unify-secret": secret})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read())
except urllib.error.HTTPError as e:
    sys.exit(f"refused ({e.code}): {json.loads(e.read() or b'{}').get('message', '')}")
u = out["user"]
print(f"created {u['username']} <{u['email']}>{' (administrator)' if u['admin'] else ''}")
if out.get("temporaryPassword"):
    print(f"temporary password (shown once, to be changed at first sign-in): {out['temporaryPassword']}")
o = out.get("onboarding", {})
if o.get("service"):
    print("service account: no mailbox, Chat seat or app permissions (by design)"); sys.exit(0)
print(f"onboarding: mailbox {'ready' if o.get('mailbox') else 'NOT ready'}; apps allowed: {', '.join(o.get('grants', [])) or 'none'}; chat: {'joined' if (o.get('chat') or {}).get('ok') else 'not joined (' + str(o.get('chat')) + ')'}")
PY
