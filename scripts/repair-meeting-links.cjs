// One-off repair: put meeting links back on Calendar events filed from an
// invitation email before Calendar kept them (fixed in mail-intake.js).
//
// For each account: reads the invitation emails in its mailbox, takes each
// one's UID and meeting link (URL / CONFERENCE lines), and sets the link on
// the Calendar event that came from that UID, if the event has none. Only
// links in this server's Meetings form are used, as Calendar itself requires.
//
//   node scripts/repair-meeting-links.cjs alice bob charlie dave
//
// Signs in with the local test password (e2e/session.cjs): local test stack only.
const { openAs, signIn, ORIGIN, API, appFrame, appUrl } = require('../e2e/session.cjs');
const LINK_BASE = `${ORIGIN}/app/meetings?m=`;
const isLink = (url) => url.startsWith(LINK_BASE) && /^[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(url.slice(LINK_BASE.length));

const post = async (token, path, body) => (await fetch(API + path, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

/** UID -> meeting link, from every invitation in the mailbox. */
async function linksInMailbox(user, token) {
  const out = new Map();
  const days = await post(token, '/readdir', { path: `/${user}/.mail/objects` });
  for (const d of Array.isArray(days) ? days : []) {
    for (const f of await post(token, '/readdir', { path: d.path })) {
      const raw = await (await fetch(`${API}/read?file=${encodeURIComponent(f.path)}`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } })).text();
      if (!/text\/calendar/i.test(raw)) continue;
      // The calendar part: headers, a blank line, the body (base64 or plain) up to the next boundary.
      for (const part of raw.split(/\r?\n--/).filter((p) => /Content-Type:\s*text\/calendar/i.test(p))) {
        const [head, ...rest] = part.split(/\r?\n\r?\n/);
        let body = rest.join('\n\n');
        if (/Content-Transfer-Encoding:\s*base64/i.test(head)) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
        const ics = body.replace(/\r?\n[ \t]/g, '');
        const uid = (ics.match(/^UID:(.+)$/m) || [])[1]?.trim();
        const url = ((ics.match(/^CONFERENCE[^:]*:(.+)$/m) || ics.match(/^URL:(.+)$/m) || [])[1] || '').trim();
        if (uid && isLink(url)) out.set(uid, url);
      }
    }
  }
  return out;
}

(async () => {
  const users = process.argv.slice(2);
  if (!users.length) { console.log('usage: node scripts/repair-meeting-links.cjs <user> ...'); process.exit(2); }
  for (const user of users) {
    const { token } = await signIn(user);
    const links = await linksInMailbox(user, token);
    const { browser, page } = await openAs(user);
    await page.goto(ORIGIN + '/app/calendar');
    const cal = await appFrame(page, 'calendar');
    await page.waitForTimeout(5000);
    // Calendar's events live in its own key-value store (cal:evt:<id>); write there, then it reloads them.
    const fixed = await cal.evaluate(async (pairs) => {
      const links = new Map(pairs);
      const done = [];
      for (const { key, value } of await puter.kv.list('cal:evt:*', true)) {
        const ev = typeof value === 'string' ? JSON.parse(value) : value;
        const url = ev?.invite?.uid && links.get(ev.invite.uid);
        if (!url || ev.meeting?.url) continue;
        await puter.kv.set(key, { ...ev, meeting: { url } });
        done.push(ev.title || '(untitled)');
      }
      return done;
    }, [...links]);
    console.log(`${user}: ${links.size} invitation(s) with a link in the mailbox; ${fixed.length} event(s) repaired${fixed.length ? ': ' + fixed.join(', ') : ''}`);
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
