// The Admin app end to end, as an administrator uses it: add a person (with
// a temporary password), disable and enable them (sign-in refused, then not),
// make them an administrator, reset their password, remove them; turn an app
// off for everyone (gone from everyone's list, and it no longer opens) and on.
// And a non-administrator is turned away.
const { openAs, signIn, ORIGIN, API, MAIL, appFrame } = require('./session.cjs');
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) process.exitCode = 1; };
const SHOTS = process.env.SHOTS || '/tmp';
const login = async (username, password) => {
  const r = await fetch(`${ORIGIN}/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username, password }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const appsFor = async (token) => (await (await fetch(`${API}/unify/apps`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } })).json()).apps.map((a) => a.name);

(async () => {
  const who = `t${Date.now() % 100000}`;
  const { browser, page } = await openAs('opsadmin');
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.type() === 'prompt' ? d.accept(who) : d.accept(); });
  await page.goto(ORIGIN + '/app/admin');
  const admin = await appFrame(page, 'admin');
  await admin.waitForSelector('#users tr td.who', { timeout: 30000 });
  const listed = await admin.$$eval('#users td.who span', (s) => s.map((x) => x.textContent));
  check('the Admin app lists the organisation\'s people', listed.some((t) => t.startsWith('alice ')) && listed.some((t) => t.startsWith('bob ')), listed.join(' | '));

  // Add a person with no password: a temporary one, shown once.
  await admin.click('#add-user');
  await admin.fill('#user-form [name=username]', who);
  await admin.fill('#user-form [name=name]', 'Test Person');
  await admin.click('#user-form button[value=ok]');
  await admin.waitForSelector('#secret-dialog[open]', { timeout: 15000 });
  const temp = await admin.textContent('#secret-value');
  check('adding a person shows a temporary password once', /^[A-Za-z0-9_-]{10,}$/.test(temp), temp);
  await page.screenshot({ path: `${SHOTS}/admin-added.png` });
  await admin.click('#secret-dialog [data-close]');
  const row = () => admin.locator('#users tr', { hasText: `${who} · ${who}@${MAIL}` });
  check(`  listed as ${who}@${MAIL}, with "Temporary password"`, (await row().count()) === 1 && /Temporary password/.test(await row().innerText()));
  check('  and they can sign in with it', (await login(who, temp)).status === 200);

  // Disable / enable.
  await row().getByRole('button', { name: `Disable ${who}` }).click();
  await admin.waitForFunction((w) => [...document.querySelectorAll('#users tr')].some((r) => r.innerText.includes(`${w} ·`) && r.innerText.includes('Disabled')), who, { timeout: 15000 });
  const refused = await login(who, temp);
  check('disabling refuses their sign-in', refused.status >= 400, JSON.stringify(refused));
  await row().getByRole('button', { name: `Enable ${who}` }).click();
  await admin.waitForFunction((w) => [...document.querySelectorAll('#users tr')].some((r) => r.innerText.includes(`${w} ·`) && r.innerText.includes('Active')), who, { timeout: 15000 });
  check('  enabling lets them in again', (await login(who, temp)).status === 200);

  // Administrator role, password reset.
  await row().getByRole('button', { name: `Make admin ${who}` }).click();
  await admin.waitForFunction((w) => [...document.querySelectorAll('#users tr')].some((r) => r.innerText.includes(`${w} ·`) && r.innerText.includes('Administrator')), who, { timeout: 15000 });
  check('making them an administrator shows it', true);
  await row().getByRole('button', { name: `Reset password ${who}` }).click();
  await admin.waitForSelector('#secret-dialog[open]', { timeout: 15000 });
  const temp2 = await admin.textContent('#secret-value');
  await admin.click('#secret-dialog [data-close]');
  check('resetting the password: the old one stops working, the new one works', (await login(who, temp)).status >= 400 && (await login(who, temp2)).status === 200);

  // Apps: off for everyone, then on.
  const alice = await signIn('alice');
  check('before: alice has Notes', (await appsFor(alice.token)).includes('notes'));
  await admin.click('#tab-apps');
  await admin.waitForSelector('#applist tr', { timeout: 15000 });
  await admin.getByRole('button', { name: 'Turn off Notes' }).click();
  await admin.getByRole('button', { name: 'Turn on Notes' }).waitFor({ timeout: 15000 });
  check('turning Notes off removes it from everyone\'s apps', !(await appsFor(alice.token)).includes('notes'));
  const { browser: b2, page: p2 } = await openAs('alice');
  await p2.goto(ORIGIN + '/app/notes');
  await p2.waitForTimeout(6000);
  const off = p2.frames().find((f) => /disabled\.html\?app=notes/.test(f.url()));
  check('  and opening it says it is turned off', !!off && /turned off/i.test(await off.innerText('body')), p2.frames().map((f) => f.url().slice(0, 80)).join(' '));
  await admin.getByRole('button', { name: 'Turn on Notes' }).click();
  await admin.getByRole('button', { name: 'Turn off Notes' }).waitFor({ timeout: 15000 });
  check('turning it on brings it back', (await appsFor(alice.token)).includes('notes'));
  await page.screenshot({ path: `${SHOTS}/admin-apps.png` });

  // Not an administrator.
  await p2.goto(ORIGIN + '/app/admin');
  const denied = await appFrame(p2, 'admin');
  const text = denied ? await denied.waitForSelector('.denied', { timeout: 20000 }).then(() => denied.innerText('body')).catch(() => '') : '';
  check('a colleague who is not an administrator is turned away', /Administrators only/.test(text), text.slice(0, 120));
  check('  and the Admin app is not in their apps', !(await appsFor(alice.token)).includes('admin'));
  await b2.close();

  // Remove (confirmed by typing the username).
  await admin.click('#tab-people');
  await row().getByRole('button', { name: `Remove ${who}` }).click();
  await admin.waitForFunction((w) => ![...document.querySelectorAll('#users tr')].some((r) => r.innerText.includes(`${w} ·`)), who, { timeout: 20000 });
  check('removing them (after typing the username) deletes the account', (await login(who, temp2)).status >= 400 && dialogs.some((d) => /cannot be undone/.test(d)));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
