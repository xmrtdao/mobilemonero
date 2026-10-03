#!/usr/bin/env node
/**
 * auto-responder.mjs — Simple email acknowledgment for PFP campaign replies
 *
 * When someone replies, sends a brief acknowledgment saying the message
 * has been routed to Joe. Joe handles all actual responses — keeps the
 * human firmly in the loop. Auto-replies and bounces are silently ignored.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load Resend API key from .env
const RESEND_API_KEY = (() => {
  try {
    const env = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    const match = env.match(/^RESEND_API_KEY=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

// ── Auto-reply / bounce detection ───────────────────────────
const AUTO_PATTERNS = [
  /^automatic reply/i, /^out of office/i, /^away from/i,
  /^auto-reply/i, /^vacation/i, /^on leave/i,
  /undeliverable/i, /delivery (failed|status)/i,
  /mail delivery failed/i, /failure notice/i, /returned mail/i,
  /please activate your account/i, /remittance receipt/i,
];

function isAutoReply(subject, from) {
  if (!subject) return false;
  const autoDomains = ['mailer-daemon', 'postmaster@', 'noreply@', 'no-reply@'];
  if (autoDomains.some(d => from?.toLowerCase().includes(d))) return true;
  return AUTO_PATTERNS.some(p => p.test(subject));
}

// ── Send acknowledgment ─────────────────────────────────────
async function sendAck(originalEmail) {
  if (!RESEND_API_KEY) return false;

  const ackBody = `Thanks for reaching out! Your message has been received and I have sent it along to Joe for follow up.

In the meantime, feel free to book instantly here:
https://buy.stripe.com/cNicN5gP9g6haH0bKCbZe0d

Talk soon,
Party Favor Photo`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Party Favor Photo <bookings@partyfavorphoto.com>',
        to: [originalEmail.from],
        subject: `Re: ${originalEmail.subject || 'Your inquiry'}`,
        text: ackBody,
        headers: originalEmail.message_id
          ? { 'In-Reply-To': originalEmail.message_id, 'References': originalEmail.message_id }
          : undefined,
      }),
    });
    const ok = res.ok;
    console.log(`[AutoResponder] ${ok ? 'Ack sent' : 'Ack failed'} to ${originalEmail.from}`);
    
    // Log to relay's sent log
    try {
      await fetch('http://localhost:8080/log/sent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: originalEmail.from, subject: `Re: ${originalEmail.subject || 'Your inquiry'}`, body: ackBody, type: 'auto-responder', status: ok ? 'delivered' : 'failed' }),
      });
    } catch { /* relay may not be available */ }
    
    return ok;
  } catch (err) {
    console.error(`[AutoResponder] Send error: ${err.message}`);
    return false;
  }
}

// ── Main handler — called from webhook ──────────────────────
const ACK_LOG = join(__dirname, '..', 'relay-data', 'auto-ack-log.json');

function hasRecentAck(from, hours = 72) {
  try {
    const log = JSON.parse(readFileSync(ACK_LOG, 'utf8'));
    const recent = log.filter(e => e.from === from && e.ts > Date.now() - hours * 3600000);
    return recent.length > 0;
  } catch { return false; }
}

function logAck(from, subject) {
  try {
    const log = JSON.parse(readFileSync(ACK_LOG, 'utf8'));
    log.push({ from, subject, ts: Date.now() });
    // Keep last 500 entries
    if (log.length > 500) log.splice(0, log.length - 500);
    writeFileSync(ACK_LOG, JSON.stringify(log, null, 2));
  } catch {}
}

export async function handleInboundEmail(emailEntry) {
  const { from, subject, email_id } = emailEntry;

  // Skip auto-replies silently
  if (isAutoReply(subject, from)) {
    return { action: 'skipped_auto_reply' };
  }

  // Skip self-domain to prevent loops
  if (from?.includes('@partyfavorphoto.com') || from?.includes('@mobilemonero.com')) {
    return { action: 'skipped_self_domain' };
  }

  // Skip if we already acknowledged this sender recently (72h cooldown)
  if (hasRecentAck(from)) {
    console.log(`[AutoResponder] Skipped duplicate ack for ${from} (recent ack exists)`);
    return { action: 'skipped_recent_ack' };
  }

  console.log(`[AutoResponder] Acknowledging reply from ${from}: "${subject}"`);

  const sent = await sendAck({ from, subject, message_id: emailEntry.message_id });
  if (sent) logAck(from, subject);
  return { action: sent ? 'ack_sent' : 'send_failed', from };
}
