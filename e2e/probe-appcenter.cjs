const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('charlie', { log });
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(7000);
  await page.getByText('Add an app').first().click();
  await page.waitForTimeout(800);
  await page.getByText('Find an app').first().click();
  await page.waitForTimeout(6000);
  const center = page.frames().find((f) => f.url().includes('/app-center/'));
  if (!center) { console.log('App Center did NOT open'); await page.screenshot({ path: out + '/appcenter-fail.png' }); await browser.close(); return; }
  console.log('App Center lists:', (await center.$$eval('.card .title', (els) => els.map((e) => e.textContent))).join(', '));
  await center.fill('#q', 'excel');
  console.log('search "excel" ->', (await center.$$eval('.card .title', (els) => els.map((e) => e.textContent))).join(', '));
  await page.screenshot({ path: out + '/appcenter.png' });
  await center.getByRole('button', { name: 'Open Spreadsheet' }).click();
  await page.waitForTimeout(6000);
  console.log('after Open:', page.frames().some((f) => f.url().includes('/spreadsheet/')) ? 'Spreadsheet is running' : 'Spreadsheet did NOT open');
  await browser.close();
})();
