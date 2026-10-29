// Third-party audit: every host outside this server that the browser contacts
// while a user opens the desktop and then each app in the App Center.
// Prints "OK" per app with none, or the hosts and what was asked of them.
const { openAs, ORIGIN } = require('./session.cjs');
const local = (h) => /(^|\.)localhost$|^127\.|^\[::1\]$/.test(h);
(async () => {
  // Every app of the suite (suite-apps.json), after the desktop itself.
  const apps = ['desktop', ...require('../suite-apps.json').apps.map((a) => a.name)];
  const { browser, page } = await openAs('alice');
  let current = 'desktop';
  const found = new Map(); // app -> Map(host -> example path)
  const note = (u) => {
    let url; try { url = new URL(u); } catch { return; }
    if (!/^(https?|wss?):$/.test(url.protocol) || local(url.hostname)) return;
    if (!found.has(current)) found.set(current, new Map());
    const m = found.get(current);
    if (!m.has(url.host)) m.set(url.host, url.pathname.slice(0, 60));
  };
  page.on('request', (r) => note(r.url()));
  page.on('websocket', (w) => note(w.url()));
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(6000);
  for (const name of [...new Set(apps)].slice(1)) {
    current = name;
    await page.goto(`${ORIGIN}/app/${name}`).catch(() => {});
    await page.waitForTimeout(7000);
  }
  for (const name of [...new Set(apps)]) {
    const m = found.get(name);
    console.log(m ? `${name}: ${[...m].map(([h, p]) => `${h}${p}`).join(', ')}` : `${name}: OK`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
