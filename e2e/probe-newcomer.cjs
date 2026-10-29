// A newcomer's first day. An administrator adds Nina; before she has ever
// signed in, Alice messages her in Chat and invites her (with a video link)
// from #general. When Nina first opens Calendar and Email, the invitation is
// there with its Join link, and neither app asks for permission. Meanwhile
// her colleagues get her suggested when they type her name in Email and Calendar.
const { openAs, signIn, ORIGIN, API, CHAT_API, MAIL, appFrame } = require('./session.cjs');
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
const PASS = 'Unify-test-123';
const chat = async (token, method, path, body, form) => {
  const r = await fetch(CHAT_API + path, { method, headers: { 'puter-auth': token, ...(form ? {} : { 'content-type': 'application/json' }) }, body: form || (body && JSON.stringify(body)) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const asAdmin = async (method, path, body) => {
  const { token } = await signIn('opsadmin');
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
};

/** Email's one-time "Welcome" card (first open on a device): not a permission screen. */
async function dismissWelcome(frame) {
  const btn = frame.locator('.modal-root .btn-primary', { hasText: 'Open my inbox' });
  await btn.waitFor({ state: 'visible', timeout: 10000 }).then(() => btn.click(), () => {});
}

const nina = `nina${Date.now() % 10000}`;
(async () => {
  const created = await asAdmin('POST', '/unify/admin/users', { username: nina, name: 'Nina Rao', password: PASS });
  check('an administrator adds Nina; she is onboarded straight away', created.ok && created.onboarding?.mailbox && created.onboarding.grants.length === 3 && created.onboarding.chat?.ok, JSON.stringify(created).slice(0, 300));
  const ninaUuid = (await (await fetch(`${API}/unify/directory?q=${nina}`, { headers: { authorization: `Bearer ${(await signIn('alice')).token}`, origin: ORIGIN } })).json()).people;
  check('  colleagues find her in the directory, by her full name', ninaUuid.some((p) => p.username === nina && p.name === 'Nina Rao' && p.email === `${nina}@${MAIL}`), JSON.stringify(ninaUuid));

  // Before Nina's first sign-in.
  const alice = await signIn('alice');
  const org = (await chat(alice.token, 'GET', '/api/me')).workspaces.find((w) => w.name === 'Unify Works');
  const ws = await chat(alice.token, 'GET', `/api/ws/${org.id}`);
  const members = ws.workspace?.members || ws.members || {};
  const ninaId = Object.entries(members).find(([, m]) => m.username === nina)?.[0];
  check('before she ever signs in, Nina is in the organisation\'s Chat', !!ninaId, Object.values(members).map((m) => m.username).join(','));
  const dm = await chat(alice.token, 'POST', `/api/ws/${org.id}/dms`, { members: [ninaId] });
  await chat(alice.token, 'POST', `/api/ws/${org.id}/conv/${dm.conv}/messages`, { text: 'Welcome aboard, Nina!', cid: `w${Date.now()}` });
  check('  Alice can message her', true);

  const title = `Onboarding ${Date.now() % 100000}`;
  const link = `${ORIGIN}/app/meetings?m=onbo-ardi-ngzz`;
  const start = new Date(Date.now() + 2 * 86400e3); start.setUTCHours(9, 0, 0, 0);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unify test//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:onb-${Date.now()}@${MAIL}`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 3600e3))}`,
    `SUMMARY:${title}`, `URL:${link}`, `CONFERENCE;VALUE=URI;FEATURE=VIDEO:${link}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const general = Object.values(ws.workspace?.channels || ws.channels).find((c) => c.name === 'general');
  const form = new FormData();
  form.append('file', new Blob([ics], { type: 'text/calendar' }), 'invite.ics');
  const file = await chat(alice.token, 'POST', `/api/ws/${org.id}/files`, null, form);
  await chat(alice.token, 'POST', `/api/ws/${org.id}/conv/${general.id}/messages`, { text: `Meeting: ${title}`, attachments: [{ id: file.id }], cid: `o${Date.now()}` });
  check('  Alice invites #general (Nina included) to a meeting with a video link', true);
  await new Promise((r) => setTimeout(r, 3000));

  // Nina's first day.
  const { browser, page } = await openAs(nina);
  const prompts = [];
  page.on('request', (r) => { if (/request-permission|requestPermission|\/auth\/check-app-acl|perms\/request/i.test(r.url())) prompts.push(r.url().slice(0, 100)); });
  await page.goto(ORIGIN + '/app/calendar');
  const cal = await appFrame(page, 'calendar');
  let ev = null;
  for (let i = 0; i < 40 && !ev; i++) {
    await page.waitForTimeout(1000);
    ev = await cal.evaluate(async (t) => (await puter.kv.list('cal:evt:*', true)).map(({ value: v }) => (typeof v === 'string' ? JSON.parse(v) : v)).find((v) => v && v.title === t) || null, title).catch(() => null);
  }
  check('Nina opens Calendar for the first time: the invitation is there', !!ev);
  check('  with its video link', ev?.meeting?.url === link, JSON.stringify(ev?.meeting));
  const dialogsCal = await page.$$eval('.window', (w) => w.map((x) => x.innerText).filter((t) => /allow|permission/i.test(t)));
  check('  and Calendar asked for no permission', dialogsCal.length === 0, dialogsCal.join(' | ').slice(0, 200));
  await page.goto(ORIGIN + '/app/email');
  const mail = await appFrame(page, 'email');
  await dismissWelcome(mail);
  const inboxText = await mail.waitForFunction((t) => document.body.innerText.includes(t), title, { timeout: 30000 }).then(() => true, () => false);
  const permissionScreen = await mail.evaluate(() => /allow|permission|grant access/i.test(document.body.innerText) && !document.querySelector('.message-list, [role="list"]'));
  check('Nina opens Email: her inbox shows the invitation, no permission screen', inboxText && !permissionScreen);
  await browser.close();

  // Colleagues get her suggested by name.
  const { browser: b2, page: p2 } = await openAs('alice');
  await p2.goto(ORIGIN + '/app/email');
  const em = await appFrame(p2, 'email');
  await dismissWelcome(em);
  await em.getByRole('button', { name: /Compose/ }).first().click({ timeout: 30000 });
  const to = em.getByLabel('To', { exact: true }).first();
  await to.fill('nina rao'.slice(0, 4));
  const offered = await em.waitForFunction((addr) => [...document.querySelectorAll('.suggestion')].some((li) => li.innerText.includes(addr)), `${nina}@${MAIL}`, { timeout: 15000 }).then(() => true, () => false);
  check('Alice types "nina" in To: Nina is suggested', offered);
  await p2.goto(ORIGIN + '/app/calendar');
  const c2 = await appFrame(p2, 'calendar');
  await c2.getByRole('button', { name: /^Create/ }).first().click({ timeout: 30000 });
  const guest = c2.getByLabel(/Add guest by name or email/).first();
  await guest.fill('Nina');
  const guestOffered = await c2.waitForFunction((addr) => [...document.querySelectorAll('#guest-suggestions [role=option]')].some((li) => li.innerText.includes(addr)), `${nina}@${MAIL}`, { timeout: 15000 }).then(() => true, () => false);
  check('Alice types "Nina" as a Calendar guest: Nina is suggested', guestOffered);
  await b2.close();

  const removed = await asAdmin('DELETE', `/unify/admin/users/${nina}`);
  check('cleanup: Nina removed', removed.ok === true, JSON.stringify(removed));
})().catch((e) => { console.error(e); process.exitCode = 1; })
  // Whatever happened, the test leaves no account behind.
  .finally(() => asAdmin('DELETE', `/unify/admin/users/${nina}`).catch(() => {}));
