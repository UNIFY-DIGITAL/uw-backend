# Unify Works: questions and answers

Decisions and the reasons behind them, kept for later. Newest topics first in
each section. With `README.md` (running it here), `docs/devops-staging.md`
(deploying it) and `docs/services.md` (what replaces each puter.com or
third-party service).

## Organisation, people and onboarding

### Our customer already has Google Workspace or Microsoft 365. Do people come from there, or must we create 10,000 accounts by hand?

Neither by hand. Today the suite has **its own accounts**; nothing is fetched
from Google or Microsoft yet. Using their SMTP relay only carries mail out; it
does not give us their people. Two pieces (not built yet; SSO is untouched on
purpose until it is decided) make their directory the source of truth:

| Piece | What it does | How |
| --- | --- | --- |
| **Sign-in with their identity (SSO)** | People sign in with their Google / Microsoft account; no password of ours | Puter supports **OIDC** sign-in (Google and Microsoft Entra ID are OIDC providers): `config.json` `oidc` providers |
| **Directory sync** | Accounts exist **before** first sign-in (so a newcomer can be messaged, invited, given files) and are disabled when someone leaves | A scheduled job reading their directory (Google Admin SDK Directory API, Microsoft Graph `/users`) and calling our admin API (`/unify/internal/users`, disable through the same extension). Puter has no SCIM endpoint; the sync is ours to write |

With both: a joiner is added **in their suite only**; the next sync (for
example every 15 minutes) creates the account here, onboarded (mailbox, Chat
seat, app permissions), and they sign in with SSO. A leaver is disabled in
their suite; the sync disables them here. 10,000 accounts is a first sync,
then small daily changes. Puter also has "admin-provisioned pre-registration"
(placeholder accounts that a sign-in claims), worth evaluating for the sync.

The bigger decision is **whose mailbox and calendar**:

| Option | Mail and calendar live in | Our Email / Calendar apps | Effort |
| --- | --- | --- | --- |
| A. Ours | Our server (MX points at us; their Google/Microsoft keeps only what they choose) | Work as now | Directory sync + SSO |
| B. Theirs | Gmail / Exchange stay the mailboxes; our suite adds chat, documents, meetings | Must read their mailbox and calendar (IMAP/Gmail API/Graph) instead of ours: new work, or drop our Email/Calendar for theirs | Large |
| C. Both, one domain split | Some people on ours, some on theirs (MX on theirs, forwarding to ours) | Works for ours; cross-system invitations as plain email | Medium; confusing for people |

Recommendation: decide A vs B per customer before onboarding; A is what the
suite does today.

### How do we simulate a new organisation (for example unify.works) locally?

One installation is one organisation. Its identity is three lines of `.env`:

```
PUTER_DOMAIN=unifyworks.localhost   # web: <app>.unifyworks.localhost
MAIL_DOMAIN=unify.works             # addresses: <username>@unify.works
BRAND_NAME="Unify Works"
```

`scripts/configure.sh` writes them everywhere (Puter's config, Caddy, the
apps server) and `scripts/deploy-apps.sh` builds every app for them. Any
`*.localhost` name reaches this machine with no DNS setup. A second
organisation is a second copy of the folder with its own `.env` and data, run
one at a time locally (both want port 80 and the same container names).

### What happens when an organisation's domain or mail domain changes?

It is a supported operation (done here from `puter.localhost` / `unify.test`
to `unifyworks.localhost` / `unify.works`), but plan it, because addresses
live in data too:

1. Back up (`docker compose --profile smtp stop`, then the `backups/` copy, as
   `scripts/upgrade-puter.sh` does).
2. Change the four lines of `.env`, run `scripts/configure.sh`, start the
   suite, restart puter, puter-smtp, caddy, apps and chat.
3. Move the accounts' addresses: `POST /unify/internal/mail-domain {from, to}`.
4. Rebuild every app: `scripts/deploy-apps.sh` (their addresses are built in).
5. Everyone signs in again (sessions belong to the old address). Chat drops
   saved workspaces whose server address moved and re-adds them.
6. Old data keeps old addresses: mail already received, chat messages, and
   calendar events (organiser / guest addresses, meeting links). Replies to old
   mail go to the old domain. Calendar events can be rewritten per account (we
   did it for the demo accounts); mail and chat history are left as written.

### Someone was removed. Why do conversations with them remain in Chat?

As in Slack: their messages stay part of the conversation's history, shown
with their name; nobody can reach them. The account itself, with its files,
mail and calendar, is gone.

### How is the first administrator created, and how does an administrator add people?

- **First administrator**: Puter creates `admin` on first start (password in
  `docker compose logs puter | grep "password for admin"`; change it at first
  sign-in). DevOps can create more with `scripts/create-user.sh <name> --admin`
  (uses the internal secret, no password of anyone).
- **Everyone else**: in the **Admin** app (admin.<domain>, listed only for
  administrators): add a person (a temporary password is shown once and must
  be changed at first sign-in), disable / enable, make or remove administrator,
  reset a password, remove (irreversible: files, mail, calendar go too).
- Administrators: `config.json` `unifyAdmin.admins` (bootstrap, protected) plus
  anyone promoted in the Admin app.

### Can we choose which apps people see?

For the **whole organisation**: yes, in the Admin app's Apps tab. Turning an
app off hides it from the App Center and the apps button and stops it opening
(it shows "this app is turned off"). An administrator can also add any web app
by its address, optionally for administrators only. The suite's own apps come
from `suite-apps.json`, deployed by DevOps.

**Per group or per person**: not available. It needs groups in the Admin app
and the same filter applied per group, plus refusing the app on the server
for the others (a hidden tile alone is not access control).

### What is the "allow access to .mail" prompt, and does it create storage?

It does not create anything. It asks the person, once per app, to let Email or
Calendar read their mail folder (`~/.mail`). Since onboarding, new accounts
get that access granted when they are created, and their mail folder exists
from the start: no prompts. Accounts created before this got it through
`/unify/internal/onboard-all`.

### Someone is added and invited to meetings before they ever sign in. What do they see later?

| | Before their first sign-in | After |
| --- | --- | --- |
| Email | Delivered to their mailbox (the account exists) | Everything |
| Calendar invitations | In their mailbox | Filed when they first open Calendar: its first look reaches **a year and 1,000 emails** back (later looks only check new mail) |
| Chat | **A member from the moment the account is created**: colleagues can message them, mention them, add them to channels; invitations posted in a conversation reach them | Everything in their conversations and all public channel history |
| Meetings | Links work for anyone signed in | Any link they are given |

### Will typing a name suggest colleagues?

Yes, from the organisation's directory (every active account; service
accounts and disabled people left out):

- **Email**: To / Cc, after the people already written to.
- **Calendar**: guests, after the person's own Contacts.
- **Chat**: everyone is a member, so every person picker and @mention lists them.
- **Meetings**: there is no field for names (a meeting is shared by its link;
  people are invited through Calendar or Chat). An "invite people" box inside a
  meeting would be new work.

## Running it: hosting, cloud, independence

### Is the suite independent of Puter's cloud?

While running, completely: accounts, sign-in, puter.js, calls and every app run
on our server; a browser audit of the desktop and every app contacts no outside
host (`node e2e/audit-external.cjs`), and no container holds an internet
connection. Installing and upgrading download images (GitHub's and Docker
Hub's registries), npm packages and Puter's source; production can mirror
these in its own registry. One limit: an app page opened outside the desktop
falls back to puter.com, which is why links open apps through the desktop.

### Where does each app live?

On its own sub-domain: `mail.`, `calendar.`, `chat.`, `meet.`, `contacts.`,
`docs.`, `sheets.`, `slides.`, `pdf.`, `notes.`, `tasks.`, `projects.`,
`appcenter.`, `admin.` (from `suite-apps.json`), each opened inside the desktop
at `<domain>/app/<name>`. The chat back end, call signaller and Meetings' room
directory are on `chat-api.`. Puter reserves `api.`, `js.`, `s3.`, `site.`,
`host.`, `app.`, `dev.`.

### GCP: one VM, or Cloud Run with a VPC?

One **Compute Engine VM running the containers**. Cloud Run does not fit:
coturn needs UDP, incoming mail needs SMTP, the chat server keeps calls'
introductions in memory (one instance), and the databases are stateful. Some
containers can become managed services: MariaDB → Cloud SQL for MySQL, Valkey →
Memorystore, RustFS → Cloud Storage (test first, below). DynamoDB-local has no
GCP equivalent (Puter's key-value store only speaks DynamoDB): keep it on the
VM's persistent disk with backups. Google blocks outgoing port 25 (we send
through a relay on 587); calls need UDP 3478 and the relay range public, and
incoming mail port 25, even when the web side is private.

### Can a UI hosted on CloudFront or Cloudflare talk to our VM in a private network?

The CDN only delivers the page; the **browser** then calls the API, so it must
reach it: public behind an HTTPS load balancer, or private with people on the
VPN. Cloudflare can reach a VM with no public IP through Cloudflare Tunnel;
CloudFront's private origins only work inside AWS. Do not serve Puter's
desktop as separate static files from a CDN (the server builds that page per
request); put the CDN in front of the same domain as a caching proxy. Calls
never go through a CDN.

### Containers or native in production?

Containers. Puter ships as an image, and the pinning, upgrade script, rollback
and checks assume it. Managed databases can replace containers; Puter, the
chat server, Caddy and coturn stay in containers.

### What does the S3 container do, and can Google replace it?

`puter-s3` (RustFS) holds the **contents of every file**: drive documents, every
mail message, attachments (chat files too), app uploads, thumbnails. MariaDB
holds only the list of files. Browsers upload and download directly with
short-lived signed links (`s3.<domain>`). Cloud Storage can replace it through
its S3-compatible interface (`s3Config`: endpoint
`https://storage.googleapis.com`, HMAC keys, path-style, a CORS rule for the
browser's uploads). Test on staging first: the AWS library Puter uses sends
checksum headers Cloud Storage may refuse, and large (multipart) uploads need
checking.

## Versions and upgrades

### Why did Meetings need a Puter upgrade when ~/everything was the latest?

Two projects: `everything` holds the apps; Puter (the server, desktop and
puter.js) is separate and was pinned to the build current when the suite was
set up (Oct 4). Meetings, written for puter.com's current puter.js, needed its
media API from Oct 8. The pin was for stability; it should have moved with the
apps. Now `scripts/upgrade-puter.sh` moves it (release 26.10.1).

### Where do the images come from, and what if Puter (or an image) disappears upstream?

From our own copy in Google Artifact Registry
(`asia-south1-docker.pkg.dev/unifyworks/unify-suite`) on staging and production:
`.env` `REGISTRY`, filled from `.env.production.example`. Every image is pinned by
digest, so the copy is bit-for-bit what was tested. If Puter went private or an
image were deleted upstream, the suite keeps running and redeploying from it;
released Puter code stays AGPL and usable (only future updates would stop).
The registry is private: developers without GCP access leave `REGISTRY` unset and
pull the same digests from Docker Hub and GitHub. Still to do for full
independence: complete mirrors of the Puter and `everything` git repos in our
private GitHub (`vendor/puter` is a partial clone).

### How do we upgrade Puter safely?

`scripts/upgrade-puter.sh check`, then `upgrade` on **staging** (backs up,
re-pins, rebuilds the desktop at the same revision, re-applies our patch,
restarts, runs every check, prints the digest), then the **same digest** on
production. `rollback <backup>` restores. Production never takes a moving tag.
26.10.1 itself needed one workaround (`NODE_PATH` in the override): its image
could not find a module.

### Why did each new feature break something in another app, and how do we stop it?

The apps are written for puter.com, where cloud services glue them together;
self-hosted, each glue is our own path, and a feature crossing apps (meeting
links: Chat → mail → Calendar → Meetings) touched several of them untested.
Rules now:

1. A cross-app feature is done when a scenario test covers every app it touches
   (`e2e/probe-chat-meeting-link.cjs` is one).
2. `scripts/check-suite.sh` runs after every change and before every staging
   deploy (to be put on a CI runner with Docker).
3. Addresses and the app list are settings (`.env`, `suite-apps.json`), not
   code, so a new domain or app cannot be missed in one place.

## Calls and meetings

### What replaced puter.com's call services?

Our signaller (in the chat server), our TURN relay (coturn, instead of
Cloudflare's paid service; logins only for signed-in users) and Meetings' room
directory (in the chat server). Calls need HTTPS on a real domain; they are a
mesh (everyone sends to everyone: about 6-8 people on video). Guests without an
account cannot join.
