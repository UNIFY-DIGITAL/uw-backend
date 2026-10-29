const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  for (const name of process.argv.slice(2)) {
    const log = [];
    const { browser, page } = await openAs('alice', { log });
    const ext = [];
    page.on('request', (r) => { if (/js\.puter\.com/.test(r.url())) ext.push(`${r.frame()?.url().slice(0, 50)} -> ${r.url().slice(0, 70)}`); });
    page.on('pageerror', (e) => log.push(`[pageerror] ${String(e.stack || e.message || e).slice(0, 300)}`));
    await page.goto(ORIGIN + '/app/' + name);
    await page.waitForTimeout(10000);
    console.log(`== ${name}`);
    console.log(log.filter((l) => /pageerror|error:/.test(l) && !/404|templates|401|Unrecognized|preload/.test(l)).join('\n'));
    console.log('js.puter.com requests:', [...new Set(ext)].join(' | '));
    await browser.close();
  }
})();
