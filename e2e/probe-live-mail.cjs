const { openAs, signIn, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('alice', { log });
  await page.goto(ORIGIN + '/app/email');
  await page.waitForTimeout(9000);
  const mail = page.frames().find((f) => f.url().includes('/email/index.html'));
  const subject = `Live check ${Date.now() % 100000}`;
  // bob sends through the real API while alice's Email is open
  const { token } = await signIn('bob');
  const eml = `From: bob@unify.test\r\nTo: alice@unify.test\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}@unify.test>\r\nContent-Type: text/plain\r\n\r\nhello\r\n`;
  const r = await fetch('http://api.puter.localhost/email/send', { method: 'POST', headers: { 'content-type': 'message/rfc822', authorization: `Bearer ${token}`, origin: ORIGIN }, body: eml });
  console.log('bob sent:', r.status);
  let seenAfter = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if ((await mail.evaluate(() => document.body.innerText)).includes(subject)) { seenAfter = i + 1; break; }
  }
  console.log(seenAfter ? `alice's Email showed it after ~${seenAfter}s, no reload` : 'NOT shown within 30s without reload');
  await page.screenshot({ path: out + '/mail-live.png' });
  await browser.close();
})();
