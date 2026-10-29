// Alice makes a meeting in Chat (+ > Meeting invitation) and sends it in #general.
const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const title = process.argv[2] || `Roadmap chat ${Date.now() % 10000}`;
  const { browser, page } = await openAs('alice');
  await page.goto(ORIGIN + '/app/teamchat', { waitUntil: 'domcontentloaded' });
  let app;
  for (let i = 0; i < 30 && !app; i++) { await page.waitForTimeout(500); app = page.frames().find((f) => /:8090\/teamchat/.test(f.url())); }
  await app.waitForSelector('textarea', { timeout: 20000 });
  await app.click('button[aria-label="Attach"]');
  await app.getByRole('menuitem', { name: /Meeting invitation/ }).click();
  await app.getByLabel('Title').fill(title);
  await app.getByLabel('Where (optional)').fill('Room 4');
  await page.screenshot({ path: '/tmp/claude-1000/chat-meeting-form.png' });
  await app.getByRole('button', { name: 'Attach invitation' }).click();
  try {
    await app.waitForSelector('button.send-btn:not([disabled])', { timeout: 20000 }); // the upload done
  } catch (e) {
    await page.screenshot({ path: '/tmp/claude-1000/chat-meeting-stuck.png' });
    throw e;
  }
  const typed = await app.$eval('textarea', (t) => t.value);
  await app.click('button.send-btn');
  await app.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/claude-1000/chat-meeting-sent.png' });
  console.log('message text:', typed);
  console.log('title:', title);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
