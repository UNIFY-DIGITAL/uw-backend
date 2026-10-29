const { openAs, signIn, ORIGIN, API, MAIL } = require('./session.cjs');
const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(4000);
  const text = await p.evaluate(() => document.body.innerText);
  console.log('login page has "Create":', /create/i.test(text), '| has Log In:', /log in/i.test(text));
  await b.close();
  // dave: home folders exist, and mail from alice reaches him
  const alice = await signIn('alice');
  const send = await fetch(`${API}/email/send`, { method: 'POST',
    headers: { 'content-type': 'message/rfc822', origin: ORIGIN, authorization: `Bearer ${alice.token}` },
    body: `From: alice@${MAIL}\r\nTo: dave@${MAIL}\r\nSubject: Welcome Dave\r\n\r\nHi Dave!\r\n` });
  console.log('alice -> dave:', send.status, (await send.text()).slice(0, 100));
  const { browser, page } = await openAs('dave');
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
  console.log('dave desktop text:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 160));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
