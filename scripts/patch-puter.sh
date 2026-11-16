#!/usr/bin/env bash
# Files of the pinned Puter image we serve changed, mounted over the image's
# own (docker-compose.override.yml). Re-run after changing the image in
# docker-compose.yml; it refuses to write a patch that no longer applies.
#
#   PuterHomepageService.js  the desktop page without its preload of the
#                            default wallpaper from Puter's CDN
#                            (puter-assets.b-cdn.net): our wallpaper is our own,
#                            and nothing on the page should reach outside.
#                            Its tab icon is our logo (brand.<domain>/logo.svg,
#                            as on the website), not Puter's favicons.
#   OIDCService.js           a Google, Microsoft or Apple sign-up is named after its address
#                            (harsh.rm@gmail.com -> harsh_rm, harsh_rm2 if
#                            taken) instead of a random name like a guest's.
#   SuggestedAppsService.js  a double-click opens a file in the suite's app
#                            that registered its type (suite-apps.json
#                            "opens") before Puter's own: our PDF, not the
#                            PDF app that loads from pdf.puter.com.
set -euo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=$(cd "$SUITE" && docker compose config --format json | python3 -c "import json,sys; print(json.load(sys.stdin)[\"services\"][\"puter\"][\"image\"])")
OUT="$SUITE/puter/patches"
mkdir -p "$OUT"
# A start before this ran leaves Docker's root-owned folder where a file goes.
for name in PuterHomepageService.js OIDCService.js SuggestedAppsService.js; do
  if [ -d "$OUT/$name" ]; then
    . "$SUITE/scripts/lib/suite.sh"   # ALPINE_IMAGE
    docker run --rm -v "$OUT:/p" "$ALPINE_IMAGE" rm -rf "/p/$name"
  fi
done

FILE=/opt/puter/dist/src/backend/services/homepage/PuterHomepageService.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/PuterHomepageService.js.orig"
LINE='<link rel="preload" as="image" href="https://puter-assets.b-cdn.net/wallpaper.webp">'
COUNT=$(grep -cF "$LINE" "$OUT/PuterHomepageService.js.orig" || true)
[ "$COUNT" = 1 ] || { echo "patch no longer applies (found the preload $COUNT times): review $OUT/PuterHomepageService.js.orig"; exit 1; }
grep -vF "$LINE" "$OUT/PuterHomepageService.js.orig" > "$OUT/PuterHomepageService.js.nopreload"
# The tab icon: our logo (gui_params.brand_logo_url, brand.<domain>/logo.svg, as on
# the website) in place of Puter's four PNG favicons; Puter's when no logo is set.
python3 - "$OUT/PuterHomepageService.js.nopreload" "$OUT/PuterHomepageService.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
lines = open(src).read().split("\n")
icons = [i for i, l in enumerate(lines) if '<link rel="icon" type="image/png"' in l and "/favicons/" in l]
if len(icons) != 4 or icons != list(range(icons[0], icons[0] + 4)):
    sys.exit(f"patch no longer applies (found {len(icons)} favicon lines, expected 4 together): review {src}")
indent = lines[icons[0]][: len(lines[icons[0]]) - len(lines[icons[0]].lstrip())]
lines[icons[0]:icons[0] + 4] = [indent + """<link rel="icon" href="${String(guiParams.brand_logo_url || assetDir + '/favicons/favicon-32x32.png').replace(/"/g, '&quot;')}">"""]
open(dst, "w").write("\n".join(lines))
PY
rm "$OUT/PuterHomepageService.js.nopreload"
rm "$OUT/PuterHomepageService.js.orig"
echo "patched: $OUT/PuterHomepageService.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/services/auth/OIDCService.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/OIDCService.js.orig"
python3 - "$OUT/OIDCService.js.orig" "$OUT/OIDCService.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
line = "const username = await (0, username_js_1.generateUsername)(this.stores);"
if text.count(line) != 1:
    sys.exit(f"patch no longer applies (found the username line {text.count(line)} times): review {src}")
text = text.replace(line, "const username = (await unifyUsernameFromEmail(this.stores, email)) ?? await (0, username_js_1.generateUsername)(this.stores);")
text += r"""
// Unify Works (scripts/patch-puter.sh): a sign-up through Google, Microsoft or Apple is named after its
// address, harsh.rm@gmail.com -> harsh_rm (harsh_rm2, ... if taken), so it is
// not mistaken for the random name a guest gets. Null (nothing usable, or a
// reserved name like admin): Puter's random name.
async function unifyUsernameFromEmail(stores, email) {
    const base = String(email || '').split('@')[0].split('+')[0]
        .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/\W+/g, '_').replace(/^_+|_+$/g, '')
        .slice(0, username_js_1.USERNAME_MAX_LENGTH - 2);
    if (!base || (0, username_js_1.usernameRejection)(base)) return null;
    for (let n = 1; n < 100; n++) {
        const candidate = n === 1 ? base : `${base}${n}`;
        if (!(await (0, username_js_1.usernameConflict)(stores, candidate))) return candidate;
    }
    return null;
}
"""
open(dst, "w").write(text)
PY
rm "$OUT/OIDCService.js.orig"
echo "patched: $OUT/OIDCService.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/services/apps/SuggestedAppsService.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/SuggestedAppsService.js.orig"
python3 - "$OUT/SuggestedAppsService.js.orig" "$OUT/SuggestedAppsService.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = """        const ordered = isFallback
            ? [...thirdPartyApps, ...builtinApps]
            : [...builtinApps, ...thirdPartyApps];"""
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the ordering {text.count(old)} times): review {src}")
# The suite's apps (the admin extension marks them metadata.unify.suite) lead; the rest keep Puter's order.
text = text.replace(old, """        const ordered = [...thirdPartyApps.filter(unifySuiteApp), ...(isFallback
            ? [...thirdPartyApps, ...builtinApps]
            : [...builtinApps, ...thirdPartyApps])];""")
text += r"""
// Unify Works (scripts/patch-puter.sh): an app the suite registered for a
// file type opens it ahead of Puter's built-in one.
function unifySuiteApp(app) {
    try {
        const meta = typeof app?.metadata === 'string' ? JSON.parse(app.metadata) : app?.metadata;
        return !!meta?.unify?.suite;
    } catch { return false; }
}
"""
open(dst, "w").write(text)
PY
rm "$OUT/SuggestedAppsService.js.orig"
echo "patched: $OUT/SuggestedAppsService.js (from $IMAGE)"
