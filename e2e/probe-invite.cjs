const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [], out = process.argv[2];
  const { browser, page } = await openAs('bob', { log });
  // Answer any confirm/permission dialogs Puter shows in the desktop page.
  page.on('dialog', (d) => d.accept());
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(7000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  await cal.getByText('Test meeting').first().click();
  await page.waitForTimeout(1000);
  await cal.getByRole('button', { name: /Email invitations/ }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out + '/cal-3.png' });
  // Any dialog in the calendar frame or in the Puter desktop (permission prompt)?
  const calText = await cal.evaluate(() => document.body.innerText);
  const deskText = await page.evaluate(() => [...document.querySelectorAll('.window, .window-alert, [role=dialog]')].map((e) => e.innerText).join(' | '));
  console.log('CAL dialog text:', calText.split('\n').filter(Boolean).filter((l) => l.length > 3).slice(-14).join(' | '));
  console.log('DESKTOP windows:', deskText.slice(0, 600));
  console.log(log.filter((l) => /net|error|pageerror/.test(l) && !/drivers\/call/.test(l)).slice(-12).join('\n'));
  await browser.close();
})();
