#!/usr/bin/env bash
# Apply the suite's settings (.env + suite-apps.json) everywhere they are needed:
#
#   puter/config/config.json   every key that names the domain, the mail domain,
#                              the brand or the call signaller, and the secrets it
#                              shares with .env (database, storage keys, internal secret);
#                              its own secrets are made once if still CHANGE_ME; the kind
#                              of server (SUITE_MODE: sign-up, guests), the mail relay
#                              (SMTP_RELAY_*) and Google sign-in (GOOGLE_CLIENT_*)
#   caddy/apps.caddy           one route per app sub-domain (<host>.<domain>),
#                              the chat back end (chat-api.), relay logins
#   caddy/sites.caddy          HTTP or HTTPS and the certificates (.env TLS_MODE)
#   nginx/apps.conf            the apps server: <host>.<domain> -> apps/<host>/
#
# Nothing else in the suite names a domain. Run it after changing .env or
# suite-apps.json (deploy-apps.sh runs it), then restart what changed:
#
#   scripts/configure.sh && docker compose --profile smtp restart puter puter-smtp caddy apps chat
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
cd "$SUITE"

python3 - "$SUITE" <<'PY'
import json, os, re, sys
suite = sys.argv[1]
env = os.environ
proto, domain, mail, brand = env["PUTER_PROTOCOL"], env["PUTER_DOMAIN"], env["MAIL_DOMAIN"], env["BRAND_NAME"]
apps = json.load(open(f"{suite}/suite-apps.json"))["apps"]

# ---- config.json
path = f"{suite}/puter/config/config.json"
c = json.load(open(path))
c.update({
    "domain": domain,
    "protocol": proto,
    "pub_port": 443 if proto == "https" else int(env.get("HTTP_PORT") or 80),
    "origin": env["ORIGIN"],
    "api_base_url": env["API"],
    "gui_puterjs_bundle": env["SDK_URL"],
    "static_hosting_domain": f"site.{domain}",
    "static_hosting_domain_alt": f"host.{domain}",
    "private_app_hosting_domain": f"app.{domain}",
    "private_app_hosting_domain_alt": f"dev.{domain}",
})
c.setdefault("s3", {}).setdefault("s3Config", {})["publicEndpoint"] = f"{proto}://s3.{domain}"
g = c.setdefault("gui_params", {})
g.update({
    "brand_name": brand,
    "title": brand,
    "brand_logo_url": f"{env['BRAND_URL']}/logo.svg",
    "brand_logo_dark_url": f"{env['BRAND_URL']}/logo-white.svg",
    "brand_wallpaper_url": f"{env['BRAND_URL']}/wallpaper.svg",
})
c.setdefault("email", {})["from"] = f'"{brand}" <no-reply@{mail}>'
ue = c.setdefault("userEmail", {})
ue["localDomains"] = [mail]
ue["localIngressHost"] = f"api.{domain}"

# Secrets Puter shares with other containers: one place to set them, .env.
import secrets
shared = [
    (("database", "password"), "MARIADB_PASSWORD"),
    (("s3", "s3Config", "accessKeyId"), "S3_ACCESS_KEY"),
    (("s3", "s3Config", "secretAccessKey"), "S3_SECRET_KEY"),
    (("unifyInternal", "secret"), "UNIFY_INTERNAL_SECRET"),
]
for keys, var in shared:
    value = env.get(var, "")
    if not value or value == "CHANGE_ME":
        sys.exit(f"set {var} in .env (openssl rand -hex 32)")
    node = c
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    node[keys[-1]] = value
# Names shared with .env: the database and its user (MariaDB creates them at its
# first start), and the storage bucket (s3-init creates it).
for name, var, rule in [("database", "MARIADB_DATABASE", r"[A-Za-z0-9_]{1,64}"), ("user", "MARIADB_USER", r"[A-Za-z0-9_]{1,64}")]:
    value = env.get(var) or "puter"
    if not re.fullmatch(rule, value):
        sys.exit(f"{var}={value}: letters, digits and _ only (a hyphen breaks MariaDB names)")
    c.setdefault("database", {})[name] = value
bucket = env.get("S3_BUCKET") or "puter-local"
if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
    sys.exit(f"S3_BUCKET={bucket}: 3-63 lower-case letters, digits, . and -")
c["s3_bucket"] = bucket
# Puter's own secrets (no other container knows them): made once, never replaced.
for keys in [("jwt_secret_v2",), ("url_signature_secret",), ("userEmail", "secret")]:
    node = c
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    if node.get(keys[-1], "CHANGE_ME") in ("", "CHANGE_ME"):
        node[keys[-1]] = secrets.token_hex(32)
# What kind of server (.env SUITE_MODE): an organisation's (people are added by
# an administrator) or a public trial (anyone signs up, or tries as a guest).
kind = env.get("SUITE_MODE") or "organisation"
if kind not in ("organisation", "trial"):
    sys.exit(f"SUITE_MODE={kind}: use organisation or trial")
trial = kind == "trial"
c["disable_user_signup"] = not trial
g["disable_temp_users"] = not trial
# (Puter's captcha stays off: it guards /signup, and the desktop's guest
# sign-up sends no answer, so guests could not start.)
ua = c.setdefault("unifyAdmin", {})
ua["mode"] = kind
ua["trialChat"] = trial and env.get("TRIAL_CHAT", "0") == "1"
# Email sign-up waits for a code by mail: offered only with a relay that can
# deliver it (below); until then a trial server offers Google and guests.
ua["emailSignup"] = bool(env.get("SMTP_RELAY_HOST"))

# Mail the server sends (sign-up codes, password resets; people's mail to
# outside addresses on an organisation server): .env SMTP_RELAY_*. Unset: the
# transport in config.json is left as it is (MailHog in the template).
relay = env.get("SMTP_RELAY_HOST", "")
if relay:
    port = int(env.get("SMTP_RELAY_PORT") or 587)
    t = {"from": c.get("email", {}).get("from"), "host": relay, "port": port, "secure": port == 465}
    if env.get("SMTP_RELAY_USER"):
        if env.get("SMTP_RELAY_PASSWORD", "CHANGE_ME") in ("", "CHANGE_ME"):
            sys.exit("set SMTP_RELAY_PASSWORD in .env (or unset SMTP_RELAY_USER)")
        t["auth"] = {"user": env["SMTP_RELAY_USER"], "pass": env["SMTP_RELAY_PASSWORD"]}
    c["email"] = t

# Sign in with Google (.env GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, an OAuth
# client for <proto>://<domain>/auth/oidc/callback/{login,signup,revalidate}). Unset: no Google button.
providers = c.setdefault("oidc", {}).setdefault("providers", {})
if env.get("GOOGLE_CLIENT_ID"):
    if env.get("GOOGLE_CLIENT_SECRET", "CHANGE_ME") in ("", "CHANGE_ME"):
        sys.exit("set GOOGLE_CLIENT_SECRET in .env (or unset GOOGLE_CLIENT_ID)")
    providers["google"] = {"client_id": env["GOOGLE_CLIENT_ID"], "client_secret": env["GOOGLE_CLIENT_SECRET"]}
else:
    providers.pop("google", None)
# The key-value store (DynamoDB Local, only Puter talks to it): any keys, made
# once, but the emulator refuses an access key that is not letters and digits
# (the template's CHANGE_ME, with its "_", is refused: Puter does not start).
aws = c.setdefault("dynamo", {}).setdefault("aws", {})
if not re.fullmatch(r"[A-Za-z0-9]+", str(aws.get("access_key", ""))):
    aws["access_key"] = "unify" + secrets.token_hex(8)
if aws.get("secret_key", "CHANGE_ME") in ("", "CHANGE_ME"):
    aws["secret_key"] = secrets.token_hex(32)
aws.setdefault("region", "us-east-1")
c["peers"] = {"signaller_url": env["SIGNAL"], "fallback_ice": [{"urls": f"stun:{env['TURN_HOST']}:3478"}]}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(c, f, indent=2)
# Keep who may read it: 600, or 640 with the containers' group (scripts/fix-permissions.sh).
st = os.stat(path)
try:
    os.chown(tmp, -1, st.st_gid)
except PermissionError:
    pass
os.chmod(tmp, st.st_mode & 0o640 or 0o600)
os.replace(tmp, path)

# ---- Caddy: app sub-domains, the chat back end, relay logins
hosts = sorted({a["host"] for a in apps} | {"brand"})
reserved = {"api", "js", "s3", "site", "host", "app", "dev", "chat-api", "www"}
clash = reserved & set(hosts)
if clash:
    sys.exit(f"suite-apps.json: host(s) {sorted(clash)} are reserved by Puter or the suite")
d = re.escape(domain)
caddy = f"""# Generated by scripts/configure.sh from .env and suite-apps.json: do not edit.
# Each app on its own sub-domain, served by the `apps` container.
@suite_apps header_regexp Host ^({'|'.join(hosts)})\\.{d}(:\\d+)?$
handle @suite_apps {{
	reverse_proxy apps:80
}}

# The chat back end (Teamchat), the call signaller (WebSocket, /signal) and
# Meetings' room directory: the chat-server container. /internal/ is for the
# suite's own containers only, never from outside.
@chat_api header_regexp Host ^chat-api\\.{d}(:\\d+)?$
handle @chat_api {{
	@internal path /internal/*
	respond @internal 404
	reverse_proxy chat:8787
}}

# TURN relay logins for calls: the chat server mints short-lived ones for our
# own coturn (Puter itself would ask Cloudflare's paid TURN service).
@turn {{
	header_regexp Host ^api\\.{d}(:\\d+)?$
	path /peer/generate-turn
}}
handle @turn {{
	reverse_proxy chat:8787
}}
"""
os.makedirs(f"{suite}/caddy", exist_ok=True)
open(f"{suite}/caddy/apps.caddy", "w").write(caddy)

# ---- Caddy: HTTP or HTTPS (.env TLS_MODE; default off for http, files for https)
mode = env.get("TLS_MODE") or ("files" if proto == "https" else "off")
if (mode == "off") != (proto == "http"):
    sys.exit(f"TLS_MODE={mode} does not fit PUTER_PROTOCOL={proto} (off goes with http; files or auto with https)")
head = "# Generated by scripts/configure.sh from .env (TLS_MODE): do not edit.\n"
if mode == "off":
    sites = head + ":80 {\n\timport puter_routes\n}\n"
elif mode == "files":
    sites = head + """:80 {
\tredir https://{host}{uri} permanent
}

:443 {
\ttls /etc/caddy/tls/fullchain.pem /etc/caddy/tls/privkey.pem
\timport puter_routes
}
"""
elif mode == "auto":
    names = [domain] + [f"{h}.{domain}" for h in ["api", "js", "s3", "chat-api", *hosts]]
    sites = head + """# Caddy fetches (and renews) a certificate per name from Let's Encrypt, and
# redirects HTTP to HTTPS for them. A host not listed here gets no answer.
""" + ",\n".join(names) + " {\n\timport puter_routes\n}\n"
else:
    sys.exit(f"TLS_MODE={mode}: use off, files or auto")
open(f"{suite}/caddy/sites.caddy", "w").write(sites)

# ---- nginx: <host>.<domain> -> apps/<host>/
nginx = f"""# Generated by scripts/configure.sh: do not edit.
# Every app is a folder of apps/ named after its sub-domain (suite-apps.json "host").
server {{
    listen 80 default_server;
    server_name _;
    set $app_dir "";
    if ($host ~* "^([a-z0-9-]+)\\.{re.escape(domain)}$") {{ set $app_dir $1; }}
    root /usr/share/nginx/html/$app_dir;
    index index.html;
    location / {{
        try_files $uri $uri/ =404;
    }}
    # Built files carry a hash in their name: cache them; never cache the page itself.
    location /assets/ {{ add_header Cache-Control "public, max-age=31536000, immutable"; }}
    location = /index.html {{ add_header Cache-Control "no-cache"; }}
}}

# brand.<domain>: the organisation's logos (apps/brand-org/, from the frontend by
# scripts/sync-brand.sh) first, the suite's defaults (apps/brand/) for any file it lacks.
server {{
    listen 80;
    server_name brand.{domain};
    root /usr/share/nginx/html/brand-org;
    add_header Cache-Control "public, max-age=300";
    location / {{ try_files $uri @suite_default; }}
    location @suite_default {{
        root /usr/share/nginx/html/brand;
        try_files $uri =404;
    }}
}}
"""
os.makedirs(f"{suite}/nginx", exist_ok=True)
open(f"{suite}/nginx/apps.conf", "w").write(nginx)
print(f"configured for {proto}://{domain} ({kind}; TLS {mode}; mail @{mail}{'; Google sign-in' if 'google' in providers else ''}); apps: " + ", ".join(f"{a['host']}.{domain}" for a in apps))
PY
