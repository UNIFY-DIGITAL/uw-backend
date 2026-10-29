// Chat -> invitation with a video link -> mailboxes: alice makes a meeting in
// Chat (+ > Meeting invitation, "Add a video meeting link" ticked) and sends
// it in #general; bob's mailbox gets the invitation carrying a link to
// Meetings on this server (<desktop>/app/meetings?m=<code>).
const { openAs, signIn, ORIGIN, API, appRe, appFrame } = require('./session.cjs');
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
const puter = async (token, path, body) => (await fetch(API + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
async function mailWith(user, token, needle) {
  for (let i = 0; i < 20; i++) {
    const days = await puter(token, '/readdir', { path: `/${user}/.mail/objects` });
    const files = [];
    for (const d of Array.isArray(days) ? days : []) for (const f of await puter(token, '/readdir', { path: d.path })) files.push(f);
    files.sort((a, b) => b.modified - a.modified);
    for (const f of files.slice(0, 5)) {
      const text = await (await fetch(`${API}/read?file=${encodeURIComponent(f.path)}`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } })).text();
      if (text.includes(needle)) return text;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
(async () => {
  const title = `Video sync ${Date.now() % 100000}`;
  const { browser, page } = await openAs('alice');
  await page.goto(ORIGIN + '/app/teamchat', { waitUntil: 'domcontentloaded' });
  let app;
  for (let i = 0; i < 40 && !app; i++) { await page.waitForTimeout(500); app = page.frames().find((f) => appRe('teamchat').test(f.url())); }
  await app.waitForSelector('textarea', { timeout: 30000 });
  await app.click('button[aria-label="Attach"]');
  await app.getByRole('menuitem', { name: /Meeting invitation/ }).click();
  await app.getByLabel('Title').fill(title);
  const box = app.getByLabel('Add a video meeting link');
  check('the invitation offers a video meeting link, ticked', await box.isChecked().catch(() => false));
  await app.getByRole('button', { name: 'Attach invitation' }).click();
  await app.waitForSelector('button.send-btn:not([disabled])', { timeout: 20000 });
  const typed = await app.$eval('textarea', (t) => t.value);
  const link = (typed.match(/Join: (\S+)/) || [])[1] || '';
  const base = `${ORIGIN}/app/meetings?m=`;
  check('the message carries the join link', link.startsWith(base) && /^[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(link.slice(base.length)), typed);
  await app.click('button.send-btn');
  await page.waitForTimeout(2000);
  await browser.close();
  const bob = await signIn('bob');
  const mail = link && await mailWith('bob', bob.token, title);
  // The calendar part (base64, calendar-bridge.mjs): headers, a blank line, then the body up to the next boundary.
  const part = (mail || '').split(/\r?\n--/).find((p) => /Content-Type: text\/calendar/i.test(p)) || '';
  const decoded = Buffer.from(part.split(/\r?\n\r?\n/).slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
  const unfolded = decoded.replace(/\r\n[ \t]/g, '');
  check('bob\'s invitation arrives', !!mail);
  if (process.env.DUMP) require('fs').writeFileSync(process.env.DUMP, mail || '');
  check('  with the meeting link as the Calendar reads it (URL / CONFERENCE)', unfolded.includes(`URL:${link}`) && unfolded.includes(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${link}`), unfolded.slice(0, 300));

  // A guest's side: bob's Calendar files the invitation with its link, and his
  // Meetings lists the meeting with Join.
  if (link) {
    const { browser: b2, page: p2 } = await openAs('bob');
    const frameOf = async (re) => { for (let i = 0; i < 40; i++) { const f = p2.frames().find((x) => re.test(x.url())); if (f) return f; await p2.waitForTimeout(500); } return null; };
    await p2.goto(ORIGIN + '/app/calendar');
    const cal = await appFrame(p2, 'calendar');
    let ev = null;
    for (let i = 0; i < 30 && !ev; i++) {
      await p2.waitForTimeout(1000);
      ev = await cal.evaluate(async (title) => {
        const list = await puter.kv.list('cal:evt:*', true);
        return list.map(({ value: v }) => (typeof v === 'string' ? JSON.parse(v) : v)).find((v) => v && v.title === title) || null;
      }, title).catch(() => null);
    }
    check('bob\'s Calendar files the invitation', !!ev);
    check('  with the meeting link (Join meeting in the event)', ev?.meeting?.url === link, JSON.stringify(ev?.meeting));
    await p2.goto(ORIGIN + '/app/meetings');
    const meet = await appFrame(p2, 'meetings');
    const listed = await meet.waitForFunction((t) => [...document.querySelectorAll('.agenda-item')].some((x) => x.innerText.includes(t)), title, { timeout: 30000 }).then(() => true, () => false);
    check('  and bob\'s Meetings lists it with Join', listed);
    await b2.close();
  }
  console.log(`link: ${link}`);
})().catch((e) => { console.error(e); process.exit(1); });
