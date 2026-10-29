const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], who = process.argv[3] || 'alice', out = process.argv[2];
  const { browser, page } = await openAs(who, { log });
  await page.goto(ORIGIN + '/app/calendar');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const allow = page.getByRole('button', { name: /^Allow$/ });
    if (await allow.count()) { log.push(`[test] prompt: ${(await page.locator('body').innerText()).match(/wants permission to[\s\S]{0,80}/)?.[0]?.replace(/\s+/g, ' ')}`); await allow.first().click(); break; }
  }
  await page.waitForTimeout(8000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await page.screenshot({ path: `${out}/guest-${who}-2.png` });
  const text = await cal.evaluate(() => document.body.innerText);
  log.push('[test] calendar text: ' + text.split('\n').filter((l) => /Test meeting|invit/i.test(l)).slice(0, 6).join(' | '));
  console.log(log.filter((l) => /test\]|error|warn|mail|perm/i.test(l) && !/Unrecognized|preload|404|templates|allowfullscreen/.test(l)).join('\n'));
  await browser.close();
})();
