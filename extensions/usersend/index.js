/**
 * usersend — `POST /email/send` for self-hosted Puter.
 *
 * Open-source Puter can *receive* mail for your own domains (the `puter-smtp`
 * receiver + `useremailrx`'s `/email/ingress`), but the route apps use to
 * *send* — `POST {APIOrigin}/email/send`, called by `puter.email.send()` and by
 * the Email app — exists only on puter.com. This extension provides it:
 *
 *   - the caller must be signed in; an app acting for a user also needs the
 *     user's `fs:/<username>/.mail:write` grant (403 "write access", which is
 *     the cue the Email and Calendar apps use to ask for it);
 *   - `From:` must be the caller's own `<username>@<domain>` for one of
 *     `userEmail.localDomains`;
 *   - each To/Cc recipient on a local domain is filed straight into that
 *     user's `~/.mail/objects/` — the same function inbound SMTP uses — so mail
 *     between colleagues never leaves the server;
 *   - every other recipient is relayed over SMTP through `userEmailSend.relay`
 *     (any nodemailer transport: Google Workspace, Microsoft 365, Postfix,
 *     MailHog...), falling back to the transactional `email` transport.
 *
 * Response (JSON): 200 `{ ok, delivered: [address], failed: [{ address, error }] }`
 * when anything was delivered; 4xx/5xx `{ code, message }` otherwise.
 *
 * Config (`config.json`):
 *   "userEmail":     { "localDomains": ["company1.example"], ... }   // shared with inbound
 *   "userEmailSend": { "relay": { "host": "...", "port": 587, "auth": {...} },
 *                      "maxRecipients": 50 }
 */
// CommonJS, like the extensions built into the image: it is mounted at
// /opt/puter/dist/extensions/usersend, where `@heyputer/backend/...` resolves
// through dist/package.json's self-reference exports.
const { Context } = require('@heyputer/backend/src/core');
const { extension } = require('@heyputer/backend/src/extensions');
const {
    MAX_MESSAGE_BYTES,
    isTempUser,
    storeInboxMessage,
} = require('@heyputer/backend/src/services/email/mailbox.js');
const nodemailer = require('nodemailer');
const addressparser = require('nodemailer/lib/addressparser');

const config = extension.config;
const LOCAL_DOMAINS = new Set(
    (config.userEmail?.localDomains ?? []).map((d) => String(d).toLowerCase()),
);
const SEND = config.userEmailSend ?? {};
const MAX_RECIPIENTS = Number(SEND.maxRecipients) || 50;
const RELAY_OPTIONS = SEND.relay ?? config.email ?? null;
let relay = null;
const getRelay = () => {
    if (!relay && RELAY_OPTIONS) relay = nodemailer.createTransport(RELAY_OPTIONS);
    return relay;
};

// ---------------------------------------------------------------- parsing

/** Unfolded header fields of an RFC 5322 message, lower-cased names. */
const parseHeaders = (raw) => {
    const text = raw.toString('latin1');
    const end = text.search(/\r?\n\r?\n/);
    const block = end === -1 ? text : text.slice(0, end);
    const fields = {};
    for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        (fields[name] ??= []).push(line.slice(colon + 1).trim());
    }
    return fields;
};

/** Every address in the given header values, lower-cased, groups flattened. */
const addressesIn = (values = []) => {
    const out = [];
    const walk = (list) => {
        for (const entry of list) {
            if (entry.group) walk(entry.group);
            else if (entry.address) out.push(entry.address.trim().toLowerCase());
        }
    };
    for (const value of values) walk(addressparser(value));
    return out;
};

const domainOf = (address) => address.split('@')[1] ?? '';
const localPartOf = (address) => address.split('@')[0] ?? '';

// ---------------------------------------------------------------- route

const fail = (res, status, code, message) => res.status(status).json({ code, message });

const readBody = async (req, limit) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('too large'), { tooLarge: true });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

if (!LOCAL_DOMAINS.size) {
    console.warn('[usersend] userEmail.localDomains is empty - /email/send disabled');
} else {
    console.log(`[usersend] /email/send enabled for ${[...LOCAL_DOMAINS].join(', ')}; ` +
        `external relay: ${RELAY_OPTIONS ? `${RELAY_OPTIONS.host}:${RELAY_OPTIONS.port}` : 'none'}`);

    extension.post('/email/send', { subdomain: 'api', requireAuth: true }, async (req, res) => {
        const actor = Context.get('actor');
        const user = actor?.user;
        if (!user?.id || isTempUser(user)) {
            return fail(res, 401, 'unauthorized', 'Sign in with a full account to send mail.');
        }
        const services = extension.import('service');
        const stores = extension.import('store');

        // An app sending for a user needs the same grant that lets it write
        // the Sent copy: write access to the user's mailbox.
        const mailbox = `/${user.username}/.mail`;
        if (actor.effectiveApp) {
            let allowed = false;
            try {
                allowed = await services.permission.check(actor, `fs:${mailbox}:write`);
            } catch {
                allowed = false;
            }
            if (!allowed) {
                return fail(res, 403, 'forbidden',
                    `This app needs write access to your mailbox (${mailbox}) to send mail.`);
            }
        }

        let raw;
        try {
            raw = await readBody(req, MAX_MESSAGE_BYTES);
        } catch (e) {
            return e.tooLarge
                ? fail(res, 413, 'too_large', `Messages are limited to ${MAX_MESSAGE_BYTES} bytes.`)
                : fail(res, 400, 'bad_request', 'Could not read the message.');
        }
        if (!raw.length) return fail(res, 400, 'bad_request', 'The message is empty.');

        const headers = parseHeaders(raw);
        const from = addressesIn(headers.from);
        const allowedDomains = [...LOCAL_DOMAINS];
        if (
            from.length !== 1 ||
            localPartOf(from[0]) !== user.username.toLowerCase() ||
            !LOCAL_DOMAINS.has(domainOf(from[0]))
        ) {
            return fail(res, 403, 'from_mismatch',
                `From must be your own address: ${user.username}@${allowedDomains[0]}.`);
        }
        if (headers.bcc) {
            // Every recipient receives the same bytes, so a Bcc header would
            // reveal itself to all of them.
            return fail(res, 400, 'bcc_unsupported', 'Bcc is not supported.');
        }
        const recipients = [...new Set(addressesIn([...(headers.to ?? []), ...(headers.cc ?? [])]))];
        if (!recipients.length) return fail(res, 400, 'no_recipients', 'Add at least one recipient.');
        if (recipients.length > MAX_RECIPIENTS) {
            return fail(res, 400, 'too_many_recipients', `At most ${MAX_RECIPIENTS} recipients per message.`);
        }

        const subject = headers.subject?.[0] ?? '';
        const delivered = [];
        const failed = [];
        const external = [];

        for (const address of recipients) {
            if (!LOCAL_DOMAINS.has(domainOf(address))) {
                external.push(address);
                continue;
            }
            try {
                const owner = await stores.user.getByUsername(localPartOf(address));
                if (!owner || isTempUser(owner)) {
                    failed.push({ address, error: 'no_such_user' });
                    continue;
                }
                await storeInboxMessage(services.fs, owner, { subject, content: raw, size: raw.length });
                delivered.push(address);
            } catch (e) {
                console.error('[usersend] local delivery failed', address, e);
                failed.push({ address, error: 'delivery_failed' });
            }
        }

        if (external.length) {
            const transport = getRelay();
            if (!transport) {
                for (const address of external) failed.push({ address, error: 'no_relay_configured' });
            } else {
                try {
                    await transport.sendMail({ envelope: { from: from[0], to: external }, raw });
                    delivered.push(...external);
                } catch (e) {
                    console.error('[usersend] relay failed', e?.message);
                    for (const address of external) failed.push({ address, error: 'relay_failed' });
                }
            }
        }

        console.log(`[usersend] ${user.username}: delivered ${delivered.length}, failed ${failed.length}`);
        if (!delivered.length) {
            return res.status(502).json({
                code: 'delivery_failed',
                message: `Nothing was delivered: ${failed.map((f) => `${f.address} (${f.error})`).join(', ')}`,
                delivered,
                failed,
            });
        }
        return res.json({ ok: failed.length === 0, delivered, failed });
    });
}

// ---------------------------------------------------------------- inbound

/**
 * `/email/ingress-stamped` — the same job as useremailrx's `/email/ingress`
 * (file one message from the SMTP receiver into a mailbox), plus the one thing
 * every mail server does and Puter's receiver does not: prepend a `Received:`
 * header. Without it, mail from outside is byte-for-byte indistinguishable
 * from mail a colleague sent through `/email/send`, so a stranger could write
 * `From: ceo@<our domain>` and be treated as an internal sender (the Calendar
 * auto-adds internal invitations). Point `userEmail.localIngressUrl` here.
 */
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { hostname } = require('node:os');
const INGRESS_SECRET = config.userEmail?.secret;
const COMPARE_KEY = randomBytes(32);
const sameSecret = (a, b) => timingSafeEqual(
    createHmac('sha256', COMPARE_KEY).update(String(a)).digest(),
    createHmac('sha256', COMPARE_KEY).update(String(b)).digest(),
);
const headerSafe = (v) => String(v ?? '').replace(/[\r\n<>;()]/g, '').slice(0, 200);

if (INGRESS_SECRET) {
    extension.post('/email/ingress-stamped', { subdomain: 'api' }, async (req, res) => {
        if (typeof req.query.SECRET !== 'string' || !sameSecret(req.query.SECRET, INGRESS_SECRET)) {
            res.status(403).end();
            req.destroy();
            return;
        }
        const declared = Number(req.headers['content-length']);
        if (!Number.isInteger(declared) || declared <= 0 || declared > MAX_MESSAGE_BYTES) {
            res.status(declared > MAX_MESSAGE_BYTES ? 413 : 411).end();
            req.destroy();
            return;
        }
        let body;
        try {
            body = await readBody(req, MAX_MESSAGE_BYTES);
        } catch {
            res.status(400).end();
            return;
        }
        const to = String(req.query.to ?? '').toLowerCase();
        const owner = await extension.import('store').user.getByUsername(localPartOf(to));
        if (!owner) { res.status(404).end(); return; }
        if (isTempUser(owner)) { res.end(); return; }
        const from = headerSafe(req.query.from);
        const stamp = Buffer.from(
            // The receiver passes the message's own From, not the SMTP
            // envelope sender, so it is labelled as a claim, not a fact.
            `Received: from external sender (claimed From <${from}>)\r\n` +
            `\tby ${headerSafe(hostname())} (Unify inbound) with SMTP for <${headerSafe(to)}>;\r\n` +
            `\t${new Date().toUTCString().replace('GMT', '+0000')}\r\n`,
        );
        const content = Buffer.concat([stamp, body]);
        await storeInboxMessage(extension.import('service').fs, owner, {
            subject: req.query.subject, content, size: content.length,
        });
        res.end();
    });
    console.log('[usersend] /email/ingress-stamped enabled (inbound mail gets a Received header)');
}

/**
 * POST /email/deliver-internal?from=<addr>&to=<addr>[,<addr>...]
 *   header x-unify-secret: <config.unifyInternal.secret>, body: the message
 *
 * Mail between colleagues that one of our own services sends on a user's
 * behalf, after checking who that user is itself: the chat server, when
 * someone shares a meeting invitation in a conversation, sends it to the
 * other members from that person. Stored like /email/send's internal
 * delivery (no Received header), so Calendar treats it as a colleague's.
 * Sender and recipients must all be accounts here; the message's own From
 * must be the sender. Off unless the secret is configured.
 */
const INTERNAL_SECRET = config.unifyInternal?.secret;
if (INTERNAL_SECRET && LOCAL_DOMAINS.size) {
    extension.post('/email/deliver-internal', { subdomain: 'api' }, async (req, res) => {
        const given = req.headers['x-unify-secret'];
        if (typeof given !== 'string' || !sameSecret(given, INTERNAL_SECRET)) {
            res.status(403).end();
            req.destroy();
            return;
        }
        let raw;
        try {
            raw = await readBody(req, MAX_MESSAGE_BYTES);
        } catch {
            return fail(res, 400, 'bad_request', 'Unreadable or oversized message.');
        }
        const stores = extension.import('store');
        const local = (address) => {
            const at = address.lastIndexOf('@');
            return at > 0 && LOCAL_DOMAINS.has(address.slice(at + 1)) ? address.slice(0, at) : null;
        };
        const from = String(req.query.from ?? '').trim().toLowerCase();
        const sender = local(from) && await stores.user.getByUsername(local(from));
        const headers = parseHeaders(raw);
        if (!sender || !addressesIn(headers.from ?? []).includes(from)) {
            return fail(res, 403, 'from_mismatch', 'The sender must be an account here and the message From.');
        }
        const delivered = [];
        const failed = [];
        for (const to of String(req.query.to ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, MAX_RECIPIENTS)) {
            const owner = local(to) && await stores.user.getByUsername(local(to));
            if (!owner || isTempUser(owner)) { failed.push({ address: to, error: 'no_such_user' }); continue; }
            await storeInboxMessage(extension.import('service').fs, owner, {
                subject: headers.subject?.[0], content: raw, size: raw.length,
            });
            delivered.push(to);
        }
        res.json({ ok: failed.length === 0, delivered, failed });
    });
    console.log('[usersend] /email/deliver-internal enabled (our services mailing colleagues on a user\'s behalf)');
}

module.exports = { parseHeaders, addressesIn };
