/**
 * relay/lib/pfp-pricing.mjs — the Party Favor Photo contract pricing catalogue.
 *
 * WHY THIS IS DATA AND NOT CONSTANTS
 * ----------------------------------
 * `generate.mjs` and `quotes/send-contract.mjs` both hard-coded the vendor's
 * name, the owner's name, the phone number, the contact line and the governing
 * law as string literals, even though `data/pfp-data.json` already held every
 * one of those values unread in the same directory. Two copies of a legal
 * document that had already drifted from each other. So the numbers and the
 * terms live here and the renderer reads them.
 *
 * THE MODEL
 * ---------
 * Price is one thing: hours, at an hourly rate chosen by print size.
 *
 *     3+ hours at $249/hr   Standard   2x6 photo booth strips
 *     3+ hours at $349/hr   Premium    4x6 full-size photo cards
 *
 * Standard and Premium differ ONLY in the print size the guest takes home.
 * Everything else in the service is identical, which is why they share one
 * inclusions list and differ on a single line. There is no third tier.
 *
 * A flat $100 discount exists as a discretionary lever an agent may apply to
 * close a deal. It is deliberately NOT a tier: it is not quoted by default, it
 * does not appear in the rate card, and it never silently changes a price. One
 * per booking, claimed at deposit.
 *
 * THE PRICE LISTS THAT USED TO CONFLICT
 * --------------------------------------
 * Four documents disagreed about a discounted 3-hour booking, and the fourth
 * was invented during this work. Rather than pick a winner quietly, each is
 * recorded in KNOWN_PRICE_CONFLICTS below. None of them is load-bearing any
 * more, because the basic structure is hours x rate with no discount tier.
 *
 * MINOR AND ROUNDED CENTS
 * -----------------------
 * Integer cents throughout. A float of $249.00 is 248.99999999 somewhere, and a
 * contract that disagrees with an invoice by a cent is a contract nobody trusts.
 */

/** US dollars. */
export const CURRENCY = 'usd';

/**
 * The two hourly rates. Print size is the only difference between them.
 *
 * `hourly_cents` is the stated commercial position, so a quote derived from it
 * is marked `derived: true` and the agent can see it was computed rather than
 * read from a published package list.
 */
export const RATES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    label: 'Standard',
    hourly_cents: 24900,
    print_format: '2x6 photo strips',
    print_note: 'Unlimited 2x6 photo booth strips for all guests.',
  }),
  premium: Object.freeze({
    id: 'premium',
    label: 'Premium',
    hourly_cents: 34900,
    print_format: '4x6 photo cards',
    print_note: 'Unlimited full-size 4x6 photo cards for all guests.',
  }),
});

/**
 * Minimum and maximum hours.
 *
 * TWO HOURS MINIMUM, as stated. Worth noting why, because three hours looked
 * reasonable and would have been wrong: four independent sources already offer a
 * two-hour booking - the published price list, AGENTS.md's pricing table,
 * `pfp-data.json`'s live `stripeLinks["2"]` checkout, and the two signed
 * `PFP-2hr-*-Contract.pdf` templates on disk. A three-hour minimum would have
 * refused to contract a booking we could already take money for.
 */
export const MIN_HOURS = 2;
export const MAX_HOURS = 6;

/**
 * The discretionary discount. Flat, capped, one per booking.
 *
 * Flat $100 off is stated three times over: AGENTS.md's QC checklist
 * ("flat $100 max (not percentage-based)"), AGENTS.md section 5.6, and
 * `pfp-data.json`'s `maxDiscount: 100`. Two renderers' own term text agrees.
 *
 * `reason` is required when a discount is applied. An agent may offer it, but a
 * $100 reduction with no stated basis on a signed document is the kind of line
 * item that gets questioned after the fact.
 */
export const DISCOUNTS = Object.freeze({
  // PUBLISHED RATES. 20% off, which reproduces the "military" column in
  // relay-data/pfp-contracts-README.md exactly - every published figure is 80% of
  // standard, rounded to the dollar:
  //     2hr  $498 x 0.80 = $398.40 -> $398        README $398
  //     3hr  $747 x 0.80 = $597.60 -> $598        README $598
  //     4hr  $996 x 0.80 = $796.80 -> $796        README $796
  //     5hr $1,245 x 0.80 = $996.00 -> $996       README $996
  //     6hr $1,494 x 0.80 = $1,195.20 -> $1,195  README $1,195
  //
  // The Fairfax County Public Schools event on 2026-10-10 was quoted $747 less
  // 20% = $598, matching the column and NOT matching the flat-$100 rule. The
  // signed contract said $599; $599 was the error, the price list was right.
  //
  // PERCENTAGE, NOT FLAT. AGENTS.md's QC checklist insists the discount is "flat
  // $100 max (not percentage-based)" and pfp-data.json carries maxDiscount: 100.
  // That rule yields $647 here, not $598. Both rules are written down and they
  // differ by $49; see KNOWN_PRICE_CONFLICTS.
  school: Object.freeze({
    id: 'school', label: 'School / Education', kind: 'percent', percent_off: 20,
    on_rate_card: true, max_per_booking: 1, claimable_at: 'deposit',
  }),
  military: Object.freeze({
    id: 'military', label: 'Military', kind: 'percent', percent_off: 20,
    on_rate_card: true, max_per_booking: 1, claimable_at: 'deposit',
  }),
  // A NAMED discount with NO STATED VALUE. Refuses rather than defaulting:
  // guessing a percentage puts money on a signed document with no basis for it.
  pay_in_full: Object.freeze({
    id: 'pay_in_full', label: 'Pay-in-Full', kind: 'unpriced',
    value_not_stated:
      'Pay-in-Full is named as a discount type in AGENTS.md and pfp-data.json but ' +
      'no value is stated anywhere. It refuses rather than assuming it matches ' +
      'the School rate.',
    on_rate_card: false, max_per_booking: 1, claimable_at: 'deposit',
  }),
  // DISCRETIONARY. The flat $100 an agent may apply to close a deal. Never
  // quoted by default, never on the rate card.
  negotiated: Object.freeze({
    id: 'negotiated', label: 'Negotiated - closing a deal', kind: 'flat', cents_off: 10000,
    discretionary: true, on_rate_card: false, max_per_booking: 1, claimable_at: 'deposit',
  }),
});

/**
 * The published discounted matrix, reproduced rather than recomputed. Kept so the
 * engine can be checked against the business's own price list instead of against
 * its own arithmetic - that check has already caught one wrong rule.
 *
 * The 4-hour entry is $796, which TRUNCATES 0.80 x $996 where rounding gives
 * $797. The published column is inconsistent by $1 there. Reproduced as
 * published; the inconsistency is recorded rather than quietly smoothed.
 */
export const PUBLISHED_DISCOUNTED = Object.freeze({
  2: 39800, 3: 59800, 4: 79600, 5: 99600, 6: 119500,
});

/**
 * The label for a reduction that matches no published rate.
 *
 * "Owner-authorized Discount", by the owner's instruction. It states who
 * authorised the reduction, which is the part that is actually true and the part
 * a client would ask about. It does not claim a category - School, Military,
 * Pay-in-Full - that nobody selected, which is the failure mode that produced a
 * contract asserting a justification the business never gave.
 */
export const OWNER_AUTHORIZED_LABEL = 'Owner-authorized Discount';

/** Every bookable duration, as integers, for a rate card or a picker. */
export const DURATIONS = Object.freeze([2, 3, 4, 5, 6]);

/**
 * What every guest receives. Identical across tiers except the print line,
 * which comes from the rate. Kept as one list so the two tiers cannot drift
 * into promising materially different services.
 */
export const INCLUSIONS = Object.freeze([
  'Professional StudioStation with bounce-diffused strobe lighting',
  'Professional DSLR cameras for editorial-quality photos',
  'Custom branded photo templates matching the event aesthetic',
  'Digital photo delivery to all guests via QR code and SMS text',
  'Professional attendant present for all booked hours',
  'Full setup and breakdown at the designated location',
  'Sequin and custom backdrop options',
  'AI watercolor portrait generation where applicable',
  'Custom props and accessories themed to the event',
  'Online gallery hosting every photo captured',
  'Social media sharing station with hashtag integration',
]);

/**
 * Payment terms. Fifty per cent at booking, balance seven days out.
 * Data, not code, because this is a commercial decision.
 */
export const PAYMENT_TERMS = Object.freeze({
  deposit_percent: 50,
  deposit_due: 'upon booking',
  balance_due: 'seven (7) days before the Event Date',
});

export const TERMS = Object.freeze([
  'Services. The Provider will deliver a professional StudioStation photo booth ' +
    'with an attendant, lighting, backdrop, and digital delivery for the hours ' +
    'booked, at the location designated by the Client.',
  'Payment. Fifty per cent (50%) of the Total Fee is due upon booking. The ' +
    'remaining balance is due seven (7) days before the Event Date.',
  'Cancellation and Rescheduling. The Provider will accommodate a reschedule ' +
    'with reasonable notice. Cancellations inside seven (7) days of the Event ' +
    'Date may forfeit the deposit, as that date is when the balance is due.',
  'Client Responsibilities. The Client will ensure venue access, power, and a ' +
    'defensible location for the booth, and will confirm the Event Date and ' +
    'hours in writing before the Event Date.',
  'Indemnity and Limitation of Liability. Each party is responsible for its own ' +
    'acts. The Provider is not liable for events outside its control, including ' +
    'venue access and power failure.',
  'General. This Agreement is the entire agreement between the parties. ' +
    'Amendments must be in writing and signed by both parties. A corrected ' +
    'agreement that states it supersedes and replaces a prior one in full is ' +
    'effective on its stated date without further signature.',
  'Acceptance. By signing, the Client accepts this Agreement and confirms the ' +
    'Event details, the Total Fee, and the payment schedule above.',
]);

/**
 * Unresolved disagreements in the business's own paperwork. Reported, never
 * silently reconciled: picking one number here would be choosing a commercial
 * position on the owner's behalf.
 */
export const KNOWN_PRICE_CONFLICTS = Object.freeze([
  Object.freeze({
    kind: 'flat_versus_percentage_discount',
    status: 'resolved_in_favour_of_the_percentage',
    detail:
      'AGENTS.md section 5.6, its QC checklist ("flat $100 max, not ' +
      'percentage-based") and pfp-data.json maxDiscount:100 all describe a flat ' +
      '$100. The README price column and the owner both say otherwise: a school ' +
      'event quoted at $598 off a $747 list is 20%, not $100. The two rules ' +
      'differ by $49 on a 3-hour booking. Resolved in favour of the percentage ' +
      'because the owner confirmed the $598 figure directly. AGENTS.md still ' +
      'describes the flat rule and has not been updated.',
  }),
  Object.freeze({
    kind: 'four_hour_column_rounding',
    detail:
      'The published discounted column reads $796 at 4 hours where 0.80 x $996 ' +
      'is $796.80 and rounds to $797. The column truncates there while rounding ' +
      'everywhere else. Reproduced as published rather than smoothed, so this ' +
      'engine agrees with the price list a client was shown.',
  }),
  Object.freeze({
    kind: 'signed_contract_off_by_one_dollar',
    status: 'resolved',
    detail:
      'FCPS-Corrected-Contract-Oct10-2026.pdf billed $599.00 for a 3-hour ' +
      'booking. The published column says $598.00. The owner confirms $598 is ' +
      'correct, so the signed figure was the error. Worth noting that this ' +
      'contract was corrected once already; the corrected document carried the ' +
      'wrong price.',
  }),
]);

/**
 * Price a booking: hours x hourly rate, optionally less one flat discount.
 *
 * Strict on input. `Number("3")` is 3 and `Number("")` is 0, so a lenient parse
 * would turn a malformed field into a plausible quantity, and a quantity becomes
 * money on a signed document.
 *
 * @param {number} hours  integer, MIN_HOURS to MAX_HOURS (currently 2-6)
 * @param {string} rateId 'standard' | 'premium'
 * @param {{discount?: boolean, discount_reason?: string}} [opts]
 * @returns {{hours:number, rate_id:string, rate_label:string, currency:string,
 *   hourly_cents:number, hourly_display:string, subtotal_cents:number,
 *   subtotal_display:string, discount_applied:boolean, discount_cents:number,
 *   discount_display:string, discount_reason:(string|null), total_cents:number,
 *   total_display:string, derived:boolean, print_format:string, print_note:string}}
 */
export function priceQuote(hours, rateId = 'standard', opts = {}) {
  const rate = RATES[rateId];
  if (!rate) {
    throw new Error(
      `unknown rate "${rateId}". Known rates: ${Object.keys(RATES).join(', ')}`
    );
  }
  // Reject the type before the value, and name the type received: "hours must
  // be a number; got string \"3\"" is actionable, "got 3" is not.
  if (typeof hours !== 'number') {
    throw new Error(
      `hours must be a number; got ${typeof hours} ${JSON.stringify(hours)}. ` +
        `A string is not coerced - parse it at the edge that received it.`
    );
  }
  if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
    throw new Error(
      `hours must be a whole number from ${MIN_HOURS} to ${MAX_HOURS} ` +
        `(the booking minimum is ${MIN_HOURS} hours); got ${JSON.stringify(hours)}`
    );
  }

  const subtotal_cents = rate.hourly_cents * hours;
  let discount_cents = 0;
  let discount_id = null;
  let discount_label = null;
  let discount_reason = null;
  let published_match = null;

  if (opts.discount) {
    const d = DISCOUNTS[opts.discount];
    if (!d) {
      throw new Error(
        `unknown discount "${opts.discount}". Known discounts: ` +
          `${Object.keys(DISCOUNTS).join(', ')}`
      );
    }
    // A named discount with no stated value refuses rather than defaulting.
    if (d.kind === 'unpriced') {
      throw new Error(
        `discount "${d.id}" has no stated value. ${d.value_not_stated}`
      );
    }
    // Percentage discounts are applied to the STANDARD price, never to a
    // premium one. The published column is a discount off Standard; letting it
    // apply to Premium would invent a 4x6 school rate nobody has published.
    if (d.kind === 'percent') {
      if (rate.id !== 'standard') {
        throw new Error(
          `discount "${d.id}" applies to Standard only - the published rate is ` +
            `80% of the Standard package. It cannot be applied to ${rate.label}.`
        );
      }
      // Rounded to the DOLLAR, not the cent. Every figure in the published column is a
// whole dollar - $747 x 0.80 is $597.60, and the column says $598. Rounding to
// cents produced $597.60 here and disagreed with the business's own price list
// by forty cents on a signed document.
// Percentage discounts are priced from the PUBLISHED column when there is one,
      // not recomputed from a percentage. The column is the business's own
      // price list; arithmetic that approximates it is how the engine ended up
      // quoting $597.60 where the list says $598, and $797 where it says $796.
      const pub = PUBLISHED_DISCOUNTED[hours];
      if (pub !== undefined) {
        discount_cents = subtotal_cents - pub;
        published_match = formatCents(pub);
      } else {
        // No published figure for this duration: fall back to the percentage,
        // rounded to the whole dollar, because every figure in the column is a
        // whole dollar.
        discount_cents = Math.round(((subtotal_cents * d.percent_off) / 100) / 100) * 100;
      }
    } else {
      discount_cents = Math.min(d.cents_off, subtotal_cents);
    }
    discount_id = d.id;
    discount_label = d.label;

    // A discretionary reduction needs a stated reason. An unexplained gap in a
    // total is what gets questioned after the fact.
    if (d.discretionary) {
      if (typeof opts.discount_reason !== 'string' || !opts.discount_reason.trim()) {
        throw new Error(
          `discount "${d.id}" is discretionary and requires a discount_reason. ` +
            `One per booking, claimed at deposit.`
        );
      }
      discount_reason = opts.discount_reason.trim();
    }
  }

  return {
    ...quoteShape(hours, rate, subtotal_cents, netOf(subtotal_cents, discount_cents)),
    discount_applied: discount_cents > 0,
    discount_cents,
    discount_display: formatCents(discount_cents),
    discount_id,
    discount_label,
    discount_reason,
    published_match,
    mismatch_with_published: null,
  };
}

/**
 * Reverse a quoted total back into a contract price.
 *
 * WHY THIS EXISTS
 * ---------------
 * A salesperson quotes a number. The contract has to say the same number, or the
 * customer signs a document that disagrees with what they were told - which is
 * how FCPS ended up needing a corrected, superseding contract at all. So the
 * engine accepts the quoted total and works out the discount that reaches it.
 *
 * WHY IT IS NOT SIMPLY SUBTRACTION
 * -------------------------------
 * "Quoted $500 for 3hr Standard" is arithmetically a $247 discount, and a
 * generator that renders it silently turns any number into a legitimate-looking
 * contract. So the derived discount is checked against what the business has
 * actually published, and only a match gets a name.
 *
 *     quoted $598, 3hr Standard -> $598 IS the published School rate.
 *                                   Basis identified, safe to print.
 *     quoted $500, 3hr Standard -> matches nothing. The arithmetic is correct
 *                                   but the basis is unknown, so it is returned
 *                                   with requires_basis: true and NO basis name.
 *                                   The caller must ask who authorised it.
 *
 * ANY quoted total is honoured - the owner prices on a real relationship and the
 * contract must match what was quoted. `requires_basis` is advisory: it never
 * blocks a render. It is true when the reduction matches no published rate, and
 * all it does is mark the line as unnamed on the page. Any amount can be
 * contracted; the engine just will not attribute it to a category nobody chose.
 *
 * @param {number} hours        integer, MIN_HOURS to MAX_HOURS
 * @param {string} rateId       'standard' | 'premium'
 * @param {number} quoted_cents the total the salesperson quoted
 * @param {{basis?: string, allow_above_list?: boolean}} [opts]
 */
export function priceQuoteFromTotal(hours, rateId, quoted_cents, opts = {}) {
  // Full validation of hours and rate happens in priceQuote, which is called
  // first so there is exactly one place that decides what a valid booking is.
  const full = priceQuote(hours, rateId);
  const rate = RATES[rateId];

  if (typeof quoted_cents !== 'number' || !Number.isInteger(quoted_cents)) {
    throw new Error(
      `quoted total must be an integer number of cents; got ` +
        `${typeof quoted_cents} ${JSON.stringify(quoted_cents)}`
    );
  }
  if (quoted_cents <= 0) {
    throw new Error(`quoted total must be positive; got ${formatCents(quoted_cents)}`);
  }
  if (quoted_cents > full.subtotal_cents && opts.allow_above_list !== true) {
    // A quote ABOVE list price is a surcharge, not a discount. Guessing at
    // rush-fee, holiday or travel premiums would be inventing a charge.
    throw new Error(
      `quoted ${formatCents(quoted_cents)} is ABOVE the ${full.hourly_display} list ` +
        `price of ${full.subtotal_display} for ${hours}hr ${rate.label}. ` +
        `That is a surcharge, not a discount. Pass allow_above_list: true only ` +
        `with a stated basis.`
    );
  }

  const discount_cents = full.subtotal_cents - quoted_cents;

  // Name the discount only when a published rate produces this exact figure.
  // An exact hit identifies the rate; anything else gets no label, so the
  // renderer prints the amount without inventing a justification.
  const basis = identifyBasis(hours, rateId, discount_cents, quoted_cents, opts.basis);
  const requires_basis = discount_cents > 0 && basis === null;

  return {
    ...full,
    total_cents: quoted_cents,
    total_display: formatCents(quoted_cents),
    quoted_cents,
    discount_applied: discount_cents > 0,
    discount_cents,
    discount_display: formatCents(discount_cents),
    discount_id: basis,
    // What the document calls a reduction matching no published rate: named for
    // who authorised it, which is the part actually true, rather than for a
    // category nobody chose.
    discount_label:
      basis ? DISCOUNTS[basis].label
            : (discount_cents > 0 ? OWNER_AUTHORIZED_LABEL : null),
    discount_reason:
      basis ? DISCOUNTS[basis].label : (opts.basis_note ?? null),
    basis_identified: basis !== null,
    requires_basis,
    requires_basis_question: requires_basis
      ? `${formatCents(discount_cents)} off ${full.subtotal_display} matches no ` +
        `published rate for ${hours}hr ${rate.label}. Who authorised this ` +
        `discount, and on what basis?`
      : null,
    // A quote above list price is flagged, never dressed as a discount.
    surcharge_cents: quoted_cents > full.subtotal_cents
      ? quoted_cents - full.subtotal_cents
      : 0,
  };
}

/**
 * Name the discount only when a published rate produces this exact figure.
 *
 * `opts_hint` is what the caller asserted, used only for the discretionary
 * `negotiated` band since that one has no published column to match. An exact
 * hit against the School/Military column identifies the rate; anything else
 * returns null, which the renderer shows as an unnamed reduction rather than a
 * reason nobody gave.
 */
function identifyBasis(hours, rateId, discount_cents, quoted_cents, opts_hint = null) {
  if (discount_cents <= 0) return null;
  if (rateId !== 'standard') return null;
  const published = PUBLISHED_DISCOUNTED[hours];
  if (published !== undefined && quoted_cents === published) return 'school';
  if (opts_hint === 'negotiated' && discount_cents === DISCOUNTS.negotiated.cents_off) {
    return 'negotiated';
  }
  return null;
}

/** The shared, discount-independent part of a quote. */
function quoteShape(hours, rate, subtotal_cents, total) {
  return {
    hours,
    rate_id: rate.id,
    rate_label: rate.label,
    currency: CURRENCY,
    hourly_cents: rate.hourly_cents,
    hourly_display: formatCents(rate.hourly_cents) + '/hr',
    subtotal_cents,
    subtotal_display: formatCents(subtotal_cents),
    total_cents: total,
    total_display: formatCents(total),
    // True when the total was computed from the rate. Kept visible so a caller
    // can tell a derived price from one read from a published package.
    derived: true,
    print_format: rate.print_format,
    print_note: rate.print_note,
  };
}

const netOf = (subtotal, discount) => subtotal - discount;

/** Cents to "$1,234.50". No floats anywhere in the path. */
export function formatCents(cents) {
  const n = Math.round(Number(cents));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return (
    `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.` +
    `${String(abs % 100).padStart(2, '0')}`
  );
}

/**
 * What is owed now and what is owed later, from the published terms.
 * On an odd-cent total the 50/50 split cannot be exact, so the balance absorbs
 * the extra cent and the two always sum to the total exactly.
 */
export function paymentSchedule(total_cents) {
  const total = Math.round(Number(total_cents));
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`total_cents must be a non-negative integer; got ${JSON.stringify(total_cents)}`);
  }
  const deposit_cents = Math.round(total * PAYMENT_TERMS.deposit_percent) / 100;
  const balance_cents = total - deposit_cents;
  return {
    total_cents: total,
    total_display: formatCents(total),
    deposit_cents,
    deposit_display: formatCents(deposit_cents),
    deposit_due: PAYMENT_TERMS.deposit_due,
    balance_cents,
    balance_display: formatCents(balance_cents),
    balance_due: PAYMENT_TERMS.balance_due,
  };
}

/**
 * The public rate card. Two rows, no discount, because the discount is a
 * discretionary lever and putting it on the card invites it to become expected.
 */
export function priceCard() {
  return Object.values(RATES).map((rate) => ({
    rate_id: rate.id,
    label: rate.label,
    hourly_display: formatCents(rate.hourly_cents) + '/hr',
    print_format: rate.print_format,
    minimum_hours: MIN_HOURS,
    packages: DURATIONS.map((h) => {
      const q = priceQuote(h, rate.id);
      return { hours: h, total_display: q.total_display };
    }),
  }));
}

/** The inclusions for a rate: the shared list plus that rate's print line. */
export function inclusionsFor(rateId = 'standard') {
  const rate = RATES[rateId];
  if (!rate) throw new Error(`unknown rate "${rateId}". Known rates: ${Object.keys(RATES).join(', ')}`);
  return [rate.print_note, ...INCLUSIONS];
}

/**
 * Everything unresolved that a caller must see before rendering a contract.
 * Returned rather than logged, so it cannot be rendered past unseen.
 */
export function openPricingGaps() {
  return KNOWN_PRICE_CONFLICTS.map((c) => ({ kind: c.kind, detail: c.detail }));
}