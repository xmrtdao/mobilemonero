/**
 * Proves the Stripe webhook actually verifies a signature.
 *
 * A webhook with no signing secret rejects everything, and a webhook with
 * verification removed accepts everything. Both are broken, and they fail
 * silently in opposite directions, so this checks BOTH: a correctly signed
 * request must be accepted, and a tampered one must be refused.
 *
 * The event type used here is deliberately unhandled, so it takes the
 * `UNHANDLED` branch and writes nothing to pfp_payments. A `charge.succeeded`
 * probe would have inserted a fake payment next to a real one.
 *
 * Usage: node scripts/_probe_stripe_webhook.mjs
 */

import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const env = fs.readFileSync('.env', 'utf8');
const val = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
};

const secret = val('STRIPE_WEBHOOK_SECRET');
if (!secret) {
  console.error('  STRIPE_WEBHOOK_SECRET is absent - the endpoint rejects every event.');
  process.exit(1);
}
console.log(`  using a signing secret of ${secret.length} chars (value never printed)\n`);

const stripe = require('stripe')(val('STRIPE_SECRET_KEY'));

const payload = JSON.stringify({
  id: 'evt_signature_probe_' + Date.now(),
  object: 'event',
  type: 'relay.signature.probe',
  data: { object: { id: 'probe', note: 'verifying signature handling only' } },
});

// Signed exactly as Stripe signs: timestamp.payload, HMAC-SHA256.
const timestamp = Math.floor(Date.now() / 1000);
const signed = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });

const TARGETS = [
  ['local relay ', 'http://localhost:8080/webhook/stripe'],
  ['public URL  ', 'https://relay.mobilemonero.com/webhook/stripe'],
];

let failures = 0;
for (const [label, url] of TARGETS) {
  const post = async (signature, body) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
        body,
      });
      return { status: r.status, text: (await r.text()).slice(0, 120) };
    } catch (e) {
      return { status: 0, text: e.message.slice(0, 120) };
    }
  };

  // 1. Correctly signed - must be accepted.
  const good = await post(signed, payload);
  const accepted = good.status === 200;
  console.log(`  ${label}  valid signature   -> HTTP ${good.status}  ${accepted ? 'ACCEPTED' : 'REFUSED  ' + good.text}`);
  if (!accepted) failures++;

  // 2. Body altered after signing - must be refused. This is the case that
  //    matters: an attacker can post anything to a public endpoint, and only
  //    signature verification stops them.
  const tampered = await post(signed, payload.replace('verifying signature', 'TAMPERED payload'));
  const refused = tampered.status >= 400;
  console.log(`  ${label}  tampered body     -> HTTP ${tampered.status}  ${refused ? 'REFUSED (correct)' : 'ACCEPTED - THIS IS A HOLE'}`);
  if (!refused) failures++;

  // 3. No signature at all - must be refused.
  const bare = await post('t=1,v1=deadbeef', payload);
  console.log(`  ${label}  no valid signature-> HTTP ${bare.status}  ${bare.status >= 400 ? 'REFUSED (correct)' : 'ACCEPTED - THIS IS A HOLE'}`);
  if (bare.status < 400) failures++;
  console.log('');
}

console.log(failures === 0
  ? '  the webhook verifies signatures: real events in, forged events out'
  : `  ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
