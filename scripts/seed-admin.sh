#!/usr/bin/env bash
# Give the bootstrap administrator ("admin", made by Puter at its first start
# with a random password printed in its log) the password in .env
# ADMIN_PASSWORD, and onboard it. For demo servers, where a known password is
# wanted; it is not asked to change it at sign-in. Run after the first start,
# and again whenever ADMIN_PASSWORD changes (it signs admin out everywhere).
#
#   scripts/seed-admin.sh            # waits for Puter (up to 3 minutes)
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD in .env}"
[ "$ADMIN_PASSWORD" != CHANGE_ME ] || { echo "set ADMIN_PASSWORD in .env"; exit 1; }
python3 - "$API" "$(internal_secret)" "${ADMIN_USER:-admin}" <<'PY'
import json, os, sys, time, urllib.error, urllib.request
api, secret, username = sys.argv[1:4]
body = json.dumps({"password": os.environ["ADMIN_PASSWORD"]}).encode()
for attempt in range(36):
    req = urllib.request.Request(f"{api}/unify/internal/users/{username}/password", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "x-unify-secret": secret})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out = json.loads(r.read())
        print(f"{username}: password set from .env ADMIN_PASSWORD; onboarding:", json.dumps(out.get("onboarding")))
        sys.exit(0)
    except urllib.error.HTTPError as e:
        msg = e.read()
        # 404 "No account": Puter is up but has not made admin yet; 502-504: still starting.
        if not ((e.code == 404 and b"No account" in msg) or e.code in (502, 503, 504)):
            sys.exit(f"refused ({e.code}): {msg.decode()[:300]}")
    except (urllib.error.URLError, OSError):
        pass                          # not reachable yet
    time.sleep(5)
sys.exit(f"Puter did not answer at {api} within 3 minutes")
PY
