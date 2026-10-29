// coturn end to end: relay logins from /peer/generate-turn, and a WebRTC data
// channel that is only allowed to use relayed candidates (no direct path).
const { signIn, ORIGIN, API } = require('./session.cjs');
const { chromium } = require(require('path').join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
(async () => {
  const { token } = await signIn('alice');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/');
  const result = await page.evaluate(async ([token, api]) => {
    const r = await fetch(`${api}/peer/generate-turn`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const { iceServers } = await r.json();
    const cfg = { iceServers, iceTransportPolicy: 'relay' };
    const a = new RTCPeerConnection(cfg), b = new RTCPeerConnection(cfg);
    const types = new Set();
    a.onicecandidate = (e) => { if (e.candidate) { types.add(e.candidate.type); b.addIceCandidate(e.candidate); } };
    b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate); };
    const ch = a.createDataChannel('t');
    const got = new Promise((res) => { b.ondatachannel = (e) => { e.channel.onmessage = (m) => res(m.data); }; });
    ch.onopen = () => ch.send('hello through the relay');
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    const msg = await Promise.race([got, new Promise((res) => setTimeout(() => res(null), 15000))]);
    const stats = [...(await a.getStats()).values()];
    const pair = stats.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated);
    const local = pair && stats.find((s) => s.id === pair.localCandidateId);
    return { msg, types: [...types], local: local?.candidateType };
  }, [token, API]);
  check('relay candidates gathered from coturn', result.types.includes('relay'), JSON.stringify(result));
  check('data flows over a relayed connection', result.msg === 'hello through the relay' && result.local === 'relay', JSON.stringify(result));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
