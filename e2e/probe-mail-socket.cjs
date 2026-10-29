const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [];
  const { browser, page } = await openAs('alice', { log });
  const sockets = [];
  page.on('websocket', (ws) => { sockets.push(ws.url().slice(0, 90)); ws.on('framereceived', (f) => { const p = String(f.payload); if (/fs|mail|event/i.test(p)) log.push('[ws<-] ' + p.slice(0, 160)); }); });
  page.on('request', (r) => { if (/events|subscribe/.test(r.url())) log.push(`[net] ${r.method()} ${r.url().slice(0, 100)}`); });
  page.on('response', (r) => { if (/events|subscribe/.test(r.url())) r.text().then((t) => log.push(`[net] <- ${r.status()} ${t.slice(0, 150)}`)).catch(() => {}); });
  await page.goto(ORIGIN + '/app/email');
  await page.waitForTimeout(10000);
  const mail = page.frames().find((f) => f.url().includes('/email/index.html'));
  console.log('email frame api origin:', await mail.evaluate(() => puter.APIOrigin));
  console.log('sockets:', JSON.stringify(sockets));
  console.log(log.filter((l) => /net\]|ws<-|error/.test(l) && !/404|templates|Unrecognized/.test(l)).slice(0, 14).join('\n'));
  await browser.close();
})();
