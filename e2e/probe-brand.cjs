// Branding: no "Puter" on the sign-in page or the signed-in desktop/dashboard.
const { openAs, ORIGIN } = require('./session.cjs');
const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
const shot = (n) => `${process.env.SHOTS || '/tmp'}/${n}.png`;
const findPuter = (page) => page.evaluate(() => {
  const hits = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.parentElement;
    if (/\bPuter\b/.test(n.nodeValue) && el && el.offsetParent !== null && !el.closest('script,style')) hits.push(n.nodeValue.trim().slice(0, 80));
  }
  for (const el of document.querySelectorAll('[title],[alt],[aria-label],[placeholder]'))
    for (const a of ['title','alt','aria-label','placeholder']) { const v = el.getAttribute(a); if (v && /\bPuter\b/.test(v)) hits.push(`@${a}: ${v.slice(0,80)}`); }
  return { title: document.title, hits: [...new Set(hits)] };
});
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const external = new Set();
  p.on('request', (r) => { const h = new URL(r.url()).host; if (!/localhost$|localhost:\d+$|^data:/.test(h) && h) external.add(h); });
  await p.goto(ORIGIN + '/'); await p.waitForTimeout(4000);
  console.log('signed out:', JSON.stringify(await findPuter(p)));
  await p.screenshot({ path: shot('brand-login') }); await b.close();

  const { browser, page } = await openAs('alice');
  page.on('request', (r) => { const h = new URL(r.url()).host; if (h && !/localhost(:\d+)?$/.test(h)) external.add(h); });
  await page.goto(ORIGIN + '/'); await page.waitForTimeout(7000);
  console.log('signed in:', JSON.stringify(await findPuter(page)));
  await page.screenshot({ path: shot('brand-desktop') });
  console.log('external hosts:', [...external]);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
