#!/usr/bin/env bash
# Every automated check of the suite, one after another, with a summary.
# Exit status 0 only when all pass. Used by scripts/upgrade-puter.sh after an
# upgrade; run it by hand after any change.
#
#   scripts/check-suite.sh            # all checks
#   scripts/check-suite.sh quick      # skip the browser-heavy call tests
set -uo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
cd "$SUITE"
CHECKS=(
  "python3 scripts/mail-smoke.py"
  "node e2e/probe-brand.cjs"
  "node e2e/probe-signup-off.cjs"
  "node e2e/chat-api.cjs"
  "node e2e/chat-calendar.cjs"
  "node e2e/probe-chat-meeting-link.cjs"
  "node e2e/probe-turn.cjs"
  "node e2e/probe-peer.cjs"
  "node e2e/probe-switcher.cjs"
  "node e2e/probe-app-links.cjs"
  "node e2e/probe-admin.cjs"
  "node e2e/probe-newcomer.cjs"
  "node e2e/audit-external.cjs"
)
[ "${1:-}" = quick ] || CHECKS+=("node e2e/probe-huddle.cjs" "node e2e/probe-meeting.cjs")

failed=()
for c in "${CHECKS[@]}"; do
  echo "== $c"
  out=$(timeout 600 $c 2>&1); status=$?
  echo "$out" | grep -E "PASS|FAIL|ALL PASSED|: OK$|: .*[a-z0-9-]+\.[a-z]{2,}" | sed 's/^/   /'
  # audit-external prints "<app>: OK" per app; anything else there is an outside host.
  # Probes that report what they see rather than PASS/FAIL, judged here:
  #   probe-brand      no "Puter" text (hits) signed out or in, no outside hosts
  #   probe-signup-off no "Create" account link on the sign-in page
  judged_bad=false
  case "$c" in
    *probe-brand*) echo "$out" | sed -n 's/^/   /p' | head -3
                   [ "$(echo "$out" | grep -c '"hits":\[\]')" -ge 2 ] && echo "$out" | grep -q 'external hosts: \[\]' || judged_bad=true ;;
    *probe-signup-off*) echo "$out" | grep -E 'has "Create"' | sed 's/^/   /'
                   echo "$out" | grep -q 'has "Create": false | has Log In: true' || judged_bad=true ;;
  esac
  if [ $status -ne 0 ] || $judged_bad || echo "$out" | grep -q "FAIL" \
     || { [[ $c == *audit-external* ]] && echo "$out" | grep -qv ": OK$"; }; then
    failed+=("$c")
    [ $status -ne 0 ] && echo "$out" | tail -5 | sed 's/^/   ! /'
  fi
done
echo
if [ ${#failed[@]} -eq 0 ]; then echo "ALL CHECKS PASSED (${#CHECKS[@]})"; exit 0; fi
echo "FAILED (${#failed[@]} of ${#CHECKS[@]}):"; printf '  %s\n' "${failed[@]}"; exit 1
