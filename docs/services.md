# Unify Works: what runs, and what replaces what

The suite is Puter (open source, self-hosted) plus the apps from
`~/everything`. Out of the box, several of those apps lean on services that
only exist on **puter.com** or on **third parties** (Cloudflare, CDNs). This
page lists every service the suite needs, what stock Puter or puter.com
provides for it, what we run instead, and what to use **locally**, on
**staging** and in **production**.

Rule of the suite: nothing depends on puter.com or another outside service.
Checked by `node e2e/audit-external.cjs` (every app, in a browser: no
outside host contacted) and by looking at the containers' connections (none
to the internet).

## 1. Services

"Local" is this machine (`docker compose`, `*.unifyworks.localhost`, no TLS). The organisation's domain, mail domain and brand are four lines of `.env`; everything else is derived from them.
"Staging / production" is the same stack on a server, with the changes listed.

### Web front

| Service | Stock Puter / puter.com | We run | Local | Staging / production |
| --- | --- | --- | --- | --- |
| Reverse proxy, TLS | Caddy in Puter's compose | Caddy, plus our routes (`caddy/Caddyfile`): `apps.`, `chat.`, `s3.`, and `api.…/peer/generate-turn` to the chat server | `caddy:2.11-alpine`, port 80, no TLS | Same Caddy on 443 with a **wildcard certificate** for `*.<domain>` (DNS-01), or a load balancer (ALB, nginx) doing TLS in front, with the same routes. HTTP redirects to HTTPS. |
| Domain names | `puter.com`, `*.puter.com` | `<domain>` (desktop), one sub-domain per app (`mail.`, `calendar.`, `chat.`, `meet.`, `docs.`, … from `suite-apps.json`), `api.`, `js.`, `s3.`, `chat-api.`, `brand.`, and Puter's per-user ones | `*.unifyworks.localhost` (resolves to this machine by itself) | Wildcard DNS `*.<domain>` and `<domain>` pointing at the server |

### Puter itself

| Service | Stock Puter / puter.com | We run | Local | Staging / production |
| --- | --- | --- | --- | --- |
| Puter server: accounts, drive, desktop, puter.js | puter.com, or the `ghcr.io/heyputer/puter` image | The same image, **pinned by digest** (now release 26.10.1, `3160b99f`) | `puter` container | Same image. **Staging** takes the newest release with `scripts/upgrade-puter.sh upgrade`; **production** takes the exact digest staging passed with. |
| Desktop (GUI) | In the image | Rebuilt at the image's own revision with our extensions: branding (`gui-extensions/unify-branding.js`) and the **app switcher** (`unify-apps.js`), mounted over the image's copy | `scripts/build-desktop.sh` | Same build, done by the deploy (and by `upgrade-puter.sh`) |
| puter.js (the SDK every app loads) | `js.puter.com` | Served by our Puter at `js.<domain>/v2/`; apps are built to load it from there | `js.unifyworks.localhost` | `js.<domain>` |
| Sign-up / accounts | Anyone signs up | Sign-up off. Administrators add, disable, promote and remove people in the **Admin** app (`admin-console/`, `extensions/useradmin`); DevOps creates administrators with `scripts/create-user.sh` (internal secret). New accounts are onboarded at once (mailbox, app access, Chat) | Same | Same. Later: SSO + directory sync from the customer's Google / Microsoft (docs/faq.md) |
| Desktop page talking to puter.com | puter.js opened a socket to `api.puter.com` on every load; the page preloaded a wallpaper from `puter-assets.b-cdn.net` | `extensions/unifyorigin` (our server from the first line) and `puter/patches/PuterHomepageService.js` (preload removed; `scripts/patch-puter.sh`) | Same | Same; the patch is re-made by `upgrade-puter.sh` for each release |
| Branding | "Puter" name, logo, wallpaper | "Unify Works", our logo and wallpaper (`config.json` `gui_params`, files in `apps/brand/`) | Same | Same; the organisation's own files |

### Data

| Service | Stock Puter / puter.com | We run | Local | Staging / production |
| --- | --- | --- | --- | --- |
| Database | MariaDB in Puter's compose | Same | `mariadb:11`, data in `puter/data/mariadb` | Same container on a persistent volume with nightly dumps, or a managed MariaDB/MySQL |
| Cache, sessions, rate limits | Valkey (Redis) | Same | `valkey:8-alpine` | Same, or a managed Redis-compatible service |
| Key-value store (apps' `puter.kv`, chat data) | DynamoDB (`dynamodb-local` in the compose) | Same | `amazon/dynamodb-local` | `dynamodb-local` is an emulator: on-premises keep it on a persistent volume with backups, and test restores. On AWS, real DynamoDB (`"useCredentialChain": true`). |
| File storage | S3-compatible (RustFS in the compose) | Same; `s3-init` creates the bucket | `rustfs/rustfs`, data in `puter/data/s3` | RustFS (or MinIO) on its own disks, or AWS S3 |
| Backups | none | `scripts/upgrade-puter.sh` backs everything up before an upgrade (`backups/`) | Same | Plus scheduled backups of the database, key-value store, file storage, `.env` and `config.json`, kept off the server |

### Mail

| Service | Stock Puter / puter.com | We run | Local | Staging / production |
| --- | --- | --- | --- | --- |
| Sending mail (`/email/send`) | Not in open-source Puter | `extensions/usersend`: users send as `<username>@<domain>`; colleagues get it in their mailbox, outside addresses go through the relay | Relay = **MailHog** (`mailhog/mailhog`, catches everything, UI on `localhost:8025`) | Relay = Google Workspace / Microsoft 365 SMTP relay, or our own Postfix; SPF, DKIM and DMARC records for `<domain>` |
| Receiving mail | Puter's SMTP receiver (`puter-smtp`, `smtp` profile) | Same, plus a `Received:` stamp so outside mail is never trusted as internal | Port 2525 on this machine | MX for `<domain>` points at a **filtering mail server** (spam, virus, SPF/DKIM/DMARC checks: Postfix + Rspamd, or the provider's), which forwards to `puter-smtp`. Never expose `puter-smtp` on port 25 directly. |
| Calendar invitations by mail | puter.com's Cloudflare email workers | Calendar sends standard iTIP invitations through `/email/send` (built with `VITE_INVITES_VIA_EMAIL=true`) | Same | Same |

### Apps and app back ends

| Service | Stock Puter / puter.com | We run | Local | Staging / production |
| --- | --- | --- | --- | --- |
| Hosting the apps (static files) | puter.com hosts them | `apps` container (`nginx:alpine`): each app on its own sub-domain, `apps/<host>/` (`nginx/apps.conf`, generated) | `<app>.unifyworks.localhost` | nginx (or a CDN) on `<app>.<domain>` |
| App Center, apps list | Puter's app store | Our App Center (`appcenter.`) and the apps button, both from `/unify/apps`: the organisation's apps, as the Admin app turned them on or off | Same | Same |
| People directory (name suggestions) | none | `/unify/directory` (admin extension): Email To/Cc and Calendar guests suggest colleagues | Same | Same; later fed by the directory sync |
| App ↔ desktop messages (app-to-app calls, dialogs) | Apps' puter.js addresses and trusts puter.com as the desktop | `scripts/set-app-origin.sh` sets our desktop's address in every app (run by `deploy-apps.sh`) | Same | Same, with the staging/production origin (`PUTER_ORIGIN`) |
| Analytics in apps | plausible.io | Stripped at deploy (`scripts/deploy-apps.sh`) | Same | Same |
| Chat back end (Teamchat) | A Puter Worker on puter.com's Cloudflare account | **Chat server** (`chat-server/server.mjs`, `node:24-alpine`) running the same worker code; data in the `unifychat` service account | `chat-api.unifyworks.localhost` | Same container on `chat-api.<domain>` |
| Chat → Calendar | none | Chat server mails invitations posted in chat to the conversation's members (`calendar-bridge.mjs`, `POST /email/deliver-internal`, secret `UNIFY_INTERNAL_SECRET`) | Same | Same |
| Meetings room directory | A Puter Worker at `puter-meetings-rooms.puter.work` | Run by the chat server (`/v1/rooms/...`) | Same | Same |
| AI | puter.com's AI drivers (OpenAI and others, billed) | Off: no provider keys configured. Optional Ollama in the compose (`ai` profile), not started | Off | Off, or Ollama on a GPU host if wanted |

### Calls (Chat huddles, Meetings)

| Service | Stock Puter / puter.com | We run | Local | Staging / production |
| --- | --- | --- | --- | --- |
| Signaller (introduces two browsers) | puter.com's hosted signaller (`peers.signaller_url`) | `chat-server/signaller.mjs` on `/signal`: checks every Puter session, both puter.js protocol generations | `ws://chat-api.unifyworks.localhost/signal` | `wss://chat-api.<domain>/signal` (`config.json` `peers.signaller_url`) |
| TURN/STUN relay (through firewalls) | Cloudflare's paid TURN service | **coturn** (`coturn/coturn:4.6.3`, pinned). Logins are short-lived and only for signed-in users, minted by the chat server (`/peer/generate-turn`, shared secret `TURN_SECRET`) | `127.0.0.1:3478`, relays on `49160-49200/udp`, loopback allowed (`TURN_ALLOW_LOOPBACK=true`) | coturn on the server's public or LAN IP (`TURN_HOST`, `TURN_EXTERNAL_IP`, `TURN_BIND=0.0.0.0`); a wider relay port range for more calls; loopback **off**; optionally TLS on 5349 (`turns:`) for networks that only allow 443-like traffic |
| HTTPS for calls | puter.com is HTTPS | Browsers only give camera and microphone to secure pages | Works (`localhost` counts as secure) | **Required**: no calls without TLS |

## 2. What DevOps provides for staging / production

- **DNS**: `<domain>` and `*.<domain>` to the server.
- **TLS**: a wildcard certificate for `*.<domain>` plus `<domain>`, renewed automatically.
- **Ports**:
  - 443 (and 80 for redirects)
  - 3478 UDP and TCP, plus the coturn relay UDP range (49160-49200 here; more for more calls)
  - 25 on the filtering mail server only
- **Mail**: SMTP relay credentials, MX record, SPF/DKIM/DMARC.
- **Secrets** (in `.env`, chmod 600, never in git):
  - `MARIADB_*`
  - `S3_*`
  - `CHAT_SERVICE_PASSWORD`
  - `UNIFY_INTERNAL_SECRET` (equal to `config.json` `unifyInternal.secret`)
  - `TURN_SECRET`
- **The organisation** (`.env`): `PUTER_DOMAIN`, `PUTER_PROTOCOL=https`, `MAIL_DOMAIN`, `BRAND_NAME`; then `scripts/configure.sh` writes them into `config.json`, Caddy and the apps server.
- **Calls** (`.env`): `TURN_HOST`, `TURN_EXTERNAL_IP`, `TURN_BIND`.
- **Backups** of `puter/data`, `.env` and `config.json`, off the server, with restore tests.
- **Upgrades**: staging first (`scripts/upgrade-puter.sh upgrade`), then production with the same digest.

## 3. Upgrades and versions

| What | How it is pinned | How to move it |
| --- | --- | --- |
| Puter (server, desktop, puter.js) | Image digest in `docker-compose.yml` | `scripts/upgrade-puter.sh check` / `upgrade` / `rollback` (README: "Upgrading Puter") |
| Apps | `~/everything`, branch `self-hosted` (on top of upstream `main`) | `git pull` / rebase, then `scripts/deploy-apps.sh` (the list: `suite-apps.json`) |
| coturn | Image digest | Change the tag and digest in `docker-compose.override.yml` |
| MariaDB, Valkey | Major-version tags (`mariadb:11`, `valkey:8-alpine`) | Pin by digest before production |
| DynamoDB-local, RustFS, aws-cli, MailHog, Ollama | `:latest` | Pin by digest before production (MailHog is local only) |

## 4. Known gaps

- **Meetings guests need an account**: no guest relay grants, and outside the
  desktop Meetings would turn to puter.com.
- **Calendar reads new mail only while it is open**: Puter's always-on event
  handlers need Cloudflare workers.
- **Calls are a mesh**: fine to about 6-8 people on video.
- **SSO**: not set up.
