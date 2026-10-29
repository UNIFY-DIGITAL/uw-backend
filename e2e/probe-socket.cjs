const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [];
  const { browser, page } = await openAs('alice', { log });
  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws.url().slice(0, 80)));
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(8000);
  console.log('websockets opened:', JSON.stringify(sockets));
  console.log('desktop api_origin:', await page.evaluate(() => window.api_origin));
  console.log(log.filter((l) => /puter\.com/.test(l)).slice(0, 4).join('\n') || '(no puter.com errors)');
  await browser.close();
})();
