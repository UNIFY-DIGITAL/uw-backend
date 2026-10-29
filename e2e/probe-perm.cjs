const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('bob', { log });
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(7000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  const has = await cal.evaluate(() => ({ perms: typeof puter.perms?.request, uiReq: typeof puter.ui?.requestPermission }));
  console.log('SDK permission APIs:', JSON.stringify(has));
  // Start the request but don't wait: it resolves when the user answers.
  cal.evaluate(() => { window.__permResult = 'pending'; puter.perms.request('fs:/bob/.mail:write').then((r) => { window.__permResult = r; }, (e) => { window.__permResult = 'error: ' + (e && e.message || e); }); });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: out + '/perm-1.png' });
  console.log('after 3s:', await cal.evaluate(() => String(window.__permResult)));
  console.log(log.filter((l) => /error|pageerror/.test(l)).slice(-6).join('\n'));
  await browser.close();
})();
