const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [];
  const { browser, page } = await openAs('bob', { log });
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(7000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await cal.evaluate(() => {
    window.__calls = [];
    const orig = puter.email.send.bind(puter.email);
    puter.email.send = async (msg) => {
      const rec = { args: { ...msg, attachments: (msg.attachments || []).map((a) => ({ ...a, content: `(${a.content.length} b64 chars)` })) } };
      window.__calls.push(rec);
      try { rec.result = await orig(msg); return rec.result; }
      catch (e) { rec.error = String(e && (e.message || e)); throw e; }
    };
    const getUser = puter.auth.getUser.bind(puter.auth);
    puter.auth.getUser = async (...a) => { const u = await getUser(...a); window.__user = { username: u && u.username, email: u && u.email }; return u; };
  });
  await cal.getByText('Test meeting').first().click();
  await page.waitForTimeout(1000);
  await cal.getByRole('button', { name: /Email invitations/ }).click();
  await page.waitForTimeout(3000);
  console.log(JSON.stringify(await cal.evaluate(() => ({ user: window.__user, calls: window.__calls })), null, 1).slice(0, 3000));
  await browser.close();
})();
