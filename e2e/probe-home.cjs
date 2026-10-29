const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('alice', { log });
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: out + '/home-1.png' });
  const buttons = await page.evaluate(() => [...document.querySelectorAll('button, [role=button], a')].map((b) => (b.innerText || b.getAttribute('aria-label') || b.title || '').trim()).filter(Boolean).slice(0, 60));
  console.log('controls:', JSON.stringify(buttons));
  await browser.close();
})();
