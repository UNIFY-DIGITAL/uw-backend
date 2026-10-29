// After chat-calendar.cjs: does the invitation shared in chat show up in the guest's Calendar?
const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const who = process.argv[2] || 'bob', title = process.argv[3];
  const { browser, page } = await openAs(who);
  await page.goto(ORIGIN + '/app/calendar', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const allow = page.getByRole('button', { name: /^Allow$/ });
    if (await allow.count()) { await allow.first().click(); break; }
  }
  let found = '';
  for (let i = 0; i < 20 && !found; i++) {
    await page.waitForTimeout(1000);
    const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
    const text = cal ? await cal.evaluate(() => document.body.innerText).catch(() => '') : '';
    found = text.split('\n').find((l) => l.includes(title) || /Added .* from/.test(l)) || '';
  }
  await page.screenshot({ path: `/tmp/claude-1000/chat-cal-${who}.png` });
  console.log(found ? `  PASS  ${who}'s Calendar: ${found.trim()}` : `  FAIL  "${title}" not in ${who}'s Calendar`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
