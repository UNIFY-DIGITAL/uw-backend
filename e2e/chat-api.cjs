// Chat end to end over the API, as the Teamchat app calls it.
const { signIn, CHAT_API } = require('./session.cjs');
const CHAT = process.env.CHAT_URL || CHAT_API;
const call = async (token, method, path, body) => {
  const r = await fetch(CHAT + path, { method, headers: { 'puter-auth': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
(async () => {
  const alice = await signIn('alice'), bob = await signIn('bob'), charlie = await signIn('charlie');
  const meBob = await call(bob.token, 'GET', '/api/me');
  const org = meBob.workspaces.find((w) => w.name === 'Unify Works');
  check('bob is in the organisation workspace on first visit', !!org, JSON.stringify(meBob.workspaces));
  await call(charlie.token, 'GET', '/api/me');
  const ws = (await call(alice.token, 'GET', `/api/ws/${org.id}`));
  const general = Object.values(ws.workspace?.channels || ws.channels || {}).find((c) => c.name === 'general')
    || (ws.channels || []).find?.((c) => c.name === 'general');
  check('#general exists', !!general, Object.keys(ws).join(','));
  const word = `zebra${Date.now() % 100000}`;
  await call(alice.token, 'POST', `/api/ws/${org.id}/conv/${general.id}/messages`, { text: `Quarterly budget review, keyword ${word}`, cid: `t${Date.now()}` });
  const msgs = await call(bob.token, 'GET', `/api/ws/${org.id}/conv/${general.id}/messages`);
  const list = msgs.messages || msgs.items || [];
  check('bob reads alice\'s message in #general', list.some((m) => (m.text || '').includes(word)), JSON.stringify(msgs).slice(0, 200));
  let hits = [];
  for (let i = 0; i < 10 && !hits.length; i++) {
    const s = await call(bob.token, 'GET', `/api/ws/${org.id}/search?q=${word}`);
    hits = s.results || s.hits || s.messages || [];
    if (!hits.length) await new Promise((r) => setTimeout(r, 500));
  }
  check('bob finds it by search', hits.length > 0);
  const aliceUuid = alice.user.uuid;
  const dm = await call(bob.token, 'POST', `/api/ws/${org.id}/dms`, { members: [aliceUuid] });
  const dmId = dm.conv;
  await call(bob.token, 'POST', `/api/ws/${org.id}/conv/${dmId}/messages`, { text: 'Hi Alice, a direct message', cid: `d${Date.now()}` });
  const dmMsgs = await call(alice.token, 'GET', `/api/ws/${org.id}/conv/${dmId}/messages`);
  check('alice gets bob\'s direct message', (dmMsgs.messages || []).some((m) => /direct message/.test(m.text || '')), JSON.stringify(dmMsgs).slice(0, 200));
})().catch((e) => { console.error(e); process.exit(1); });
