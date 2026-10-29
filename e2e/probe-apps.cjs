const { openAs, ORIGIN } = require('./session.cjs');
const APPS = process.argv.slice(3);
(async () => {
  const out = process.argv[2];
  for (const name of APPS) {
    const log = [];
    const { browser, page } = await openAs('alice', { log });
    const external = new Set();
    page.on('request', (r) => { const u = r.url(); if (/puter\.com|puter\.work/.test(u) && !/b-cdn|wallpaper/.test(u)) external.add(new URL(u).host); });
    await page.goto(ORIGIN + '/app/' + name);
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); const a = page.locator('dialog.perm-dialog[open] button:not(.perm-dialog-deny)'); if (await a.count()) await a.first().click(); }
    await page.waitForTimeout(3000);
    const frame = page.frames().find((f) => f.url().includes(':8090/'));
    let words = 0, api = '?';
    if (frame) { words = (await frame.evaluate(() => document.body.innerText).catch(() => '')).split(/\s+/).filter(Boolean).length; api = await frame.evaluate(() => (typeof puter !== 'undefined' ? puter.APIOrigin : 'no SDK')).catch(() => '?'); }
    const errors = log.filter((l) => /pageerror|error:/.test(l) && !/404|templates|401|Unrecognized|preload/.test(l)).length;
    await page.screenshot({ path: `${out}/app-${name}.png` });
    console.log(`${name.padEnd(15)} frame:${frame ? 'yes' : 'NO '} words:${String(words).padStart(4)} api:${api} errors:${errors} external:${[...external].join(',') || '-'}`);
    await browser.close();
  }
})();
