/**
 * relay/lib/pfp-contract-tools.mjs — the contract tool for agents.
 *
 * AVAILABLE TO EVERY AGENT, BY THE OWNER'S INSTRUCTION.
 * ------------------------------------------------------------
 * Every other write tool here passes `gate(...)` first. This one does not, and
 * that is a decision rather than an oversight:
 *
 *   - a money tool moves a client's funds. A wrong call is unrecoverable.
 *   - a contract tool produces a DOCUMENT. Nothing leaves the building until a
 *     human sends it, and a wrong document is re-rendered in seconds.
 *
 * The expensive failure here was never an agent issuing a bad contract. It was a
 * salesperson quoting $598 and having no way to produce a contract for it, which
 * is how a correction contract and a re-signature happened in the first place.
 * Speed and reach matter more than a gate that would have blocked exactly the
 * agents that need it.
 *
 * WHAT IS STILL ENFORCED, AND IT IS NOT NOTHING
 * ----------------------------------------------
 * Ungated does not mean unchecked. Three things are refused regardless of who is
 * asking, because they are the failure modes that actually happened:
 *
 *   1. An unconfirmed event date cannot be rendered. The FCPS contract said
 *      "Friday, October 10, 2026"; October 10 2026 is a Saturday. Getting that
 *      wrong cost a correction contract, a supersede clause and a re-signature.
 *      The tool asks instead of guessing.
 *   2. The vendor identity is never defaulted. No provider means no contract, so
 *      the counterparty's legal name, contact and jurisdiction cannot be
 *      invented to fill a blank.
 *   3. Pricing comes from the catalogue. Hours, rate and the quoted total are all
 *      validated, and a quote above list price is recorded as a surcharge rather
 *      than dressed as a discount.
 *
 * A draft is available on request and is stamped DRAFT on the page. What cannot
 * happen is a clean-looking contract carrying a fact nobody supplied.
 *
 * The relay is not given Stripe access or the vendor's identity here. The caller
 * passes a provider; this file reads no environment and stores no secrets.
 */

import { renderContract, renderContractPdf } from './pfp-contract-pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { buildContractModel, summarize, requireConfirmedFields } from './pfp-contract.mjs';
import {
  priceCard, priceQuote, priceQuoteFromTotal, paymentSchedule, formatCents,
  MIN_HOURS, MAX_HOURS, DURATIONS, RATES, DISCOUNTS, openPricingGaps,
} from './pfp-pricing.mjs';
import { contractInputFromLead } from './pfp-lead-contracts.mjs';

const OUT_DIR = process.env.PFP_CONTRACT_OUT || './contracts/generated';

/** A short, stable id for the filename. Never a client-name-derived path. */
function refFor(args) {
  const raw = String(args.ref || '').trim();
  if (!raw) return null;
  // Refused rather than sanitised into something surprising. A reference is
  // supplied by a caller, and a caller supplying a path traversal has a bug.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
    throw new Error(
      `ref must be 1-64 characters of letters, digits, dot, dash or underscore; ` +
        `got ${JSON.stringify(raw.slice(0, 40))}`
    );
  }
  return raw;
}

export function pfpContractTools({ log, writeFile, mkdir, renderPdf = renderContractPdf }) {
  const log_ = log || (() => {});
  const write = writeFile || (async () => { throw new Error('no file writer configured'); });
  const mk = mkdir || (async () => { throw new Error('no directory maker configured'); });

  return {
    /**
     * The price card. Cheap, always available, and the first thing an agent
     * should call - it is how an agent finds out the rate exists at all.
     */
    async pfp_price_card() {
      return {
        minimum_hours: MIN_HOURS,
        maximum_hours: MAX_HOURS,
        durations: DURATIONS,
        rates: priceCard(),
        discounts: Object.values(DISCOUNTS).map((d) => ({
          id: d.id,
          label: d.label,
          kind: d.kind,
          value: d.kind === 'percent' ? `${d.percent_off}% off`
               : d.kind === 'flat' ? formatCents(d.cents_off) + ' off'
               : 'value not stated',
          discretionary: d.discretionary === true,
        })),
        payment_terms: '50% on booking, balance 7 days before the event',
        // Anything unresolved in the business's own paperwork, so an agent
        // quoting a price can see the caveats rather than discover them later.
        open_conflicts: openPricingGaps(),
      };
    },

    /**
     * Price a booking without writing a document. The dry run.
     *
     * Takes either `hours` + `rate` for list price, or `quoted_total_cents` when
     * a salesperson has already quoted a figure - the contract then matches the
     * quote, which is the whole point.
     */
    async pfp_price_quote(args = {}) {
      const { hours, rate = 'standard', quoted_total_cents, discount, discount_reason,
              allow_above_list = false } = args;
      try {
        const q = quoted_total_cents !== undefined
          ? priceQuoteFromTotal(hours, rate, quoted_total_cents,
              { basis: discount, basis_note: discount_reason, allow_above_list })
          : priceQuote(hours, rate, discount ? { discount, discount_reason } : {});
        return {
          ...q,
          schedule: paymentSchedule(q.total_cents),
          note: q.requires_basis
            ? `${q.requires_basis_question} The contract will label this an ` +
              `owner-authorized Discount rather than name a category.`
            : null,
        };
      } catch (e) {
        // Refusals come back as answers. An agent needs to read "hours must be a
        // whole number from 2 to 6" and correct itself; an exception is just a
        // stack trace it has to guess at.
        return { error: e.message };
      }
    },

    /**
     * Generate a contract PDF.
     *
     * Refuses on an unconfirmed event date. `allow_draft: true` renders one
     * stamped DRAFT, for an internal read-through - never for sending.
     */
    async pfp_create_contract(args = {}) {
      const {
        provider, event = {}, hours, rate = 'standard',
        quoted_total_cents, discount, discount_reason,
        allow_above_list = false, allow_draft = false, ref,
      } = args;

      // Ref is validated FIRST, before any field checks. It was validated after
      // them, which meant a bad ref returned the "unconfirmed fields" error
      // instead of the path-traversal one - the agent fixed the date, then hit
      // the same wall again with a different message. One error, about the thing
      // actually wrong with this call.
      let refId;
      try { refId = refFor(args); }
      catch (e) { return { error: e.message }; }

      // Pre-flight the required fields so the refusal is actionable rather than
      // a stack trace out of the catalogue. Skipped when a draft was asked for -
      // a draft exists precisely to be rendered while fields are still missing,
      // and blocking it here made the flag unreachable.
      const check = requireConfirmedFields(event);
      if (!check.ok && !allow_draft) {
        return {
          error: 'contract not generated: unconfirmed required fields',
          draft_available: true,
          pass_allow_draft_to_render_a_draft: true,
          gaps: check.gaps.map((g) => ({
            field: g.key,
            missing: g.label,
            why: g.why,
            ask_the_client: g.question,
          })),
        };
      }

      let model;
      try {
        // Build first, so a pricing or identity failure is reported against the
        // model rather than after a document has been rendered and half-written.
        model = buildContractModel({
          provider, event, hours, rate,
          quoted_total_cents, discount, discount_reason,
          allow_above_list, allowGaps: allow_draft,
        });
      } catch (e) {
        return { error: e.message, rendered: false };
      }

      // Rendered here rather than via a caller-supplied render(), so the tool
      // always reports a real page count. `out` is bytes, not the renderContract
      // wrapper - passing the wrapper in previously lost page_count and
      // returned undefined three fields later.
      let bytes;
      let page_count;
      try {
        bytes = await renderPdf(model);
        const probe = await PDFDocument.load(bytes);
        page_count = probe.getPageCount();
      } catch (e) {
        return { error: `contract model built but rendering failed: ${e.message}`, rendered: false };
      }

      const m = model;
      const out = { bytes, pageCount: page_count };
      const slug = refId || `contract-${Date.now()}`;
      const filename = `PFP-${slug}.pdf`;
      const path = `${OUT_DIR}/${filename}`;

      try {
        await mk(OUT_DIR, { recursive: true });
        await write(path, out.bytes);
      } catch (e) {
        // The document is fine; only the write failed. Report that honestly
        // rather than pretending the contract was produced as a file.
        return {
          error: `contract rendered but could not be written: ${e.message}`,
          rendered: true,
          bytes: out.bytes.length,
          page_count: out.page_count,
          model: m,
          summary: summarize(m),
        };
      }

      log_('pfp_create_contract', {
        ref: slug, bytes: out.bytes.length, pages: out.pageCount,
        total: m.quote.total_display, draft: m.draft,
      });

      return {
        ok: true,
        path,
        filename,
        bytes: out.bytes.length,
        page_count: out.pageCount,
        draft: m.draft,
        summary: summarize(m),
        pricing: {
          hourly_display: m.quote.hourly_display,
          hours: m.quote.hours,
          list_price: m.quote.subtotal_display,
          discount: m.quote.discount_applied
            ? `${m.quote.discount_label} -${m.quote.discount_display}`
            : null,
          total: m.quote.total_display,
          deposit: `${m.schedule.deposit_display} ${m.schedule.deposit_due}`,
          balance: `${m.schedule.balance_display} ${m.schedule.balance_due}`,
        },
        gaps: m.gaps,
        // A draft is never presentable. Say so at the point of return.
        send_warning: m.draft
          ? 'DRAFT - not for signature. Resolve the gaps, then regenerate.'
          : null,
        unresolved_price_conflicts: m.unresolved_price_conflicts,
      };
    },

    /**
     * What a contract would say, without writing anything. Lets an agent read a
     * contract back to a client and check the arithmetic before committing.
     */
    async pfp_preview_contract(args = {}) {
      try {
        const m = buildContractModel({
          provider: args.provider, event: args.event || {}, hours: args.hours,
          rate: args.rate, quoted_total_cents: args.quoted_total_cents,
          discount: args.discount, discount_reason: args.discount_reason,
          allow_above_list: args.allow_above_list === true,
          allowGaps: args.allow_draft === true,
        });
        return {
          summary: summarize(m),
          draft: m.draft,
          gaps: m.gaps,
          pricing: {
            list_price: m.quote.subtotal_display,
            discount: m.quote.discount_applied
              ? `${m.quote.discount_label} -${m.quote.discount_display}`
              : null,
            total: m.quote.total_display,
            deposit: m.schedule.deposit_display,
            balance: m.schedule.balance_display,
          },
          provider: {
            business_name: m.provider.business_name,
            governing_law: m.provider.governing_law,
            ein: m.provider.ein,
          },
          event: m.event,
        };
      } catch (e) {
        return { error: e.message };
      }
    },
  };
}

/** The tool descriptions, for registration alongside the money tools. */
export const PFP_CONTRACT_TOOL_DESCRIPTIONS = Object.freeze({
  pfp_price_card:
    'Party Favor Photo published pricing. Call this first: it gives the hourly ' +
    'rates by print size, bookable durations, available discounts and the ' +
    'payment schedule.',
  pfp_price_quote:
    'Price a Party Favor Photo booking without writing a document. Pass hours ' +
    'and rate for list price, or quoted_total_cents when a figure has already ' +
    'been quoted to the client - the contract will match that quote exactly.',
  pfp_preview_contract:
    'Read back what a contract would say - pricing, schedule, parties and any ' +
    'unconfirmed fields - without writing a file.',
  pfp_create_contract:
    'Generate a Party Favor Photo contract PDF. Refuses if the event date has ' +
    'not been confirmed by the client; pass allow_draft for an internal draft, ' +
    'which is stamped DRAFT and is not for signature.',
  pfp_lead_contract_input:
    'Read a lead from the database and report what a contract for it would ' +
    'need. Returns the event fields it can source and the gaps it cannot - ' +
    'call this before pfp_create_contract so nothing is invented to fill a blank.',
});

/**
 * Build a contract for a lead in `public.pfp_leads`.
 *
 * The lead table has no duration, no tier and no price column. Those come from
 * the conversation with the client, so the caller passes them; if it does not,
 * they come back as questions rather than defaults. See pfp-lead-contracts.mjs
 * for why that is the whole design.
 */
export function pfpLeadContractTools({ query, getPool, log, ...rest }) {
  const q = query || (() => { throw new Error('no query function configured'); });
  const base = pfpContractTools({ log, ...rest });

  return {
    ...base,

    async pfp_lead_contract_input(args = {}) {
      const { lead_id, ...supplied } = args;
      if (!lead_id) return { error: 'lead_id is required' };
      const { rows } = await q(
        'SELECT id, company_name, contact_name, contact_email, contact_phone, ' +
          'event_type, event_date, venue_name, venue_address, status, notes ' +
          'FROM public.pfp_leads WHERE id = $1',
        [lead_id]
      );
      if (!rows.length) return { error: `no lead with id ${lead_id}` };
      const out = contractInputFromLead(rows[0], supplied);
      return {
        lead_id,
        status: rows[0].status,
        event: out.event,
        duration_hours: out.duration_hours,
        rate: out.rate,
        quoted_total_cents: out.quoted_total_cents,
        quote: out.quote ? {
          list_price: out.quote.subtotal_display,
          discount: out.quote.discount_applied
            ? `${out.quote.discount_label} -${out.quote.discount_display}`
            : null,
          total: out.quote.total_display,
        } : null,
        priceable: out.priceable,
        gaps: out.gaps,
        summary: out.summary,
        next: out.priceable
          ? `Call pfp_create_contract with lead_id's inputs: ${out.duration_hours}hr ` +
            `${out.rate} at ${out.quote?.total_display}.`
          : 'Ask the client the gap questions, then call again.',
      };
    },
  };
}

export default { pfpContractTools, pfpLeadContractTools, PFP_CONTRACT_TOOL_DESCRIPTIONS };
export { renderContractPdf };