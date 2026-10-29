const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('bob', { log });
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(7000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await cal.getByText('Test meeting').first().click();
  await page.waitForTimeout(1000);
  const t0 = Date.now();
  await cal.getByRole('button', { name: /Email invitations/ }).click();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const allow = page.getByRole('button', { name: /^Allow$/ });
    if (await allow.count()) { log.push(`[test] permission prompt after ${Date.now() - t0}ms -> Allow`); await allow.first().click(); break; }
    const toast = await cal.evaluate(() => (document.querySelector('[class*=toast]') || {}).innerText || '');
    if (toast) { log.push(`[test] toast after ${Date.now() - t0}ms: ${toast}`); }
  }
  await page.waitForTimeout(4000);
  const toast = await cal.evaluate(() => [...document.querySelectorAll('[class*=toast]')].map((e) => e.innerText).join(' | '));
  log.push(`[test] final toast: ${toast}`);
  await page.screenshot({ path: out + '/cal-4.png' });
  console.log(log.filter((l) => /test\]|email\/send/.test(l)).join('\n'));
  await browser.close();
})();
