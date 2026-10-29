const { openAs, ORIGIN } = require('./session.cjs');
(async () => {
  const log = [];
  const { browser, page } = await openAs('bob', { log });
  await page.goto(ORIGIN + '/app/calendar');
  await page.waitForTimeout(7000);
  const cal = page.frames().find((f) => f.url().includes('/calendar/index.html'));
  const result = await cal.evaluate(async () => {
    const out = {};
    try {
      out.user = (await puter.auth.getUser()).username;
      const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n';
      out.body = await puter.email.send({
        from: 'bob@unify.test', to: 'alice@unify.test', replyTo: 'bob@unify.test',
        subject: 'probe', text: 'probe',
        attachments: [{ filename: 'invite.ics', content: btoa(ics), contentType: 'text/calendar; charset=utf-8; method=REQUEST' }],
      });
    } catch (e) {
      out.error = String(e && (e.stack || e.message || e));
      out.errorJson = JSON.stringify(e, Object.getOwnPropertyNames(e || {})).slice(0, 400);
    }
    return out;
  });
  console.log(JSON.stringify(result, null, 1).slice(0, 2000));
  console.log(log.filter((l) => /email\/send/.test(l)).join('\n'));
  await browser.close();
})();
