#!/usr/bin/env bash
# Build, publish and register the suite's apps (suite-apps.json), each on its
# own sub-domain: <host>.<PUTER_DOMAIN>.
#
#   scripts/deploy-apps.sh               every app
#   scripts/deploy-apps.sh calendar chat  some, by Puter name (calendar, teamchat, ...) or host (chat, mail, ...)
#   SKIP_BUILD=1 scripts/deploy-apps.sh   re-publish and re-register what is already built
#
# For each app: build it pointed at this server (every address from .env, via
# scripts/lib/suite.sh), copy it to apps/<host>/, tell its puter.js which
# desktop it runs in (set-app-origin.sh), and register it with Puter through
# the admin extension (x-unify-secret: no admin password). Chat's and
# Meetings' back ends go to the chat server, which is restarted if they changed.
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
cd "$SUITE"
EVERYTHING=${EVERYTHING:-$HOME/everything/src}

# npm runs in the pinned node:24 container (scripts/lib/suite.sh), as you, so a
# server needs Docker only, and every machine builds with the same Node.
# BUILD_ON_HOST=1 uses this machine's own node/npm instead.
#   in_node <app dir> [KEY=value ...] -- <command ...>
in_node() {
  local dir=$1; shift
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  if [ "${BUILD_ON_HOST:-}" = 1 ]; then (cd "$dir" && env "${envs[@]}" "$@"); return; fi
  local root; root=$(dirname "$EVERYTHING")   # the whole checkout: apps may import ../../dev/...
  mkdir -p "$SUITE/.npm-cache"
  local e=(); for kv in "${envs[@]}"; do e+=(-e "$kv"); done
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/npm-cache "${e[@]}" \
    -v "$root:$root" -v "$SUITE:$SUITE" -v "$SUITE/.npm-cache:/npm-cache" -w "$dir" \
    "$NODE_BUILD_IMAGE" "$@"
}

scripts/configure.sh >/dev/null

want=("$@")
[ ${#want[@]} -gt 0 ] || read -r -a want <<< "$(app_names)"

python3 - "$SUITE/suite-apps.json" "${want[@]}" > "$SUITE/.deploy-plan" <<'PY'
import json, sys
apps = json.load(open(sys.argv[1]))["apps"]
wanted = sys.argv[2:]
for w in wanted:
    hits = [a for a in apps if w in (a["name"], a["host"], a["source"])]
    if not hits: sys.exit(f"no app {w!r} in suite-apps.json")
    for a in hits: print(a["name"])
PY
mapfile -t names < <(awk '!seen[$0]++' "$SUITE/.deploy-plan"); rm -f "$SUITE/.deploy-plan"


restart_chat=0
for name in "${names[@]}"; do
  host=$(app_field "$name" host); source=$(app_field "$name" source); title=$(app_field "$name" title)
  description=$(app_field "$name" description); admin_only=$(app_field "$name" adminOnly)
  out="$SUITE/apps/$host"
  echo "==> $title ($name) -> $(app_url "$host")"

  if [[ $source == suite:* ]]; then
    # A page of this project (App Center, Admin): copied, with this server's SDK and brand filled in.
    dir="$SUITE/${source#suite:}"
    rm -rf "$out" && cp -r "$dir" "$out"
    for f in "$out"/*.html; do sed -i -e "s#%SDK_URL%#$SDK_URL#g" -e "s#%BRAND_NAME%#$BRAND_NAME#g" "$f"; done
    icon="$dir/icon.svg"
  else
    dir="$EVERYTHING/$source"
    [ -d "$dir" ] || { echo "   no source at $dir"; exit 1; }
    [ -d "$dir/node_modules" ] || in_node "$dir" -- npm ci --silent --no-audit --no-fund
    # Its back end, run by the chat server (Chat, Meetings).
    worker=$(app_field "$name" worker)
    if [ -n "$worker" ]; then
      read -r w_build w_bundle w_copy w_to < <(python3 -c '
import json, sys
w = json.loads(sys.argv[1])
print(w.get("build", "-"), w.get("bundle", "-"), w.get("copy", "-"), w["to"])' "$worker")
      if [ "$w_build" != - ]; then
        in_node "$dir" -- npm run --silent "$w_build" >/dev/null
        cp "$dir/$w_bundle" "$SUITE/$w_to"
      else
        cp "$dir/$w_copy" "$SUITE/$w_to"
      fi
      touch "$SUITE/.chat-changed"
    fi
    if [ "${SKIP_BUILD:-}" != 1 ] || [ ! -d "$dir/dist" ]; then
      build_env=$(app_field "$name" build)
      env_args=(VITE_PUTER_SDK_URL="$SDK_URL" VITE_MAIL_DOMAINS="$MAIL_DOMAIN")
      if [ -n "$build_env" ]; then
        # Whole KEY=value lines, ${...} filled in (a value may itself contain "=", as "...?m=" does).
        while IFS= read -r line; do env_args+=("$line"); done < <(python3 -c '
import json, os, re, sys
for k, v in json.loads(sys.argv[1]).items():
    print(k + "=" + re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), ""), str(v)))' "$build_env")
      fi
      # --base=./ : relative asset paths, so the app works from any folder.
      in_node "$dir" "${env_args[@]}" -- npm run build --silent -- --base=./ >/dev/null
    fi
    rm -rf "$out" && cp -r "$dir/dist" "$out"
    SDK_ORIGIN=${SDK_URL%/v2/}
    for f in $(grep -rlE "js\.puter\.com|plausible\.io" "$out" --include=*.html 2>/dev/null); do
      sed -i "s#https://js.puter.com/v2/#$SDK_URL#g; s#https://js.puter.com#$SDK_ORIGIN#g" "$f"   # puter.com's SDK -> ours
      sed -i '/plausible\.io/d' "$f"                                                           # no analytics off the premises
    done
    icon="$dir/icon-128.png"
    # The product name people read: Puter's, in the apps as written for puter.com,
    # becomes the organisation's brand ("Puter Mail" -> "Unify Works Mail", "your
    # Puter account" -> "your Unify Works account"). Whole words only (code says
    # getPuter, PuterPeer), and never the technical names (Puter.js, Puter SDK)
    # or Calendar's file signature (-//Calendar//Puter//EN).
    python3 - "$out" "$BRAND_NAME" <<'PY'
import os, re, sys
root, brand = sys.argv[1], sys.argv[2]
word = re.compile(r"(?<![-/\w.$])Puter(?![\w$]|\.js|//| SDK| script)")
changed = 0
for d, _, files in os.walk(root):
    for f in files:
        if not f.endswith((".js", ".html")): continue
        p = os.path.join(d, f)
        text = open(p, encoding="utf-8").read()
        new, n = word.subn(brand, text)
        if n:
            open(p, "w", encoding="utf-8").write(new)
            changed += n
print(f"   branded: {changed} mention(s) of the product name")
PY
  fi
  [ -f "$icon" ] && cp "$icon" "$out/unify-icon.${icon##*.}"
  scripts/set-app-origin.sh "$out" >/dev/null

  if [ "${SKIP_REGISTER:-}" != 1 ]; then
    python3 - "$API" "$(internal_secret)" "$name" "$title" "$description" "$(app_url "$host")/index.html" "${icon:-}" "$admin_only" <<'PY'
import base64, json, os, sys, urllib.request
api, secret, name, title, desc, url, icon, admin_only = sys.argv[1:9]
body = {"name": name, "title": title, "description": desc, "url": url, "adminOnly": admin_only == "true"}
if icon and os.path.exists(icon):
    mime = "image/svg+xml" if icon.endswith(".svg") else "image/png"
    body["icon"] = f"data:{mime};base64," + base64.b64encode(open(icon, "rb").read()).decode()
req = urllib.request.Request(f"{api}/unify/internal/apps", data=json.dumps(body).encode(), method="POST",
                             headers={"Content-Type": "application/json", "x-unify-secret": secret})
try:
    with urllib.request.urlopen(req, timeout=30) as r: print("   registered:", json.loads(r.read()).get("uid"))
except urllib.error.HTTPError as e:
    sys.exit(f"   registration refused ({e.code}): {e.read().decode()[:300]}")
PY
  fi
done

if [ -f "$SUITE/.chat-changed" ]; then
  rm -f "$SUITE/.chat-changed"
  docker compose restart chat >/dev/null && echo "==> chat server restarted with the new back ends"
fi
echo "done: ${names[*]}"
