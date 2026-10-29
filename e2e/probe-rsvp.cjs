const { openAs, ORIGIN } = require('./session.cjs');
// Puter's permission dialog (dialog.perm-dialog) can open at any moment; accept it.
const clickAllow = async (page) => {
  const a = page.locator('dialog.perm-dialog[open] button:not(.perm-dialog-deny)');
  if (await a.count()) { await a.first().click(); await page.waitForTimeout(400); return true; }
  return false;
};
const act = async (page, fn) => { await clickAllow(page); await fn(); await page.waitForTimeout(600); await clickAllow(page); };
(async () => {
  const out = process.argv[2], log = [];
  // alice: open the invitation, answer Yes, send the reply
  let { browser, page } = await openAs('alice', { log });
  await page.goto(ORIGIN + '/app/calendar');
  for (let i = 0; i < 16; i++) { await page.waitForTimeout(500); await clickAllow(page); }
  await page.waitForTimeout(4000);
  let cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await act(page, () => cal.getByText('Test meeting').first().click());
  await page.screenshot({ path: out + '/rsvp-1.png' });
  await act(page, () => cal.getByRole('button', { name: /^Yes$/ }).first().click());
  const sendBtn = cal.getByRole('button', { name: /Send/ });
  if (await sendBtn.count()) await act(page, () => sendBtn.first().click());
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(500); if (await clickAllow(page)) log.push('[test] alice allowed mailbox write'); }
  await page.waitForTimeout(3000);
  log.push('[test] alice toast: ' + await cal.evaluate(() => [...document.querySelectorAll('[class*=toast]')].map((e) => e.innerText).join(' | ')));
  await page.screenshot({ path: out + '/rsvp-2.png' });
  await browser.close();
  // bob: open his calendar, look at the guest list
  ({ browser, page } = await openAs('bob', { log }));
  await page.goto(ORIGIN + '/app/calendar');
  for (let i = 0; i < 16; i++) { await page.waitForTimeout(500); await clickAllow(page); }
  await page.waitForTimeout(5000);
  cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await act(page, () => cal.getByText('Test meeting').first().click());
  await page.waitForTimeout(1000);
  log.push('[test] bob sees: ' + (await cal.evaluate(() => document.body.innerText)).match(/\d+ guests[\s\S]{0,160}/)?.[0]?.replace(/\n/g, ' | '));
  await page.screenshot({ path: out + '/rsvp-3.png' });
  await browser.close();
  console.log(log.filter((l) => /test\]|email\/send/.test(l)).join('\n'));
})();
