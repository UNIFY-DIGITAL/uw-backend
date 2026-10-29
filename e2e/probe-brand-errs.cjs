const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = []; const { browser, page } = await openAs('alice', { log });
  page.on('requestfailed', (r) => log.push('FAILED ' + r.url().slice(0, 100)));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(8000);
  console.log(log.filter((l) => /error|FAILED/i.test(l)).slice(0, 15).join('\n'));
  console.log('body chars:', await page.evaluate(() => document.body.innerText.length));
  await browser.close();
})();
