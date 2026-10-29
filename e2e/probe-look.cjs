const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const [out, who, app] = [process.argv[2], process.argv[3] || 'alice', process.argv[4] || 'calendar'];
  const log = [];
  const { browser, page } = await openAs(who, { log });
  await page.goto(ORIGIN + '/app/' + app);
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${out}/look-${who}-${app}.png` });
  console.log('frames:', page.frames().map((f) => f.url().slice(0, 70)).join('\n        '));
  await browser.close();
})();
