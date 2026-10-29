/**
 * Puter Peer signaller and TURN credentials, on our own server.
 *
 * puter.peer (Teamchat huddles, Meetings) connects browsers to each other
 * over WebRTC. Media then flows directly between them (or through our TURN
 * relay, coturn); a signaller is only the introduction: a host registers
 * and gets an invite code (or serves a room name), a caller dials it, and
 * the two swap their offer, answer and ICE candidates through here. Puter's
 * own server only hands browsers the signaller's address
 * (`peers.signaller_url` in config.json); this is that signaller.
 *
 * The wire protocol is the one puter.js speaks (src/puter-js/src/modules/Peer.js):
 *
 *   {"ping":1}                                   -> {"pong":1}
 *   server.create {authToken, name?, resume?}    -> server.create {success, invitecode, resumeToken, resumed} | {success:false, error, code}
 *   client.connect {authToken, invitecode, resume?} -> server.connect {id, user}  then  client.connect {success, owner, room?, resumeToken}
 *   client.offer|answer|candidate|bye {...}      -> server.<same> {..., id}      (to the host)
 *   server.offer|answer|candidate|bye {id, ...}  -> client.<same> {...}          (to that caller)
 *   client.release / server.release              -> the other end hears disconnect
 *
 * Both generations of puter.js speak it: the one our Puter serves (offer one
 * way, the caller's socket closed once the call is up) and the newer one
 * Meetings is built with (renegotiation through here both ways, and resume:
 * a host or caller whose socket drops gets its session back within 30 s;
 * the other end hears disconnect {resumable} and then reconnect).
 *
 * Room names (`?room=<name>` on the socket, or `create.name`) are held by
 * whoever serves them: another account gets `name_in_use`; the same account
 * takes the name over and the older server is closed with 4001 (replaced).
 * A call to a room nobody serves gets `no_host`; to a dead code
 * `invalid_invite`.
 *
 * Who is calling comes from here, never from the caller: a Puter session is
 * checked against /whoami. Without one, `anonToken` (any id the browser made
 * up; Meetings dials its own invite that way to check it is alive) is
 * accepted as `{ uuid: <token>, username: 'anonymous' }`, unless the token is
 * a real account's id: the apps admit callers by id (Teamchat: workspace
 * members), so an anonymous caller must never carry a colleague's. Guest
 * relay grants are not issued here.
 *
 * TURN: Puter mints relay credentials from Cloudflare's paid TURN service.
 * Caddy sends `api.<domain>/peer/generate-turn` here instead, and this
 * answers with short-lived coturn credentials (the TURN REST scheme,
 * coturn's `use-auth-secret`) for signed-in users only, so no TURN password
 * is ever published.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

// ------------------------------------------------------------------ WebSocket

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024; // an SDP offer is a few kilobytes

/**
 * A minimal RFC 6455 server socket: text messages, ping/pong, close. All the
 * signaller needs, without a dependency.
 */
class Socket {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#data(chunk));
    socket.on('close', () => this.#closed());
    socket.on('error', () => socket.destroy());
  }

  send(text) {
    if (!this.open) return;
    this.#frame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#frame(0x8, body);
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  #frame(opcode, payload) {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    this.socket.write(Buffer.concat([head, payload]));
  }

  #data(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open && this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'too big');
        len = Number(big); offset = 10;
      }
      if (!masked) return this.close(1002, 'unmasked'); // clients must mask
      if (len > MAX_MESSAGE) return this.close(1009, 'too big');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);

      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this.#frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragments) return this.close(1002, 'bad fragment');
        if (fin) { if (opcode === 0x1) this.#message(payload); continue; }
        this.fragments = { opcode, parts: [payload], size: len };
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragments) return this.close(1002, 'bad fragment');
        this.fragments.parts.push(payload);
        this.fragments.size += len;
        if (this.fragments.size > MAX_MESSAGE) return this.close(1009, 'too big');
        if (fin) {
          const { opcode: first, parts } = this.fragments;
          this.fragments = null;
          if (first === 0x1) this.#message(Buffer.concat(parts));
        }
        continue;
      }
      return this.close(1002, 'bad opcode');
    }
  }

  #message(payload) {
    try { this.onmessage?.(payload.toString('utf8')); } catch { /* the handler logs its own */ }
  }

  #closed() {
    this.open = false;
    const handler = this.onclose;
    this.onclose = null;
    handler?.();
  }
}

/** Answer an HTTP upgrade as a WebSocket; null (and a 400) if it is not one. */
function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new Socket(socket);
}

// ------------------------------------------------------------------ signaller

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const INVITE_CODE_RE = /^[A-Z0-9]{0,4}-[0-9A-F]{6}$/;
const isRoomName = (v) => typeof v === 'string' && ROOM_NAME_RE.test(v) && !INVITE_CODE_RE.test(v);
const CLOSE_REPLACED = 4001;
const MAX_SOCKETS = 5000;
const MAX_CALLERS_PER_SERVER = 64;
/** How long a dropped host or caller keeps its session for a resume (newer puter.js). */
const RESUME_GRACE_MS = 30_000;
/** Signals relayed between the two ends of a connection, both ways. */
const RELAYED = ['offer', 'answer', 'candidate', 'bye'];

/**
 * @param {object} o
 * @param {(token: string) => Promise<object>} o.whoami  Puter's /whoami for a session token
 * @param {(uuid: string) => Promise<boolean>} [o.isAccount]  whether an id is a real account's (beyond those seen signed in here)
 * @param {{secret: string, urls: string[], stun: string[], ttl: number}} o.turn
 * @param {(...a: any[]) => void} o.log
 */
export function createSignaller({ whoami, turn, log, isAccount = async () => false }) {
  // A host's session: { code, room, user, ws (null while it is away), callers: Map<id, Caller>, resume, grace }
  const sessions = new Map();       // invite code or room name -> session
  const sessionByResume = new Map();
  // A caller: { id, user, ws (null while away), session, resume, grace }
  const callers = new Map();        // id -> caller
  const callerByResume = new Map();
  let sockets = 0;

  // A session checked once a minute, not on every message.
  const seen = new Map();
  const accounts = new Set(); // ids of accounts seen signed in: never usable as an anonymous id
  const ANON_RE = /^[A-Za-z0-9-]{8,128}$/;

  /** The caller of a create/connect: their account, else an anonymous id; null to refuse. */
  async function identity(msg) {
    // An anonToken wins over a session sent alongside it: puter.js sends both
    // when a signed-in page dials anonymously (Meetings' self-probe does).
    const anon = msg.anonToken;
    if (anon === undefined || anon === null || anon === '') return msg.authToken ? identify(msg.authToken) : null;
    if (typeof anon !== 'string' || !ANON_RE.test(anon)) return null;
    if (accounts.has(anon) || await isAccount(anon).catch(() => true)) return null;
    return { uuid: anon, username: 'anonymous' };
  }

  async function identify(token) {
    if (typeof token !== 'string' || !token) return null;
    const key = createHash('sha256').update(token).digest('hex');
    const hit = seen.get(key);
    if (hit && hit.until > Date.now()) return hit.user;
    try {
      const who = await whoami(token);
      if (!who?.uuid) return null;
      const user = { uuid: who.uuid, username: who.username };
      accounts.add(who.uuid);
      if (seen.size > 5000) seen.clear();
      seen.set(key, { user, until: Date.now() + 60_000 });
      return user;
    } catch {
      return null;
    }
  }

  const send = (ws, msg) => { if (ws?.open) ws.send(JSON.stringify(msg)); };
  const token = () => randomBytes(24).toString('base64url');
  const live = (session) => !!session?.ws?.open;

  function inviteCodeFor(user) {
    const prefix = String(user.username || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    for (;;) {
      const code = `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
      if (!sessions.has(code)) return code;
    }
  }

  /** A host's session is over: its code is free, and everyone still on it is told. */
  function endSession(session, reason) {
    if (session.ended) return;
    session.ended = true;
    clearTimeout(session.grace);
    if (sessions.get(session.code) === session) sessions.delete(session.code);
    sessionByResume.delete(session.resume);
    if (session.ws?.peer?.session === session) session.ws.peer.session = null;
    for (const c of session.callers.values()) {
      send(c.ws, { client: { disconnect: { reason } } });
      dropCaller(c, null);
    }
    session.callers.clear();
  }

  /** A caller is gone; tell the host, as resumable or not. */
  function dropCaller(c, tellHost) {
    clearTimeout(c.grace);
    callers.delete(c.id);
    callerByResume.delete(c.resume);
    c.session?.callers.delete(c.id);
    if (c.ws?.peer?.caller === c) c.ws.peer.caller = null;
    if (tellHost && c.session) send(c.session.ws, { server: { disconnect: { id: c.id, resumable: false } } });
  }

  async function create(ws, msg, room) {
    const fail = (error, code) => send(ws, { server: { create: { success: false, error, code } } });
    if (ws.peer.session) return fail('Already serving', 'already_serving');
    if (msg.port) return fail('Port servers are not supported here', 'unsupported');
    const user = await identity(msg);
    if (!user) return fail('Sign in to host a call', 'invalid_auth');
    if (!ws.open) return;

    // A host back from a dropped socket (newer puter.js): the same session, code and callers.
    let resumeRefused = false;
    if (msg.resume) {
      const held = sessionByResume.get(msg.resume);
      if (held && !held.ended && !live(held) && held.user.uuid === user.uuid) {
        clearTimeout(held.grace);
        held.ws = ws;
        ws.peer.session = held;
        send(ws, { server: { create: { success: true, invitecode: held.code, resumed: true, resumeToken: held.resume } } });
        for (const c of held.callers.values()) send(c.ws, { client: { reconnect: {} } });
        return;
      }
      resumeRefused = true;
    }

    const name = msg.name ?? room;
    if (name !== undefined && name !== null) {
      if (!isRoomName(name)) return fail('Not a valid room name', 'invalid_name');
      const held = sessions.get(name);
      if (held) {
        if (live(held) && held.user.uuid !== user.uuid) return fail('Someone else is serving this room', 'name_in_use');
        // The same account again (a new tab, a reconnect), or a holder who is away: the newer server takes the room.
        const old = held.ws;
        endSession(held, 'replaced');
        if (old?.open) old.close(CLOSE_REPLACED, 'replaced');
      }
    }
    const code = name ?? inviteCodeFor(user);
    const session = { code, room: name ?? null, user, ws, callers: new Map(), resume: token(), grace: null, ended: false };
    sessions.set(code, session);
    sessionByResume.set(session.resume, session);
    ws.peer.session = session;
    send(ws, { server: { create: { success: true, invitecode: code, resumeToken: session.resume, resumed: false, ...(resumeRefused ? { resumeRefused: true } : {}) } } });
  }

  async function connect(ws, msg, room) {
    const fail = (error, code) => send(ws, { client: { connect: { success: false, error, code } } });
    if (ws.peer.caller) return fail('Already connecting', 'already_connecting');
    if (msg.port) return fail('Port servers are not supported here', 'unsupported');
    const user = await identity(msg);
    if (!user) return fail('Sign in to join a call', 'invalid_auth');
    if (!ws.open) return;

    // A caller back from a dropped socket (newer puter.js): the same id, so the host addresses it as before.
    if (msg.resume) {
      const c = callerByResume.get(msg.resume);
      if (!c || c.ws?.open || c.user.uuid !== user.uuid || c.session?.ended) return fail('This session cannot be resumed', 'invalid_resume');
      clearTimeout(c.grace);
      c.ws = ws;
      ws.peer.caller = c;
      const s = c.session;
      send(ws, { client: { connect: { success: true, owner: s.user, resumeToken: c.resume, ...(s.room ? { room: s.room } : {}) } } });
      send(s.ws, { server: { reconnect: { id: c.id } } });
      return;
    }

    const target = room ?? msg.invitecode;
    const session = typeof target === 'string' ? sessions.get(target) : undefined;
    if (!live(session)) {
      return isRoomName(target) ? fail('Nobody is hosting this room yet', 'no_host') : fail('This invite code is not live', 'invalid_invite');
    }
    if (session.callers.size >= MAX_CALLERS_PER_SERVER) return fail('Too many people are joining at once', 'busy');
    const c = { id: randomUUID(), user, ws, session, resume: token(), grace: null };
    session.callers.set(c.id, c);
    callers.set(c.id, c);
    callerByResume.set(c.resume, c);
    ws.peer.caller = c;
    // The host first, so its connection exists before the caller's offer arrives.
    send(session.ws, { server: { connect: { id: c.id, user } } });
    send(ws, { client: { connect: { success: true, owner: session.user, resumeToken: c.resume, ...(session.room ? { room: session.room } : {}) } } });
  }

  function onMessage(ws, text, room) {
    if (text === '{"ping":1}') return send(ws, { pong: 1 });
    let data;
    try { data = JSON.parse(text); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const s = data.server, c = data.client;

    if (s && typeof s === 'object') {
      if (s.create) return create(ws, s.create, room);
      const session = ws.peer.session;
      if (!session) return;
      if (s.grant) return; // guest relay grants are not issued here
      if (s.release) { endSession(session, 'The host left'); return; }
      // offer / answer / candidate / bye, addressed to one caller by id.
      for (const kind of RELAYED) {
        if (!s[kind]) continue;
        const { id, ...signal } = s[kind];
        const target = session.callers.get(id);
        if (target) send(target.ws, { client: { [kind]: signal } });
        return;
      }
      return;
    }

    if (c && typeof c === 'object') {
      if (c.connect) return connect(ws, c.connect, room);
      const me = ws.peer.caller;
      if (!me) return;
      if (c.release) { dropCaller(me, true); return; }
      for (const kind of RELAYED) {
        if (!c[kind]) continue;
        send(me.session?.ws, { server: { [kind]: { ...c[kind], id: me.id } } });
        return;
      }
    }
  }

  function onClose(ws) {
    sockets--;
    const session = ws.peer.session;
    if (session && session.ws === ws && !session.ended) {
      // The host's socket dropped: newer puter.js comes back with its resume
      // token; hold the session that long, then let it go.
      session.ws = null;
      for (const c of session.callers.values()) send(c.ws, { client: { disconnect: { reason: 'The host\'s connection dropped', resumable: true } } });
      session.grace = setTimeout(() => endSession(session, 'The host left'), RESUME_GRACE_MS);
      session.grace.unref?.();
    }
    const me = ws.peer.caller;
    if (me && me.ws === ws) {
      // A caller's socket closed. Older puter.js closes it on purpose once
      // the call is up; newer puter.js keeps it and comes back if it drops.
      me.ws = null;
      send(me.session?.ws, { server: { disconnect: { id: me.id, resumable: true } } });
      me.grace = setTimeout(() => dropCaller(me, true), RESUME_GRACE_MS);
      me.grace.unref?.();
    }
  }

  /** The HTTP server's `upgrade` event, for requests to /signal. */
  function handleUpgrade(req, socket) {
    if (sockets >= MAX_SOCKETS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const url = new URL(req.url, 'http://signal');
    const roomParam = url.searchParams.get('room');
    const room = roomParam === null ? undefined : roomParam;
    const ws = upgrade(req, socket);
    if (!ws) return;
    sockets++;
    ws.peer = { session: null, caller: null };
    // One message at a time per socket, so a create is settled before what follows it.
    let queue = Promise.resolve();
    ws.onmessage = (text) => {
      queue = queue.then(() => onMessage(ws, text, room)).catch((e) => log('signal: message failed:', e.message));
    };
    ws.onclose = () => onClose(ws);
  }

  // ---------------------------------------------------------------- TURN

  /** coturn REST credentials: username "<expiry>:<user>", password HMAC-SHA1(secret, username). */
  function turnCredentials(user) {
    const username = `${Math.floor(Date.now() / 1000) + turn.ttl}:${user.uuid}`;
    const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
    const iceServers = [];
    if (turn.stun.length) iceServers.push({ urls: turn.stun });
    if (turn.urls.length) iceServers.push({ urls: turn.urls, username, credential });
    return { iceServers, ttl: turn.ttl };
  }

  /** POST /peer/generate-turn (routed here by Caddy from api.<domain>): relays for a signed-in user. */
  async function generateTurn(request) {
    const cors = {
      'access-control-allow-origin': request.headers.get('origin') || '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-credentials': 'true',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (!turn.secret || !turn.urls.length) return json(503, { message: 'TURN not configured' });
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = await identify(token);
    if (!user) return json(401, { message: 'Sign in to use the relays' });
    return json(200, turnCredentials(user));
  }

  return {
    handleUpgrade,
    generateTurn,
    stats: () => ({ sockets, sessions: sessions.size, callers: callers.size }),
  };
}
