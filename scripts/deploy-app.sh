#!/usr/bin/env bash
# Deploy one app. The apps, their sub-domains and build settings are listed in
# suite-apps.json; this takes the app's Puter name (or its source folder, as
# the old form `deploy-app.sh <source> <name> ...` did) and runs deploy-apps.sh.
#   deploy-app.sh calendar
set -euo pipefail
exec "$(dirname "$0")/deploy-apps.sh" "${2:-${1:?app name}}"
