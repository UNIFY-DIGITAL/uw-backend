const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('alice', { log });
  page.on('response', async (r) => { if (r.status() >= 400 && !/templates|favicon/.test(r.url())) log.push(`[http ${r.status()}] ${r.request().method()} ${r.url().slice(0, 110)} ${(await r.text().catch(() => '')).slice(0, 160)}`); });
  page.on('request', (r) => { if (/puter\.com|app-store|marketplace|store/i.test(r.url())) log.push(`[req] ${r.url().slice(0, 110)}`); });
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(7000);
  await page.getByText('Add an app').first().click();
  await page.waitForTimeout(6000);
  await page.getByText('Find an app').first().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: out + '/findapp.png' });
  log.push('[frames] ' + page.frames().map((f) => f.url().slice(0, 80)).join(' , '));
  console.log(log.filter((l) => /http|req\]|error|frames/.test(l) && !/Unrecognized|preload/.test(l)).slice(-12).join('\n'));
  await browser.close();
})();
