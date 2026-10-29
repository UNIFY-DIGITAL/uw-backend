// Chat: alice opens Teamchat inside the desktop; what does she see?
const { openAs, ORIGIN } = require('./session.cjs');
const who = process.argv[2] || 'alice';
(async () => {
  const log = [];
  const { browser, page } = await openAs(who, { log });
  page.on('response', (r) => { if (/chat\.puter\.localhost/.test(r.url())) log.push(`[net] ${r.status()} ${r.url().slice(0, 120)}`); });
  page.on('requestfailed', (r) => { if (!/b-cdn|api\.puter\.com/.test(r.url())) log.push(`[failed] ${r.url().slice(0, 120)}`); });
  await page.goto(ORIGIN + '/app/teamchat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  for (const d of await page.$$('dialog.perm-dialog[open]')) log.push('[perm dialog open]');
  await page.screenshot({ path: `/tmp/claude-1000/chat-${who}.png` });
  const frame = page.frames().find((f) => /:8090\/teamchat/.test(f.url()));
  if (frame) console.log('app text:', (await frame.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400));
  console.log(log.filter((l) => /error|net\]|failed|perm/i.test(l)).slice(0, 20).join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
