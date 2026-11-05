/**
 * Chat's email invitations, sent by our own mail server.
 *
 * Teamchat's "Invite people → Email" posts the parts of an invitation to an
 * email worker of puter.com's (worker/email.js, teamchat-email.puter.work),
 * which this server cannot reach. The suite builds Chat with
 * VITE_EMAIL_WORKER_URL pointing here instead, and this answers the same
 * request the same way:
 *
 *   POST /invites  { kind, server, code, workspace, channel?, inviter, emails[], exp?, note? }
 *     -> { ok: true, sent, failed: [{ address, error }] }
 *      | { ok: false, error }   error: sign_in_required, invalid, too_many_recipients,
 *                                      daily_limit, not_sent (Chat words each one)
 *
 * The caller is the signed-in person (the `puter-auth` token Chat's request
 * carries), and the mail goes out as them, From <username>@<mail domain>,
 * through Puter's /email/send (extensions/usersend): colleagues get it in their
 * mailbox, outside addresses through the relay (refused on a trial server).
 * The suite's internal secret tells /email/send that the message was composed
 * here, so Chat needs no grant to the person's mailbox. Like puter.com's
 * worker, it takes only the parts: subject, body and the one link are written
 * here, and the link always points at this desktop.
 */
import { randomBytes } from 'node:crypto';

const KINDS = {
  workspace: {
    subject: (r) => `${r.inviter} invited you to ${r.workspace}`,
    heading: (r) => `${r.inviter} invited you to join ${r.workspace}`,
    lead: (r) => `${r.workspace} talks in Chat: channels, threads and direct messages. Use the button below to join.`,
    button: 'Join the workspace',
    hash: (r) => `#/join/${r.server}/${r.code}`,
  },
  guest: {
    subject: (r) => `${r.inviter} invited you to #${r.channel} in ${r.workspace}`,
    heading: (r) => `${r.inviter} invited you to #${r.channel}`,
    lead: (r) => `You are invited as a guest of ${r.workspace}: you will see the #${r.channel} channel and the people in it, nothing else.`,
    button: 'Join the channel',
    hash: (r) => `#/join/${r.server}/${r.code}`,
  },
  connect: {
    subject: (r) => `${r.inviter} wants to share the #${r.channel} channel with your workspace`,
    heading: (r) => `${r.workspace} is sharing #${r.channel} with you`,
    lead: (r) => `${r.inviter} from ${r.workspace} is sharing the #${r.channel} channel with your organisation. If you administer a workspace, open the link and pick which of your workspaces to add it to.`,
    button: 'Open the shared channel',
    hash: (r) => `#/connect/${r.server}/${r.code}`,
  },
};

const MAX_RECIPIENTS = 10;   // per request, as Chat says
const DAILY_LIMIT = 100;     // per person per day

const line = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const lowerEmail = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(s) && s.length <= 254 ? s : '';
};
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The parts of one request, validated, or { error }. */
export function readRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid' };
  const kind = Object.hasOwn(KINDS, body.kind) ? body.kind : '';
  const server = typeof body.server === 'string' && /^[a-z0-9][a-z0-9.-]{0,90}$/.test(body.server.toLowerCase()) ? body.server.toLowerCase() : '';
  const code = typeof body.code === 'string' && /^[a-z0-9][a-z0-9-]{2,40}$/i.test(body.code) ? body.code.toUpperCase() : '';
  const workspace = line(body.workspace, 60);
  const inviter = line(body.inviter, 60);
  const channel = line(body.channel, 40);
  if (!kind || !server || !code || !workspace || !inviter) return { error: 'invalid' };
  if ((kind === 'guest' || kind === 'connect') && !channel) return { error: 'invalid' };
  const raw = Array.isArray(body.emails) ? body.emails : [];
  if (raw.length > MAX_RECIPIENTS) return { error: 'too_many_recipients' };
  const emails = [...new Set(raw.map(lowerEmail))].filter(Boolean);
  if (!emails.length) return { error: 'invalid' };
  const exp = Number.isFinite(body.exp) && body.exp > Date.now() && body.exp < Date.now() + 366 * 86400000 ? Math.floor(body.exp) : 0;
  return { kind, server, code, workspace, inviter, channel, emails, exp, note: block(body.note, 400) };
}

/** One RFC 5322 message, text and HTML, to one address. */
export function compose(r, { from, to, link }) {
  const k = KINDS[r.kind];
  const expiry = r.exp
    ? `This invitation works until ${new Date(r.exp).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`
    : '';
  const text = [k.heading(r), '', k.lead(r),
    ...(r.note ? ['', `${r.inviter} added a note:`, r.note] : []),
    '', `${k.button}: ${link}`, ...(expiry ? [expiry] : []),
    '', 'If you were not expecting this, you can ignore this email.'].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">`
    + `<h1 style="font-size:20px;line-height:1.3;color:#111827;margin:0 0 12px">${escapeHtml(k.heading(r))}</h1>`
    + `<p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px">${escapeHtml(k.lead(r))}</p>`
    + (r.note ? `<p style="font-size:12px;color:#6b7280;margin:0 0 4px">${escapeHtml(r.inviter)} added a note</p>`
      + `<p style="font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap;margin:0 0 16px">${escapeHtml(r.note)}</p>` : '')
    + `<p style="margin:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px">${escapeHtml(k.button)}</a></p>`
    + `<p style="font-size:12px;line-height:1.6;color:#6b7280;margin:0">Or paste this link into your browser:<br><a href="${escapeHtml(link)}" style="color:#4f46e5;word-break:break-all">${escapeHtml(link)}</a></p>`
    + (expiry ? `<p style="font-size:12px;color:#6b7280;margin:10px 0 0">${escapeHtml(expiry)}</p>` : '')
    + `<p style="font-size:12px;color:#9ca3af;margin:18px 0 0">If you were not expecting this, you can ignore this email.</p></div>`;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const boundary = `inv-${randomBytes(12).toString('hex')}`;
  const domain = from.split('@')[1];
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(k.subject(r), 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

export function createInvites({ origin, apiOrigin, mailDomain, secret, whoami, log }) {
  const sentToday = new Map();   // username -> { day, count }
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

  /** The link in the mail: through this desktop, which hands ?route= on to Chat. */
  const linkFor = (r) => `${origin}/app/teamchat?route=${encodeURIComponent(KINDS[r.kind].hash(r))}`;

  async function handle(method, token, raw) {
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (method !== 'POST') return answer(405, { ok: false, error: 'invalid' });
    if (!secret || !mailDomain) return answer(503, { ok: false, error: 'not_sent' });
    let who = null;
    try { who = token ? await whoami(token) : null; } catch { who = null; }
    if (!who?.username || who.is_temp) return answer(401, { ok: false, error: 'sign_in_required' });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return answer(400, { ok: false, error: 'invalid' }); }
    const r = readRequest(body);
    if (r.error) return answer(400, { ok: false, error: r.error });

    const day = new Date().toISOString().slice(0, 10);
    const used = sentToday.get(who.username);
    const count = used?.day === day ? used.count : 0;
    if (count + r.emails.length > DAILY_LIMIT) return answer(429, { ok: false, error: 'daily_limit' });
    sentToday.set(who.username, { day, count: count + r.emails.length });
    if (sentToday.size > 10000) sentToday.clear();

    const from = `${who.username}@${mailDomain}`;
    const link = linkFor(r);
    let sent = 0;
    const failed = [];
    // One private message per address: recipients never see each other.
    for (const to of r.emails) {
      try {
        const res = await fetch(`${apiOrigin}/email/send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-unify-secret': secret, 'content-type': 'message/rfc822' },
          body: compose(r, { from, to, link }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok && out.delivered?.includes(to)) sent += 1;
        else failed.push({ address: to, error: out.failed?.[0]?.error || out.code || `http_${res.status}` });
      } catch (e) {
        failed.push({ address: to, error: 'unreachable' });
        log('invitation mail failed:', e.message);
      }
    }
    log(`${who.username} sent ${sent} ${r.kind} invitation(s)${failed.length ? `; not sent: ${failed.map((f) => `${f.address} (${f.error})`).join(', ')}` : ''}`);
    return sent ? answer(200, { ok: true, sent, failed }) : answer(502, { ok: false, error: 'not_sent', failed });
  }

  return { handle };
}
