/**
 * The organisation's administration: users, apps, the people directory and
 * onboarding. config.json "unifyAdmin.mode" (.env SUITE_MODE, scripts/configure.sh):
 *
 *   organisation  people cannot sign themselves up; administrators add them
 *   trial         a public trial server: anyone signs up (email, Google) or tries
 *                 the apps as a temporary guest. Sign-ups are onboarded like
 *                 added accounts (a Chat seat only with "unifyAdmin.trialChat":
 *                 its one workspace is shared by everyone), and the people
 *                 directory is empty: visitors are strangers to each other.
 *
 * Signed in as an administrator, from the desktop or the Admin app
 * (api.<domain>, the Admin console uses these):
 *
 *   GET    /unify/admin/me                          am I an administrator
 *   GET    /unify/admin/users                       everyone, with status
 *   POST   /unify/admin/users                       { username, name?, email?, password?, admin? }
 *          no password: a temporary one is made, returned once, and must be changed at first sign-in
 *   PATCH  /unify/admin/users/:username             { disabled?, admin?, name?, resetPassword? }
 *   DELETE /unify/admin/users/:username             the account and everything it owns (irreversible)
 *   POST   /unify/admin/users/:username/onboard     redo onboarding (below)
 *   GET    /unify/admin/apps                        every app of the suite, on or off
 *   POST   /unify/admin/apps                        { name, title, url, description?, icon?, adminOnly? }
 *   PATCH  /unify/admin/apps/:name                  { enabled?, title?, description? }
 *   DELETE /unify/admin/apps/:name
 *
 * Signed in as anyone (the App Center, the apps button, name suggestions):
 *
 *   GET /unify/apps                 the apps this person may use
 *   GET /unify/directory?q=         colleagues: username, name, email (not suspended, not service accounts;
 *                                   none on a trial server)
 *
 * For DevOps scripts on the server, no session: header x-unify-secret =
 * config.json "unifyInternal.secret" (= UNIFY_INTERNAL_SECRET in .env):
 *
 *   POST /unify/internal/users                     as POST /unify/admin/users (scripts/create-user.sh)
 *   POST /unify/internal/apps                      register or update an app (scripts/deploy-apps.sh)
 *   POST /unify/internal/apps/:name/enabled        { enabled }: turn an app on or off for everyone
 *   POST /unify/internal/onboard-all               onboard every account again
 *   POST /unify/internal/users/:username/password  { password }: set it (no change at sign-in),
 *                                                  end its sessions, onboard it (scripts/seed-admin.sh)
 *   POST /unify/internal/mail-domain               { from, to }: move addresses to a new mail domain
 *
 * Onboarding, when an account is created or signs itself up (and on demand): its mailbox folder
 * exists from the start, Email and Calendar are allowed into it (no
 * permission prompts on first use), and it joins the organisation's Chat
 * workspace (chat-server /internal/onboard), so colleagues can message and
 * invite it before its first sign-in.
 *
 * Administrators: config.json "unifyAdmin.admins" (the bootstrap list, never
 * demoted here) plus accounts an administrator promoted (user metadata
 * unify.admin). Service accounts ("unifyAdmin.serviceAccounts", the chat
 * service account by default) and `system` are never listed, edited or removed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { Context, makeActor } = require('@heyputer/backend/src/core');
const { extension } = require('@heyputer/backend/src/extensions');
const { generateDefaultFsentries } = require('@heyputer/backend/src/util/userProvisioning.js');
const { cleanEmail } = require('@heyputer/backend/src/util/email.js');

const config = extension.config;
const lower = (s) => String(s ?? '').trim().toLowerCase();
const BOOT_ADMINS = new Set((config.unifyAdmin?.admins ?? ['admin']).map(lower));
const SERVICE = new Set(['system', ...(config.unifyAdmin?.serviceAccounts ?? ['unifychat']).map(lower)]);
const MAIL_DOMAIN = lower(config.userEmail?.localDomains?.[0]);
const SECRET = config.unifyInternal?.secret || '';
const PROTO = config.protocol || 'http';
const DOMAIN = config.domain;
const ORIGIN = config.origin || `${PROTO}://${DOMAIN}`;
const API = config.api_base_url || `${PROTO}://api.${DOMAIN}`;
const CHAT_INTERNAL = config.unifyInternal?.chatUrl || 'http://chat:8787';
const TRIAL = config.unifyAdmin?.mode === 'trial';
const TRIAL_CHAT = TRIAL && config.unifyAdmin?.trialChat === true;
const MANIFEST = process.env.UNIFY_SUITE_APPS || '/etc/puter/suite-apps.json';
const USERNAME = /^[a-z0-9_]{3,45}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

const stores = () => extension.import('store');
const services = () => extension.import('service');
const db = () => extension.import('client').db;
const fail = (res, status, code, message) => res.status(status).json({ code, message });
const log = (...a) => console.log('[unify-admin]', ...a);

/** The suite's app list (suite-apps.json), read fresh: an app added there shows without a restart. */
function manifestApps() {
    try {
        return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).apps || [];
    } catch (e) {
        log('suite-apps.json unreadable:', e.message);
        return [];
    }
}
const appUrlFor = (host) => `${PROTO}://${host}.${DOMAIN}`;

// ------------------------------------------------------------------ people

const unifyMeta = (row) => {
    const m = typeof row?.metadata === 'string' ? safeJson(row.metadata) : row?.metadata;
    return (m && m.unify) || {};
};
/** A JSON column as an object: the database hands some back decoded already, some as text. */
function safeJson(s) {
    if (s && typeof s === 'object') return s;
    try { return JSON.parse(s); } catch { return null; }
}
const isAdmin = (row) => !!row && !row.suspended && (BOOT_ADMINS.has(lower(row.username)) || unifyMeta(row).admin === true);
const isService = (row) => SERVICE.has(lower(row?.username));
const displayName = (row) => unifyMeta(row).name || row.username;

/** Every real account (no system, no service accounts, no temporary guests). */
async function allPeople() {
    const rows = await db().read(
        'SELECT `id`, `uuid`, `username`, `email`, `suspended`, `timestamp`, `last_activity_ts`, `metadata`, `requires_password_change`, `password` IS NULL AS `no_password` FROM `user` ORDER BY `username`',
    );
    return rows.filter((r) => !isService(r) && !(r.no_password && !r.email));
}

const publicUser = (row) => ({
    username: row.username,
    name: displayName(row),
    email: row.email,
    admin: isAdmin(row),
    bootstrapAdmin: BOOT_ADMINS.has(lower(row.username)),
    disabled: !!row.suspended,
    mustChangePassword: !!row.requires_password_change,
    created: row.timestamp ? new Date(row.timestamp).toISOString() : null,
    lastActive: row.last_activity_ts ? new Date(row.last_activity_ts).toISOString() : null,
});

const tempPassword = () => crypto.randomBytes(9).toString('base64url');

/** Sign the account out everywhere (on disable, password reset, removal). */
async function endSessions(userId) {
    try {
        const sessions = await stores().session.getByUserId(userId);
        const uuids = (sessions || []).map((s) => s.uuid).filter(Boolean);
        if (uuids.length) await stores().session.revokeCascades(uuids);
    } catch (e) {
        log('could not end sessions:', e.message);
    }
}

async function chat(path, body) {
    if (!SECRET) return { ok: false, skipped: 'no internal secret' };
    try {
        const r = await fetch(CHAT_INTERNAL + path, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-unify-secret': SECRET }, body: JSON.stringify(body),
        });
        return { ok: r.ok, status: r.status, ...(await r.json().catch(() => ({}))) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Ready an account before its first sign-in: its mailbox folder, Email and
 * Calendar allowed into it, and a seat in the organisation's Chat (on a trial
 * server only with "unifyAdmin.trialChat").
 */
async function onboard(row) {
    const result = { mailbox: false, grants: [], chat: null };
    const mailbox = `/${row.username}/.mail`;
    try {
        if (!(await stores().fsEntry.getEntryByPath(mailbox))) {
            await services().fs.mkdir(row.id, { path: mailbox, createMissingParents: true });
        }
        result.mailbox = true;
    } catch (e) {
        log(`mailbox for ${row.username}:`, e.message);
    }
    const actor = makeActor({ user: row });
    for (const [app, modes] of [['email', ['read', 'write']], ['calendar', ['read']]]) {
        if (!(await stores().app.getByName(app))) continue;
        for (const mode of modes) {
            try {
                await services().permission.grantUserAppPermission(actor, app, `fs:${mailbox}:${mode}`);
                result.grants.push(`${app}:${mode}`);
            } catch (e) {
                log(`grant ${app} ${mode} for ${row.username}:`, e.message);
            }
        }
    }
    result.chat = TRIAL && !TRIAL_CHAT
        ? { skipped: 'trial server' }
        : await chat('/internal/onboard', { uuid: row.uuid, username: row.username });
    return result;
}

// A trial server's sign-ups (email or Google), and guests who keep their
// account (a temporary user saving it), are onboarded as an added account is.
// Temporary guests are not: they have no address, and go when they sign out.
if (TRIAL) {
    const onboardSignup = async (userId, why) => {
        try {
            const row = await stores().user.getById(userId);
            if (!row || isService(row) || !row.email || (row.password === null && !row.email_confirmed)) return;
            log(`${why} ${row.username}; onboarding:`, JSON.stringify(await onboard(row)));
        } catch (e) {
            log(`onboarding after ${why}:`, e.message);
        }
    };
    extension.on('puter.signup.success', (_key, ev) => {
        if (!ev?.is_temp) onboardSignup(ev.user_id, 'signed up');
    });
    extension.on('user.save_account', (_key, ev) => onboardSignup(ev?.user_id, 'saved account'));
}

/**
 * A new account, onboarded. `service`: only DevOps (the internal route) may
 * create a service account ("unifyAdmin.serviceAccounts", e.g. the chat
 * server's): it gets no mailbox, Chat seat or app grants, and its password is
 * the one given (never temporary).
 */
async function createAccount({ username, name, email, password, admin }, createdBy, { service = false } = {}) {
    username = lower(username);
    email = lower(email || (MAIL_DOMAIN ? `${username}@${MAIL_DOMAIN}` : ''));
    if (!USERNAME.test(username)) return { status: 400, code: 'bad_username', message: 'Username: 3–45 lower-case letters, digits or underscores.' };
    const isServiceName = SERVICE.has(username);
    if (isServiceName && !service) return { status: 400, code: 'reserved', message: `"${username}" is reserved.` };
    if (isServiceName && !password) return { status: 400, code: 'password_required', message: 'A service account needs its password (from .env).' };
    if (isServiceName) admin = false;
    const temporary = !password;
    if (temporary) password = tempPassword();
    if (password.length < 8) return { status: 400, code: 'weak_password', message: 'Password: at least 8 characters.' };
    if (!EMAIL.test(email)) return { status: 400, code: 'bad_email', message: 'A valid email address is required.' };
    if (await stores().user.getByUsername(username)) return { status: 409, code: 'username_taken', message: `The username "${username}" is already in use.` };
    if (await stores().user.findEmailOwner(email)) return { status: 409, code: 'email_taken', message: `The address ${email} already belongs to an account.` };
    let user;
    try {
        user = await stores().user.create({
            username,
            uuid: uuidv4(),
            password: await bcrypt.hash(password, 8),
            email,
            clean_email: cleanEmail(email),
            free_storage: config.storage_capacity ?? null,
            requires_email_confirmation: false,
            email_confirmed: true,
            email_confirm_code: String(crypto.randomInt(100000, 1000000)),
            email_confirm_token: uuidv4(),
            audit_metadata: { created_by: createdBy },
        });
    } catch (e) {
        log('create failed:', e.message);
        return { status: 409, code: 'conflict', message: 'That username or address was taken in the meantime.' };
    }
    if (config.default_user_group) {
        try { await stores().group.addUsers(config.default_user_group, [username]); } catch (e) { log('group:', e.message); }
    }
    try {
        await generateDefaultFsentries(db(), stores().user, user);
    } catch (e) {
        log('home folders failed:', e.message);
        return { status: 500, code: 'provisioning_failed', message: 'The account was created but its home folders were not.' };
    }
    const meta = {};
    if (name) meta.name = String(name).trim().slice(0, 120);
    if (admin) meta.admin = true;
    if (Object.keys(meta).length) await stores().user.updateMetadata(user.id, { unify: meta });
    if (temporary) await stores().user.update(user.id, { requires_password_change: 1 });
    const fresh = await stores().user.getById(user.id);
    const onboarding = isServiceName ? { service: true } : await onboard(fresh);
    log(`${createdBy} created ${username} <${email}>${admin ? ' (administrator)' : ''}; onboarding:`, JSON.stringify(onboarding));
    return { status: 201, body: { ok: true, user: publicUser(fresh), ...(temporary ? { temporaryPassword: password } : {}), onboarding } };
}

// ------------------------------------------------------------------ apps

/** The suite's apps: suite-apps.json plus those added in the Admin console, with their Puter rows. */
async function suiteApps() {
    const listed = manifestApps();
    const names = new Set(listed.map((a) => a.name));
    const rows = await db().read('SELECT `id`, `uid`, `name`, `title`, `description`, `index_url`, `approved_for_listing`, `metadata` FROM `apps`');
    const byName = new Map(rows.map((r) => [r.name, r]));
    const extra = rows.filter((r) => !names.has(r.name) && safeJson(r.metadata || '{}')?.unify?.suite);
    const out = [];
    for (const a of [...listed, ...extra.map((r) => ({ name: r.name, title: r.title, description: r.description, added: true }))]) {
        const row = byName.get(a.name);
        const meta = row ? (safeJson(row.metadata || '{}')?.unify || {}) : {};
        out.push({
            name: a.name,
            title: row?.title || a.title,
            description: row?.description || a.description || '',
            host: a.host || null,
            url: `${ORIGIN}/app/${a.name}`,
            address: a.host ? appUrlFor(a.host) : (meta.indexUrl || row?.index_url || ''),
            icon: row ? `${API}/app-icon/${row.uid}/128` : null,
            adminOnly: !!(a.adminOnly || meta.adminOnly),
            registered: !!row,
            enabled: !!row && !meta.disabled,
            added: !!a.added,
            uid: row?.uid || null,
        });
    }
    return out.sort((x, y) => x.title.localeCompare(y.title));
}

async function adminAppUid() {
    const a = await stores().app.getByName('admin');
    return a?.uid || null;
}

/** Approve an app for listing and opening, and set our marks on it (then refresh Puter's cache of it). */
async function approve(app, metaPatch, listed = true) {
    const meta = { ...(safeJson(app.metadata || '{}') || {}) };
    meta.unify = { ...(meta.unify || {}), suite: true, ...metaPatch };
    await db().write('UPDATE `apps` SET `approved_for_listing` = ?, `approved_for_opening_items` = 1 WHERE `id` = ?', [listed ? 1 : 0, app.id]);
    await stores().app.update(app.id, { metadata: JSON.stringify(meta) });
}

async function ownerId() {
    for (const name of BOOT_ADMINS) {
        const u = await stores().user.getByUsername(name);
        if (u) return u.id;
    }
    throw new Error('no administrator account to own the app');
}

async function registerApp({ name, title, url, description, icon, adminOnly }) {
    name = lower(name);
    if (!APP_NAME.test(name)) return { status: 400, code: 'bad_name', message: 'App name: lower-case letters, digits and hyphens.' };
    if (!title) return { status: 400, code: 'bad_title', message: 'A title is required.' };
    try { if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(); } catch { return { status: 400, code: 'bad_url', message: 'A web address (http or https) is required.' }; }
    const fields = { name, title: String(title).slice(0, 100), index_url: url, description: String(description || '').slice(0, 500), maximize_on_start: 1 };
    if (typeof icon === 'string' && /^data:image\/(png|svg\+xml|jpeg|webp);base64,/.test(icon) && icon.length < 2_000_000) fields.icon = icon;
    let app = await stores().app.getByName(name);
    if (app) {
        const meta = safeJson(app.metadata || '{}')?.unify || {};
        // A disabled app keeps pointing at the "turned off" page; its own address waits in metadata.
        if (meta.disabled) { fields.index_url = app.index_url; meta.indexUrl = url; }
        await stores().app.update(app.id, fields);
        app = await stores().app.getById(app.id);
        await approve(app, { adminOnly: !!adminOnly, ...(meta.disabled ? { indexUrl: url } : {}) }, !meta.disabled && !adminOnly);
    } else {
        app = await stores().app.create(fields, { ownerUserId: await ownerId() });
        await approve(app, { adminOnly: !!adminOnly }, !adminOnly);
    }
    log(`app ${name} registered -> ${url}`);
    return { status: 200, body: { ok: true, name, uid: app.uid } };
}

async function setAppEnabled(name, enabled) {
    const app = await stores().app.getByName(name);
    if (!app) return { status: 404, code: 'not_found', message: `No app named ${name}.` };
    if (name === 'admin') return { status: 400, code: 'protected', message: 'The Admin app cannot be turned off.' };
    const meta = safeJson(app.metadata || '{}')?.unify || {};
    if (!enabled && !meta.disabled) {
        const admin = manifestApps().find((a) => a.name === 'admin');
        const off = `${admin ? appUrlFor(admin.host) : ORIGIN}/disabled.html?app=${encodeURIComponent(name)}`;
        await stores().app.update(app.id, { index_url: off });
        await approve(await stores().app.getById(app.id), { disabled: true, indexUrl: app.index_url }, false);
    } else if (enabled && meta.disabled) {
        await stores().app.update(app.id, { index_url: meta.indexUrl || app.index_url });
        await approve(await stores().app.getById(app.id), { disabled: false, indexUrl: null }, !meta.adminOnly);
    }
    log(`app ${name} ${enabled ? 'turned on' : 'turned off'}`);
    return { status: 200, body: { ok: true } };
}

// ------------------------------------------------------------------ who is asking

/** The signed-in administrator, directly or through the Admin app; null otherwise. */
async function currentAdmin() {
    const actor = Context.get('actor');
    if (!actor?.user?.username) return null;
    if (actor.effectiveApp && actor.effectiveApp.uid !== (await adminAppUid())) return null;
    const row = await stores().user.getByUsername(actor.user.username);
    return isAdmin(row) ? row : null;
}
const internalCall = (req) => !!SECRET && req.headers['x-unify-secret'] === SECRET;

/** Wrap a handler: the caller must be an administrator. */
const asAdmin = (fn) => async (req, res) => {
    const admin = await currentAdmin();
    if (!admin) return fail(res, 403, 'forbidden', 'Only an administrator can do this.');
    try { return await fn(req, res, admin); } catch (e) { log('admin request failed:', e); return fail(res, 500, 'internal', e.message); }
};
const asInternal = (fn) => async (req, res) => {
    if (!internalCall(req)) return fail(res, 403, 'forbidden', 'Internal only.');
    try { return await fn(req, res); } catch (e) { log('internal request failed:', e); return fail(res, 500, 'internal', e.message); }
};
const reply = (res, r) => (r.body ? res.status(r.status).json(r.body) : fail(res, r.status, r.code, r.message));

async function editableTarget(res, username, admin) {
    const row = await stores().user.getByUsername(lower(username));
    if (!row || isService(row)) { fail(res, 404, 'not_found', `No account named ${username}.`); return null; }
    return row;
}

// ------------------------------------------------------------------ routes

const API_ROUTE = { subdomain: 'api', requireAuth: true };
const OPEN_ROUTE = { subdomain: 'api' };

extension.get('/unify/admin/me', API_ROUTE, async (req, res) => {
    const admin = await currentAdmin();
    res.json({ admin: !!admin, username: Context.get('actor')?.user?.username || null, domain: DOMAIN, mailDomain: MAIL_DOMAIN });
});

extension.get('/unify/admin/users', API_ROUTE, asAdmin(async (req, res) => {
    res.json({ users: (await allPeople()).map(publicUser), mailDomain: MAIL_DOMAIN });
}));

extension.post('/unify/admin/users', API_ROUTE, asAdmin(async (req, res, admin) => {
    reply(res, await createAccount(req.body || {}, admin.username));
}));

extension.patch('/unify/admin/users/:username', API_ROUTE, asAdmin(async (req, res, admin) => {
    const row = await editableTarget(res, req.params.username, admin);
    if (!row) return;
    const self = row.id === admin.id;
    const body = req.body || {};
    const out = { ok: true };
    if (typeof body.disabled === 'boolean' && body.disabled !== !!row.suspended) {
        if (self) return fail(res, 400, 'self', 'You cannot disable your own account.');
        if (body.disabled && BOOT_ADMINS.has(lower(row.username))) return fail(res, 400, 'protected', 'This administrator is set in config.json and cannot be disabled here.');
        await stores().user.update(row.id, body.disabled
            ? { suspended: 1, suspended_at: Math.floor(Date.now() / 1000), suspended_reason: `disabled by ${admin.username}` }
            : { suspended: 0, suspended_at: null, suspended_reason: null });
        if (body.disabled) await endSessions(row.id);
        log(`${admin.username} ${body.disabled ? 'disabled' : 'enabled'} ${row.username}`);
    }
    if (typeof body.admin === 'boolean' && body.admin !== isAdmin(row)) {
        if (!body.admin && BOOT_ADMINS.has(lower(row.username))) return fail(res, 400, 'protected', 'This administrator is set in config.json and cannot be demoted here.');
        if (!body.admin && self) return fail(res, 400, 'self', 'You cannot remove your own administrator role.');
        await stores().user.updateMetadata(row.id, { unify: { ...unifyMeta(row), admin: body.admin } });
        log(`${admin.username} ${body.admin ? 'made' : 'removed'} ${row.username} ${body.admin ? 'an administrator' : 'as administrator'}`);
    }
    if (typeof body.name === 'string') {
        const fresh = await stores().user.getById(row.id);
        await stores().user.updateMetadata(row.id, { unify: { ...unifyMeta(fresh), name: body.name.trim().slice(0, 120) } });
    }
    if (body.resetPassword) {
        const password = tempPassword();
        await stores().user.update(row.id, { password: await bcrypt.hash(password, 8), requires_password_change: 1 });
        await endSessions(row.id);
        out.temporaryPassword = password;
        log(`${admin.username} reset the password of ${row.username}`);
    }
    out.user = publicUser(await stores().user.getById(row.id));
    res.json(out);
}));

extension.delete('/unify/admin/users/:username', API_ROUTE, asAdmin(async (req, res, admin) => {
    const row = await editableTarget(res, req.params.username, admin);
    if (!row) return;
    if (row.id === admin.id) return fail(res, 400, 'self', 'You cannot remove your own account.');
    if (BOOT_ADMINS.has(lower(row.username))) return fail(res, 400, 'protected', 'This administrator is set in config.json and cannot be removed here.');
    await chat('/internal/offboard', { uuid: row.uuid });
    await endSessions(row.id);
    await services().userAccount.cascadeDelete(row.id);
    log(`${admin.username} removed ${row.username}`);
    res.json({ ok: true });
}));

extension.post('/unify/admin/users/:username/onboard', API_ROUTE, asAdmin(async (req, res, admin) => {
    const row = await editableTarget(res, req.params.username, admin);
    if (!row) return;
    res.json({ ok: true, onboarding: await onboard(row) });
}));

extension.get('/unify/admin/apps', API_ROUTE, asAdmin(async (req, res) => {
    res.json({ apps: await suiteApps() });
}));

extension.post('/unify/admin/apps', API_ROUTE, asAdmin(async (req, res) => {
    const body = req.body || {};
    if (manifestApps().some((a) => a.name === lower(body.name))) {
        return fail(res, 400, 'suite_app', 'That is one of the suite\'s own apps: DevOps deploys it (scripts/deploy-apps.sh).');
    }
    reply(res, await registerApp(body));
}));

extension.patch('/unify/admin/apps/:name', API_ROUTE, asAdmin(async (req, res) => {
    const name = lower(req.params.name);
    const body = req.body || {};
    const app = await stores().app.getByName(name);
    if (!app) return fail(res, 404, 'not_found', `No app named ${name}.`);
    const patch = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 100);
    if (typeof body.description === 'string') patch.description = body.description.slice(0, 500);
    if (Object.keys(patch).length) await stores().app.update(app.id, patch);
    if (typeof body.enabled === 'boolean') {
        const r = await setAppEnabled(name, body.enabled);
        if (!r.body) return reply(res, r);
    }
    res.json({ ok: true });
}));

extension.delete('/unify/admin/apps/:name', API_ROUTE, asAdmin(async (req, res) => {
    const name = lower(req.params.name);
    if (manifestApps().some((a) => a.name === name)) {
        return fail(res, 400, 'suite_app', 'The suite\'s own apps are turned off rather than removed (remove it from suite-apps.json to retire it).');
    }
    const app = await stores().app.getByName(name);
    if (!app) return fail(res, 404, 'not_found', `No app named ${name}.`);
    await stores().app.delete(app.id);
    log(`app ${name} removed`);
    res.json({ ok: true });
}));

// For everyone signed in.
extension.get('/unify/apps', API_ROUTE, async (req, res) => {
    const admin = await currentAdmin().catch(() => null);
    const apps = (await suiteApps()).filter((a) => a.registered && a.enabled && (!a.adminOnly || admin));
    res.json({ apps: apps.map(({ name, title, description, url, icon, adminOnly }) => ({ name, title, description, url, icon, adminOnly })) });
});

extension.get('/unify/directory', API_ROUTE, async (req, res) => {
    if (TRIAL) return res.json({ people: [] });
    const q = lower(req.query?.q);
    const people = (await allPeople()).filter((r) => !r.suspended && r.email);
    const match = (r) => !q || [r.username, r.email, displayName(r)].some((v) => lower(v).includes(q));
    res.json({
        people: people.filter(match).slice(0, Math.min(Number(req.query?.limit) || 500, 2000))
            .map((r) => ({ username: r.username, name: displayName(r), email: r.email })),
    });
});

// For DevOps scripts on the server (x-unify-secret).
extension.post('/unify/internal/users', OPEN_ROUTE, asInternal(async (req, res) => {
    reply(res, await createAccount(req.body || {}, 'devops', { service: true }));
}));

extension.post('/unify/internal/apps', OPEN_ROUTE, asInternal(async (req, res) => {
    reply(res, await registerApp(req.body || {}));
}));

extension.post('/unify/internal/apps/:name/enabled', OPEN_ROUTE, asInternal(async (req, res) => {
    reply(res, await setAppEnabled(lower(req.params.name), req.body?.enabled !== false));
}));

extension.post('/unify/internal/users/:username/password', OPEN_ROUTE, asInternal(async (req, res) => {
    const row = await stores().user.getByUsername(lower(req.params.username));
    if (!row || isService(row)) return fail(res, 404, 'not_found', `No account named ${req.params.username}.`);
    const password = String(req.body?.password ?? '');
    if (password.length < 8) return fail(res, 400, 'weak_password', 'Password: at least 8 characters.');
    await stores().user.update(row.id, { password: await bcrypt.hash(password, 8), requires_password_change: 0 });
    await endSessions(row.id);
    log(`devops set the password of ${row.username}`);
    res.json({ ok: true, user: publicUser(await stores().user.getById(row.id)), onboarding: await onboard(await stores().user.getById(row.id)) });
}));

extension.post('/unify/internal/onboard-all', OPEN_ROUTE, asInternal(async (req, res) => {
    const results = {};
    for (const row of await allPeople()) {
        if (row.suspended) continue;
        results[row.username] = await onboard(await stores().user.getById(row.id));
    }
    res.json({ ok: true, results });
}));

extension.post('/unify/internal/mail-domain', OPEN_ROUTE, asInternal(async (req, res) => {
    const from = lower(req.body?.from), to = lower(req.body?.to);
    if (!from || !to || from === to) return fail(res, 400, 'bad_domains', 'from and to: two different mail domains.');
    const moved = [];
    for (const row of await allPeople()) {
        if (!lower(row.email).endsWith(`@${from}`)) continue;
        const email = `${lower(row.email).slice(0, -from.length - 1)}@${to}`;
        if (await stores().user.findEmailOwner(email)) continue;
        await stores().user.update(row.id, { email, clean_email: cleanEmail(email) });
        moved.push(`${row.email} -> ${email}`);
    }
    log(`mail domain ${from} -> ${to}:`, moved.length, 'account(s)');
    res.json({ ok: true, moved });
}));

log(`users, apps and directory on api.${DOMAIN}/unify/...; bootstrap administrators: ${[...BOOT_ADMINS].join(', ')}`);
