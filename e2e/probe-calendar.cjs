const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [];
  const { browser, page } = await openAs('bob', { log });
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: process.argv[2] + '/cal-1.png' });
  for (const f of page.frames()) log.push(`[frame] ${f.url().slice(0, 120)}`);
  console.log(log.join('\n'));
  await browser.close();
})();
