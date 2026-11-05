/**
 * Unify chat server: runs Teamchat's back end (a Puter Serverless Worker,
 * ~/everything/src/teamchat/worker) on our own machine instead of on
 * puter.com's Cloudflare account.
 *
 * A Puter worker is plain fetch-handler JavaScript that expects three things
 * from its runtime, and this file provides them:
 *
 *   router      routes registered with router.get/post/put/delete(path, fn)
 *   me.puter    a puter.js client for the account the worker runs as: its
 *               key-value store holds all chat data, its drive the
 *               attachments. Here: a dedicated service account on our Puter
 *               server (CHAT_SERVICE_USER).
 *   user.puter  per request, who is calling: the `puter-auth` header the
 *               Teamchat app sends (puter.workers.exec), checked against
 *               Puter's /whoami by the worker itself.
 *
 * The same runtime hosts the Meetings app's room directory
 * (~/everything/src/meetings/worker/rooms.js, MEETINGS_WORKER_BUNDLE), and
 * signaller.mjs adds what calls need: the Puter Peer signaller (/signal) and
 * short-lived coturn credentials (/peer/generate-turn), so huddles and
 * meetings run without puter.com or Cloudflare.
 *
 * On top of that, the organisation: everyone with an account on this Puter
 * server is a colleague, so on their first request they are joined to the
 * organisation's workspace (CHAT_ORG_NAME) through Teamchat's own invite
 * route — the same thing as following an invite link, without the link.
 *
 * Settings come from the environment (see .env.example). No dependencies
 * beyond Node 22+.
 */
import http from 'node:http';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createCalendarBridge } from './calendar-bridge.mjs';
import { createInvites } from './invites.mjs';
import { createSignaller } from './signaller.mjs';

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`${name} is not set`);
    return fallback;
  }
  return v;
};

const PORT = Number(env('CHAT_PORT', '8787'));
const ORIGIN = env('PUTER_ORIGIN').replace(/\/+$/, '');          // <proto>://<domain> (docker-compose.override.yml, from .env)
const API = env('PUTER_API_ORIGIN').replace(/\/+$/, '');          // <proto>://api.<domain>
const SDK_URL = env('PUTER_SDK_URL');                             // <proto>://js.<domain>/v2/
const WORKER_BUNDLE = env('CHAT_WORKER_BUNDLE', new URL('./teamchat-worker.js', import.meta.url).pathname);
const SERVICE_USER = env('CHAT_SERVICE_USER');
const SERVICE_PASSWORD = env('CHAT_SERVICE_PASSWORD');
const ORG_NAME = env('CHAT_ORG_NAME', 'Unify Works');
// A trial server's people are strangers: each may create workspaces of their
// own (and invite whom they like to them); the one shared workspace only with TRIAL_CHAT=1.
const TRIAL = env('SUITE_MODE', 'organisation') === 'trial';
const AUTOJOIN = env('CHAT_ORG_AUTOJOIN', 'true') === 'true' && (!TRIAL || env('TRIAL_CHAT', '0') === '1');
// Admins of the organisation's workspace (they see its invite link and can
// invite guests to a channel): the suite's administrators, plus these usernames.
const CHAT_ADMINS = new Set(env('CHAT_ADMINS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// Accounts that are not people (the administrator, this service) never join.
const NOT_PEOPLE = new Set(env('CHAT_ORG_EXCLUDE', 'admin').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
NOT_PEOPLE.add(SERVICE_USER.toLowerCase());
// Chat -> Calendar (calendar-bridge.mjs): off without both.
const INTERNAL_SECRET = env('UNIFY_INTERNAL_SECRET', '');
const MAIL_DOMAIN = env('CHAT_MAIL_DOMAIN', '').toLowerCase();
// Meetings' room directory: optional (a missing bundle only turns it off).
const MEETINGS_BUNDLE = env('MEETINGS_WORKER_BUNDLE', new URL('./meetings-rooms.js', import.meta.url).pathname);
// Calls (signaller.mjs): coturn's shared secret and the addresses browsers use.
const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
const TURN = {
  secret: env('TURN_SECRET', ''),
  urls: list(env('TURN_URLS', '')),
  stun: list(env('STUN_URLS', '')),
  ttl: Number(env('TURN_TTL', '43200')),
};

const log = (...a) => console.log(new Date().toISOString(), '[chat]', ...a);

// ------------------------------------------------------------------ puter.js

/** The service account's session, from Puter's normal sign-in. */
async function serviceLogin() {
  const res = await fetch(`${ORIGIN}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: SERVICE_USER, password: SERVICE_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.token) throw new Error(`service account sign-in refused (${res.status}): ${body.message || body.code || ''}`);
  return body.token;
}

/**
 * A puter.js client, loaded the way puter.js's own Node entry does it
 * (src/puter-js/src/init.cjs): the browser bundle in a fresh context. The
 * bundle comes from our Puter server, so it always matches that server.
 */
async function loadPuter(token) {
  const res = await fetch(SDK_URL);
  if (!res.ok) throw new Error(`puter.js not available at ${SDK_URL} (${res.status})`);
  const code = await res.text();
  const context = {};
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    try { context[name] = globalThis[name]; } catch { /* not copyable */ }
  }
  context.globalThis = context;
  // No live socket for a server-side client: the worker only makes requests.
  context.puter_socket_enabled = false;
  vm.runInNewContext(code, vm.createContext(context), { filename: 'puter.js' });
  const puter = context.puter;
  puter.setAPIOrigin(API);
  puter.setAuthToken(token);
  return puter;
}

/**
 * Who is calling, for the worker's identify(): only `authToken` and
 * `auth.getUser()` are used on a caller's client, so the caller gets this
 * rather than a whole puter.js instance per request.
 */
const callerPuter = (token) => ({
  authToken: token,
  APIOrigin: API,
  auth: {
    async getUser() {
      const res = await fetch(`${API}/whoami`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } });
      if (!res.ok) throw new Error(`whoami ${res.status}`);
      return res.json();
    },
  },
});

// ------------------------------------------------------------------ router

/** Path patterns as Puter's worker router reads them: `:name` one segment, `*name` the rest. */
function matcher(pattern) {
  const names = [];
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/([:*])([A-Za-z0-9_]+)/g, (_, kind, name) => { names.push(name); return kind === ':' ? '([^/]+)' : '(.*)'; });
  const re = new RegExp(`^${source}$`);
  return (path) => {
    const m = re.exec(path);
    if (!m) return null;
    return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
  };
}

const routes = new Map();
globalThis.router = {
  custom(method, path, fn) {
    if (!routes.has(method)) routes.set(method, []);
    routes.get(method).push([matcher(path), fn]);
  },
  get(p, fn) { this.custom('GET', p, fn); },
  post(p, fn) { this.custom('POST', p, fn); },
  put(p, fn) { this.custom('PUT', p, fn); },
  delete(p, fn) { this.custom('DELETE', p, fn); },
  options(p, fn) { this.custom('OPTIONS', p, fn); },
};

const cors = (headers) => {
  if (!headers.has('access-control-allow-origin')) headers.set('access-control-allow-origin', '*');
  return headers;
};

/**
 * One request through the worker's routes, as Puter's worker runtime does it.
 * `as`: an identity the suite vouches for (internal onboarding), in place of
 * the caller's own session.
 */
async function dispatch(request, as = null) {
  const method = request.method.toUpperCase();
  const list = routes.get(method === 'HEAD' ? 'GET' : method);
  if (method === 'OPTIONS' && !list) {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,HEAD,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
        'access-control-max-age': '86400',
      },
    });
  }
  const path = new URL(request.url).pathname;
  const token = request.headers.get('puter-auth');
  for (const [match, fn] of list || []) {
    const params = match(path);
    if (!params) continue;
    const user = as
      ? { puter: { authToken: null, APIOrigin: API, auth: { getUser: async () => ({ uuid: as.uuid, username: as.username }) } } }
      : token ? { puter: callerPuter(token) } : undefined;
    // Deferred work (search indexing, pushes) runs after the answer, as on
    // Cloudflare; the process stays up, so nothing is cut short.
    const event = { request, params, user, requestor: user, waitUntil: (p) => Promise.resolve(p).catch((e) => log('deferred work failed', e)) };
    let response = await fn(event);
    if (!(response instanceof Response)) {
      response = typeof response === 'string' ? new Response(response)
        : new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    }
    cors(response.headers);
    return response;
  }
  return new Response('Not found', { status: 404, headers: cors(new Headers()) });
}

// ------------------------------------------------------------------ organisation

const org = { ws: null, code: null, joined: new Set(), checked: new Map() };
const tokenKey = (t) => createHash('sha256').update(t).digest('hex');

/** A call into the worker as a given account, for the organisation's own housekeeping. */
async function call(token, method, path, body) {
  const res = await dispatch(new Request(`http://chat.internal${path}`, {
    method,
    headers: { 'puter-auth': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${data.message || data.code || ''}`), { status: res.status, data });
  return data;
}

/**
 * The organisation's workspace, created by the service account the first
 * time, plus a current invite code (renewed well before it lapses) that
 * colleagues are joined with.
 */
async function ensureOrg(serviceToken) {
  const me = await call(serviceToken, 'GET', '/api/me');
  // The service account is who "created #general" and owns the workspace:
  // it goes by the organisation's name, not its username.
  if (me.profile?.name !== ORG_NAME) await call(serviceToken, 'PUT', '/api/me', { name: ORG_NAME });
  let ws = me.workspaces.find((w) => w.name === ORG_NAME && w.role === 'owner') || null;
  if (!ws) {
    const created = await call(serviceToken, 'POST', '/api/workspaces', { name: ORG_NAME });
    ws = created.workspace || created;
    log(`created the organisation workspace "${ORG_NAME}" (${ws.id})`);
  }
  org.ws = ws.id;
  const detail = await call(serviceToken, 'GET', `/api/ws/${ws.id}`);
  const doc = detail.workspace || detail;
  const exp = Number(doc.inviteExp || 0);
  if (!doc.invite || (exp && exp - Date.now() < 7 * 86400 * 1000)) {
    const updated = await call(serviceToken, 'PUT', `/api/ws/${ws.id}`, { rotateInvite: true, inviteTtl: '30d' });
    org.code = (updated.workspace || updated).invite;
  } else {
    org.code = doc.invite;
  }
  if (!org.code) throw new Error('the organisation workspace has no invite code');
}

/** A colleague's first request: join them to the organisation's workspace. */
async function autojoin(token) {
  if (!AUTOJOIN || !org.ws || !org.code) return;
  const key = tokenKey(token);
  if (org.checked.get(key) > Date.now()) return;
  org.checked.set(key, Date.now() + 10 * 60 * 1000);
  if (org.checked.size > 5000) org.checked.clear();
  try {
    const who = await callerPuter(token).auth.getUser();
    if (!who?.uuid || who.is_temp || NOT_PEOPLE.has(String(who.username).toLowerCase())) return;
    if (org.joined.has(who.uuid)) return;
    const doc = await globalThis.me.puter.kv.get(`tc:ws:${org.ws}`);
    if (!doc?.members?.[who.uuid]) {
      await call(token, 'POST', '/api/join', { code: org.code });
      log(`${who.username} joined "${ORG_NAME}"`);
    }
    org.joined.add(who.uuid);
  } catch (e) {
    org.checked.delete(key);
    log('auto-join failed:', e.message);
  }
}

// ------------------------------------------------------------------ HTTP

/** The incoming request as a fetch Request; `body` given when it was already read. */
function toRequest(req, body) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const url = `${proto}://${req.headers.host || `localhost:${PORT}`}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  if (body !== undefined) return new Request(url, { method: req.method, headers, body });
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined });
}

/** A small JSON body read whole (a message post: kilobytes), so it can be looked at after. */
async function readSmall(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function send(res, response, head) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (head || !response.body) return res.end();
  Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
}

/**
 * A member's role in the organisation's workspace: admin for the suite's
 * administrators and CHAT_ADMINS, member otherwise. Guests and the owner are left alone.
 */
async function syncRole(serviceToken, uuid, username, admin) {
  const doc = await globalThis.me.puter.kv.get(`tc:ws:${org.ws}`);
  const role = doc?.members?.[uuid]?.role;
  const want = admin || CHAT_ADMINS.has(username) ? 'admin' : 'member';
  if (!(role === 'admin' || role === 'member') || role === want) return role || null;
  const res = await dispatch(new Request(`http://chat.internal/api/ws/${org.ws}/members/${uuid}/role`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'puter-auth': serviceToken },
    body: JSON.stringify({ role: want }),
  }));
  if (!res.ok) throw new Error(`role for ${username}: ${res.status} ${await res.text().catch(() => '')}`);
  log(`${username} is now ${want === 'admin' ? 'an admin' : 'a member'} of "${ORG_NAME}"`);
  return want;
}

/**
 * POST /internal/onboard  {uuid, username, admin}  a new account joins the organisation now,
 *                                                  not on its first visit to Chat; its role
 *                                                  follows `admin` (again on every call)
 * POST /internal/offboard {uuid}                   a removed account leaves it
 */
async function internal(req, serviceToken) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (!INTERNAL_SECRET || req.headers['x-unify-secret'] !== INTERNAL_SECRET) return json(403, { code: 'forbidden' });
  if (req.method !== 'POST') return json(405, { code: 'method' });
  let body;
  try { body = JSON.parse((await readSmall(req, 64 * 1024)).toString('utf8')); } catch { return json(400, { code: 'bad_json' }); }
  const uuid = typeof body.uuid === 'string' ? body.uuid : '';
  const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return json(400, { code: 'bad_uuid' });
  if (!org.ws || !org.code) return json(503, { code: 'no_org', message: 'The organisation workspace is not ready yet' });
  if (req.url === '/internal/onboard') {
    if (!username || NOT_PEOPLE.has(username)) return json(200, { ok: true, skipped: true });
    const doc = await globalThis.me.puter.kv.get(`tc:ws:${org.ws}`);
    if (!doc?.members?.[uuid]) {
      const res = await dispatch(new Request('http://chat.internal/api/join', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: org.code }),
      }), { uuid, username });
      if (!res.ok) return json(res.status, { code: 'join_failed', detail: await res.text().catch(() => '') });
      log(`${username} joined "${ORG_NAME}" (onboarded)`);
    }
    org.joined.add(uuid);
    const role = await syncRole(serviceToken, uuid, username, body.admin === true);
    return json(200, { ok: true, workspace: org.ws, role });
  }
  if (req.url === '/internal/offboard') {
    org.joined.delete(uuid);
    const res = await dispatch(new Request(`http://chat.internal/api/ws/${org.ws}/members/${uuid}`, {
      method: 'DELETE', headers: { 'puter-auth': serviceToken },
    }));
    if (!res.ok && res.status !== 404) return json(res.status, { code: 'remove_failed', detail: await res.text().catch(() => '') });
    log(`${uuid} left "${ORG_NAME}" (offboarded)`);
    return json(200, { ok: true });
  }
  return json(404, { code: 'not_found' });
}

async function main() {
  let serviceToken = await serviceLogin();
  globalThis.me = { puter: await loadPuter(serviceToken) };
  const me0 = await callerPuter(serviceToken).auth.getUser();
  globalThis.my = globalThis.me;
  globalThis.myself = globalThis.me;
  // Keep the service session alive: sign in again if Puter stops accepting it.
  setInterval(async () => {
    try {
      await globalThis.me.puter.auth.getUser();
    } catch {
      try {
        serviceToken = await serviceLogin();
        globalThis.me.puter.setAuthToken(serviceToken);
        log('service session renewed');
      } catch (e) {
        log('service session renewal failed:', e.message);
      }
    }
  }, 10 * 60 * 1000).unref();

  // Meetings' room directory first: Teamchat ends with catch-all routes (/*path), and the
  // first match wins. Its routes are /v1/rooms/..., its keys room:* (Teamchat's: tc:*).
  const meetings = await readFile(MEETINGS_BUNDLE, 'utf8').catch(() => null);
  if (meetings) {
    vm.runInThisContext(meetings, { filename: 'meetings-rooms.js' });
    log('Meetings room directory loaded');
  } else {
    log(`no Meetings room directory at ${MEETINGS_BUNDLE}; meetings are off`);
  }

  // Teamchat's back end, unchanged: it registers its routes on `router`.
  vm.runInThisContext(await readFile(WORKER_BUNDLE, 'utf8'), { filename: 'teamchat-worker.js' });
  log(`Teamchat back end loaded: ${[...routes.values()].reduce((n, l) => n + l.length, 0)} routes`);
  const signaller = createSignaller({
    whoami: (token) => callerPuter(token).auth.getUser(), turn: TURN, log,
    // An anonymous caller may not carry a colleague's id (signaller.mjs): the
    // organisation's members are everyone Teamchat would admit by id.
    isAccount: async (uuid) => {
      if (org.joined.has(uuid) || uuid === me0.uuid) return true;
      if (!org.ws) return false;
      const doc = await globalThis.me.puter.kv.get(`tc:ws:${org.ws}`);
      return !!doc?.members?.[uuid];
    },
  });
  if (!TURN.secret || !TURN.urls.length) log('TURN_SECRET / TURN_URLS not set: calls connect only where a direct path exists');

  // The service account claims this server on its first request (owner);
  // only it creates workspaces, so it holds the one the organisation uses.
  await call(serviceToken, 'GET', '/api/server');
  // Trial: anyone may create a workspace (they own it, so they can invite to it).
  const cfg = await call(serviceToken, 'PUT', '/api/server', { open: TRIAL });
  log(TRIAL ? 'trial server: everyone may create workspaces' : 'organisation server: only this service creates workspaces', cfg.open ? '(open)' : '(closed)');
  if (AUTOJOIN) {
    await ensureOrg(serviceToken);
    setInterval(() => ensureOrg(serviceToken).catch((e) => log('invite renewal failed:', e.message)), 6 * 3600 * 1000).unref();
    log(`organisation workspace "${ORG_NAME}" (${org.ws}); colleagues join on first visit`);
  }

  const bridge = createCalendarBridge({
    secret: INTERNAL_SECRET, mailDomain: MAIL_DOMAIN, apiOrigin: API, origin: ORIGIN,
    kv: globalThis.me.puter.kv, fs: globalThis.me.puter.fs, call,
    whoami: (token) => callerPuter(token).auth.getUser(), excluded: NOT_PEOPLE, log,
  });

  // Chat's email invitations (invites.mjs), sent as the person through our mail.
  const invites = createInvites({
    origin: ORIGIN, apiOrigin: API, mailDomain: MAIL_DOMAIN, secret: INTERNAL_SECRET,
    whoami: (token) => callerPuter(token).auth.getUser(), log,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') return send(res, new Response('ok'));
      if (new URL(req.url, 'http://x').pathname === '/invites') {
        const raw = req.method === 'POST' ? await readSmall(req, 64 * 1024) : Buffer.alloc(0);
        return send(res, await invites.handle(req.method, String(req.headers['puter-auth'] || ''), raw));
      }
      if (req.url === '/peer/generate-turn') return send(res, await signaller.generateTurn(toRequest(req)));
      // The suite's own calls (Puter's admin extension), never from outside:
      // Caddy refuses /internal/ on chat-api.<domain>, and each needs the secret.
      if (req.url.startsWith('/internal/')) return send(res, await internal(req, serviceToken));
      const token = req.headers['puter-auth'];
      if (token && req.method !== 'OPTIONS') await autojoin(String(token));
      const post = token && bridge.matches(req.method, new URL(req.url, 'http://x').pathname);
      if (post) {
        // A new message: read it whole, answer, then look at its attachments.
        const raw = await readSmall(req);
        const response = await dispatch(toRequest(req, raw));
        await send(res, response, false);
        if (response.ok) {
          let body = null;
          try { body = JSON.parse(raw.toString('utf8')); } catch { /* not JSON: nothing to bridge */ }
          if (body) bridge.afterPost({ ws: post[1], conv: post[2], token: String(token), body }).catch((e) => log('calendar bridge failed:', e.message));
        }
        return;
      }
      await send(res, await dispatch(toRequest(req)), req.method === 'HEAD');
    } catch (e) {
      log('request failed:', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ code: 'internal', message: 'Something went wrong on the chat server' }));
    }
  });
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').pathname === '/signal') return signaller.handleUpgrade(req, socket);
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  server.listen(PORT, () => log(`listening on :${PORT} for ${ORIGIN}; call signaller at /signal`));
}

main().catch((e) => {
  // Usually Puter still starting; the container's restart policy tries again.
  console.error('[chat] could not start:', e.message || e);
  setTimeout(() => process.exit(1), 5000);
});
