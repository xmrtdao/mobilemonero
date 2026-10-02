/**
 * relay/lib/pfp-checkout.mjs — turning a paid lead into a booking.
 *
 * WHY THIS EXISTS
 * ---------------
 * A PFP lead and a PFP booking were separate tables with no link. `pfp_payments`
 * had a `booking_id` column that nothing ever wrote, and `pfp_bookings` had a
 * `lead_id` that nothing ever filled. So a client who paid had no booking, and
 * nobody could tell from the data that they had.
 *
 * The link is explicit, not inferred: the lead id travels to Stripe in the
 * Checkout Session's metadata and comes back on the webhook. Matching a payment
 * to a lead by email would have been a guess, and a wrong guess books the wrong
 * client for the wrong event.
 *
 * THREE THINGS THIS REFUSES TO DO
 * -------------------------------
 * 1. Invent a fact. A lead with no event date produces a booking with a null
 *    date, and one with no event name produces a null name. `event_type` is not
 *    an event name and is not promoted into that column.
 * 2. Book twice. Stripe retries webhooks, and an agent may retry a tool call, so
 *    every step is keyed on the lead and guarded by a unique index.
 * 3. Move money. This module never calls Stripe's API. It only records what
 *    Stripe has already told us happened.
 */

const DOMAIN = 'payments';

/** Money arrives from Stripe in the smallest unit. Never store a float of it. */
const toAmount = (minor, currency) =>
  (Number(minor) / 100).toFixed(2) + ' ' + String(currency || 'usd').toUpperCase();

/**
 * Create a Stripe Checkout Session for a lead.
 *
 * The lead id goes in metadata, which is the only reason the webhook can find
 * its way back to the right client. An idempotency key is supplied by the caller
 * so a retried request returns the same session rather than charging twice.
 *
 * @param {object} deps - { stripe, query, log }
 * @param {string} leadId - public.pfp_leads.id
 * @param {object} opts - { amountCents, currency, description, idempotencyKey, successUrl, cancelUrl }
 */
export async function createCheckoutForLead(deps, leadId, opts = {}) {
  const { stripe, query } = deps;
  const { rows } = await query('SELECT * FROM public.pfp_leads WHERE id = $1', [leadId]);
  const lead = rows[0];
  if (!lead) {
    const e = new Error(`no lead with id ${leadId}`);
    e.status = 404;
    throw e;
  }
  // The address is what the receipt and the tax record need. A Checkout Session
  // without it is not a payment, it is an anonymous donation.
  if (!lead.contact_email) {
    const e = new Error(`lead ${leadId} has no contact_email, so there is nowhere to send a receipt`);
    e.status = 422;
    throw e;
  }
  if (lead.status === 'booked') {
    const e = new Error(`lead ${leadId} is already booked - refund or amend the booking instead of charging again`);
    e.status = 409;
    throw e;
  }

  const amount = Number(opts.amountCents);
  if (!Number.isInteger(amount) || amount < 50) {
    const e = new Error('amountCents must be a whole number of cents, at least 50');
    e.status = 422;
    throw e;
  }

  const description = opts.description
    || [lead.event_type, lead.event_date ? new Date(lead.event_date).toISOString().slice(0, 10) : null]
        .filter(Boolean).join(' - ')
    || `Party Favor Photo - ${lead.contact_name || 'client'}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: lead.contact_email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(opts.currency || 'usd').toLowerCase(),
        unit_amount: amount,
        product_data: { name: description },
      },
    }],
    // The whole point: this is what the webhook reads to find the lead.
    metadata: {
      lead_id: String(lead.id),
      lead_email: lead.contact_email,
      lead_name: lead.contact_name || '',
      source: 'pfp_checkout',
    },
    payment_intent_data: {
      metadata: { lead_id: String(lead.id), source: 'pfp_checkout' },
    },
    ...(opts.successUrl ? { success_url: opts.successUrl } : {}),
    ...(opts.cancelUrl ? { cancel_url: opts.cancelUrl } : {}),
  }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});

  deps.log?.('pfp-checkout', 'CREATED', `${session.id} for lead ${lead.id} ${toAmount(amount, opts.currency)}`);
  return { session, lead };
}

/**
 * Turn a paid Checkout Session into a booking.
 *
 * Called from the webhook. Safe to call repeatedly: Stripe delivers the same
 * event more than once, and an agent may replay it.
 *
 * @returns {object} { booking, lead, alreadyDone }
 */
export async function fulfilCheckoutSession(deps, session) {
  const { query, log } = deps;
  const leadId = session?.metadata?.lead_id;
  if (!leadId) {
    // Not ours, or created outside this flow. Say so rather than guessing.
    log?.('pfp-checkout', 'NO_LEAD', `session ${session?.id} carried no lead_id`);
    return { skipped: 'no lead_id in metadata' };
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    return { skipped: `payment_status is ${session.payment_status}, not paid` };
  }

  const { rows: leadRows } = await query('SELECT * FROM public.pfp_leads WHERE id = $1', [leadId]);
  const lead = leadRows[0];
  if (!lead) {
    log?.('pfp-checkout', 'NO_LEAD_ROW', `metadata named lead ${leadId}, which does not exist`);
    return { skipped: `lead ${leadId} not found` };
  }

  // One booking per lead. The unique index is the real guard; this check only
  // saves a pointless second query.
  const { rows: existing } = await query(
    'SELECT * FROM public.pfp_bookings WHERE lead_id = $1', [leadId]);
  if (existing.length) {
    await linkPaymentToBooking(deps, { leadId, booking: existing[0], session });
    return { booking: existing[0], lead, alreadyDone: true };
  }

  const amountCents = session.amount_total ?? session.amount_subtotal ?? null;
  const currency = session.currency || 'usd';

  // Only what the lead actually states. `event_type` is NOT promoted into
  // event_name: "Wedding" is not the name of a wedding.
  //
  // No lead carries an event name - only 4 of 28 have a company name, and a
  // company is not an event - so at the owner's direction the client's name is
  // used as a stand-in rather than leaving the field blank. It is flagged, so
  // "Meagan VanHoy" in the event column is never later read as the name of her
  // wedding. A stand-in that is marked can be corrected; one that is not marked
  // becomes a fact.
  const eventName = lead.event_name ?? null;
  const eventNameIsPlaceholder = !eventName;
  const eventNameValue = eventName || lead.contact_name || null;

  const { rows: bookingRows } = await query(
    `INSERT INTO public.pfp_bookings
       (lead_id, client_name, client_email, client_phone, event_name, event_name_is_placeholder,
        event_type, event_date, venue, address, total_fee, deposit_paid, status, addons, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'confirmed','[]',$13)
     ON CONFLICT (lead_id) WHERE lead_id IS NOT NULL DO UPDATE
       SET deposit_paid = GREATEST(COALESCE(public.pfp_bookings.deposit_paid,0), EXCLUDED.deposit_paid)
     RETURNING *`,
    [
      lead.id,
      lead.contact_name || null,
      lead.contact_email || null,
      lead.contact_phone || null,
      eventNameValue,
      eventNameIsPlaceholder,
      lead.event_type || null,
      lead.event_date || null,
      lead.venue_name || null,
      lead.venue_address || null,
      amountCents !== null ? (Number(amountCents) / 100).toFixed(2) : null,
      amountCents !== null ? (Number(amountCents) / 100).toFixed(2) : null,
      `paid via Stripe session ${session.id}` +
        (eventNameIsPlaceholder ? ' | event_name is the client name as a stand-in; no event name was stated' : ''),
    ]
  );
  const booking = bookingRows[0];

  await query(
    `UPDATE public.pfp_leads SET status = 'booked', updated_at = NOW() WHERE id = $1`, [lead.id]);
  await linkPaymentToBooking(deps, { leadId, booking, session });

  log?.('pfp-checkout', 'BOOKED', `lead ${lead.id} -> booking ${booking.id} ${toAmount(amountCents, currency)}`);
  return { booking, lead, alreadyDone: false };
}

/**
 * Point the payment row at the booking it paid for.
 *
 * `pfp_payments.booking_id` existed and was never written. A payment with no
 * booking reference is why this could not be reconciled by hand either.
 */
export async function linkPaymentToBooking(deps, { leadId, booking, session }) {
  const { query } = deps;
  const chargeId = typeof session?.payment_intent === 'string' ? session.payment_intent : null;
  const stripePaymentIntent = session?.payment_intent?.id || chargeId;
  if (!stripePaymentIntent) return null;

  const { rows } = await query(
    `UPDATE public.pfp_payments
        SET booking_id = $2, updated_at = NOW()
      WHERE stripe_payment_intent_id = $1
      RETURNING id, stripe_charge_id, booking_id`,
    [stripePaymentIntent, booking.id]
  );
  if (rows.length) return rows[0];

  // No payment row yet - charge.succeeded has not landed. Create it, so the
  // money is on record even if this session arrived first.
  const { rows: made } = await query(
    `INSERT INTO public.pfp_payments
       (stripe_charge_id, stripe_payment_intent_id, amount, currency, status,
        client_name, client_email, description, receipt_url, booking_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,'succeeded',$5,$6,$7,$8,$9,$10, to_timestamp($11))
     ON CONFLICT (stripe_charge_id) WHERE stripe_charge_id IS NOT NULL DO UPDATE SET booking_id = EXCLUDED.booking_id
     RETURNING id, stripe_charge_id, booking_id`,
    [
      `session_${session.id}`,
      stripePaymentIntent,
      ((session.amount_total ?? 0) / 100).toFixed(2),
      String(session.currency || 'usd'),
      session.customer_details?.name || session.customer_email || null,
      session.customer_details?.email || session.customer_email || null,
      `PFP booking ${booking.id}`,
      null,
      booking.id,
      JSON.stringify({ lead_id: leadId, checkout_session: session.id }),
      Math.floor((session.created || Date.now() / 1000)),
    ]
  );
  return made[0] || null;
}
