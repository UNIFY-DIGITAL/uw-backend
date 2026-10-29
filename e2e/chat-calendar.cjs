// Chat -> Calendar: an invitation (.ics) posted in #general reaches the other members' mailboxes as a colleague's invitation.
const { signIn, CHAT_API: CHAT, API, ORIGIN, MAIL } = require('./session.cjs');
const chat = async (token, method, path, body, form) => {
  const r = await fetch(CHAT + path, { method, headers: { 'puter-auth': token, ...(form ? {} : { 'content-type': 'application/json' }) }, body: form || (body && JSON.stringify(body)) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const puter = async (token, path, body) => (await fetch(API + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
async function newestMail(user, token) {
  const days = await puter(token, '/readdir', { path: `/${user}/.mail/objects` });
  const files = [];
  for (const d of Array.isArray(days) ? days : []) for (const f of await puter(token, '/readdir', { path: d.path })) files.push(f);
  files.sort((a, b) => b.created - a.created || b.modified - a.modified);
  if (!files.length) return { count: 0 };
  const r = await fetch(`${API}/read?file=${encodeURIComponent(files[0].path)}`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } });
  return { count: files.length, text: await r.text() };
}
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
(async () => {
  const alice = await signIn('alice'), bob = await signIn('bob'), charlie = await signIn('charlie');
  const before = { bob: (await newestMail('bob', bob.token)).count, charlie: (await newestMail('charlie', charlie.token)).count };
  const org = (await chat(alice.token, 'GET', '/api/me')).workspaces.find((w) => w.name === 'Unify Works');
  const ws = await chat(alice.token, 'GET', `/api/ws/${org.id}`);
  const general = Object.values(ws.workspace?.channels || ws.channels).find((c) => c.name === 'general');
  const title = process.argv[2] || `Chat planning sync ${Date.now() % 10000}`;
  const start = new Date(Date.now() + 2 * 86400e3); start.setUTCHours(9, 0, 0, 0);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unify test//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:chat-${Date.now()}@${MAIL}`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 3600e3))}`,
    `SUMMARY:${title}`, `ORGANIZER;CN=alice:mailto:alice@${MAIL}`,
    `ATTENDEE;CN=bob;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@${MAIL}`,
    `ATTENDEE;CN=charlie;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:charlie@${MAIL}`,
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const form = new FormData();
  form.append('file', new Blob([ics], { type: 'text/calendar' }), 'invite.ics');
  const file = await chat(alice.token, 'POST', `/api/ws/${org.id}/files`, null, form);
  await chat(alice.token, 'POST', `/api/ws/${org.id}/conv/${general.id}/messages`, { text: `Meeting: ${title}`, attachments: [{ id: file.id }], cid: `c${Date.now()}` });
  check('alice posts the invitation in #general', true);
  await new Promise((r) => setTimeout(r, 3000));
  for (const [u, tok] of [['bob', bob.token], ['charlie', charlie.token]]) {
    const m = await newestMail(u, tok);
    check(`${u} gets the invitation in their mailbox`, m.count === before[u] + 1 && m.text.includes(`Subject: Invitation: ${title}`), `count ${before[u]} -> ${m.count}`);
    check(`  from alice, internal (no Received header), with text/calendar`, new RegExp(`^From: alice <alice@${MAIL.replace(/\./g, '\.')}>`, 'm').test(m.text) && !/^Received:/m.test(m.text) && /text\/calendar; charset=utf-8; method=REQUEST/.test(m.text));
  }
  console.log(`title: ${title}`);
})().catch((e) => { console.error(e); process.exit(1); });
