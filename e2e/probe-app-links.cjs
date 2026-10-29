// App-to-desktop wiring that broke before: every app's puter.js must address
// our desktop, not puter.com (scripts/set-app-origin.sh), so Meetings reaches
// Calendar; and no app or the App Center shows a broken image.
const { openAs, ORIGIN, appRe } = require('./session.cjs');
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
(async () => {
  const { browser, page } = await openAs('alice');
  const wrongOrigin = [];
  page.on('console', (m) => { if (/target origin provided \('https:\/\/puter\.com'\)/.test(m.text())) wrongOrigin.push(m.text().slice(0, 120)); });
  const frameOf = async (re) => { for (let i = 0; i < 40; i++) { const f = page.frames().find((x) => re.test(x.url())); if (f) return f; await page.waitForTimeout(500); } return null; };
  const broken = (f) => f.$$eval('img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map((i) => i.getAttribute('src').slice(0, 60)));
  await page.goto(ORIGIN + '/app/meetings');
  const m = await frameOf(appRe('meetings'));
  // Reached: the day's meetings listed (rows with Join), or an empty day said so; never "Couldn't reach Calendar".
  const reached = await m.waitForFunction(() => !/Couldn.t reach Calendar/.test(document.body.innerText)
    && (document.querySelector('.agenda-item') || /No meetings|nothing on your calendar|Meetings from your calendar show up here/i.test(document.body.innerText)),
    null, { timeout: 30000 }).then(() => true, () => false);
  check('Meetings reaches Calendar (its panel lists the day)', reached, (await m.innerText('body')).replace(/\s+/g, ' ').match(/Today.{0,120}/)?.[0]);
  check('  no app message addressed to puter.com', wrongOrigin.length === 0, wrongOrigin[0]);
  check('  Meetings: no sign-out of its own in the desktop, no "no account needed"', !(await m.$('[aria-label="Sign out"]')) && !(await m.innerText('body')).includes('No account needed'));
  for (const [name, re] of ['meetings', 'calendar', 'teamchat', 'app-center'].map((n) => [n, appRe(n)])) {
    if (name !== 'meetings') { await page.goto(`${ORIGIN}/app/${name}`); }
    const f = name === 'meetings' ? m : await frameOf(re);
    await page.waitForTimeout(5000);
    const bad = f ? await broken(f) : ['no frame'];
    check(`no broken images in ${name}`, bad.length === 0, bad.join(', '));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
