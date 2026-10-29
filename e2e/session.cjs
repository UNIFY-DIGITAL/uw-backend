// Shared helper: the suite's addresses (from .env, as scripts/lib/suite.sh
// derives them) and a signed-in Puter desktop page for a test user.
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(process.env.HOME, 'everything/src/email/node_modules/playwright'));
const SUITE = path.join(__dirname, '..');

/** KEY=value lines of .env (quotes stripped, comments ignored). */
function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(SUITE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, '').trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const env = { ...readEnv(), ...process.env };
const PROTO = env.PUTER_PROTOCOL || 'http';
const DOMAIN = env.PUTER_DOMAIN;
if (!DOMAIN) throw new Error('PUTER_DOMAIN is not set in .env');
const MAIL = env.MAIL_DOMAIN;
const ORIGIN = `${PROTO}://${DOMAIN}`, API = `${PROTO}://api.${DOMAIN}`, SDK = `${PROTO}://js.${DOMAIN}/v2/`;
const CHAT_API = `${PROTO}://chat-api.${DOMAIN}`;
const APPS = JSON.parse(fs.readFileSync(path.join(SUITE, 'suite-apps.json'), 'utf8')).apps;
const hostOf = (name) => {
  const app = APPS.find((a) => a.name === name || a.host === name);
  if (!app) throw new Error(`no app ${name} in suite-apps.json`);
  return app.host;
};
/** An app's own address: <proto>://<host>.<domain> */
const appUrl = (name) => `${PROTO}://${hostOf(name)}.${DOMAIN}`;
/** Matches the URL of that app's frame inside the desktop. */
const appRe = (name) => new RegExp(`^${PROTO}://${hostOf(name)}\\.${DOMAIN.replace(/\./g, '\\.')}/`);
/** The app's frame in a desktop page, once it is there. */
async function appFrame(page, name, tries = 60) {
  const re = appRe(name);
  for (let i = 0; i < tries; i++) {
    const f = page.frames().find((x) => re.test(x.url()));
    if (f) return f;
    await page.waitForTimeout(500);
  }
  return null;
}

async function signIn(username, password = 'Unify-test-123') {
  const post = async (url, body, token) => (await fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) })).json();
  // Local test stack only: every request reaches Puter from one Docker
  // address, so repeated test logins trip its per-IP login limit. Reset it.
  require('child_process').execSync(`docker exec puter-valkey sh -c 'for k in $(valkey-cli -c --scan --pattern "rate:login*"); do valkey-cli -c del "$k" >/dev/null; done'`);
  const reply = await post(`${ORIGIN}/login`, { username, password });
  if (!reply.token) throw new Error(`login as ${username} refused: ${JSON.stringify(reply)}`);
  const { token } = reply;
  const user = await (await fetch(`${API}/whoami`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } })).json();
  return { token, user };
}

async function openAs(username, { log = [] } = {}) {
  const { token, user } = await signIn(username);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const tag = (src) => (m) => log.push(`[${username}:${src}] ${m.type ? m.type() : 'error'}: ${m.text ? m.text() : m.message}`);
  page.on('console', tag('console'));
  page.on('pageerror', tag('pageerror'));
  page.on('request', (r) => { if (/email\/send|perms|grant|workers|\/drivers\/call/.test(r.url())) log.push(`[${username}:net] ${r.method()} ${r.url().slice(0, 100)}`); });
  page.on('response', (r) => { if (/email\/send/.test(r.url())) r.text().then((t) => log.push(`[${username}:net] <- ${r.status()} ${t.slice(0, 160)}`)).catch(() => {}); });
  await page.goto(ORIGIN + '/');
  await page.evaluate(([t, u]) => { localStorage.setItem('auth_token_v2', t); localStorage.setItem('user', JSON.stringify(u)); }, [token, user]);
  return { browser, page, user };
}
module.exports = { openAs, signIn, ORIGIN, API, SDK, CHAT_API, MAIL, DOMAIN, appUrl, appRe, appFrame };
