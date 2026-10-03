/**
 * relay/lib/pfp-lead-contracts.mjs — build a contract from a real lead.
 *
 * THE LEAD IS THE INPUT, AND THE LEAD IS INCOMPLETE
 * ------------------------------------------------
 * `public.pfp_leads` has no duration column, no tier column and no price column.
 * It has event_type, event_date, venue_name, contact details and a notes field.
 * So a lead CANNOT price itself, and the temptation is to fill the gaps:
 * guess 3 hours, guess Standard, guess $598 because that is the number in the
 * notes.
 *
 * That is exactly how "Friday, October 10th" happened. The lead had a date; the
 * renderer formatted a weekday for it; nobody checked whether the day matched.
 *
 * So this module EXTRACTS and REPORTS. Every field it cannot source from the
 * lead is returned as a gap with the question to ask. `event_date` counts as
 * confirmed only when the notes carry explicit written confirmation - which the
 * Mercedes notes do, in Mercedes's own correction. A date nobody confirmed is not
 * a confirmation.
 *
 * PRICING IS NOT INVENTED HERE. The duration, the tier and the quoted total come
 * from the caller, because they come from the conversation with the client, not
 * from the database. If they are absent they are gaps. An agent that has spoken
 * to a salesperson passes them in; one that has not, asks.
 */

import { MIN_HOURS, MAX_HOURS, DURATIONS, RATES, priceQuoteFromTotal, formatCents } from './pfp-pricing.mjs';

/**
 * Words that indicate a client confirmed the date in writing. Checked against
 * the notes because that is where a correction like Mercedes's lives.
 *
 * Deliberately narrow. A note saying "date TBC" must not read as confirmation,
 * and absence of doubt is not evidence of certainty.
 */
const CONFIRMED_MARKERS = [
  'confirmed',
  'corrected',
  'in writing',
  'replied',
  'she confirmed',
  'he confirmed',
  'client confirmed',
];

const DOUBT_MARKERS = ['tbc', 'to be confirmed', 'to be decided', 'unconfirmed', 'tentative'];

/**
 * "Not confirmed" has to mean one thing: nobody has confirmed it. It must NOT
 * match "booking not confirmed until payment received", which is about PAYMENT
 * and says nothing about the date - and it did match, which made a lead whose
 * client had corrected the date in writing read as unconfirmed.
 *
 * So doubt phrases that refer to a SUBJECT other than the date are excluded.
 * The list is short and explicit because an unbounded keyword scan over free-text
 * notes will always be wrong somewhere, and being wrong here means either
 * blocking a contract the client already agreed to, or issuing one they did not.
 */
const DOUBT_PHRASES = [
  'date not confirmed', 'date is not confirmed', 'date unconfirmed',
  'date tbc', 'date is tentative', 'date still to be confirmed',
  'awaiting confirmation', 'awaiting reply on the date', 'no confirmed date',
];

/**
 * Patterns for doubt, as regexes rather than literal phrases.
 *
 * Free-text notes vary the wording: "not confirmed by client", "not confirmed by
 * the client", "has not been confirmed". A literal list misses the variants and
 * a bare substring match catches payment statements. So the shapes are matched
 * with optional words.
 */
const DOUBT_PATTERNS = [
  /date\s+(?:is\s+|was\s+|still\s+)?(?:not\s+confirmed|unconfirmed|tbc|tentative)/i,
  /not\s+(?:been\s+)?confirmed\s+by\s+(?:the\s+)?client/i,
  /(?:date|time)\s+(?:awaiting|still\s+awaiting)\s+confirmation/i,
];

/**
 * Doubt phrases that must NOT count.
 *
 * "booking not confirmed until payment received" is about PAYMENT and says
 * nothing about the date. It matched a bare "not confirmed" scan and blocked a
 * contract for a lead whose client had already corrected the date in writing -
 * which is exactly what happened to the Mercedes lead.
 *
 * So doubt is matched as a phrase, not as a substring. "not confirmed by the
 * client" counts; "not confirmed until payment" does not.
 */
const NOT_ABOUT_DATE = Object.freeze([
  'not confirmed until payment',
  'not confirmed until paid',
  'booking not confirmed',
  'not confirmed until deposit',
]);

/**
 * Read a lead and report what a contract needs from it.
 *
 * @param {object} lead  a row from public.pfp_leads
 * @param {{duration_hours?: number, rate?: string, quoted_total_cents?: number}} [supplied]
 * @returns {{event: object, gaps: Array, priceable: boolean, summary: string}}
 */
export function contractInputFromLead(lead, supplied = {}) {
  const gaps = [];
  const notes = String(lead.notes || '');
  const notesLower = notes.toLowerCase();

  const ask = (key, label, question, why) => gaps.push({ key, label, question, why });

  // ── the client ────────────────────────────────────────────────────────────
  const client_name = trimOrNull(lead.contact_name);
  if (!client_name) {
    ask('client_name', 'Client name', "What is the client's full name for the agreement?",
      'the agreement names its parties');
  }
  const client_email = trimOrNull(lead.contact_email);
  if (!client_email) {
    ask('client_email', 'Client email', 'What email address should the contract go to?',
      'the contract has to be deliverable');
  }

  // ── the event ─────────────────────────────────────────────────────────────
  // `event_type` on a lead is free text like "School Dance". The company name is
  // not an event name, so it is not used as one.
  const event_name = trimOrNull(lead.event_type);
  if (!event_name) {
    ask('event_name', 'Event name', 'What is the name of the event?', 'the service is for a named event');
  }

  const venue_name = trimOrNull(lead.venue_name);
  if (!venue_name) {
    ask('venue_name', 'Venue', 'Where is the event being held?',
      'travel and setup depend on it');
  }

  // ── the date, and whether anyone actually confirmed it ─────────────────────
  const rawDate = lead.event_date;
  let event_date = null;
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    // Postgres returns a date column as a Date at local midnight. Take the UTC
    // calendar date, which is the day the column holds.
    event_date = rawDate.toISOString().slice(0, 10);
  } else if (typeof rawDate === 'string' && rawDate.trim()) {
    event_date = rawDate.trim().slice(0, 10);
  }
  if (!event_date) {
    ask('event_date', 'Event date', 'What is the event date?', 'a date that is wrong costs a correction contract');
  }

  // Confirmation is read from the record, never assumed from the column being
  // non-null. A `date` column records what somebody entered, not that a client
  // agreed to it.
  const doubts = DOUBT_PATTERNS.some((re) => re.test(notes)) &&
  !NOT_ABOUT_DATE.some((m) => notesLower.includes(m));
  const confirmed = Boolean(event_date) && !doubts &&
    CONFIRMED_MARKERS.some((m) => notesLower.includes(m));
  if (event_date && !confirmed) {
    ask('date_confirmed', 'Event date confirmed by the client',
      'Has the client confirmed that exact event date in writing?',
      'an unconfirmed date is a guess, and a wrong weekday is what cost us a corrected contract');
  }

  // ── duration, tier, price: from the conversation, not the database ────────
  let duration_hours = supplied.duration_hours ?? null;
  if (duration_hours === null) {
    ask('duration_hours', 'Service hours',
      `How many hours is the booth booked for? (${MIN_HOURS}-${MAX_HOURS})`,
      'the total is rate multiplied by hours');
  } else if (!DURATIONS.includes(Number(duration_hours))) {
    ask('duration_hours', 'Service hours',
      `Bookings are ${MIN_HOURS}-${MAX_HOURS} hours; ${duration_hours} is not bookable.`,
      'the total is rate multiplied by hours');
  }

  const rate = supplied.rate ?? null;
  if (rate === null) {
    ask('rate', 'Print size / tier',
      `Which package - ${Object.values(RATES).map((r) => `${r.label} (${formatCents(r.hourly_cents)}/hr, ${r.print_format})`).join(', ')}?`,
      'the tier sets the hourly rate');
  } else if (!RATES[rate]) {
    ask('rate', 'Print size / tier', `Unknown tier "${rate}". Known: ${Object.keys(RATES).join(', ')}.`,
      'the tier sets the hourly rate');
  }

  let quoted_total_cents = supplied.quoted_total_cents ?? null;
  if (quoted_total_cents === null) {
    ask('quoted_total_cents', 'Quoted total',
      'What total was quoted to the client? The contract must state the figure they were given.',
      'a contract that disagrees with the quote is what caused the FCPS correction');
  }

  // ── can it be priced yet? ────────────────────────────────────────────────
  let quote = null;
  if (duration_hours && RATES[rate] && quoted_total_cents !== null) {
    try {
      quote = priceQuoteFromTotal(duration_hours, rate, Number(quoted_total_cents), {
        allow_above_list: true,
      });
    } catch (e) {
      ask('quoted_total_cents', 'Quoted total', e.message, 'the quote could not be reconciled with the rate card');
    }
  }

  const event = {
    client_name,
    client_email,
    event_name,
    venue_name,
    // pfp_leads HAS a venue_address column and this module never copied it, so a
    // corrected address in the database did not reach the contract: the row said
    // the venue, the document said "undefined". Optional, not a gap - plenty of
    // events are at an address nobody wrote down, and the attendant asks.
    venue_address: trimOrNull(lead.venue_address),
    event_date,
    date_confirmed: confirmed,
    contact_name: trimOrNull(lead.contact_name),
    contact_phone: normalisePhone(lead.contact_phone),
    // Guests expected has no column on the lead. Left null; it renders as a
    // blank to fill in, which is correct - it is optional on the form.
    guests_expected: null,
  };

  return {
    event,
    duration_hours: duration_hours === null ? null : Number(duration_hours),
    rate,
    quoted_total_cents: quoted_total_cents === null ? null : Number(quoted_total_cents),
    quote,
    gaps,
    priceable: gaps.length === 0,
    summary: buildSummary(lead, event, quote),
  };
}

function buildSummary(lead, event, quote) {
  const bits = [`lead ${lead.id} - ${lead.status}`];
  bits.push(event.event_name || 'event not stated');
  if (event.event_date_display !== undefined) { /* not set here */ }
  if (event.event_date) {
    bits.push(`${event.event_date}${event.date_confirmed ? ' (client-confirmed)' : ' (NOT confirmed)'}`);
  }
  if (quote) bits.push(`quoted ${quote.total_display}, list ${quote.subtotal_display}`);
  return bits.join(', ');
}

const trimOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Digits only, with a US assumption made explicit rather than silent.
 * The lead stores "7329960334" with no country code and no formatting.
 */
function normalisePhone(v) {
  const s = trimOrNull(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return s;
}

export default { contractInputFromLead };