#!/usr/bin/env bash
# Fetch the organisation's logos from the frontend into apps/brand-org/.
#
# brand.<domain> serves a file from apps/brand-org/ when it is there and from
# apps/brand/ (the suite's own logos, in git) otherwise, so a file the
# frontend does not provide, or that fails its check, keeps the suite's
# default. Fetched at deploy time, never by browsers at run time: the running
# suite still contacts no outside host.
#
# The frontend's brand folder, first found of:
#   1. git: .env BRAND_GIT_URL (uw-frontend-web) at BRAND_GIT_REF, the folder
#      BRAND_GIT_PATH in it (default public/brand); kept in vendor/brand-source
#   2. .env BRAND_SOURCE: a URL (https://<firebase site>/brand) or a local path
#      (a checkout of uw-frontend-web: .../public/brand)
#   3. none: the suite's defaults (apps/brand/)
#
#   scripts/sync-brand.sh            # fetch; no restart needed
#   scripts/sync-brand.sh --reset    # back to the suite's defaults
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
DEST="$SUITE/apps/brand-org"
# The files Puter's desktop uses (config.json gui_params, scripts/configure.sh).
FILES=(logo.svg logo-white.svg wallpaper.svg)

if [ "${1:-}" = "--reset" ]; then
  rm -rf "$DEST"; echo "brand: the suite's defaults (apps/brand/)"; exit 0
fi
SOURCE=""
if [ -n "${BRAND_GIT_URL:-}" ] && git_copy "$SUITE/vendor/brand-source" "$BRAND_GIT_URL" "${BRAND_GIT_REF:-main}" "${BRAND_GIT_PATH:-public/brand}"; then
  SOURCE="$SUITE/vendor/brand-source/${BRAND_GIT_PATH:-public/brand}"
  echo "brand: from $BRAND_GIT_URL ${BRAND_GIT_REF:-main} at $(git -C "$SUITE/vendor/brand-source" rev-parse --short HEAD)"
elif [ -n "${BRAND_SOURCE:-}" ]; then
  SOURCE=$BRAND_SOURCE
elif [ -n "${BRAND_GIT_URL:-}" ]; then
  echo "brand: $BRAND_GIT_URL unreachable and no BRAND_SOURCE; logos left as they were"; exit 0
else
  rm -rf "$DEST"; echo "brand: neither BRAND_GIT_URL nor BRAND_SOURCE set in .env; the suite's defaults (apps/brand/)"; exit 0
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  src="${SOURCE%/}/$f"
  if [[ "$SOURCE" =~ ^https?:// ]]; then
    code=0; curl -fsSL --max-time 20 --max-filesize 2000000 -o "$tmp/$f" "$src" 2>/dev/null || code=$?
    # 22: the server answered "no such file"; anything else: could not ask, so change nothing.
    if [ "$code" = 22 ]; then rm -f "$DEST/$f"; echo "  $f: not at the source, default"; continue; fi
    if [ "$code" != 0 ]; then echo "  $f: source unreachable (curl $code), left as it was"; continue; fi
  elif [ -f "$src" ]; then
    cp "$src" "$tmp/$f"
  else
    rm -f "$DEST/$f"; echo "  $f: not at the source, default"; continue
  fi
  # Served from our own domain to every signed-in page: a plain SVG with no
  # script in it, nothing else.
  if python3 - "$tmp/$f" <<'PY'
import re, sys
s = open(sys.argv[1], 'rb').read(2_000_001)
t = s.decode('utf-8', 'replace')
ok = len(s) <= 2_000_000 and re.search(r'<svg\b', t[:2000], re.I) \
     and not re.search(r'<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:|<!ENTITY', t, re.I)
sys.exit(0 if ok else 1)
PY
  then
    install -m 644 "$tmp/$f" "$DEST/$f"; echo "  $f: from $src"
  else
    rm -f "$DEST/$f"; echo "  $f: not a plain SVG, default"
  fi
done
echo "brand: $(ls "$DEST" | wc -l) file(s) from the organisation in apps/brand-org/, the rest from apps/brand/"
