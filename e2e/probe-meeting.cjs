// Meetings end to end on our own server: alice and bob open the same meeting
// link, alice starts it (first to arrive hosts), bob joins, and each gets the
// other's camera and microphone. Room directory, signaller and relay are all
// ours (chat server + coturn); nothing reaches puter.com.
//
// Meetings is opened the way the desktop launches it (app mode, our API
// origin, the user's session in the launch URL), so this runs before the app
// is registered too. Headless Chrome with a fake camera and microphone.
const { signIn, API, DOMAIN, CHAT_API, appUrl } = require('./session.cjs');
const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
const APP = process.env.MEETINGS_URL || appUrl('meetings') + '/index.html';
const SHOTS = process.env.SHOTS || '/tmp';
const letters = () => Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

async function openMeeting(browser, username, code, offsite) {
  const { token } = await signIn(username);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  const page = await context.newPage();
  page.on('request', (r) => { const u = new URL(r.url()); if (/^(https?|wss?):$/.test(u.protocol) && !/localhost$|^127\./.test(u.hostname)) offsite.add(`${u.hostname}${u.pathname}`.slice(0, 90)); });
  const q = new URLSearchParams({ 'puter.app_instance_id': `test-${username}`, 'puter.app.name': 'meetings', 'puter.api_origin': API,
    'puter.domain': DOMAIN, 'puter.auth.token': token, m: code });
  // In a frame, like the desktop's app window: puter.js only takes the launch
  // parameters (our API origin, the session) when it is framed.
  // A *.localhost host page: calls need a secure context all the way up (camera, crypto.randomUUID).
  if (process.env.DEBUG) await context.addInitScript(() => {
    const Real = window.RTCPeerConnection; if (!Real) return;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Real(...a); const rec = { pc, tracks: 0, cfg: a[0] }; pc.addEventListener('track', () => rec.tracks++); window.__pcs.push(rec); return pc; };
    window.RTCPeerConnection.prototype = Real.prototype;
  });
  if (process.env.DEBUG) page.on('console', (m) => { if (!['debug'].includes(m.type()) && !/%c/.test(m.text())) console.log(`[${username}] ${m.type()}: ${m.text().slice(0, 220)}`); });
  await page.goto(appUrl('app-center') + '/');
  await page.setContent(`<style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style>
    <iframe src="${APP}?${q}" allow="camera; microphone; display-capture; autoplay; clipboard-write"></iframe>`);
  let app;
  for (let i = 0; i < 40 && !app; i++) { await page.waitForTimeout(250); app = page.frames().find((f) => f.url().startsWith(APP)); }
  await app.waitForLoadState();
  app.screenshot = (o) => page.screenshot(o);
  const name = app.getByLabel('Your name');
  if (await name.isVisible({ timeout: 15000 }).catch(() => false) && !(await name.inputValue())) await name.fill(username);
  return app;
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const code = letters().replace(/(....)(....)(....)/, '$1-$2-$3');
  const offsite = new Set();
  const alice = await openMeeting(browser, 'alice', code, offsite);
  check('the meeting link opens the join screen', await alice.getByRole('button', { name: 'Join now' }).isVisible({ timeout: 20000 }).catch(() => false));
  await alice.getByRole('button', { name: 'Join now' }).click();
  const bob = await openMeeting(browser, 'bob', code, offsite);
  await bob.getByRole('button', { name: 'Join now' }).click({ timeout: 20000 });

  const sees = (page) => page.waitForFunction(() => {
    const live = [...document.querySelectorAll('.tile video')].filter((v) => v.srcObject && !v.muted
      && v.srcObject.getVideoTracks().some((t) => t.readyState === 'live') && v.srcObject.getAudioTracks().some((t) => t.readyState === 'live'));
    return document.querySelectorAll('.tile').length >= 2 && live.length >= 1;
  }, null, { timeout: 45000 }).then(() => true, () => false);
  const [aOk, bOk] = await Promise.all([sees(alice), sees(bob)]);
  if (process.env.DEBUG) for (const [who, p] of [['alice', alice], ['bob', bob]]) console.log(who, 'pcs', JSON.stringify(await p.evaluate(() => (window.__pcs || []).map((r) => ({
    sig: r.pc.signalingState, conn: r.pc.connectionState, ice: r.pc.iceConnectionState, tracks: r.tracks, senders: r.pc.getSenders().filter((x) => x.track).length, relayOnly: r.cfg?.iceTransportPolicy, servers: (r.cfg?.iceServers || []).length })))));
  if (process.env.DEBUG) for (const [who, p] of [['alice', alice], ['bob', bob]]) console.log(who, JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.tile video')].map((v) => ({
    muted: v.muted, a: v.srcObject?.getAudioTracks().map((t) => t.readyState + (t.enabled ? '' : ':off')), v: v.srcObject?.getVideoTracks().map((t) => t.readyState + (t.enabled ? '' : ':off')) })))));
  check('alice gets bob\'s camera and microphone', aOk);
  check('bob gets alice\'s camera and microphone', bOk);
  const room = await (await fetch(`${CHAT_API}/v1/rooms/${code}`)).json();
  check('our room directory knows the live meeting', !!room.room?.invite, JSON.stringify(room).slice(0, 200));
  check('nothing was requested from outside this server', offsite.size === 0, [...offsite].join(', '));
  if (process.env.DEBUG) console.log('offsite:', [...offsite]);
  await alice.screenshot({ path: `${SHOTS}/meeting-alice.png` });
  await bob.screenshot({ path: `${SHOTS}/meeting-bob.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
