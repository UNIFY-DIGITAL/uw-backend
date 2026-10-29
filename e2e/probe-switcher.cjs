// The app switcher (gui-extensions/unify-apps.js): the apps button shows on
// the desktop and over an open app; its panel lists and searches the apps;
// picking one opens it in a new tab; a desktop tile opens in a new tab too,
// and the desktop stays where it was.
const { openAs, ORIGIN } = require('./session.cjs');
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
const SHOTS = process.env.SHOTS || '/tmp';
(async () => {
  const { browser, page } = await openAs('alice');
  const ctx = page.context();
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('#unify-apps-btn:not([hidden])', { timeout: 30000 }).catch(() => {});
  check('the apps button shows on the desktop', await page.isVisible('#unify-apps-btn'));

  // A desktop tile: a new tab, and this one stays on the desktop.
  await page.click('.dashboard-sidebar-item:has-text("Apps"), [data-section="apps"]').catch(() => {});
  const tile = page.locator('.myapps-tile[data-app-name="calendar"]').first();
  const ready = await tile.waitFor({ timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(2000); // the grid settles (it re-renders as the lists arrive)
  if (ready) {
    const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null), tile.click()]);
    await page.waitForTimeout(1500);
    // Where the tab went: Puter rewrites the address to / as soon as it launches the app.
    const went = tab ? await tab.evaluate(() => performance.getEntriesByType('navigation')[0]?.name || location.href).catch(() => tab.url()) : '';
    check('a desktop tile opens the app in a new tab', !!tab && /\/app\/calendar$/.test(went), went || 'no new tab');
    check('  and the desktop stays in this tab', !(await page.$('.window-app.window-active')), 'an app window opened here');
    await tab?.close();
  } else check('a desktop tile opens the app in a new tab', false, 'no Calendar tile found');

  // Over an open app.
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(6000);
  check('the apps button shows over an open app', await page.isVisible('#unify-apps-btn'));
  await page.click('#unify-apps-btn');
  await page.waitForSelector('#unify-apps-grid a', { timeout: 15000 });
  const titles = await page.$$eval('#unify-apps-grid a span', (s) => s.map((x) => x.textContent));
  check('the panel lists the apps', ['Calendar', 'Chat', 'Email', 'Documents'].every((t) => titles.includes(t)), titles.join(', '));
  await page.screenshot({ path: `${SHOTS}/switcher-open.png` });
  await page.fill('#unify-apps-panel input', 'cha');
  const found = await page.$$eval('#unify-apps-grid a span', (s) => s.map((x) => x.textContent));
  check('search narrows it ("cha" -> Chat)', found.length >= 1 && found.every((t) => /cha/i.test(t)) && found.includes('Chat'), found.join(', '));
  const [chat] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null), page.click('#unify-apps-grid a[data-app="teamchat"]')]);
  const wentChat = chat ? await chat.evaluate(() => performance.getEntriesByType('navigation')[0]?.name || location.href).catch(() => chat.url()) : '';
  check('picking an app opens it in a new tab', !!chat && /\/app\/teamchat$/.test(wentChat), wentChat || 'no new tab');
  check('  and the panel closes', await page.isHidden('#unify-apps-panel'));
  check('  and Calendar is still open here', /\/app\/calendar|\/$/.test(page.url()) && !!(await page.$('.window-app')));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
