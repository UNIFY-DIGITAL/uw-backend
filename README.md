# Unify Works — self-hosted suite (on Puter)

The "everything" apps on our own Puter server, for one organisation, branded
**Unify Works**: email (inside the organisation and to/from the outside),
calendar with invitations by email, chat with calls, video meetings,
documents, sheets, slides, PDF, contacts, notes, tasks, projects, an App
Center and an Admin app. Signed-in people only; an administrator adds them.

Docs, all in this folder:

| Doc | For |
| --- | --- |
| `README.md` (this file) | Running and testing the suite on this machine |
| [docs/devops-staging.md](docs/devops-staging.md) | DevOps: deploying a staging copy on premises, configuration, upgrades, verification, operations |
| [docs/services.md](docs/services.md) | What replaces each puter.com / third-party service, locally and on staging / production |
| [docs/faq.md](docs/faq.md) | Questions and decisions: identity from Google/Microsoft, onboarding, GCP, storage, versions |

## The organisation

One installation is one organisation, set by four lines of `.env`:

```bash
PUTER_DOMAIN=unifyworks.localhost   # web: <domain>, and each app at <app>.<domain>
PUTER_PROTOCOL=http                 # https on staging and production
MAIL_DOMAIN=unify.works             # addresses: <username>@unify.works
BRAND_NAME="Unify Works"
```

Nothing else names a domain. `scripts/configure.sh` writes them into Puter's
`config.json`, Caddy's routes and the apps server; `scripts/deploy-apps.sh`
builds every app for them. After changing them:

```bash
scripts/configure.sh && docker compose --profile smtp up -d && docker compose --profile smtp restart puter puter-smtp caddy apps chat
scripts/deploy-apps.sh          # every app, rebuilt for the new addresses
```

Any `*.localhost` name reaches this machine with no DNS setup.

## What runs

`docker compose --profile smtp up -d` (from this folder) starts:

| Container | Role | Address |
| --- | --- | --- |
| `puter` | Puter server: accounts, drive, storage, SDK, desktop | http://unifyworks.localhost |
| `puter-caddy` | Reverse proxy on port 80: the desktop, `api.`, `js.`, `s3.`, each app's sub-domain, `chat-api.` | |
| `puter-apps` | Serves each app from its own sub-domain (`apps/<host>/`), and `brand.` (logos, wallpaper) | http://mail.unifyworks.localhost, … |
| `puter-chat` | Chat server: Teamchat's back end, the call signaller, relay logins, Meetings' room directory, onboarding into Chat | http://chat-api.unifyworks.localhost |
| `puter-coturn` | TURN/STUN relay for calls | 127.0.0.1:3478 udp/tcp, 49160-49200/udp |
| `puter-smtp` | **Inbound** mail for `@unify.works` (an outside server delivers here) | localhost:2525 |
| `puter-mailhog` | Stands in for the **outbound** relay (Google Workspace / Microsoft 365 / own mail server) | http://localhost:8025 |
| `puter-mariadb`, `puter-valkey`, `puter-dynamo`, `puter-s3` | Database, cache, key-value store, file storage (all data in `puter/data/`) | |

Nothing depends on puter.com or any other outside service while running:
`node e2e/audit-external.cjs` opens the desktop and every app and lists every
outside host the browser contacts (none).

Puter is pinned by digest in `docker-compose.yml` (release 26.10.1, revision
`3160b99f`); move it only with `scripts/upgrade-puter.sh` (see "Upgrading Puter").

### Our additions to stock Puter

| Where | What |
| --- | --- |
| `.env` + `scripts/lib/suite.sh` + `scripts/configure.sh` | The organisation's settings, and everything derived from them |
| `suite-apps.json` | The suite's apps: name, sub-domain, source, build settings. Drives deploys, routes, the App Center, the apps button and the Admin app |
| `extensions/useradmin/` | **Administration** (`/unify/...`): people (add, disable, make administrator, reset password, remove), apps (on/off for everyone, add a web app), the people **directory**, and **onboarding** (mailbox, Email/Calendar access, Chat seat at account creation). For DevOps also `/unify/internal/...` with the internal secret |
| `admin-console/` | The **Admin** app (admin.<domain>), administrators only |
| `app-center/` | The **App Center** (appcenter.<domain>): the organisation's apps, each opening in a new tab |
| `gui-extensions/unify-apps.js` | The **apps button** (9 dots, top of every screen): search the organisation's apps, open one in a new tab; desktop tiles open in new tabs too |
| `gui-extensions/unify-branding.js` | The brand name, logo and wallpaper in the desktop, from `config.json` |
| `extensions/usersend/` | `POST /email/send` (open-source Puter lacks it): colleagues get mail straight in their mailbox, outside addresses go through the relay; outside mail is stamped `Received:` |
| `extensions/unifyorigin/` | The desktop's puter.js talks to this server from its first line, never puter.com |
| `scripts/set-app-origin.sh` | Every app's puter.js is told our desktop's address (by default it addresses and trusts puter.com, so app-to-app features broke). Run by `deploy-apps.sh` |
| `scripts/deploy-apps.sh` branding step | "Puter" as a product name in the apps' text becomes the brand ("Unify Works Mail") |
| `puter/patches/PuterHomepageService.js` | Puter's page without its CDN wallpaper preload (`scripts/patch-puter.sh`, re-made on upgrade) |
| `chat-server/` | Teamchat's back end, call signaller (`signaller.mjs`), relay logins, Meetings' rooms, chat → calendar bridge, `/internal/onboard` and `/offboard` |
| `docker-compose.override.yml` `NODE_PATH` | Works around a packaging slip in Puter 26.10.1's image (cannot find `sharp`) |
| `~/everything`, branch `self-hosted` | The apps, made to work for any server and mail domain: Calendar invitations by email, meeting links, directory suggestions, Meetings and Calendar fixes |

### Settings Puter reads (`puter/config/config.json`, chmod 600)

The domain, mail domain, brand and call keys are written by
`scripts/configure.sh` from `.env`; the rest are set once:

| Key | Value | Why |
| --- | --- | --- |
| `domain`, `origin`, `api_base_url`, `gui_puterjs_bundle`, `*_hosting_domain*`, `s3.s3Config.publicEndpoint` | from `PUTER_DOMAIN` | The desktop and apps talk to this server, not puter.com |
| `userEmail.localDomains`, `email.from` | from `MAIL_DOMAIN` | The organisation's addresses; outbound relay sender |
| `gui_params.brand_*`, `title` | from `BRAND_NAME`, files on `brand.<domain>` (`apps/brand/`) | Name, logos, wallpaper |
| `peers.signaller_url`, `peers.fallback_ice` | `ws://chat-api.<domain>/signal`, our STUN | Calls (no TURN password here: relay logins come from `/peer/generate-turn`) |
| `unifyAdmin.admins`, `serviceAccounts` | `["admin"]`, the chat service account | Bootstrap administrators (protected); accounts never listed or edited |
| `unifyInternal.secret` | = `UNIFY_INTERNAL_SECRET` in `.env` | The suite's own calls: chat → mail, onboarding, DevOps scripts |
| `events.enabled` | `true` | Live updates (new mail in about a second) |
| `disable_user_signup`, `gui_params.disable_temp_users` | `true` | Sign-in only; no sign-up, no throw-away guest accounts |
| `email` | `mailhog:1025` | Outbound relay (Google/Microsoft/own SMTP in production) |

## People

Sign in at http://unifyworks.localhost. Test passwords: `Unify-test-123`.

| User | Email | Use it for |
| --- | --- | --- |
| `alice` | `alice@unify.works` | main sender, meeting organiser |
| `bob` | `bob@unify.works` | recipient, guest |
| `charlie` | `charlie@unify.works` | Cc, a second guest |
| `dave` | `dave@unify.works` | another colleague |
| `opsadmin` | `opsadmin@unify.works` | administrator (created by DevOps' script) |
| `admin` | — | Puter's bootstrap administrator (`docker logs puter \| grep "password for admin"` until changed) |

**Adding people: the Admin app** (Apps button → Admin, administrators only):
add a person (no password given: a temporary one is shown once and must be
changed at first sign-in), disable / enable, make or remove administrator,
reset a password (signs them out everywhere), remove (irreversible: their
files, mail and calendar go too). A new account is onboarded at once: its
mailbox exists, Email and Calendar may use it (no permission prompts), and it
is in the organisation's Chat, reachable before its first sign-in.

**From the server (DevOps, first administrators):** no password of anyone
needed, it uses the internal secret:

```bash
scripts/create-user.sh priya --admin --name "Priya Shah"     # temporary password printed once
scripts/create-user.sh erin --password 'Some-password-1'     # erin@unify.works
```

### Test addresses outside the organisation

| Address | What happens |
| --- | --- |
| another domain, e.g. `someone@gmail.example` | relayed: appears in MailHog, http://localhost:8025 (nothing leaves the machine) |
| `nobody@unify.works` (no such account) | refused, `no_such_user` |
| mail **from** outside, e.g. `carol@partner.example` → `bob@unify.works` | `python3 scripts/mail-smoke.py` delivers one over SMTP (port 2525) |

## Apps

Each app lives on its own sub-domain and opens inside the desktop
(`unifyworks.localhost/app/<name>`, or the apps button / App Center, which
open it in a new tab):

| App | Address | Puter name | Built from |
| --- | --- | --- | --- |
| Email | mail.unifyworks.localhost | `email` | `~/everything/src/email` |
| Calendar | calendar. | `calendar` | `calendar` |
| Chat | chat. | `teamchat` | `teamchat` (back end: chat server) |
| Meetings | meet. | `meetings` | `meetings` (room directory: chat server) |
| Contacts, Notes, Tasks, Projects, PDF | contacts., notes., tasks., projects., pdf. | `contacts`, `notes`, `tasks`, `projects`, `pdf-editor` | same names |
| Documents, Spreadsheet, Presentation | docs., sheets., slides. | `word-processor`, `spreadsheet`, `presentation` | `documents`, `spreadsheet`, `presentation` |
| App Center | appcenter. | `app-center` | `app-center/` |
| Admin | admin. | `admin` | `admin-console/` |

The list is `suite-apps.json`. Deploy or update:

```bash
scripts/deploy-apps.sh                 # every app
scripts/deploy-apps.sh calendar chat   # some (Puter name or sub-domain)
SKIP_BUILD=1 scripts/deploy-apps.sh    # re-publish and re-register without rebuilding
```

Each deploy builds the app for this server, publishes it at its sub-domain,
tells its puter.js our desktop's address, brands its text and registers it
with Puter (through the admin extension, no admin password). An
administrator turns apps on and off for everyone, or adds another web app, in
the Admin app.

Rebuild the **desktop** only after changing `gui-extensions/` or the Puter
revision: `scripts/build-desktop.sh` (~2 min; restarts puter).

## Chat

Teamchat on our chat server, its data in the `unifychat` service account.

- Everyone is in the **Unify Works** workspace from the moment their account
  exists: channels, DMs, threads, search, and every person picker lists
  everyone.
- **Chat → Calendar**: **+ → Meeting invitation** (or any `.ics` posted) is
  mailed from the poster to the conversation's members and lands in their
  calendars, with a video link ("Add a video meeting link", on by default:
  `unifyworks.localhost/app/meetings?m=abcd-efgh-ijkl`).
- **Huddles** (audio, camera, screen share): the headphones button.
- Logs: `docker logs puter-chat`.

## Calls and meetings

Browsers send media to each other directly, or through our relay:

| Piece | Where | Replaces |
| --- | --- | --- |
| Signaller | chat server, `ws://chat-api.<domain>/signal` | puter.com's signaller |
| TURN/STUN | `puter-coturn`; logins from `api.<domain>/peer/generate-turn` (Caddy → chat server), signed-in users only, 12 h | Cloudflare's paid TURN |
| Meeting rooms | Meetings' `worker/rooms.js` in the chat server | `puter-meetings-rooms.puter.work` |

Calls need HTTPS on a real domain (`localhost` counts as secure here); they are
a mesh (about 6-8 people on video). Meetings: camera, microphone, screen
sharing, background blur; links open it in the desktop. Guests need an account.

## Name suggestions

Typing a name suggests colleagues from the organisation's directory
(`/unify/directory`: active accounts, service accounts and disabled people left
out): Email's To/Cc (after the people already written to), Calendar's guests
(after the person's Contacts), and Chat's pickers (everyone is a member).

## Automated checks

```bash
scripts/check-suite.sh                 # everything, with a summary (about 15 minutes)
scripts/check-suite.sh quick           # without the two call tests in browsers
```

One by one (every test reads its addresses from `.env`):

```bash
python3 scripts/mail-smoke.py          # internal, outbound relay, forged From, inbound SMTP
node e2e/probe-brand.cjs               # no "Puter" on sign-in page or desktop
node e2e/probe-signup-off.cjs          # sign-in only
node e2e/chat-api.cjs                  # chat: membership, messages, search, DMs
node e2e/chat-calendar.cjs             # an .ics in #general reaches bob's and charlie's mailboxes
node e2e/probe-chat-meeting-link.cjs   # chat invitation with a link -> bob's Calendar and Meetings
node e2e/probe-turn.cjs                # coturn: relay logins, data over a relay-only connection
node e2e/probe-peer.cjs                # signaller: codes, rooms, both protocols, resume, anonymous, sign-in
node e2e/probe-switcher.cjs            # apps button; apps and desktop tiles open in new tabs
node e2e/probe-app-links.cjs           # Meetings reaches Calendar; no broken images
node e2e/probe-admin.cjs               # Admin app: people and apps
node e2e/probe-newcomer.cjs            # a newcomer: Chat and invitations before first sign-in, suggestions
node e2e/audit-external.cjs            # every app: no request to any outside host
node e2e/probe-huddle.cjs              # a Chat huddle: connected, hearing each other
node e2e/probe-meeting.cjs             # Meetings: camera and microphone both ways
```

## Manual test in the browser

Two browser windows that don't share cookies: **alice** in one, **bob** in the
other, at http://unifyworks.localhost (you land on **Log In**; no sign-up).

1. **Email.** Alice writes to `bob@unify.works` (type "bo": Bob is suggested);
   Bob's Inbox shows it within seconds. Mail to `someone@gmail.example` shows
   in MailHog.
2. **Calendar.** Alice creates an event, adds guest "Bob" (suggested), adds a
   meeting link, saves and emails the invitation. Bob opens Calendar: the event
   is there with **Join meeting**; he answers **Yes**; Alice sees him accepted.
3. **Chat.** Alice opens Chat → #general, writes; Bob sees it. **+ → Meeting
   invitation**: the meeting shows in everyone's Calendar and Meetings.
4. **Meetings.** Both join the meeting from the link: camera and microphone.
5. **Apps.** The apps button (top centre) → search "sheet" → opens in a new tab.
6. **Admin** (as `opsadmin`): add a person, then sign in as them with the
   temporary password; turn an app off and see it vanish for Alice.

## Known limits on self-hosted Puter

- **Calendar picks up mail only while it is open** (Puter's always-on handlers
  need Cloudflare workers); it catches up when opened.
- **Apps per group**: an administrator turns apps on or off for everyone; not
  per group or person.
- **Meetings**: guests need an account; there is no "invite people" box inside
  a meeting (invite through Calendar or Chat).
- **People from Google / Microsoft**: accounts are ours; SSO and directory sync
  are not set up (see `docs/faq.md`).
- **Notifications**: live in-app and browser notifications; no sound.
- The inbound receiver does no spam / SPF / DKIM / DMARC checks; put a
  filtering mail server in front of port 25. No TLS locally; production needs
  a wildcard certificate.

## Upgrading Puter

```bash
scripts/upgrade-puter.sh check                # what we run, the newest release, setup files changed upstream
scripts/upgrade-puter.sh upgrade              # staging: to the newest build
scripts/upgrade-puter.sh upgrade sha256:<d>   # production: exactly what staging passed with
scripts/upgrade-puter.sh rollback backups/puter-<date>-<rev>.tgz
```

`upgrade` stops the suite, backs everything up to `backups/` (chmod 600),
regenerates `docker-compose.yml` from the release's own file pinned by digest,
rebuilds the desktop at that revision, re-makes the page patch, starts
everything and runs `scripts/check-suite.sh`; it stops at the first problem
with the rollback command. Production never takes a moving tag.

## Stop / reset

```bash
docker compose --profile smtp down        # stop, keep data
docker compose --profile smtp down && rm -rf puter/data   # wipe everything (irreversible)
```

## Troubleshooting

- **"Too many requests" signing in.** 10 logins per 15 minutes per address,
  and locally everything comes from one Docker address:
  `docker exec puter-valkey sh -c 'for k in $(valkey-cli -c --scan --pattern "rate:login*"); do valkey-cli -c del "$k"; done'`
- **Blank desktop after rebuilding it.** `docker compose restart puter`
  (`build-desktop.sh` does this).
- **An app does not load.** `curl -s http://<host>.unifyworks.localhost/index.html`
  should answer; after a domain change run `scripts/configure.sh`, restart, and
  `scripts/deploy-apps.sh`.
- **A setting in `.env` did not take.** `scripts/configure.sh`, then restart
  puter, puter-smtp, caddy, apps and chat.
