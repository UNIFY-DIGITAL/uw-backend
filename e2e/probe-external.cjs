// Every host the browser contacts while a user opens the desktop and an app.
const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [];
  const { browser, page } = await openAs('alice', { log });
  const hosts = new Map();
  page.on('request', (r) => { const h = new URL(r.url()).host; hosts.set(h, (hosts.get(h) || 0) + 1); });
  page.on('websocket', (w) => { const h = new URL(w.url()).host; hosts.set('ws:' + h, (hosts.get('ws:' + h) || 0) + 1); });
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(6000);
  await page.goto(ORIGIN + '/app/' + (process.argv[2] || 'calendar'));
  await page.waitForTimeout(8000);
  console.log([...hosts.entries()].map(([h, n]) => `${h} (${n})`).join('\n'));
  await browser.close();
})();
