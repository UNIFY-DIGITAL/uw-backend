#!/usr/bin/env bash
# Files of the pinned Puter image we serve changed, mounted over the image's
# own (docker-compose.override.yml). Re-run after changing the image in
# docker-compose.yml; it refuses to write a patch that no longer applies.
#
#   PuterHomepageService.js  the desktop page without its preload of the
#                            default wallpaper from Puter's CDN
#                            (puter-assets.b-cdn.net): our wallpaper is our own,
#                            and nothing on the page should reach outside.
set -euo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=$(cd "$SUITE" && docker compose config --format json | python3 -c "import json,sys; print(json.load(sys.stdin)[\"services\"][\"puter\"][\"image\"])")
OUT="$SUITE/puter/patches"
mkdir -p "$OUT"
# A start before this ran leaves Docker's root-owned folder where the file goes.
if [ -d "$OUT/PuterHomepageService.js" ]; then
  . "$SUITE/scripts/lib/suite.sh"   # ALPINE_IMAGE
  docker run --rm -v "$OUT:/p" "$ALPINE_IMAGE" rm -rf /p/PuterHomepageService.js
fi
FILE=/opt/puter/dist/src/backend/services/homepage/PuterHomepageService.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/PuterHomepageService.js.orig"
LINE='<link rel="preload" as="image" href="https://puter-assets.b-cdn.net/wallpaper.webp">'
COUNT=$(grep -cF "$LINE" "$OUT/PuterHomepageService.js.orig" || true)
[ "$COUNT" = 1 ] || { echo "patch no longer applies (found the preload $COUNT times): review $OUT/PuterHomepageService.js.orig"; exit 1; }
grep -vF "$LINE" "$OUT/PuterHomepageService.js.orig" > "$OUT/PuterHomepageService.js"
rm "$OUT/PuterHomepageService.js.orig"
echo "patched: $OUT/PuterHomepageService.js (from $IMAGE)"
