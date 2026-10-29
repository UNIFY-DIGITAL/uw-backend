const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('bob', { log });
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(7000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await cal.getByText('Test meeting').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out + '/cal-2.png' });
  // What the details card says, as text
  const text = await cal.evaluate(() => document.body.innerText);
  console.log(text.split('\n').filter(Boolean).slice(0, 80).join(' | '));
  console.log(log.filter((l) => !/Unrecognized feature|preload|allowfullscreen/.test(l)).slice(-12).join('\n'));
  await browser.close();
})();
