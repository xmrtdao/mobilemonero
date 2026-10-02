/**
 * End-to-end proof that a paid PFP lead becomes a booking.
 *
 * This is a real Checkout Session, created against the real Stripe account,
 * because the point is the webhook's signature verification and metadata
 * round-trip - neither of which a mocked session would exercise. The session is
 * created and then EXPIRED so it cannot be paid:
 *
 *   - an unexpired session is a real payment page for a real client, and this
 *     must never be able to receive money
 *   - expiring it also proves the refund/expire API path works
 *
 * The webhook is then driven with a signed event carrying the real session id and
 * the real lead id, so the code under test is the production path.
 *
 * Usage: node scripts/_probe_pfp_fulfilment.mjs
 */

import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const env = fs.readFileSync('.env', 'utf8');
const val = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };

const RELAY = 'http://localhost:8080';
const API_KEY = val('RELAY_API_KEY');
const stripe = require('stripe')(val('STRIPE_SECRET_KEY'));
const { getPool } = await import('file:///C:/Users/PureTrek/Desktop/xmrtdao/relay/jobby/store.mjs');
const pool = await getPool();

const call = async (path, body) => {
  const r = await fetch(RELAY + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// A lead of our own, so the probe never touches a real client's record.
const TAG = 'checkout-probe-' + Date.now();
const { rows: leads } = await pool.query(
  `INSERT INTO public.pfp_leads (contact_name, contact_email, status, event_type, event_date, source)
   VALUES ($1,$2,'negotiating','School Dance','2027-05-14T18:00:00Z','probe') RETURNING id, contact_email`,
  [`Probe Person ${TAG}`, `${TAG}@example.test`]);
const leadId = leads[0].id;
console.log(`  probe lead ${leadId} (${TAG})`);

let sessionId = null;
try {
  console.log('\n  1. the endpoint refuses without an idempotency key');
  const noKey = await call('/api/pfp/checkout', { lead_id: leadId, amountCents: 25000 });
  console.log(`     -> HTTP ${noKey.status}  ${noKey.body.error || ''}`);
  console.log(`     and says why: ${noKey.body.detail ? noKey.body.detail.slice(0, 70) + '...' : '(none)'}`);

  console.log('\n  2. it creates a real Checkout Session, with the lead id in metadata');
  // Identical parameters are sent again in step 3. Stripe rejects a reused
  // idempotency key whose body differs, so a retry must send exactly the same
  // request - which is the point of the key.
  const args = {
    lead_id: leadId, amountCents: 25000, currency: 'usd',
    idempotencyKey: 'pfp-probe-' + TAG,
    successUrl: 'https://relay.mobilemonero.com/done', cancelUrl: 'https://relay.mobilemonero.com/cancel',
  };
  const created = await call('/api/pfp/checkout', args);
  console.log(`     -> HTTP ${created.status}  session=${created.body.session_id}  amount=${created.body.amount} ${created.body.currency}`);
  if (created.body.error) console.log(`     error: ${created.body.error}`);
  sessionId = created.body.session_id;
  if (!sessionId) { console.log('     no session created; stopping'); process.exit(1); }

  const sess = await stripe.checkout.sessions.retrieve(sessionId);
  console.log(`     metadata carried back from Stripe: ${JSON.stringify(sess.metadata)}`);

  console.log('\n  3. the same key and the same body returns the same session, not a second one');
  const again = await call('/api/pfp/checkout', args);
  console.log(`     -> session ${again.body.session_id}  same as before: ${again.body.session_id === sessionId}`);
  if (again.body.error) console.log(`     error: ${again.body.error}`);

  console.log('\n  4. EXPIRE the session so it can never be paid');
  const expired = await stripe.checkout.sessions.expire(sessionId);
  console.log(`     status is now: ${expired.status}`);

  console.log('\n  5. deliver a SIGNED checkout.session.completed, twice');
  const event = {
    id: 'evt_probe_' + Date.now(), object: 'event', type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: { object: {
      id: sessionId, object: 'checkout.session', payment_status: 'paid',
      amount_total: 25000, currency: 'usd', customer_email: leads[0].contact_email,
      customer_details: { email: leads[0].contact_email, name: 'Probe Person' },
      payment_intent: 'pi_probe_' + TAG, created: Math.floor(Date.now() / 1000),
      metadata: sess.metadata,
    } },
  };
  const payload = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({
    payload, secret: val('STRIPE_WEBHOOK_SECRET'), timestamp: Math.floor(Date.now() / 1000),
  });
  const deliver = async () => {
    const r = await fetch(RELAY + '/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body: payload,
    });
    return r.status;
  };
  console.log(`     first delivery  -> HTTP ${await deliver()}`);
  console.log(`     second delivery -> HTTP ${await deliver()}   (Stripe retries; must not book twice)`);

  console.log('\n  6. what the data says now');
  const bk = await pool.query('SELECT id, lead_id, client_name, event_name, event_type, event_date, venue, total_fee, deposit_paid, status FROM public.pfp_bookings WHERE lead_id = $1', [leadId]);
  console.log(`     bookings for this lead: ${bk.rows.length}   <- must be exactly 1`);
  bk.rows.forEach(b => console.log(`       id=${b.id} name=${b.client_name} event_name=${b.event_name ?? '(null - not invented)'} type=${b.event_type} date=${String(b.event_date).slice(0,10)} venue=${b.venue ?? '(null)'} fee=${b.total_fee} deposit=${b.deposit_paid} status=${b.status}`));
  const ld = await pool.query('SELECT status FROM public.pfp_leads WHERE id = $1', [leadId]);
  console.log(`     lead status is now: ${ld.rows[0].status}`);
  const pay = await pool.query('SELECT id, stripe_charge_id, amount, status, booking_id FROM public.pfp_payments WHERE metadata->>\'checkout_session\' = $1', [sessionId]);
  console.log(`     payment rows linked to this session: ${pay.rows.length}`);
  pay.rows.forEach(p => console.log(`       id=${p.id} ${p.stripe_charge_id} $${p.amount} ${p.status} booking_id=${p.booking_id}`));
  const linked = pay.rows[0] && pay.rows[0].booking_id;
  console.log(`\n  ${bk.rows.length === 1 && linked === bk.rows[0].id
    ? 'PASS  one lead, one booking, payment linked to it, replay did not duplicate'
    : 'CHECK the numbers above'}`);
} finally {
  // Tidy the probe. The lead, its booking and its payment row are all ours.
  await pool.query('DELETE FROM public.pfp_payments WHERE metadata->>\'checkout_session\' = $1', [sessionId]);
  await pool.query('DELETE FROM public.pfp_bookings WHERE lead_id = $1', [leadId]);
  await pool.query('DELETE FROM public.pfp_leads WHERE id = $1', [leadId]);
  const left = await pool.query('SELECT count(*)::int n FROM public.pfp_leads WHERE id = $1', [leadId]);
  console.log(`\n  probe rows removed (leads matching: ${left.rows[0].n})`);
  await pool.end();
}
