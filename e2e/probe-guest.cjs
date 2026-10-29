const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], who = process.argv[3] || 'alice', out = process.argv[2];
  const { browser, page } = await openAs(who, { log });
  page.on('dialog', (d) => d.accept());
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(9000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await page.screenshot({ path: `${out}/guest-${who}-1.png` });
  const text = await cal.evaluate(() => document.body.innerText);
  console.log(text.split('\n').filter((l) => /invit|mailbox|Test meeting|connect/i.test(l)).slice(0, 12).join(' | ') || '(no invitation-related text)');
  console.log(log.filter((l) => /mail|invit|error/i.test(l) && !/404|Unrecognized|preload/.test(l)).slice(-8).join('\n'));
  await browser.close();
})();
