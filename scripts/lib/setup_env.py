"""Write .env from .env.production.example by asking a few questions.

Run by scripts/provision.sh when there is no .env (or with --setup, to change
one: the current values are the defaults). Secrets are made here, each its
own `openssl rand -hex`-style value, and are never replaced once set: the
database and storage take theirs at their first start and refuse a new one.

    python3 scripts/lib/setup_env.py <suite dir> [--defaults]   (--defaults: no questions)
"""
import getpass
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.request

SUITE = sys.argv[1]
ASK = "--defaults" not in sys.argv[2:] and sys.stdin.isatty()
TEMPLATE = os.path.join(SUITE, ".env.production.example")
ENV = os.path.join(SUITE, ".env")
LINE = re.compile(r"^(#?)([A-Z0-9_]+)=(.*)$")


def parse_value(raw):
    """A .env value as bash reads it: quotes removed, an inline # comment dropped."""
    raw = raw.strip()
    if raw[:1] in ("'", '"'):
        end = raw.find(raw[0], 1)
        return raw[1:end] if end > 0 else raw[1:]
    return re.split(r"\s+#", raw, maxsplit=1)[0].strip()


def read_env(path):
    out = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = LINE.match(line.rstrip("\n"))
                if m and not m.group(1):
                    out[m.group(2)] = parse_value(m.group(3))
    return out


def quote(value):
    if re.fullmatch(r"[A-Za-z0-9._@:/+,=-]*", value):
        return value
    if "'" in value:
        sys.exit("a value may not contain a single quote (')")
    return f"'{value}'"


def ask(label, default="", secret=False, check=None, hint=None):
    if not ASK:
        return default
    while True:
        shown = ("(set: Enter keeps it)" if default else "") if secret else (f"[{default}]" if default else "")
        prompt = f"  {label} {shown}: " if shown else f"  {label}: "
        value = (getpass.getpass(prompt) if secret else input(prompt)).strip() or default
        problem = check(value) if check else None
        if not problem:
            return value
        print(f"    {problem}{' (' + hint + ')' if hint else ''}")


def host_check(v):
    return None if re.fullmatch(r"(?=.{3,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}", v) else "a domain name, e.g. unifyworks.duckdns.org"


def this_server_ip():
    try:
        req = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
            headers={"Metadata-Flavor": "Google"})
        return urllib.request.urlopen(req, timeout=2).read().decode().strip()
    except Exception:
        return ""


def reachable(url):
    try:
        subprocess.run(["git", "ls-remote", "--heads", url], check=True, timeout=30,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        return True
    except Exception:
        return False


with open(TEMPLATE, encoding="utf-8") as f:
    tmpl = f.read().splitlines()
defaults = {}
for line in tmpl:
    m = LINE.match(line)
    if m:
        v = parse_value(m.group(3))
        if v != "CHANGE_ME" and not m.group(1):
            defaults[m.group(2)] = v
old = read_env(ENV)
cur = {**defaults, **{k: v for k, v in old.items() if v != "CHANGE_ME"}}
had_env = bool(old)
vals = dict(cur)

print("\nSettings for this server (Enter takes the value in [brackets]):\n")
vals["PUTER_DOMAIN"] = ask("Domain (the desktop; every app is <app>.<domain>)",
                           cur.get("PUTER_DOMAIN", "unifyworks.duckdns.org"), check=host_check)
domain = vals["PUTER_DOMAIN"]
label = domain.split(".")[0]
vals["SUITE_MODE"] = ask("Kind of server: organisation (admins add people) or trial (public sign-up, guests)",
                         cur.get("SUITE_MODE", "organisation"),
                         check=lambda v: None if v in ("organisation", "trial") else "organisation or trial")
vals["MAIL_DOMAIN"] = ask("Mail domain (addresses <username>@<it>)", cur.get("MAIL_DOMAIN", "unify.works"), check=host_check)
vals["BRAND_NAME"] = ask("Product name people see", cur.get("BRAND_NAME", "Unify Works"))
vals["CHAT_ORG_NAME"] = old.get("CHAT_ORG_NAME") or vals["BRAND_NAME"]
admin = ask("Password for admin (Enter: a random one, shown at the end)", cur.get("ADMIN_PASSWORD", ""), secret=True,
            check=lambda v: None if not v or len(v) >= 8 else "at least 8 characters")
made_admin = not admin
vals["ADMIN_PASSWORD"] = admin or secrets.token_urlsafe(12)

ip = this_server_ip()
vals["TURN_EXTERNAL_IP"] = ask("This server's public IP (calls)", cur.get("TURN_EXTERNAL_IP") or ip,
                               check=lambda v: None if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", v) else "an IPv4 address")
vals["TURN_HOST"] = cur.get("TURN_HOST") or vals["TURN_EXTERNAL_IP"]

if vals["SUITE_MODE"] == "trial":
    print("\n  Sign in with Google (Enter: skip; redirect URIs https://%s/auth/oidc/callback/login, /signup, /revalidate)" % domain)
    gid = ask("Google OAuth client ID", cur.get("GOOGLE_CLIENT_ID", ""))
    if gid:
        vals["GOOGLE_CLIENT_ID"] = gid
        vals["GOOGLE_CLIENT_SECRET"] = ask("Google OAuth client secret", cur.get("GOOGLE_CLIENT_SECRET", ""), secret=True,
                                           check=lambda v: None if v else "needed with a client ID")
    else:
        vals.pop("GOOGLE_CLIENT_ID", None); vals.pop("GOOGLE_CLIENT_SECRET", None)

print("\n  Outgoing mail relay, port 587 (Enter: skip; needed for sign-up with email and password resets)")
relay = ask("Relay host", cur.get("SMTP_RELAY_HOST", ""))
if relay:
    vals["SMTP_RELAY_HOST"] = relay
    vals["SMTP_RELAY_PORT"] = ask("Relay port", cur.get("SMTP_RELAY_PORT", "587"))
    vals["SMTP_RELAY_USER"] = ask("Relay user (Enter: none)", cur.get("SMTP_RELAY_USER", ""))
    if vals["SMTP_RELAY_USER"]:
        vals["SMTP_RELAY_PASSWORD"] = ask("Relay password", cur.get("SMTP_RELAY_PASSWORD", ""), secret=True,
                                          check=lambda v: None if v else "needed with a user")
else:
    for k in ("SMTP_RELAY_HOST", "SMTP_RELAY_PORT", "SMTP_RELAY_USER", "SMTP_RELAY_PASSWORD"):
        vals.pop(k, None)

# Names from the domain's first label (unifyworks-internal -> unifyworks_internal),
# kept once set: MariaDB and the bucket take them at their first start.
name = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:60] or "unifyworks"
for k in ("MARIADB_DATABASE", "MARIADB_USER"):
    if old.get(k, "puter") in ("", "puter", "CHANGE_ME"):
        vals[k] = name
if old.get("S3_BUCKET", "puter-local") in ("", "puter-local", "CHANGE_ME"):
    vals["S3_BUCKET"] = name.replace("_", "-")

# Secrets: made once, never replaced.
for k, n in [("MARIADB_ROOT_PASSWORD", 32), ("MARIADB_PASSWORD", 32), ("S3_ACCESS_KEY", 10), ("S3_SECRET_KEY", 20),
             ("CHAT_SERVICE_PASSWORD", 32), ("UNIFY_INTERNAL_SECRET", 32), ("TURN_SECRET", 32)]:
    if not old.get(k) or old[k] == "CHANGE_ME":
        vals[k] = secrets.token_hex(n)

# Puter's source: our mirror when this server can read it, else HeyPuter's GitHub.
mirror = cur.get("PUTER_GIT_URL") or defaults.get("PUTER_GIT_URL", "")
if mirror and not reachable(mirror):
    print(f"\n  note: {mirror} cannot be read from here: Puter's source comes from HeyPuter's GitHub for now")
    vals.pop("PUTER_GIT_URL", None)

# DuckDNS: point the name at this server now, if given its token (not stored).
duck = None
if domain.endswith(".duckdns.org") and domain.count(".") == 2 and ASK:
    token = ask(f"DuckDNS token, to point {domain} at {vals['TURN_EXTERNAL_IP']} now (Enter: skip)", "", secret=True)
    if token:
        url = f"https://www.duckdns.org/update?domains={label}&token={token}&ip={vals['TURN_EXTERNAL_IP']}"
        try:
            duck = urllib.request.urlopen(url, timeout=15).read().decode().strip()
        except Exception as e:
            duck = f"failed ({e.__class__.__name__})"
        print(f"    DuckDNS: {duck}{' (wrong token or name?)' if duck == 'KO' else ''}")

# ---- summary and write
mask = {"ADMIN_PASSWORD", "GOOGLE_CLIENT_SECRET", "SMTP_RELAY_PASSWORD", "MARIADB_ROOT_PASSWORD", "MARIADB_PASSWORD",
        "S3_ACCESS_KEY", "S3_SECRET_KEY", "CHAT_SERVICE_PASSWORD", "UNIFY_INTERNAL_SECRET", "TURN_SECRET"}
print("\n  .env will have:")
for k in ["PUTER_DOMAIN", "SUITE_MODE", "MAIL_DOMAIN", "BRAND_NAME", "TURN_EXTERNAL_IP", "MARIADB_DATABASE", "MARIADB_USER",
          "S3_BUCKET", "GOOGLE_CLIENT_ID", "SMTP_RELAY_HOST", "PUTER_GIT_URL", "REGISTRY"]:
    if vals.get(k):
        print(f"    {k}={vals[k]}")
print("    secrets: " + ", ".join(k for k in sorted(mask) if vals.get(k)) + " (set; never printed)")
if had_env and any(old.get(k) and old[k] != vals.get(k) for k in ("MARIADB_DATABASE", "MARIADB_USER", "S3_BUCKET")):
    print("    WARNING: a database or bucket name changed: an existing database keeps the old one (provision.sh --fresh)")
if ASK and input("\n  Write .env? [Y/n] ").strip().lower() not in ("", "y", "yes"):
    sys.exit("nothing written")

out = []
for line in tmpl:
    m = LINE.match(line)
    if not m:
        out.append(line); continue
    commented, key, raw = m.groups()
    comment = ""
    cm = re.search(r"\s{2,}#.*$", raw) if raw[:1] not in ("'", '"') else re.search(r"(?<=['\"])\s+#.*$", raw)
    if cm:
        comment = cm.group(0)
    if key in vals and vals[key] != "":
        out.append(f"{key}={quote(vals[key])}{comment}")
    elif not commented and parse_value(raw) == "CHANGE_ME":
        out.append(line)              # still to fill in: provision.sh stops on it
    else:
        out.append(line if commented else f"#{line}")
extra = {k: v for k, v in old.items() if not any((LINE.match(l) or [None, None, None])[2] == k for l in tmpl)}
if extra:
    out += ["", "# Kept from the previous .env (not in the template)"] + [f"{k}={quote(v)}" for k, v in extra.items()]
if had_env:
    os.replace(ENV, f"{ENV}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
fd = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print(f"\n  wrote {ENV} (mode 600){' ; the previous one is kept as .env.bak-*' if had_env else ''}")
if made_admin:
    print(f"  admin password (shown once; it is in .env as ADMIN_PASSWORD): {vals['ADMIN_PASSWORD']}")
if domain.endswith(".duckdns.org") and duck != "OK" and vals.get("TURN_EXTERNAL_IP"):
    print(f"  DNS: point {domain} at {vals['TURN_EXTERNAL_IP']} on duckdns.org before continuing")
