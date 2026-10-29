// The call signaller end to end, through puter.js's own puter.peer API, as
// Teamchat huddles and Meetings use it: alice serves, bob dials, data flows.
// Also the room-name rules: no_host, name_in_use, same-account takeover.
const { signIn, API, SDK, CHAT_API, appUrl } = require('./session.cjs');
const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };

async function peerPage(browser, token) {
  const page = await browser.newPage();
  await page.goto(appUrl('app-center') + '/');
  await page.addScriptTag({ url: SDK });
  await page.evaluate(([t, api]) => { puter.setAPIOrigin(api); puter.setAuthToken(t); }, [token, API]);
  return page;
}

(async () => {
  const alice = await signIn('alice'), bob = await signIn('bob');
  const browser = await chromium.launch();
  const a = await peerPage(browser, alice.token), b = await peerPage(browser, bob.token);

  // Generated invite code.
  const code = await a.evaluate(async () => {
    window.server = await puter.peer.serve();
    window.got = new Promise((res) => server.addEventListener('connection', (e) => {
      e.conn.addEventListener('message', (m) => res({ data: m.data, from: e.user?.username }));
    }));
    return server.inviteCode;
  });
  check('alice gets an invite code', /^[A-Z0-9]{0,4}-[0-9A-F]{6}$/.test(code), code);
  const owner = await b.evaluate(async (code) => {
    const conn = await puter.peer.connect(code);
    await new Promise((res, rej) => { conn.addEventListener('open', res); conn.addEventListener('error', (e) => rej(e.error)); setTimeout(() => rej(new Error('open timeout')), 15000); });
    conn.send('hi alice, from bob');
    return conn.owner?.username;
  }, code);
  const got = await a.evaluate(() => Promise.race([window.got, new Promise((r) => setTimeout(() => r(null), 10000))]));
  check('bob reaches alice through the signaller', owner === 'alice', owner);
  check('alice receives bob\'s message, and knows it is bob', got?.data === 'hi alice, from bob' && got?.from === 'bob', JSON.stringify(got));

  // The rest at the protocol level, straight to the signaller from Node, so it
  // holds whichever puter.js the apps load (the newer one has no room names,
  // and reports a refusal without its code).
  const SIGNAL = CHAT_API.replace(/^http/, 'ws') + '/signal';
  const sock = (query = '') => new Promise((res, rej) => {
    const ws = new WebSocket(SIGNAL + query);
    const inbox = [];
    let waiter = null;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (waiter && waiter.test(m)) { const w = waiter; waiter = null; w.res(m); } else inbox.push(m); };
    ws.next = (test, ms = 5000) => {
      const i = inbox.findIndex(test);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((r) => { waiter = { test, res: r }; setTimeout(() => { if (waiter?.res === r) { waiter = null; r(null); } }, ms); });
    };
    ws.say = (m) => ws.send(JSON.stringify(m));
    ws.closed = new Promise((r) => { ws.onclose = (e) => r(e.code); });
    ws.onopen = () => res(ws);
    ws.onerror = rej;
  });
  const created = (m) => !!m.server?.create, connected = (m) => !!m.client?.connect;
  const room = `unify-test-${Date.now() % 100000}`;

  const c1 = await sock(`?room=${room}`);
  c1.say({ client: { connect: { authToken: bob.token, invitecode: room } } });
  check('dialling an empty room says no_host', (await c1.next(connected))?.client.connect.code === 'no_host');
  const h1 = await sock(`?room=${room}`);
  h1.say({ server: { create: { authToken: alice.token } } });
  const r1 = (await h1.next(created))?.server.create;
  check('alice serves a room by name', r1?.success && r1.invitecode === room, JSON.stringify(r1));
  const h2 = await sock(`?room=${room}`);
  h2.say({ server: { create: { authToken: bob.token } } });
  check('another account cannot take a held room (name_in_use)', (await h2.next(created))?.server.create.code === 'name_in_use');
  const c2 = await sock(`?room=${room}`);
  c2.say({ client: { connect: { authToken: bob.token, invitecode: room } } });
  const j = (await c2.next(connected))?.client.connect;
  const seenByHost = await h1.next((m) => !!m.server?.connect);
  check('bob joins alice\'s room by name; alice is told it is bob', j?.success && j.owner?.username === 'alice' && seenByHost?.server.connect.user.username === 'bob', JSON.stringify([j, seenByHost]));

  // Both directions relayed, with what the newer puter.js adds (names, gen).
  c2.say({ client: { offer: { offer: { type: 'offer', sdp: 'v=0' }, names: { a: 'camera' }, gen: 1 } } });
  const off = await h1.next((m) => !!m.server?.offer);
  h1.say({ server: { answer: { id: seenByHost.server.connect.id, answer: { type: 'answer', sdp: 'v=0' }, re: 1 } } });
  const ans = await c2.next((m) => !!m.client?.answer);
  h1.say({ server: { offer: { id: seenByHost.server.connect.id, offer: { type: 'offer', sdp: 'v=1' }, gen: 2 } } });
  const back = await c2.next((m) => !!m.client?.offer);
  check('offers and answers relayed both ways, with names and numbers', off?.server.offer.names?.a === 'camera' && off.server.offer.gen === 1
    && ans?.client.answer.re === 1 && back?.client.offer.gen === 2);

  // Resume (newer puter.js): the caller drops and comes back on the same id.
  const tokenC2 = j.resumeToken;
  c2.close();
  const away = await h1.next((m) => !!m.server?.disconnect);
  const c3 = await sock(`?resume=${tokenC2}`);
  c3.say({ client: { connect: { authToken: bob.token, invitecode: room, resume: tokenC2 } } });
  const again = (await c3.next(connected))?.client.connect;
  const back2 = await h1.next((m) => !!m.server?.reconnect);
  check('a caller who drops comes back on the same session (resume)', away?.server.disconnect.resumable === true && again?.success
    && back2?.server.reconnect.id === seenByHost.server.connect.id, JSON.stringify([away, again, back2]));

  const h3 = await sock(`?room=${room}`);
  const oldClosed = h1.closed;
  h3.say({ server: { create: { authToken: alice.token } } });
  await h3.next(created);
  check('alice in a new tab takes her room over; the old one is closed as "replaced" (4001)', await oldClosed === 4001);

  const a0 = await sock();
  a0.say({ client: { connect: { anonToken: `anon-${Date.now()}-check`, invitecode: code } } });
  const anonOk = (await a0.next(connected))?.client.connect;
  check('an anonymous caller is let through', anonOk?.success === true, JSON.stringify(anonOk));
  a0.close();
  const a1 = await sock();
  a1.say({ client: { connect: { anonToken: bob.user.uuid, invitecode: code } } });
  check('an anonymous caller cannot use a colleague\'s id', (await a1.next(connected))?.client.connect.code === 'invalid_auth');
  const a2 = await sock();
  a2.say({ client: { connect: { authToken: 'not-a-session', invitecode: code } } });
  check('a request without a valid session is refused', (await a2.next(connected))?.client.connect.code === 'invalid_auth');
  for (const w of [c1, h2, c3, h3, a1, a2]) w.close();

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
