# Unify Works — on-premises deployment & staging guide (DevOps)

Updated Oct 26, 2026 (first version Oct 22) · Harshavardhan Reddy

Kept in the project as `docs/devops-staging.md`; with it, `docs/services.md` (what replaces each puter.com / third-party service) and `README.md`.

## Summary

Unify Works runs on one Docker host: a self-hosted Puter server plus our own extensions, an apps web server, a chat server and a TURN relay for calls. It is verified end to end on a local machine; this guide is what DevOps needs to stand up a **staging** copy for one organisation (for example `company1.unify.works`).

What a signed-in user gets, all on the organisation's domain and storage:

- **Email** at `<username>@<org domain>`: colleague-to-colleague delivery is instant; outside mail goes through an SMTP relay and arrives over SMTP.
- **Calendar** with invitations that travel as normal calendar emails both ways (RSVP included).
- **Documents, Spreadsheet, Presentation, PDF, Contacts, Notes, Tasks, Projects** and a **Drive**, plus an **App Center** that searches every app ("excel", "powerpoint", "chat").
- **Chat** (Teamchat): every account joins the organisation's workspace automatically; channels, direct messages, threads and search. A meeting invitation created or shared in a chat conversation lands in the members' calendars.
- **Calls**: huddles in Chat, and **Meetings** (Google Meet-style) with links in Chat and Calendar invitations; all on our own signaller and TURN relay.
- An **apps button** on every screen: search any app and open it in a new tab.
- Branded as **Unify Works** (name, logo and wallpaper are settings); sign-in only, accounts are created by an administrator.

Locally verified on 2026-10-26 (`scripts/check-suite.sh`, 12 of 12): mail in and out, calendar invite → RSVP, chat, search, chat → calendar, invitation with a meeting link, huddles, Meetings with camera and microphone, the TURN relay, the app switcher, branding, sign-up blocked, and no request to any outside host. Two source trees hold the work and **neither is in version control yet** (see *What staging needs*).

## Architecture

Everything runs as Docker Compose services on one host behind Caddy; only Caddy (80/443) and inbound SMTP (25) face the network, and all data stays in `puter/data/` on that host.

```
Browsers ──443──▶ Caddy ─┬─ <domain>, api., js.      ─▶ puter      (accounts, desktop, drive, puter.js)
                         ├─ apps.                    ─▶ apps       (built apps, App Center, brand files)
                         ├─ chat.  (+ wss /signal)   ─▶ chat       (Teamchat back end, call signaller,
                         ├─ api./peer/generate-turn  ─▶ chat        Meetings room directory, relay logins)
                         └─ s3.                      ─▶ s3         (signed uploads/downloads)
Browsers ◀─3478 + UDP relay range─▶ coturn            (call media when no direct path)
Outside mail ──25──▶ filtering MTA ──▶ puter-smtp ─▶ puter (mailboxes)
puter ──587──▶ SMTP relay ──▶ outside addresses
puter, chat ─▶ mariadb, valkey, dynamo, s3   (all data in puter/data/)
```

Browsers reach every service through Caddy by host name; the chat server reaches Puter through Caddy too, so it sees the same names and certificates as a browser. Colleague mail never leaves Puter; outside mail comes in through `puter-smtp` and goes out through the relay.

| Service (container) | Image | Role |
| --- | --- | --- |
| `puter` | `ghcr.io/heyputer/puter` pinned by digest (release 26.10.1, revision `3160b99f`; moved only by `scripts/upgrade-puter.sh`) | accounts, desktop, drive, SDK, apps registry; our extensions `usersend` (send mail, internal delivery), `useradmin` (admin-created accounts) and `unifyorigin` (desktop never talks to puter.com); the rebuilt desktop (branding + app switcher) and the patched page template are mounted in |
| `puter-caddy` | `caddy:2.11-alpine` | TLS and routing by host: Puter, `apps.`, `chat.`, `s3.` |
| `puter-chat` | `node:24-alpine` + `chat-server/` | Teamchat's back end; org auto-join; chat → calendar bridge; call signaller (`/signal`); short-lived relay logins (`/peer/generate-turn`); Meetings room directory |
| `puter-coturn` | `coturn/coturn:4.6.3` pinned by digest | TURN/STUN relay for call media (replaces Cloudflare's paid TURN) |
| `puter-apps` | `nginx:alpine` + `apps/` | the built apps, App Center, brand files |
| `puter-smtp` | same Puter image, SMTP mode | inbound mail on port 25 into mailboxes |
| `puter-mariadb`, `puter-valkey`, `puter-dynamo`, `puter-s3` | `mariadb:11`, `valkey/valkey:8-alpine`, `amazon/dynamodb-local`, `rustfs/rustfs` | database, sessions/cache, key-value store, S3 file storage |
| `puter-mailhog` | `mailhog/mailhog` | local only: stands in for the relay; not on staging |

## What staging needs

One Linux VM with Docker, a wildcard DNS name and certificate, an SMTP relay and inbound port 25 cover staging. Locally the whole stack idles at about 1.3 GB RAM with 250 MB of data.

| Item | Staging requirement | Notes |
| --- | --- | --- |
| Server | 1 VM: 4 vCPU, 8 GB RAM, 100 GB SSD (data grows with mail and files) | Ubuntu 24.04 LTS or similar; Docker Engine 27+ with the Compose plugin |
| Build tools on the server or a CI runner | Docker (builds run in `node:24` containers), git, Python 3, `openssl` | Nothing else is installed on the host |
| DNS | `stg.unify.works` and `*.stg.unify.works` → the VM | Puter uses subdomains: `api.`, `js.`, `s3.`, `chat.`, `apps.`, plus per-app and per-user ones |
| TLS | `TLS_MODE=auto`: Caddy fetches its own (ports 80/443 open). Or `files`: a **wildcard** certificate for `*.stg.unify.works` + the bare name, DNS-01 issued, in `puter/tls/` | |
| Mail domain | e.g. `stg.unify.works` or `company1-stg.unify.works` | Users' addresses are `<username>@<mail domain>` |
| Outbound mail | SMTP relay credentials (Google Workspace, Microsoft 365 or our own MTA) | Replaces MailHog; used for mail to outside addresses and Puter's own notices |
| Inbound mail | MX record → the VM; port 25 open; ideally a filtering MTA in front | Our receiver has no spam, SPF, DKIM or DMARC checks |
| Sender reputation | SPF, DKIM and DMARC records for the mail domain | DKIM signing is done by the relay, not by Puter |
| Firewall in | 80, 443 (web), 25 (SMTP), 3478 UDP+TCP and the relay range UDP 49160-49200 (calls) | Widen the relay range for many simultaneous calls (about 1 port per call participant) |
| HTTPS | Required | Browsers give camera and microphone only to secure pages: no calls without TLS |
| Firewall out | 443 to our Artifact Registry (`asia-south1-docker.pkg.dev`) and npm; the SMTP relay | Chat link previews and web push also need outbound HTTPS |
| Source code | Two trees, to be moved into git first: `~/unify-suite` (stack, extensions, chat server, scripts) and `~/everything` branch `self-hosted` (the apps) | Neither is committed today; staging must build from tagged commits |
| Secrets store | Somewhere to keep `.env` and `puter/config/config.json` (both mode 600) | They hold DB, S3, mail and internal secrets |

## Configuration reference

All settings live in two files in the stack folder, never in exported shell variables: `.env` (read by Docker Compose) and `puter/config/config.json` (read by Puter). Both stay `chmod 600`. Generate every secret fresh for staging with `openssl rand -hex 32`; never copy the local ones.

### `.env`

The organisation is four variables; every address is derived from them
(`scripts/lib/suite.sh`) and written into Puter's config, Caddy and the apps
server by `scripts/configure.sh`:

| Variable | Purpose | Staging value |
| --- | --- | --- |
| `PUTER_DOMAIN` | The web domain: the desktop at `<domain>`, each app at `<app>.<domain>`, `api.`, `js.`, `s3.`, `chat-api.`, `brand.` | `stg.unify.works` |
| `PUTER_PROTOCOL` | `http` or `https` | `https` |
| `MAIL_DOMAIN` | The organisation's addresses: `<username>@<MAIL_DOMAIN>` | e.g. `stg.unify.works` |
| `BRAND_NAME` | Product name people see | `"Unify Works"` |

The rest:

| Variable | Purpose | Staging value |
| --- | --- | --- |
| `REGISTRY` | Where images come from: our Artifact Registry copy (`scripts/mirror-images.sh`). Unset = Docker Hub / GitHub, same digests | `asia-south1-docker.pkg.dev/unifyworks/unify-suite` |
| `HTTP_PORT`, `HTTPS_PORT` | Ports Caddy publishes | `80`, `443` |
| `PUTER_GIT_URL` | Where Puter's source comes from (desktop build, upgrades). Unset = HeyPuter's GitHub | `https://github.com/UNIFY-DIGITAL/puter-mirror.git` |
| `ADMIN_PASSWORD` | Demo servers: a known password for `admin` (`scripts/seed-admin.sh`). Unset: Puter's random one, in its log | unset on real servers |
| `SUITE_MODE` | `organisation` (administrators add people) or `trial` (public sign-up, Google, guests; *Trial server*) | `organisation` |
| `SMTP_RELAY_HOST`, `_PORT`, `_USER`, `_PASSWORD` | Mail the server sends (sign-up codes, password resets; on an organisation server people's mail out). Unset: MailHog keeps it all | a relay on 587 (port 25 out is blocked on Google Cloud) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google. Unset: no Google button | trial server only, for now |
| `FRONTEND_GIT_URL`, `FRONTEND_GIT_REF`, `EVERYTHING` | The apps' source (*Sources*) | `https://github.com/UNIFY-DIGITAL/uw-frontend.git`, `self-hosted` |
| `BRAND_GIT_URL`, `BRAND_GIT_REF`, `BRAND_GIT_PATH`, `BRAND_SOURCE` | The logos (*Sources*) | `https://github.com/UNIFY-DIGITAL/uw-frontend-web.git`, its branch |
| `TLS_MODE` | `off` (http), `auto` (Caddy fetches certificates), `files` (yours in `puter/tls/`) | `auto` |
| `MARIADB_ROOT_PASSWORD`, `MARIADB_DATABASE`, `MARIADB_USER`, `MARIADB_PASSWORD` | Database | new random passwords; DB `puter`, user `puter` |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` | File storage (RustFS, S3-compatible) | new random keys; bucket per org |
| `SMTP_PORT` | Host port for inbound mail | `25` |
| `CHAT_SERVICE_USER`, `CHAT_SERVICE_PASSWORD` | Puter account that holds all chat data | `unifychat` + new random password |
| `CHAT_ORG_NAME` | Chat workspace name everyone joins | the organisation's name, quoted if it has spaces |
| `UNIFY_INTERNAL_SECRET` | The suite's own calls: chat → mail, onboarding, DevOps scripts (`create-user.sh`, `deploy-apps.sh`) | same value as `unifyInternal.secret` below |
| `TURN_SECRET` | coturn shared secret; the chat server mints relay logins from it | new random value |
| `TURN_HOST`, `TURN_EXTERNAL_IP`, `TURN_BIND` | Where browsers reach coturn, the IP it advertises, the host address it listens on | the VM's public DNS name or IP, its public IP, `0.0.0.0` |
| `TURN_ALLOW_LOOPBACK` | Local testing only | leave unset (`false`) |

### `config.json`

Keys marked *(configure.sh)* are written from `.env`; set the rest once.

| Key | Purpose | Staging value |
| --- | --- | --- |
| `domain`, `protocol`, `pub_port` | Public address *(configure.sh)* | `stg.unify.works`, `https`, `443` |
| `origin`, `api_base_url`, `gui_puterjs_bundle` *(configure.sh)* | Keep the desktop and SDK on this server (not puter.com) | `https://stg.unify.works`, `https://api.stg.unify.works`, `https://js.stg.unify.works/v2/` |
| `static_hosting_domain(_alt)`, `private_app_hosting_domain(_alt)` *(configure.sh)* | Puter's hosting subdomains | `site.`, `host.`, `app.`, `dev.` + the domain |
| `jwt_secret_v2`, `url_signature_secret` | Session and URL signing | new random values |
| `database.*`, `redis.*`, `dynamo.*`, `s3.*`, `s3_bucket` | Backing services | match `.env`; `s3.s3Config.publicEndpoint` = `https://s3.stg.unify.works` |
| `trust_proxy` | Caddy in front | `1` |
| `events.enabled` | Live updates (mail shows in about 1 s) | `true` |
| `disable_user_signup` | Sign-in only; `/signup` refused | `true` |
| `gui_params.disable_temp_users` | No throw-away guest accounts | `true` |
| `gui_params.brand_name`, `title`, `brand_logo_url`, `brand_logo_dark_url`, `brand_wallpaper_url` *(configure.sh)* | Branding | `BRAND_NAME`; the files on `https://brand.stg.unify.works/` (`apps/brand/`) |
| `email.*` | Outbound SMTP relay (and Puter's own notices) | relay host, port 587, `secure`/auth as the relay requires; `from` on the mail domain |
| `userEmail.localDomains` *(configure.sh)* | The organisation's mail domain(s) | `["stg.unify.works"]` |
| `userEmail.secret`, `localIngressUrl`, `localIngressHost`, `localServer` | Inbound mail into mailboxes | new secret; `http://puter:4100/email/ingress-stamped`; `api.stg.unify.works`; `true` |
| `unifyAdmin.admins` | Bootstrap administrators (protected: cannot be disabled, demoted or removed in the Admin app); more are promoted in the Admin app | `["admin"]` |
| `unifyAdmin.serviceAccounts` *(configure.sh)* | Accounts never listed or edited (the chat service account) | `["unifychat"]` |
| `unifyInternal.secret` | Internal mail from the chat server | new secret, = `UNIFY_INTERNAL_SECRET` |
| `peers.signaller_url` *(configure.sh)* | Call signaller | `wss://chat-api.stg.unify.works/signal` |
| `peers.fallback_ice` *(configure.sh)* | STUN for calls (public: no passwords here) | `[{"urls": "stun:<TURN_HOST>:3478"}]` |
| `gui_params.unify_app_switcher`, `unify_apps_new_tab` | Apps button; desktop tiles in new tabs | leave unset (on) |
| `oidc` providers | SSO (optional) | not configured yet; Puter supports OIDC sign-in only (no SAML, LDAP or SCIM) |

### Apps (`suite-apps.json`)

The suite's apps, each with its sub-domain, source folder and build settings
(`${ORIGIN}`, `${CHAT_API}` and so on are filled in from `.env`). The apps bake
their server's address into the build, so each environment builds its own copy
with `scripts/deploy-apps.sh`; nothing is set by hand. Adding an app = a line
here + `scripts/deploy-apps.sh <name>`.

## First-time deployment

**The short way**: after step 1 (the code) and filling in `.env` (step 2), one
command does steps 2-9 in order and checks each one, stopping with the reason
and the fix at the first problem. Safe to run again after fixing it:

```bash
scripts/provision.sh --check    # settings, Docker, registry sign-in, DNS: nothing started
scripts/provision.sh            # configure, database login, desktop, start, admin, chat account, apps, final checks
scripts/provision.sh --fresh    # the same, first deleting puter/data (asks you to type the domain)
```

The steps below are what it runs, for doing (or debugging) them one by one.

From an empty VM to a working suite is about twelve commands; the slow steps are the image pulls and the app builds (about 15 minutes in all). Run everything as one non-root deploy user in the `docker` group, from the stack folder. The example domain is `stg.unify.works`.

1. **Get the code** over HTTPS with the deploy token (*Git access* below sets it up once per VM):

   ```bash
   git clone https://github.com/UNIFY-DIGITAL/uw-backend.git ~/unify-suite
   cd ~/unify-suite
   ```

   Only the suite is cloned by hand. The scripts fetch the rest from git themselves (`.env`, *Sources*): the apps' source (`uw-frontend`, only the apps the suite builds), the logos (`uw-frontend-web`) and Puter's source (`puter-mirror`). Later deploys are `git pull` here, then the scripts (*Updates and redeploys*): no copying files to the server.

   Not in git, made on the server by the scripts: `vendor/puter` (cloned by `build-desktop.sh` at the image's revision), `vendor/frontend` and `vendor/brand-source` (`deploy-apps.sh`, `sync-brand.sh`), the built apps in `apps/` and the chat server's two bundles (`deploy-apps.sh`; the chat server restarts until they exist), Caddy and nginx routes (`configure.sh`) and the page patch (`patch-puter.sh`). See `.gitignore`.
2. **Settings from the templates**, then fill in every `CHANGE_ME` with `openssl rand -hex 32` and the staging values from *Configuration reference*:

   ```bash
   cp .env.production.example .env && chmod 600 .env
   cp puter/config/config.example.json puter/config/config.json && chmod 600 puter/config/config.json
   ```

   Set the organisation (`PUTER_DOMAIN`, `PUTER_PROTOCOL=https`, `MAIL_DOMAIN`, `BRAND_NAME`) at the top of `.env`. `UNIFY_INTERNAL_SECRET` in `.env` and `unifyInternal.secret` in `config.json` must be the same value. Then write the domain into every config:

   ```bash
   scripts/configure.sh
   scripts/fix-permissions.sh   # owners the containers need (Puter 1000, RustFS 10001); safe to re-run
   ```

   On a Linux server, skipping `fix-permissions.sh` shows as `puter-s3` restarting with "Permission denied", and Puter unable to read `config.json`.

   **Finish `.env` before the first start.** MariaDB creates its database, user and password (`MARIADB_*`) only at its first start, into `puter/data/mariadb`, and ignores later changes. A changed value afterwards shows as Puter unhealthy with "Access denied for user". On a fresh install with no data, stop the stack, run `scripts/configure.sh`, remove `puter/data` (`docker run --rm -v "$HOME/unify-suite/puter:/p" alpine:3.20 rm -rf /p/data`) and start again. With real data, change the password inside MariaDB instead (`ALTER USER`). Database and user names: letters, digits and `_` only.
3. **TLS**, by `TLS_MODE` in `.env` (`scripts/configure.sh` writes Caddy's site blocks, `caddy/sites.caddy`; port 443 is always published):
   - `auto`: Caddy fetches and renews a Let's Encrypt certificate per host name the suite uses (desktop, `api.`, `js.`, `s3.`, `chat-api.`, every app). Needs DNS for `<domain>` and `*.<domain>` pointing at the server and ports 80 and 443 open to the internet before the first start. Nothing to renew by hand. Does not cover Puter's per-user sites (`<name>.site.<domain>`), which the suite does not use.
   - `files`: put a wildcard `fullchain.pem` and `privkey.pem` (DNS-01 issued) in `puter/tls/`, and renew them yourself.
4. **Build the desktop and the page patch** (in containers, about 3 minutes; both follow the pinned image):

   ```bash
   scripts/patch-puter.sh
   scripts/build-desktop.sh
   ```
5. **Start the stack**, inbound SMTP included:

   ```bash
   docker compose --profile smtp up -d
   docker compose ps          # all running; puter becomes healthy in about a minute
   ```
6. **Administrators**: Puter's bootstrap `admin` (password in `docker logs puter 2>&1 | grep "password for admin"`; sign in and change it, keep it in the secrets store; on a demo server `scripts/seed-admin.sh` sets `.env` `ADMIN_PASSWORD` instead), and named administrators, created from the server with no password of anyone (the internal secret):

   ```bash
   scripts/create-user.sh priya --admin --name "Priya Shah"   # prints a temporary password, changed at first sign-in
   ```
7. **Chat service account** (the chat server restarts until it exists):

   ```bash
   scripts/create-user.sh --chat-service      # CHAT_SERVICE_USER / CHAT_SERVICE_PASSWORD from .env
   docker compose restart chat && docker logs puter-chat | tail -3   # "listening on :8787"
   ```
8. **Apps**: every app of `suite-apps.json`, built for this server, published at its sub-domain, branded and registered (about 15 minutes; no admin password):

   ```bash
   scripts/deploy-apps.sh
   ```
9. **Branding**: `BRAND_GIT_URL` / `BRAND_GIT_REF` in `.env` (the site's repository; or `BRAND_SOURCE`, its Firebase address or a local folder), then `scripts/sync-brand.sh` (also run by `deploy-apps.sh`). It copies `logo.svg`, `logo-white.svg` and `wallpaper.svg` into `apps/brand-org/`; `https://brand.<domain>/` serves those, and the suite's own files in `apps/brand/` for any it lacks. No restart needed; `scripts/sync-brand.sh --reset` goes back to the defaults.
10. **People**: in the Admin app (an administrator, from the apps button), or `scripts/create-user.sh <username> [--name "Full Name"]`. Each account is onboarded at creation: mailbox, Email and Calendar access, Chat membership.
11. **DNS for mail**: MX → the VM, plus SPF, DKIM (from the relay) and DMARC records. Then run *Verification*.

## Updates and redeploys

Every change is a script run from the stack folder; settings come from `.env`, nothing is exported. Only a Puter upgrade needs a maintenance window.

| What changed | Command | Downtime |
| --- | --- | --- |
| One or more apps | `scripts/deploy-apps.sh <name> …` (e.g. `calendar`, `teamchat`, `admin`) | none; users reload the app. Chat and Meetings: the chat server restarts (about 5 s; calls carry on, peer-to-peer) |
| An app on or off for everyone, or another web app added | the Admin app (Apps), or `POST /unify/internal/apps/<name>/enabled` | none |
| The domain, mail domain or brand (`.env`) | `scripts/configure.sh`, restart puter, puter-smtp, caddy, apps, chat, then `scripts/deploy-apps.sh` | a few minutes |
| Logo, wallpaper (changed in the frontend's `public/brand/`) | `scripts/sync-brand.sh` | seconds |
| Brand name | `BRAND_NAME` in `.env`, then as for the domain above | a few minutes |
| Branding code (`gui-extensions/`) | `scripts/build-desktop.sh` (restarts Puter itself) | about 1 minute |
| Our extensions (`extensions/usersend`, `extensions/useradmin`, `extensions/unifyorigin`) | `docker compose restart puter` | about 1 minute |
| Any setting in `config.json` | `docker compose restart puter` (and `puter-smtp` for mail settings) | about 1 minute |
| Any setting in `.env` | `docker compose --profile smtp up -d` (recreates what changed) | per container |

**Puter upgrades** are deliberate, never automatic: the image is pinned by digest, and the rebuilt desktop, our extensions and the page patch follow it. One script does the whole upgrade:

```bash
scripts/upgrade-puter.sh check                      # what runs, the newest release, setup files changed upstream
scripts/upgrade-puter.sh upgrade                    # staging: the newest build
scripts/upgrade-puter.sh upgrade sha256:<digest>    # production: exactly what staging passed with
scripts/upgrade-puter.sh rollback backups/puter-<date>-<rev>.tgz
```

`upgrade` stops the suite, backs up `puter/data`, the config, `.env` and the pin to `backups/`, regenerates `docker-compose.yml` from the release's own file pinned by digest, rebuilds the desktop and the page patch at that revision, starts everything and runs `scripts/check-suite.sh`. It stops at the first problem and prints the rollback command.

1. **Staging**: `upgrade`, let people use it, keep the printed digest.
2. **Production**: in a maintenance window, `upgrade sha256:<that digest>`. Never a moving tag in production.
3. **Release notes**: read the files `check` lists as changed upstream (`config.template.jsonc`, `doc/self-hosting.md`) before production.

Puter 26.10.1 (the current pin) needed one workaround: its image cannot find the `sharp` module and does not start; `NODE_PATH` in `docker-compose.override.yml` fixes it, harmless once upstream does.

### Images: our own copy

Every image (the suite's 11 and the scripts' `alpine` and `node:24`) is pinned
by digest and named `${REGISTRY:-docker.io}/…` (`docker-compose.override.yml`,
`scripts/lib/suite.sh`; Puter's line `${REGISTRY:-ghcr.io}/heyputer/puter@…`).
Staging and production set `REGISTRY` to our Artifact Registry
(`asia-south1-docker.pkg.dev/unifyworks/unify-suite`, project `unifyworks`), so
they never depend on Docker Hub or GitHub still offering an image. Developers
leave it unset and get the same images, by the same digests, from upstream.

| Who | Access | Setup |
| --- | --- | --- |
| Servers (staging, production VMs) | Artifact Registry **Reader** on the VM's service account | `gcloud auth configure-docker asia-south1-docker.pkg.dev` (no key files) |
| Whoever upgrades (staging, a DevOps laptop) | Artifact Registry **Writer** | the same, signed in as themselves |
| Developers | none | `REGISTRY` unset |

- **Changing or adding an image**: pin it by digest in the compose file, then
  `scripts/mirror-images.sh` (copies what is missing; `--list` to preview).
  Copies are exact (every platform, same digest).
- **Puter upgrades** copy the new release by themselves: `upgrade` on staging
  copies it into the registry before pinning; production's
  `upgrade sha256:<digest>` then pulls it from there.
- **List or tag**: `gcloud artifacts docker images list asia-south1-docker.pkg.dev/unifyworks/unify-suite --include-tags`.

### Puter's source: our own copy

`vendor/puter` is not in git: `build-desktop.sh` clones it at the image's
revision from `.env` `PUTER_GIT_URL`. Servers point it at our private mirror,
so a rebuild never depends on HeyPuter's GitHub. Create the mirror once, and
refresh it before each Puter upgrade (DevOps laptop, with push rights):

```bash
git clone --bare https://github.com/HeyPuter/puter.git puter.git    # branches and tags only
cd puter.git && git push --mirror git@github.com:UNIFY-DIGITAL/puter-mirror.git
# refresh:
git fetch --prune origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' && git push --mirror git@github.com:UNIFY-DIGITAL/puter-mirror.git
```

(Not `git clone --mirror`: it also copies GitHub's pull-request refs, which
GitHub refuses on push.) An existing `vendor/puter` switches to a new
`PUTER_GIT_URL` by itself on the next run.

### Sources: git first, then a local folder, then a fallback

| What | 1. git (`.env`) | 2. local folder | 3. neither |
| --- | --- | --- | --- |
| The apps (`deploy-apps.sh`) | `FRONTEND_GIT_URL` at `FRONTEND_GIT_REF`, in `vendor/frontend`: only `dev/` and the apps' folders (about 0.8 GB, not the whole 1.8 GB) | `EVERYTHING` (default `~/everything/src`, a developer's checkout) | each app keeps what is deployed in `apps/<host>/` (re-registered, not rebuilt) |
| The logos (`sync-brand.sh`) | `BRAND_GIT_URL` at `BRAND_GIT_REF`, folder `BRAND_GIT_PATH` (default `public/brand`), in `vendor/brand-source` | `BRAND_SOURCE`: a local folder, or a URL (the Firebase site) | the suite's own logos (`apps/brand/`) |
| Puter's source (`build-desktop.sh`) | `PUTER_GIT_URL` | – | – |

A git server that cannot be reached keeps the copy already in `vendor/` (with a
warning), so a GitHub outage does not stop a redeploy.

### Git access: one read-only token for every server

Servers clone and `git pull` four private repositories: the suite
(`uw-backend`), the apps (`uw-frontend`), the site's logos (`uw-frontend-web`)
and `puter-mirror`. One **fine-grained personal access token** covers all four (a deploy key cannot: GitHub allows each key
on one repository only).

1. **Make the token** (GitHub → Settings → Developer settings → Fine-grained
   tokens): resource owner **UNIFY-DIGITAL**; *Only select repositories*: the
   four above; *Repository permissions → Contents: Read-only* (Metadata is
   added by itself); an expiry date (e.g. one year; diary the renewal). If the
   organisation requires approval for fine-grained tokens, an owner approves
   it. Best made by a bot account rather than a person, so it outlives
   staff changes.
2. **Keep it in Secret Manager**, not on the servers' disks (once, from a
   laptop with project rights):

   ```bash
   gcloud services enable secretmanager.googleapis.com --project unifyworks
   printf %s '<token>' | gcloud secrets create github-deploy-token --data-file=- --project unifyworks
   gcloud secrets add-iam-policy-binding github-deploy-token --project unifyworks \
     --member serviceAccount:unify-suite-vm@unifyworks.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   ```

   Renewing: `printf %s '<new token>' | gcloud secrets versions add github-deploy-token --data-file=- --project unifyworks`.
   Every server uses the new one at its next `git pull`.
3. **On each server** (once, as the deploy user): git asks the VM's service
   account for the token whenever it talks to github.com:

   ```bash
   git config --global credential.https://github.com.helper \
     '!f() { [ "$1" = get ] || exit 0; echo username=x-access-token; echo "password=$(gcloud secrets versions access latest --secret=github-deploy-token --project unifyworks)"; }; f'
   ```

   Use the HTTPS addresses (step 1 of *First-time deployment*); SSH addresses
   would not use the token. The VM needs the `cloud-platform` access scope
   (`unify-staging` has it).

The token can only read code: it cannot push, and the servers never need to.
Without Secret Manager, `git config --global credential.helper store` keeps it
in `~/.git-credentials` (mode 600) instead.

## Trial server

A second, separate server where anyone can try the suite: the public site
(`uw-frontend-web`, on Firebase) links each app to `<app>.<trial domain>`. It
runs the same commit as staging; only `.env` differs:

```bash
SUITE_MODE=trial
PUTER_DOMAIN=<trial domain>           # and the site's public/unify-config.json backend.domain
GOOGLE_CLIENT_ID=...                  # Sign in with Google (below)
GOOGLE_CLIENT_SECRET=...
SMTP_RELAY_HOST=... (and _USER, _PASSWORD)   # only for sign-up with email (below)
```

What `trial` changes (`scripts/configure.sh` writes it into `config.json`; the
extensions read it):

| | organisation | trial |
| --- | --- | --- |
| Sign-up | off: administrators add people | on: email + password, or Google |
| Guests | none | a first visit gets a temporary account at once; it can open the apps, save, and download files to the computer. Saving the account (email, password) keeps it; signing out deletes it |
| Onboarding (mailbox, Email/Calendar access) | when an administrator adds someone | also at sign-up and when a guest saves the account (not for guests) |
| Chat | everyone in the organisation's workspace | sign-ups get no seat (the one workspace would put strangers together) unless `TRIAL_CHAT=1` |
| People directory (name suggestions) | everyone | empty: visitors never see each other |
| Mail to outside addresses | through the relay | refused (`outside_mail_off`): no relaying for strangers. Mail between trial accounts works |

**Sign-up with email needs a real relay**: Puter sends a code and the account
waits for it. Without `SMTP_RELAY_*` the code lands in MailHog and the person
is stuck; offer Google and guests only until a relay is set (a transactional
mail service, or the company's Google Workspace relay, on port 587). Google
sign-ups need no relay: Google has confirmed the address.

**Sign in with Google**, once (Google Cloud console, project `unifyworks`):
*Google Auth Platform* → *Branding* (app name, support email; audience
*External*), *Audience* → *Publish app* (basic profile and email need no
review), *Clients* → *Create client*, type *Web application*, authorised
redirect URIs `https://<trial domain>/auth/oidc/callback/login`, `/signup` and
`/revalidate`. Put the client ID and secret in `.env` and run
`scripts/configure.sh && docker compose restart puter`. Any Google account,
personal or a company's Workspace, can then sign in.

Not built yet: removing guest accounts that were abandoned without signing out,
limits per trial account (storage, how long a trial lasts), and a bot check:
Puter's own captcha cannot be used, as it also guards guest sign-up, which the
desktop sends without an answer.

## Verification

The automated checks run against the local stack and all pass as of 2026-10-26 (`scripts/check-suite.sh` runs them all with a summary); staging is accepted with the manual checklist below, using three test accounts (alice, bob, charlie) in two browsers that do not share cookies.

**Automated (local stack, before every release tag):**

| Check | Command | Covers |
| --- | --- | --- |
| Mail | `python3 scripts/mail-smoke.py` | colleague mail, outside mail via relay, forged From refused, unknown user, inbound SMTP |
| Chat | `node e2e/chat-api.cjs` | auto-join, channel message, reading, search, direct message |
| Chat → calendar | `node e2e/chat-calendar.cjs` | invitation in chat reaches members' mailboxes as a colleague's |
| Meeting made in chat → RSVP | `node e2e/probe-chat-meeting.cjs "<title>"`, then `node e2e/probe-rsvp-chat.cjs <dir> "<title>"` | the + menu form, three calendars, a Yes back to the organiser |
| Branding, sign-in only | `node e2e/probe-brand.cjs`, `node e2e/probe-signup-off.cjs` | no "Puter" on sign-in or desktop; no sign-up; admin-created user works |
| Invitation with a meeting link | `node e2e/probe-chat-meeting-link.cjs` | the chat invitation carries a Meetings link, as Calendar reads it |
| TURN relay | `node e2e/probe-turn.cjs` | relay logins; data over a relay-only connection |
| Signaller | `node e2e/probe-peer.cjs` | invite codes, rooms, both protocol generations, resume, anonymous callers never under a colleague's id, sign-in required |
| Huddle | `node e2e/probe-huddle.cjs` | two users connected in Chat, each hearing the other |
| Meetings | `node e2e/probe-meeting.cjs` | two users in a meeting, each getting the other's camera and microphone |
| App switcher | `node e2e/probe-switcher.cjs` | apps button, search, apps and desktop tiles open in new tabs |
| No outside services | `node e2e/audit-external.cjs` | the desktop and every app contact no host outside this server |
| Apps' own tests | `npx vitest run` in `~/everything/src/teamchat`, `src/meetings` and `src/calendar` | 2,420 Teamchat and 568 Meetings tests pass; Calendar has one known date-dependent failure in its booking-page test |

**Staging acceptance (manual):**

- [ ] `https://stg.unify.works` shows the Unify Works **Log In** page, valid certificate, no "Create Free Account"
- [ ] alice signs in; the Apps page lists Email, Calendar, Chat, Documents, Spreadsheet, Presentation, PDF, Contacts, Notes, Tasks, Projects
- [ ] Search → App Center: "excel", "powerpoint" and "chat" each find their app and **Open** works
- [ ] alice emails bob; it shows in bob's Inbox within a few seconds
- [ ] alice emails an outside mailbox (Gmail/Outlook); it arrives, not in spam; SPF and DKIM pass in its headers
- [ ] the outside mailbox replies; alice receives it
- [ ] alice creates a Calendar event with bob and charlie and sends invitations; both see it in their Calendar; bob answers Yes; alice sees bob accepted
- [ ] Chat: alice, bob and charlie are all in the organisation workspace without an invite; a #general message reaches the others; search finds it; a direct message works
- [ ] Chat → + → **Meeting invitation**: the meeting appears in all three calendars; bob's Yes shows on alice's event
- [ ] Documents, Spreadsheet, Presentation: create, save, reopen a file
- [ ] Chat huddle between two people on **different networks** (one on mobile data): both hear each other (proves the relay)
- [ ] A meeting from a Calendar or Chat invitation link: both see and hear each other; screen sharing works
- [ ] The apps button: search "mail", open it; it opens in a new tab
- [ ] `docker compose ps`: every container up; `curl -s https://chat-api.stg.unify.works/healthz` answers `ok`

## Operations

All state is in one folder, `puter/data/`, plus the two settings files; back up those three and the stack can be rebuilt from git.

**Accounts**

- Create, disable, remove, reset passwords, promote: the **Admin** app (administrators). From the server: `scripts/create-user.sh <username> [--admin] [--name "…"] [--password …]` (internal secret; prints a temporary password otherwise). People cannot sign themselves up.
- New accounts join the chat workspace on their first visit to Chat; no invite needed.
- Password reset: "Forgot password" on the sign-in page is Puter's own flow and sends its email through the outbound relay; not yet tested here, so add it to the staging checklist.
- Disabling or deleting an account has no admin screen yet (open item).

**Backups**

| What | Where | How |
| --- | --- | --- |
| Database (accounts, apps, file index) | `puter/data/mariadb` | in the snapshot below; or live `docker exec puter-mariadb mariadb-dump --single-transaction …` |
| Files and mailboxes (S3) | `puter/data/s3` | in the snapshot |
| Key-value data (chat messages, settings) | `puter/data/dynamo` | in the snapshot; copy only while stopped |
| Cache, sessions | `puter/data/valkey` | in the snapshot (losing it signs people out) |
| Settings and secrets | `.env`, `puter/config/config.json`, `puter/tls/` | secrets store |

Nightly cold snapshot for staging (about one minute of downtime):

```bash
docker compose --profile smtp stop
tar czf /backup/unify-$(date +%F).tgz puter/data puter/config .env puter/tls
docker compose --profile smtp start
```

Restore = the same paths back in place, then `docker compose --profile smtp up -d`. Restore has not been rehearsed yet; do it once on staging before relying on it.

**Health and logs**

- `docker compose ps`: `puter`, `puter-mariadb`, `puter-s3`, `puter-valkey`, `puter-caddy`, `puter-smtp` and `puter-chat` report health; all should be `healthy`. `puter-coturn` has no health check: `docker logs puter-coturn` should show its listeners.
- `https://chat-api.stg.unify.works/healthz` answers `ok` from the chat server.
- Logs: `docker logs puter` (server, extensions: lines start `[usersend]`, `[useradmin]`), `docker logs puter-chat` (joins, meeting invitations, errors), `docker logs puter-smtp` (inbound mail).
- Set Docker log rotation on the host (`/etc/docker/daemon.json`: `"log-opts": {"max-size": "50m", "max-file": "5"}`).

**Restarts**: `docker compose restart <service>`; the chat server waits for Puter on its own (it exits and is restarted until Puter answers).

**Login rate limit**: Puter allows 10 sign-ins per 15 minutes per client address. Behind one office NAT that limit is shared; if testers are locked out, clear it with `docker exec puter-valkey sh -c 'for k in $(valkey-cli -c --scan --pattern "rate:login*"); do valkey-cli -c del "$k"; done'`.

## Security notes, limits and open items

Staging is fit for internal testers; the items marked *before production* must be closed before real users or real mail.

**Security notes**

- Only Caddy (80/443) and SMTP (25) are public. MariaDB, Valkey, DynamoDB, S3, Puter, the chat server and the apps server listen only on the Docker network; S3 is reached through Caddy at `s3.` for signed uploads. The local test helpers (MailHog on 8025, the apps server on 8090) are bound to 127.0.0.1 only; on staging remove the mailhog service from docker-compose.override.yml.
- `.env` and `config.json` hold every secret; keep them `chmod 600`, out of git, and generated per environment.
- The chat server trusts only Puter's own answer to "who is this token": every request is checked against Puter's `/whoami`, cached for 30 s per token.
- The chat server mails colleagues on a user's behalf only through `/email/deliver-internal`, which needs `unifyInternal.secret`, accepts only accounts on this server as sender and recipients, and requires the message's From to match the sender.
- Mail from outside is stamped with a `Received` header on arrival, so Calendar never treats a forged "From: colleague" as internal.
- Account creation is limited to `unifyAdmin.admins`, signed in directly (an app acting for an admin is refused).

**Known limits**

| Area | Limit | Workaround or plan |
| --- | --- | --- |
| Inbound mail | No spam filtering, no SPF/DKIM/DMARC checks | *before production*: a filtering MTA (e.g. Rspamd + Postfix) in front of port 25 |
| Calendar | Picks up invitations only while the Calendar app is open (Puter's background handlers need Cloudflare workers) | it catches up on open; re-checks every minute while open |
| Meetings | Guests without an account cannot join (no guest relay grants; outside the desktop Meetings would turn to puter.com). Calls are a mesh: fine to about 6-8 people on video | add accounts for guests; a media server (e.g. LiveKit) only if large meetings are needed |
| Notifications | Live in-app; browser notifications if the user turns them on; no sound | — |
| Chat | Chat email notifications and email invitations are off; web push and link previews need outbound internet | org members join automatically, so invites are not needed |
| Chat scale | Messages live in the chat service account's key-value store (one DynamoDB-local instance) | fine for a staging org; load-test before a large one |
| Accounts | No admin screen to disable or delete accounts; no SAML, LDAP or SCIM | *before production*: decide on SSO (Puter supports OIDC sign-in) |
| DynamoDB | `dynamodb-local` is an emulator, single node | *before production*: decide whether it is acceptable or move to a managed DynamoDB |

**Open items before staging can start**

- [ ] Put `~/unify-suite` and `~/everything` (branch `self-hosted`) into git, tag a release; both are uncommitted today
- [ ] Pin the images still on `latest` (and the major-version tags)
- [ ] Open the firewall for calls (3478 UDP+TCP, the relay UDP range) and set `TURN_HOST` / `TURN_EXTERNAL_IP`
- [ ] Staging VM, wildcard DNS and certificate, SMTP relay credentials, MX/SPF/DKIM/DMARC records
- [ ] `BRAND_SOURCE` in `.env` (the frontend's brand folder), `scripts/sync-brand.sh` run
- [ ] Rehearse a backup restore once
