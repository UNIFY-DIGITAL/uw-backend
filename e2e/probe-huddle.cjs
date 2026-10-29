// A Teamchat huddle end to end, in the real app: alice starts one in #general,
// bob joins from the bar, and each sees the other connected (audio over our
// signaller + coturn). Headless Chrome with a fake microphone.
const { signIn, ORIGIN, appRe } = require('./session.cjs');
const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
const SHOTS = process.env.SHOTS || '/tmp';

async function chatAs(browser, username) {
  const { token, user } = await signIn(username);
  const context = await browser.newContext({ viewport: { width: 1300, height: 850 }, permissions: ['microphone', 'camera'] });
  const page = await context.newPage();
  await page.goto(ORIGIN + '/');
  await page.evaluate(([t, u]) => { localStorage.setItem('auth_token_v2', t); localStorage.setItem('user', JSON.stringify(u)); }, [token, user]);
  await page.goto(ORIGIN + '/app/teamchat', { waitUntil: 'domcontentloaded' });
  let app;
  for (let i = 0; i < 40 && !app; i++) { await page.waitForTimeout(500); app = page.frames().find((f) => appRe('teamchat').test(f.url())); }
  await app.waitForSelector('textarea', { timeout: 30000 });
  return { page, app };
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const alice = await chatAs(browser, 'alice');
  const bob = await chatAs(browser, 'bob');
  const errors = [];
  for (const [who, p] of [['alice', alice.page], ['bob', bob.page]]) p.on('console', (m) => { if (/signal|peer|huddle|TURN|relay/i.test(m.text()) && m.type() !== 'debug') errors.push(`${who}: ${m.type()}: ${m.text().slice(0, 160)}`); });

  await alice.app.click('button.huddle-btn');
  await alice.app.waitForSelector('.huddle-dock:not([hidden])', { timeout: 20000 });
  const join = await bob.app.waitForSelector('button.huddle-bar-join', { timeout: 45000 }).catch(() => null);
  check('bob sees alice\'s huddle in #general, with Join', !!join);
  if (join) await join.click();
  const connected = async (app, other) => app.waitForFunction((other) => {
    const tile = [...document.querySelectorAll('.huddle-tiles [role="listitem"]')].find((t) => (t.getAttribute('aria-label') || '').toLowerCase().startsWith(other));
    return tile && !tile.classList.contains('connecting');
  }, other, { timeout: 45000 }).then(() => true, () => false);
  const [aSeesB, bSeesA] = await Promise.all([connected(alice.app, 'bob'), connected(bob.app, 'alice')]);
  check('alice is connected to bob', aSeesB);
  check('bob is connected to alice', bSeesA);
  const hearing = (app) => app.waitForFunction(() => [...document.querySelectorAll('.huddle-sink audio')]
    .some((m) => m.srcObject && m.srcObject.getAudioTracks().some((t) => t.readyState === 'live') && !m.paused), null, { timeout: 20000 }).then(() => true, () => false);
  const audio = (await hearing(bob.app)) && (await hearing(alice.app));
  check('each hears the other (a live, playing audio track)', audio);
  await alice.page.screenshot({ path: `${SHOTS}/huddle-alice.png` });
  await bob.page.screenshot({ path: `${SHOTS}/huddle-bob.png` });
  if (process.exitCode) console.log(errors.slice(-15).join('\n'));
  await bob.app.click('.huddle-ctl-leave').catch(() => {});
  await alice.app.click('.huddle-ctl-leave').catch(() => {});
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
