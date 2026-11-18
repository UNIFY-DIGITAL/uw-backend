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
#                            as on the website), not Puter's favicons; its
#                            author and link-preview domain are ours.
#   OIDCService.js           a Google, Microsoft or Apple sign-up is named after its address
#                            (harsh.rm@gmail.com -> harsh_rm, harsh_rm2 if
#                            taken) instead of a random name like a guest's.
#   SuggestedAppsService.js  a double-click opens a file in the suite's app
#                            that registered its type (suite-apps.json
#                            "opens") before Puter's own: our PDF, not the
#                            PDF app that loads from pdf.puter.com; and
#                            Puter's hidden apps (config.json
#                            unifyAdmin.hiddenPuterApps) are never offered.
#   EmailClient.js           the server's emails name our brand and support
#                            address and link this server, not puter.com;
#                            our wording from email-templates/ where given.
#   AuthController.js        a confirmation code expires (EMAIL_CODE_MINUTES).
#   SignupService.js         sign-up always mails the code the desktop asks for.
#   ChatCompletionDriver.js  AI: an app that names no model, or one this server
#                            does not have, gets the suite's (AI_MODEL).
#   GeminiChatProvider.js    Gemini gets a turn's tool calls back in its own order
#                            (its thought signature rides on the first).
#   HomepageController.js    the desktop page's author is our company, not
#                            Puter Technologies Inc.
#   puter.js                 the SDK's dialogs in our apps: our brand, logo
#                            and links (config.json gui_params, so run
#                            scripts/configure.sh first).
set -euo pipefail
SUITE=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=$(cd "$SUITE" && docker compose config --format json | python3 -c "import json,sys; print(json.load(sys.stdin)[\"services\"][\"puter\"][\"image\"])")
OUT="$SUITE/puter/patches"
mkdir -p "$OUT"
# A start before this ran leaves Docker's root-owned folder where a file goes.
for name in PuterHomepageService.js OIDCService.js SuggestedAppsService.js EmailClient.js AuthController.js SignupService.js ChatCompletionDriver.js GeminiChatProvider.js HomepageController.js puter.js; do
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
text = "\n".join(lines)
# The page's link-preview domain: this server, not puter.com (its author: HomepageController.js).
for old, new in [
    ('<meta property="twitter:domain" content="puter.com">',
     """<meta property="twitter:domain" content="${e(String(this.config.domain ?? ''))}">"""),
]:
    if text.count(old) != 1:
        sys.exit(f"patch no longer applies (found {old!r} {text.count(old)} times): review {src}")
    text = text.replace(old, new)
open(dst, "w").write(text)
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
old = "const builtinApps = await Promise.all(builtinNames.map((appName) => this.stores.app.getByName(appName)));"
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the built-in lookup {text.count(old)} times): review {src}")
# Puter's apps the suite hides (config.json unifyAdmin.hiddenPuterApps: those that load
# from puter.com and other outside sites) are never offered to open a file.
text = text.replace(old, "const builtinApps = await Promise.all(builtinNames.filter((appName) => !(this.config.unifyAdmin?.hiddenPuterApps ?? []).includes(appName)).map((appName) => this.stores.app.getByName(appName)));")
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

FILE=/opt/puter/dist/src/backend/clients/email/EmailClient.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/EmailClient.js.orig"
python3 - "$OUT/EmailClient.js.orig" "$OUT/EmailClient.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = "const templates = templates_1.EMAIL_TEMPLATES;"
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the templates line {text.count(old)} times): review {src}")
text = text.replace(old, "const templates = unifyRebrandTemplates(this.config, templates_1.EMAIL_TEMPLATES);")
old = "const compiled = this.compiledTemplates[template];"
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the send lookup {text.count(old)} times): review {src}")
# When each confirmation code goes out, for its expiry (AuthController.js, below).
text = text.replace(old, "if (template === 'email_verification_code' && values?.code) unifyCodeSent(to, values.code);\n        " + old)
text += r"""
// Unify Works (scripts/patch-puter.sh): the server's emails (codes, password
// resets, shares) name our brand and support address, and link this server,
// not Puter's; a template in the suite's email-templates/ (config.json
// "unifyEmailTemplates", scripts/configure.sh) replaces Puter's wording, with
// {{brand}}, {{support}} and {{minutes}} (how long a code lasts) filled in.
// Read once, when the templates are compiled at start.
function unifyRebrandTemplates(config, templates) {
    const brand = config?.gui_params?.brand_name;
    if (!brand) return templates;
    const support = config.support_email || 'support@unify.works';
    const origin = config.origin || '';
    const minutes = String(config.unifyAdmin?.emailCodeMinutes ?? 10);
    const fix = (s) => typeof s !== 'string' ? s : s
        .replace(/support@puter\.com/g, () => support)
        .replace(/https:\/\/puter\.com/g, () => origin)
        .replace(/Puter App Center/g, () => 'App Center')
        // One signature on every email: "Thanks, <brand> Team".
        .replace(/<p>Sincerely,<\/p>\s*<p>Puter<\/p>/g, () => `<p>Thanks,<br>${brand} Team</p>`)
        .replace(/Best,<br \/>\s*The Puter Team/g, () => `Thanks,<br />\n${brand} Team`)
        .replace(/The Puter Team/g, () => `${brand} Team`)
        .replace(/\bPuter\b/g, () => brand);
    const fill = (s) => typeof s !== 'string' ? s : s
        .replace(/\{\{\s*brand\s*\}\}/g, () => brand)
        .replace(/\{\{\s*support\s*\}\}/g, () => support)
        .replace(/\{\{\s*minutes\s*\}\}/g, () => minutes);
    const ours = config.unifyEmailTemplates ?? {};
    return Object.fromEntries(Object.entries(templates).map(([name, template]) => {
        const own = ours[name];
        let parts = template;
        if (own) {
            // Our wording replaces Puter's part by part; a new HTML body drops Puter's text part.
            parts = { subject: own.subject ?? template.subject, html: own.html ?? template.html };
            const textPart = own.text ?? (own.html ? undefined : template.text);
            if (textPart) parts.text = textPart;
        }
        return [name, Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, fix(fill(v))]))];
    }));
}

// When each confirmation code was sent, by address and code; AuthController.js
// refuses one older than config.json unifyAdmin.emailCodeMinutes (Puter's own
// codes never expire). In memory: after a restart, earlier codes count as expired.
function unifyCodeSent(to, code) {
    const sent = (globalThis.__unifyCodesSent ??= new Map());
    const now = Date.now();
    for (const [key, at] of sent) if (now - at > 24 * 3600 * 1000) sent.delete(key);
    sent.set(`${String(to).trim().toLowerCase()}|${code}`, now);
}
"""
open(dst, "w").write(text)
PY
rm "$OUT/EmailClient.js.orig"
echo "patched: $OUT/EmailClient.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/controllers/auth/AuthController.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/AuthController.js.orig"
python3 - "$OUT/AuthController.js.orig" "$OUT/AuthController.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = """            if (!user.email_confirm_code ||
                String(user.email_confirm_code) !== String(code)) {"""
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the code check {text.count(old)} times): review {src}")
# A code older than its lifetime is refused like a wrong one: the desktop says so, and the person asks for a new one.
text = text.replace(old, """            if (!user.email_confirm_code ||
                String(user.email_confirm_code) !== String(code) ||
                unifyCodeExpired(this.config, user.email, code)) {""")
text += r"""
// Unify Works (scripts/patch-puter.sh): a confirmation code lasts
// config.json unifyAdmin.emailCodeMinutes (.env EMAIL_CODE_MINUTES, 10 by
// default; 0: no limit, Puter's own behaviour). Its send time is kept by
// EmailClient.js; a code with none (sent before a restart) counts as expired.
function unifyCodeExpired(config, email, code) {
    const minutes = Number(config?.unifyAdmin?.emailCodeMinutes ?? 10);
    if (!(minutes > 0)) return false;
    const at = globalThis.__unifyCodesSent?.get(`${String(email).trim().toLowerCase()}|${code}`);
    return !at || Date.now() - at > minutes * 60 * 1000;
}
"""
open(dst, "w").write(text)
PY
rm "$OUT/AuthController.js.orig"
echo "patched: $OUT/AuthController.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/services/user/SignupService.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/SignupService.js.orig"
python3 - "$OUT/SignupService.js.orig" "$OUT/SignupService.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = "(body.send_confirmation_code ?? true)"
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the code-or-link choice {text.count(old)} times): review {src}")
# Sign-up always mails the code: the desktop's sign-up asks for a link
# (send_confirmation_code false) yet shows the code window, so the two disagreed.
text = text.replace(old, "(true /* Unify Works (scripts/patch-puter.sh): always the code */)")
open(dst, "w").write(text)
PY
rm "$OUT/SignupService.js.orig"
echo "patched: $OUT/SignupService.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/drivers/ai-chat/ChatCompletionDriver.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/ChatCompletionDriver.js.orig"
python3 - "$OUT/ChatCompletionDriver.js.orig" "$OUT/ChatCompletionDriver.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = """        let intendedProvider = args.provider || '';
        if (!args.model && !intendedProvider) {
            intendedProvider = 'azure-openai';
        }"""
# Twice: a completion, and its token count.
if text.count(old) != 2:
    sys.exit(f"patch no longer applies (found the default-provider lines {text.count(old)} times, expected 2): review {src}")
text = text.replace(old, """        let intendedProvider = args.provider || '';
        // Unify Works (scripts/patch-puter.sh): no model named, or one this server
        // does not have (an app asking for Claude or GPT): the suite's, config.json unifyAI.model.
        if (this.config.unifyAI?.model && (!args.model || !(await this.#resolveLoadedModel(args.model, intendedProvider)))) {
            args.model = this.config.unifyAI.model;
            intendedProvider = '';
        }
        if (!args.model && !intendedProvider) {
            intendedProvider = 'azure-openai';
        }""")
open(dst, "w").write(text)
PY
rm "$OUT/ChatCompletionDriver.js.orig"
echo "patched: $OUT/ChatCompletionDriver.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/drivers/ai-chat/providers/gemini/GeminiChatProvider.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/GeminiChatProvider.js.orig"
python3 - "$OUT/GeminiChatProvider.js.orig" "$OUT/GeminiChatProvider.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = """    preservesToolCallOrder(model) {
        return models_js_1.GEMINI_NATIVE_MODELS.has(model.id);
    }"""
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the tool-call order rule {text.count(old)} times): review {src}")
# Unify Works: a turn's parallel tool calls go back to Gemini in the order it made them, for every
# Gemini model. Puter kept the order only for its native ones; reversed, the thought signature
# Gemini 3 puts on the first call lands on the last, and Google refuses the request (400).
text = text.replace(old, """    preservesToolCallOrder(model) {
        return true; // Unify Works (scripts/patch-puter.sh): every Gemini model, see there
    }""")
open(dst, "w").write(text)
PY
rm "$OUT/GeminiChatProvider.js.orig"
echo "patched: $OUT/GeminiChatProvider.js (from $IMAGE)"

FILE=/opt/puter/dist/src/backend/controllers/homepage/HomepageController.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/HomepageController.js.orig"
python3 - "$OUT/HomepageController.js.orig" "$OUT/HomepageController.js" <<'PY'
import sys
src, dst = sys.argv[1:3]
text = open(src).read()
old = "company: 'Puter Technologies Inc.',"
if text.count(old) != 1:
    sys.exit(f"patch no longer applies (found the company line {text.count(old)} times): review {src}")
# The page's author (and the desktop's gui_params.company): ours, from config.json gui_params.
text = text.replace(old, "company: String(this.config.gui_params?.company || this.config.gui_params?.brand_name || 'Puter Technologies Inc.'),")
open(dst, "w").write(text)
PY
rm "$OUT/HomepageController.js.orig"
echo "patched: $OUT/HomepageController.js (from $IMAGE)"

# puter.js, the SDK our apps load from js.<domain>: its sign-in and notice
# dialogs name our brand, show our logo and link our site, source code, terms
# and dashboard, not Puter's (no Docs or Discord links). The values come from
# config.json gui_params, written by scripts/configure.sh: run this again after
# changing BRAND_NAME, WEBSITE_URL, SOURCE_URL, TERMS_URL or PRIVACY_URL.
FILE=/opt/puter/src/puter-js/dist/puter.js
docker run --rm --entrypoint cat "$IMAGE" "$FILE" > "$OUT/puter.js.orig"
python3 - "$OUT/puter.js.orig" "$OUT/puter.js" "$SUITE/puter/config/config.json" <<'PY'
import html, json, re, sys
src, dst, config = sys.argv[1:4]
text = open(src).read()
c = json.load(open(config))
g = c.get("gui_params", {})
v = {
    "brand": g.get("brand_name") or "",
    "origin": c.get("origin") or "",
    "website": g.get("website_url") or c.get("origin") or "",
    "source": g.get("source_url") or "",
    "terms": g.get("terms_url") or "",
    "privacy": g.get("privacy_url") or "",
    "logo": g.get("brand_logo_url") or "",
}
if not v["brand"] or not v["origin"]:
    sys.exit(f"{config} has no gui_params.brand_name or origin: run scripts/configure.sh first")
for k, s in v.items():
    if re.search(r"[`\\]|\$\{", s):
        sys.exit(f"gui_params value for {k} has a character the SDK's strings cannot hold: {s!r}")
    v[k] = html.escape(s, quote=True)   # no quotes left: safe in any of the bundle's strings

missing = []
def sub(old, new, required=True):
    # The text sits in a template literal (as written) or, after minifying, in
    # a quoted string with its quotes escaped: either form, kept as found.
    global text
    for esc in (lambda s: s, lambda s: s.replace('"', '\\"'), lambda s: s.replace("'", "\\'")):
        n = text.count(esc(old))
        if n:
            text = text.replace(esc(old), esc(new))
            return
    if required:
        sys.exit(f"patch no longer applies (did not find {old[:70]!r}...): review {src}")
    missing.append(old[:50])

terms = (f"""By clicking 'Continue' you agree to {v['brand']}'s <a href="{v['terms']}" target="_blank">Terms of Service</a> and <a href="{v['privacy']}" target="_blank">Privacy Policy</a>"""
         if v["terms"] and v["privacy"] else "")
sub("""By clicking 'Continue' you agree to Puter's <a href="https://puter.com/terms" target="_blank">Terms of Service</a> and <a href="https://puter.com/privacy" target="_blank">Privacy Policy</a>""", terms)
sub("This website uses Puter to bring you", f"This website uses {v['brand']} to bring you")
sub('<a href="https://puter.com?utm_source=sdk-splash"', f'<a href="{v["website"]}"')
sub('<a href="https://docs.puter.com" target="_blank">Docs</a><span style="margin:10px; color: #CCC;">|</span>', "")
sub('<a href="https://github.com/heyPuter/puter/" target="_blank">Github</a><span style="margin:10px; color: #CCC;">|</span>',
    f'<a href="{v["source"]}" target="_blank">Source code</a>' if v["source"] else "")
sub('<a href="https://discord.com/invite/PQcx7Teh8u" target="_blank">Discord</a>', "")
sub("Go to Puter.com", f"Go to {v['brand']}")
sub("https://puter.com/dashboard/", f"{v['origin']}/dashboard/")
sub("Puter.js Error: Unsupported Origin", "Error: Unsupported Origin", required=False)
sub(" Puter.js signs a page in by its origin", f" {v['brand']} signs a page in by its origin", required=False)
sub("To use Puter.js here:", "To sign in here:", required=False)
sub("Or load Puter.js from the parent page instead", "Or load the SDK from the parent page instead", required=False)
sub("Sending email to addresses outside Puter requires", f"Sending email to addresses outside {v['brand']} requires", required=False)

# The email-confirmation dialog's button opens puter.com: this server.
text, n = re.subn(r"""(open\(\s*)(["'`])https://puter\.com\2""", lambda m: f"{m[1]}{m[2]}{v['origin']}{m[2]}", text)
if n != 1:
    sys.exit(f"patch no longer applies (found open('https://puter.com') {n} times): review {src}")
# The dialog's logo (Puter's, inline on a blue square): ours, which brings its own background.
text, n = re.subn(r"""width: 40px; height: 40px; margin: 0 auto; border-radius: 8px; background-color: #2210d7; padding: 15px;(\\?")( src=)(\\?")data:image/svg\+xml;base64,[A-Za-z0-9+/=]+\\?\"""",
                  lambda m: f"width: 70px; height: 70px; margin: 0 auto; border-radius: 8px;{m[1]}{m[2]}{m[3]}{v['logo']}{m[3]}", text)
if n != 1 or not v["logo"]:
    sys.exit(f"patch no longer applies (found Puter's dialog logo {n} times, or no brand_logo_url): review {src}")
open(dst, "w").write(text)
if missing:
    print(f"  puter.js: not found (left as they were): {'; '.join(missing)}")
PY
rm "$OUT/puter.js.orig"
echo "patched: $OUT/puter.js (from $IMAGE)"
