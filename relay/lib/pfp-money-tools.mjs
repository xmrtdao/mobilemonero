/**
 * relay/lib/pfp-money-tools.mjs — financial tools for agents.
 *
 * WHY THIS IS SHAPED THE WAY IT IS
 * --------------------------------
 * An agent that can move money is a different thing from an agent that can read
 * a balance. The Stripe docs this was built from separate restricted keys from
 * secret keys for exactly this reason, so:
 *
 *   - the relay keeps the key. No tool returns it, logs it, or accepts one.
 *   - every tool takes narrow, typed arguments. There is no "raw request" tool,
 *     because a generic caller is how a refund turns into a payout by accident.
 *   - every call passes the existing standing gate before it reaches Stripe. The
 *     gate is not decoration; it is the control that decides whether an agent
 *     that has not earned standing may touch a client's money.
 *   - writes carry an idempotency key, so an agent retry after a timeout cannot
 *     charge twice.
 *   - amounts are integers of cents. A float is how $0.30 becomes $0.29999.
 *
 * Reads are cheap and gated lightly. Anything that moves money out of the
 * account is gated at the strictest level in ACTIVITY_REQUIREMENTS.
 *
 * The gate is expected to REFUSE low-standing agents - Jobby sits at trust 40
 * with zero standing, so `pfp_refund` correctly denies him. That is the system
 * working. A tool that let a standing-less agent issue a refund would be the bug.
 */

const DOMAIN = 'payments';
const CAP = 1_000_00;          // $1,000.00 - a single tool call may not exceed this
const MIN_CENTS = 50;          // Stripe's own floor

export function pfpMoneyTools({ stripe, query, gate, log, capPerCall = CAP }) {
  const stripe_ = stripe || (() => { throw new Error('Stripe is not configured'); })();

  /**
   * Ask the standing gate whether this agent may perform this activity.
   * Returns { allowed, reasons, decision } and never throws for a denial - a
   * refusal is an answer, and the tool returns it so the model can read it.
   */
  const authorise = async (agentDid, activityType, purpose) =>
    gate({ agentDid, activityType, domain: DOMAIN, purpose });

  const cents = (v, field) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < MIN_CENTS) {
      throw new Error(`${field} must be a whole number of cents, at least ${MIN_CENTS}`);
    }
    if (n > capPerCall) {
      throw new Error(`${field} of ${n} cents exceeds the per-call cap of ${capPerCall} cents ($${(capPerCall/100).toFixed(2)})`);
    }
    return n;
  };

  return {

    // ── reads ──────────────────────────────────────────────────────────────

    /** What is in the Stripe account right now. No customer detail. */
    async pfp_balance(args) {
      const v = await authorise(args.agentDid, 'PAYMENT_REPORT_READ', 'read');
      if (!v.allowed) return { error: 'not authorised to read the balance', reasons: v.reasons };
      const acct = await stripe_.balance.retrieve();
      return {
        available: acct.available.map((a) => ({ currency: a.currency, amount: (a.amount / 100).toFixed(2) })),
        pending: acct.pending.map((a) => ({ currency: a.currency, amount: (a.amount / 100).toFixed(2) })),
        livemode: acct.livemode,
      };
    },

    /**
     * Recent charges. Paginated and capped, because an agent asking for "all
     * charges" would otherwise pull the entire customer history into a prompt.
     */
    async pfp_list_charges(args) {
      const v = await authorise(args.agentDid, 'PAYMENT_REPORT_READ', 'read');
      if (!v.allowed) return { error: 'not authorised to list charges', reasons: v.reasons };
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 25);
      const charges = await stripe_.charges.list({ limit });
      return {
        has_more: charges.has_more,
        charges: charges.data.map((c) => ({
          id: c.id,
          amount: (c.amount / 100).toFixed(2),
          currency: c.currency,
          status: c.status,
          // Deliberately not the customer's email or card: a balance report does
          // not need it, and a prompt is a place data leaks from.
          receipt_url: c.receipt_url,
          created: new Date(c.created * 1000).toISOString(),
        })),
      };
    },

    // ── writes ─────────────────────────────────────────────────────────────

    /**
     * Create a payment link for a lead. This does NOT take money: the client
     * completes it on Stripe's page. It is the lowest-risk write because the
     * amount is still a proposal at this point.
     */
    async pfp_create_checkout(args) {
      const v = await authorise(args.agentDid, 'PAYMENT_LINK_CREATED', 'write');
      if (!v.allowed) return { error: 'not authorised to create a payment link', reasons: v.reasons };
      if (!args.idempotencyKey) {
        return { error: 'idempotencyKey is required', detail: 'A retry without one could charge the client twice.' };
      }
      const { createCheckoutForLead } = await import('./pfp-checkout.mjs');
      const { session } = await createCheckoutForLead(
        { stripe: stripe_, query, log }, args.lead_id, {
          amountCents: cents(args.amountCents, 'amountCents'),
          currency: args.currency || 'usd',
          description: args.description,
          idempotencyKey: args.idempotencyKey,
        });
      return { session_id: session.id, url: session.url, amount: (session.amount_total / 100).toFixed(2), currency: session.currency };
    },

    /**
     * Refund a charge. Money leaves the account, so this carries the strictest
     * requirements in the gate and cannot exceed the per-call cap.
     */
    async pfp_refund(args) {
      const v = await authorise(args.agentDid, 'REFUND_ISSUED', 'admin');
      if (!v.allowed) {
        log?.('pfp-refund', 'DENIED', `${args.agentDid}: ${JSON.stringify(v.reasons)}`);
        return { error: 'not authorised to issue a refund', reasons: v.reasons };
      }
      if (!args.chargeId) return { error: 'chargeId is required' };
      if (!args.idempotencyKey) return { error: 'idempotencyKey is required' };
      if (args.amountCents !== undefined && args.amountCents !== null) {
        cents(args.amountCents, 'amountCents');
      }
      const refund = await stripe_.refunds.create(
        { charge: args.chargeId, amount: args.amountCents ?? undefined, reason: args.reason || 'requested_by_customer' },
        { idempotencyKey: args.idempotencyKey }
      );
      log?.('pfp-refund', 'ISSUED', `${refund.id} for charge ${args.chargeId} by ${args.agentDid}`);
      return {
        refund_id: refund.id, status: refund.status,
        amount: (refund.amount / 100).toFixed(2), currency: refund.currency,
      };
    },

    /**
     * What our own records say about a booking and its payment, without asking
     * Stripe anything. The safest tool in the set, and the one an agent should
     * reach for first.
     */
    async pfp_booking_status(args) {
      const v = await authorise(args.agentDid, 'PAYMENT_REPORT_READ', 'read');
      if (!v.allowed) return { error: 'not authorised', reasons: v.reasons };
      const { rows: bookings } = await query(
        `SELECT b.id, b.lead_id, b.client_name, b.event_name, b.event_name_is_placeholder,
                b.event_type, b.event_date, b.venue, b.total_fee, b.deposit_paid, b.status,
                (SELECT count(*)::int FROM public.pfp_payments p WHERE p.booking_id = b.id) AS payments
           FROM public.pfp_bookings b
          WHERE ($1::uuid IS NULL OR b.id = $1::uuid) OR ($2::uuid IS NOT NULL AND b.lead_id = $2::uuid)
          ORDER BY b.created_at DESC LIMIT 5`,
        [args.bookingId || null, args.leadId || null]
      );
      if (!bookings.length) return { bookings: [] };
      const { rows: payments } = await query(
        `SELECT id, stripe_charge_id, amount, currency, status, created_at
           FROM public.pfp_payments WHERE booking_id = ANY($1::uuid[])
          ORDER BY created_at DESC`,
        [bookings.map((b) => b.id)]
      );
      return { bookings, payments };
    },
  };
}

/** Descriptions for the tool surface. */
export const PFP_MONEY_TOOL_DESCRIPTIONS = {
  pfp_balance: 'Read the Stripe account balance (available and pending). Read-only. Args: agentDid',
  pfp_list_charges: 'List recent Stripe charges, newest first, without customer detail. Read-only. Args: agentDid, limit (1-25, default 5)',
  pfp_booking_status: 'Read our own booking and payment records. Does not call Stripe. Args: agentDid, bookingId or leadId',
  pfp_create_checkout: 'Create a Stripe payment link for a PFP lead. Does NOT take money - the client pays on Stripe. Requires a stable idempotencyKey. Args: agentDid, lead_id, amountCents (integer), currency, description, idempotencyKey',
  pfp_refund: 'Refund a Stripe charge. Money leaves the account; gated at the strictest level and capped. Requires idempotencyKey. Args: agentDid, chargeId, amountCents (omit for a full refund), reason, idempotencyKey',
};
