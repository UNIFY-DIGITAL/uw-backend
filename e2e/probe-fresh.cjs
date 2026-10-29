const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto('http://puter.localhost/');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: process.argv[2] + '/fresh.png' });
  console.log('signed in as:', await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('user') || 'null')?.username || '(nobody)'; } catch { return '?'; } }));
  await browser.close();
})();
