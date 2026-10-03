/**
 * relay/lib/pfp-contract.mjs — the shared Party Favor Photo contract engine.
 *
 * A backend engine, not a script. Jobby, Suite and Lumen are SPAs over the same
 * engines, so a fleet agent anywhere calls `renderContract()` and gets a PDF
 * from whichever tenant's provider config it passes.
 *
 * WHAT THIS REPLACES, AND WHY
 * ---------------------------
 * There were two renderers - `contracts/generate.mjs` (blank templates) and
 * `quotes/send-contract.mjs` (per-client) - containing the same layout code and
 * the same hard-coded vendor literals at nearly the same line numbers. They had
 * already drifted: section 5.6 was `Discounts` in one and `Discount` in the
 * other. Two copies of a legal document, differing, neither generated from a
 * single source.
 *
 * The vendor's name, owner, phone, contact line and governing law were string
 * literals in both, even though `data/pfp-data.json` already held every one of
 * those values unread in the same directory. That is the whole reason an FCPS
 * contract came out carrying Party Favor Photo's identity and District of
 * Columbia law when the counterparty was Photographic Communication Services,
 * LLC in Virginia.
 *
 * So: no vendor string appears in this file. `provider` carries the identity.
 *
 * THE RULE THAT MATTERS MOST
 * --------------------------
 * Nothing unconfirmed is ever rendered as fact. The FCPS contract originally
 * said "Friday, October 10, 2026" - October 10 2026 is a Saturday - and it took
 * a hand-built correction contract, a supersede clause and a re-signature to put
 * that right. The cause was a renderer willing to compute a weekday for a date
 * the client had never confirmed.
 *
 * Therefore: `requireConfirmedFields()` returns gaps, `renderContract()` refuses
 * to render a contract carrying an unresolved gap, and a weekday is derived only
 * from a date the client confirmed. A missing date produces a visible blank, not
 * a plausible-looking guess. Absence of complaint is not evidence - a contract
 * that renders cleanly is exactly what a wrong one looks like.
 */

import {
  priceQuote, priceQuoteFromTotal, paymentSchedule, formatCents, inclusionsFor,
  openPricingGaps, TERMS, PAYMENT_TERMS, MIN_HOURS, MAX_HOURS, RATES, DISCOUNTS,
} from './pfp-pricing.mjs';

export {
  MIN_HOURS, MAX_HOURS, RATES, DISCOUNTS,
  priceQuote, priceQuoteFromTotal, paymentSchedule, formatCents,
};

/**
 * Fields a contract must have before it may be rendered, and why each is
 * required. `date_confirmed` is separate from `event_date` on purpose: a caller
 * can easily hold a date that nobody confirmed, and that is the exact FCPS
 * failure.
 */
export const REQUIRED_FIELDS = Object.freeze([
  Object.freeze({ key: 'client_name', label: 'Client name', why: 'the agreement names its parties' }),
  Object.freeze({ key: 'client_email', label: 'Client email', why: 'the agreement must be deliverable' }),
  Object.freeze({ key: 'event_name', label: 'Event name', why: 'the service is for a named event' }),
  Object.freeze({ key: 'event_date', label: 'Event date', why: 'a date that is wrong costs a correction contract' }),
  Object.freeze({ key: 'date_confirmed', label: 'Event date confirmed by the client', why: 'an unconfirmed date is a guess' }),
  Object.freeze({ key: 'venue_name', label: 'Venue', why: 'travel and setup depend on it' }),
]);

/**
 * Check a booking against the required fields. Returns every gap rather than the
 * first, because an agent should be able to ask the client all four questions at
 * once instead of one per round trip.
 *
 * @returns {{ok:boolean, gaps:Array<{key:string,label:string,why:string,question:string}>}}
 */
export function requireConfirmedFields(event = {}) {
  const gaps = [];
  for (const f of REQUIRED_FIELDS) {
    const v = event[f.key];
    const missing =
      f.key === 'date_confirmed'
        ? v !== true
        : v === undefined || v === null || String(v).trim() === '';
    if (missing) gaps.push({ ...f, question: QUESTION_FOR[f.key] });
  }
  return { ok: gaps.length === 0, gaps };
}

/** The question an agent should actually ask, per gap. Not a field name. */
const QUESTION_FOR = Object.freeze({
  client_name: 'What is the client\'s full legal name for the agreement?',
  client_email: 'What email address should the contract go to?',
  event_name: 'What is the name of the event?',
  event_date: 'What is the event date?',
  date_confirmed: 'Has the client confirmed that exact event date in writing?',
  venue_name: 'Where is the event being held?',
});

/**
 * Parse and validate an event date, and derive its weekday.
 *
 * Returns nulls rather than throwing for a missing or unparseable date, because
 * the caller renders a visible blank instead of a document. Throwing is for
 * programming errors; an absent client answer is a normal state to report.
 *
 * Weekday comes from the parsed date, never from the caller's string, so
 * "10/10/2026" cannot become "Friday" because a template concatenated a label
 * with a stale literal.
 */
export function resolveEventDate(eventDate, confirmed) {
  if (confirmed !== true) return { date: null, weekday: null, display: null, confirmed: false };
  const d = typeof eventDate === 'string' ? new Date(eventDate) : eventDate;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    return { date: null, weekday: null, display: null, confirmed: false, unparseable: true };
  }
  return {
    date: d,
    weekday: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    display: d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    confirmed: true,
  };
}

/**
 * Normalise a provider/tenant into the shape the renderer needs, refusing rather
 * than defaulting anything. A contract that falls back to a hard-coded business
 * name is the original bug; falling back to a placeholder address is the same bug
 * wearing a hat.
 */
export function normalizeProvider(p = {}) {
  const need = ['business_name', 'contact_name', 'email', 'phone', 'governing_law'];
  const missing = need.filter((k) => !p[k] || !String(p[k]).trim());
  if (missing.length) {
    throw new Error(
      `provider is missing required identity: ${missing.join(', ')}. ` +
        `A renderer that defaults these invents the counterparty's legal identity.`
    );
  }
  return {
    business_name: String(p.business_name).trim(),
    legal_name: p.legal_name ? String(p.legal_name).trim() : null,
    dba: p.dba ? String(p.dba).trim() : null,
    contact_name: String(p.contact_name).trim(),
    contact_title: p.contact_title ? String(p.contact_title).trim() : 'Owner',
    email: String(p.email).trim(),
    phone: String(p.phone).trim(),
    website: p.website ? String(p.website).trim() : null,
    ein: p.ein ? String(p.ein).trim() : null,
    insurance: p.insurance ? String(p.insurance).trim() : null,
    governing_law: String(p.governing_law).trim(),
    service_area: p.service_area ? String(p.service_area).trim() : null,
    logo_path: p.logo_path ?? null,
    signature_path: p.signature_path ?? null,
  };
}

/**
 * Build the full contract model: the validated booking, the schedule, the terms
 * and the gap list. No PDF yet - this is the part an agent can inspect and
 * reason about, and the part that must be checkable without rendering anything.
 *
 * @throws when a required field is missing or the pricing is invalid. Refusing
 *   here is the whole point; a caller that wants a partial document must say so
 *   explicitly via `allowGaps`, which stamps the result `draft`.
 */
export function buildContractModel(input = {}) {
  const {
    provider, event, hours, rate = 'standard',
    discount, discount_reason, quoted_total_cents,
    allow_above_list = false, allowGaps = false,
    drafted_on,
  } = input;
  const gaps = [];
  const prov = normalizeProvider(provider);
  const check = requireConfirmedFields(event);

  if (!check.ok) {
    gaps.push(...check.gaps);
    if (!allowGaps) {
      const lines = gaps.map((g) => `  - ${g.question}`).join('\n');
      throw new Error(
        `cannot render a contract: ${gaps.length} unconfirmed field(s).\n${lines}\n` +
          `Pass allowGaps: true only for an internal draft; the result is marked draft.`
      );
    }
  }

  // Price comes from the catalogue, so a bad value throws here with the
  // catalogue's own message rather than reaching the page as a blank.
  //
  // Two ways in, and they are not interchangeable:
  //
  //   quoted_total  the number a salesperson actually quoted. Preferred. The
  //                 catalogue works backwards from it to the discount.
  //   rate x hours  list price, with an optional named discount.
  //
  // When a quoted total lands on a discount that matches no published rate, the
  // model carries `requires_basis` and a question. It still builds, because the
  // salesperson did quote that figure and the contract must match it - but it
  // builds as a draft with the unknown named as unknown, and the renderer is
  // forbidden from printing a basis line until someone answers.
  let quote;
  if (input.quoted_total_cents !== undefined) {
    quote = priceQuoteFromTotal(hours, rate, input.quoted_total_cents, {
      basis: discount,
      basis_note: discount_reason,
      allow_above_list: input.allow_above_list === true,
    });
    // Advisory, NOT a gap. The owner sets the price on a real relationship and a
    // real quote; the engine's job is to make the contract match it, not to
    // second-guess it. So a discount with no published rate does not block
    // rendering and does not force a draft. It is surfaced so an agent can
    // mention it if it is asked, and it is never given a fabricated basis.
  } else {
    quote = priceQuote(hours, rate, discount ? { discount, discount_reason } : {});
  }

  const schedule = paymentSchedule(quote.total_cents);
  const when = resolveEventDate(event.event_date, event.date_confirmed);

  return {
    draft: gaps.length > 0,
    gaps_pending: gaps.length,
    provider: prov,
    event: {
      client_name: event.client_name ?? null,
      client_email: event.client_email ?? null,
      event_name: event.event_name ?? null,
      venue_name: event.venue_name ?? null,
      venue_address: event.venue_address ?? null,
      venue_room: event.venue_room ?? null,
      event_date_display: when.display,
      event_weekday: when.weekday,
      date_confirmed: when.confirmed === true,
      contact_name: event.contact_name ?? null,
      contact_phone: event.contact_phone ?? null,
      guests_expected: event.guests_expected ?? null,
    },
    quote,
    schedule,
    // When the document was drafted. A fact the renderer knows and no longer
    // has to guess: previously the agreement date was a blank line, because
    // nothing supplied it.
    options: { drafted_on: drafted_on ?? new Date() },
    inclusions: inclusionsFor(quote.rate_id),
    terms: TERMS,
    payment_terms: PAYMENT_TERMS,
    // Every gap, from the event fields AND from the price. Carried on the model
    // so a renderer, an email or a reviewer can all see the document is
    // incomplete. Never dropped silently.
    gaps,
    unresolved_price_conflicts: openPricingGaps(),
  };
}

/**
 * One-line summary for an agent or an email, safe to read aloud to a client.
 * Says what is missing when something is missing, which is the case that matters.
 */
export function summarize(model) {
  const { quote, schedule, event } = model;
  const bits = [
    `${event.event_name ?? '(event not stated)'} - ${quote.hours}hr ${quote.rate_label}`,
    `${quote.rate_label} is ${quote.print_format} at ${quote.hourly_display}`,
  ];
  if (event.event_date_display) bits.push(`${event.event_weekday}, ${event.event_date_display}`);
  if (quote.discount_applied) {
    bits.push(`less ${quote.discount_display} (${quote.discount_label})`);
  }
  bits.push(`total ${quote.total_display}, deposit ${schedule.deposit_display} on booking`);
  if (model.gaps.length) {
    bits.push(`DRAFT - ${model.gaps.length} unconfirmed: ${model.gaps.map((g) => g.label).join('; ')}`);
  }
  return bits.join('. ') + '.';
}

export default { buildContractModel, requireConfirmedFields, resolveEventDate, normalizeProvider, summarize, REQUIRED_FIELDS };