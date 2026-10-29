/**
 * Chat -> Calendar: a meeting invitation (.ics) shared in a conversation
 * reaches the calendars of the people in it.
 *
 * After a message with a calendar file attached is posted, the file is sent
 * as an ordinary invitation email from the person who posted it to every
 * other member of the conversation, through our mail extension's
 * /email/deliver-internal. Calendar picks invitations up from the mailbox and
 * adds a colleague's straight to the calendar, so nothing in Calendar or
 * Teamchat changes for this.
 *
 * Needs UNIFY_INTERNAL_SECRET (= config.json "unifyInternal.secret") and
 * CHAT_MAIL_DOMAIN; without them the bridge is off.
 */
import { randomUUID } from 'node:crypto';

const MAX_ICS_BYTES = 256 * 1024;
const MESSAGE_PATH = /^\/api\/ws\/([a-z0-9]{6,20})\/conv\/([A-Za-z0-9_]{3,64})\/messages$/;

/** RFC 2047 for a header that is not plain ASCII (as Calendar's own mailer does). */
const asciiHeader = (value) => {
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
};

/** A property's value from an iCalendar text (first occurrence, lines unfolded). */
const icsValue = (ics, name) => {
  const m = ics.replace(/\r?\n[ \t]/g, '').match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'mi'));
  return m ? m[1].trim().replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ') : '';
};

/** A parameter value (CN=...), quoted when it holds characters that would end it. */
const icsParam = (v) => {
  const clean = String(v ?? '').replace(/["\r\n]/g, '');
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
};

const b64Lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

export function createCalendarBridge({ secret, mailDomain, apiOrigin, origin, kv, fs, call, whoami, excluded, log }) {
  const enabled = Boolean(secret && mailDomain);
  if (!enabled) log('calendar bridge off (set UNIFY_INTERNAL_SECRET and CHAT_MAIL_DOMAIN)');

  /** Whether a request is a new message whose attachments should be looked at. */
  const matches = (method, path) => (enabled && method === 'POST' ? MESSAGE_PATH.exec(path) : null);

  async function membersOf(ws, conv, token, posterUuid) {
    if (conv.startsWith('dm_')) {
      const doc = await kv.get(`tc:ws:${ws}:u:${posterUuid}`);
      return doc?.dms?.[conv]?.members || [];
    }
    // Teamchat's own answer, asked as the poster: it knows public and private channels alike.
    const res = await call(token, 'GET', `/api/ws/${ws}/channels/${encodeURIComponent(conv)}/members`);
    return res.members || [];
  }

  async function deliver(from, to, ics, summary, where) {
    const method = (icsValue(ics, 'METHOD') || 'PUBLISH').toUpperCase();
    const calendar = /^METHOD:/mi.test(ics) ? ics : ics.replace(/BEGIN:VCALENDAR\r?\n/i, (m) => `${m}METHOD:PUBLISH\r\n`);
    const boundary = `unify-${randomUUID()}`;
    const when = icsValue(ics, 'DTSTART');
    const text = `${from.name} shared a meeting in ${where} on Chat:\r\n\r\n${summary}\r\n${when ? `Starts: ${when}\r\n` : ''}` +
      `\r\nCalendar adds it to your calendar; open it there to answer.\r\n`;
    const raw = [
      `From: ${asciiHeader(from.name)} <${from.address}>`,
      `To: ${to.join(', ')}`,
      `Subject: ${asciiHeader(`Invitation: ${summary}`)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${randomUUID()}@${mailDomain}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lines(Buffer.from(text)),
      `--${boundary}`,
      `Content-Type: text/calendar; charset=utf-8; method=${method}; name="invite.ics"`,
      'Content-Disposition: attachment; filename="invite.ics"',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lines(Buffer.from(calendar)),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const url = `${apiOrigin}/email/deliver-internal?from=${encodeURIComponent(from.address)}&to=${encodeURIComponent(to.join(','))}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-unify-secret': secret, 'content-type': 'message/rfc822', origin },
      body: raw,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok && !out.delivered) throw new Error(`deliver-internal ${res.status} ${out.code || ''}`);
    return out;
  }

  /**
   * After a message was posted: every calendar file among its attachments
   * goes to the conversation's other members. Runs behind the answer; a
   * failure is logged, never shown as a failed post.
   */
  async function afterPost({ ws, conv, token, body }) {
    const ids = (Array.isArray(body?.attachments) ? body.attachments : []).map((a) => a?.id).filter((id) => typeof id === 'string');
    if (!ids.length) return;
    const files = [];
    for (const id of ids) {
      const meta = await kv.get(`tc:file:${id}`);
      if (meta?.ws !== ws || meta.size > MAX_ICS_BYTES) continue;
      if (!/calendar/i.test(meta.type || '') && !/\.ics$/i.test(meta.name || '')) continue;
      const blob = await fs.read(`teamchat-files/${ws}/${id}`);
      const ics = typeof blob === 'string' ? blob : await blob.text();
      if (/BEGIN:VEVENT/i.test(ics)) files.push(ics);
    }
    if (!files.length) return;

    const who = await whoami(token);
    const wsDoc = await kv.get(`tc:ws:${ws}`);
    const cards = wsDoc?.members || {};
    const members = await membersOf(ws, conv, token, who.uuid);
    const to = [...new Set(members)]
      .filter((u) => u !== who.uuid && cards[u]?.username && !excluded.has(String(cards[u].username).toLowerCase()))
      .map((u) => `${String(cards[u].username).toLowerCase()}@${mailDomain}`);
    if (!to.length) return;
    const channel = wsDoc?.channels?.[conv];
    const where = channel ? `#${channel.name}` : 'a direct message';
    const from = { address: `${String(who.username).toLowerCase()}@${mailDomain}`, name: cards[who.uuid]?.name || who.username };
    for (const file of files) {
      const summary = icsValue(file, 'SUMMARY') || 'Meeting';
      // A meeting made in the conversation (Teamchat's "Meeting invitation")
      // names nobody: the poster organizes it and the conversation is
      // invited, so answers go back to the poster as for any invitation, and
      // the poster gets it in their own calendar too, as its host. A file shared as it
      // came (someone's invitation, forwarded) is passed on unchanged.
      if (!/^ORGANIZER[;:]/mi.test(file)) {
        const people = [
          `ORGANIZER;CN=${icsParam(from.name)}:mailto:${from.address}`,
          ...to.map((addr) => `ATTENDEE;CN=${icsParam(addr.split('@')[0])};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${addr}`),
        ].join('\r\n');
        const invite = file.replace(/BEGIN:VEVENT\r?\n/i, (m) => `${m}${people}\r\n`);
        const out = await deliver(from, to, invite, summary, where);
        // The organizer's copy: the same REQUEST, which their Calendar files as
        // a meeting they host (organizer = them), so guests' answers land on it.
        await deliver(from, [from.address], invite, summary, where);
        log(`meeting "${summary}" made by ${from.address} in ${where}: invited ${out.delivered?.length ?? 0}, failed ${out.failed?.length ?? 0}`);
      } else {
        const out = await deliver(from, to, file, summary, where);
        log(`calendar invite "${summary}" shared by ${from.address} in ${where}: delivered to ${out.delivered?.length ?? 0}, failed ${out.failed?.length ?? 0}`);
      }
    }
  }

  return { matches, afterPost };
}
