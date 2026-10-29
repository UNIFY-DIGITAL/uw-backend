#!/usr/bin/env bash
# Tell each deployed app's puter.js which desktop it runs in.
#
# Inside an app, puter.js addresses (and trusts) its desktop at puter.com
# unless the page sets PUTER_ORIGIN first, so every message between an app
# and our desktop (app-to-app connections such as Meetings asking Calendar,
# dialogs, pickers) went to puter.com and was dropped. This puts one line
# before the page's first script, setting our desktop and API origins.
# Idempotent; run by scripts/deploy-app.sh for each app, or by hand for all:
#
#   scripts/set-app-origin.sh                 # every app in apps/
#   scripts/set-app-origin.sh apps/calendar   # one
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"   # ORIGIN, API from .env
MARK='<script data-unify-origin>'
LINE="${MARK}window.PUTER_ORIGIN='${ORIGIN}';window.PUTER_API_ORIGIN='${API}';</script>"
dirs=("$@"); [ ${#dirs[@]} -gt 0 ] || dirs=("$SUITE"/apps/*/)
for d in "${dirs[@]}"; do
  f="${d%/}/index.html"
  [ -f "$f" ] || continue
  python3 - "$f" "$MARK" "$LINE" <<'PY'
import re, sys
path, mark, line = sys.argv[1:4]
html = open(path, encoding='utf-8').read()
html = re.sub(re.escape(mark) + r'.*?</script>\n?', '', html)   # an older line, replaced
m = re.search(r'<script\b', html, re.I)
if not m: sys.exit(0)
html = html[:m.start()] + line + '\n' + html[m.start():]
open(path, 'w', encoding='utf-8').write(html)
PY
  echo "  $f"
done
