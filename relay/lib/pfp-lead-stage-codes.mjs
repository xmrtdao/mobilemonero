/**
 * relay/lib/pfp-lead-stage-codes.mjs — the stage vocabulary, in one place.
 *
 * Split out because three modules need the codes and one of them is imported by
 * a different package boundary. Keeping the list here means there is exactly one
 * definition of what a stage may be called, rather than three copies that drift.
 */

export const LEAD_STAGE_CODES = Object.freeze(['new', 'negotiating', 'booked', 'stale', 'lost']);

/**
 * Legacy values that appeared in pfp_leads.status before stages existed.
 *
 * `status` was free text and carried six shapes, two of them B2B vocabulary
 * ("MQL", "SQL" style framing) applied to an events business. These map to the
 * stages rather than being invented fresh.
 *
 *   NEW          -> new          a reply we have not acted on
 *   warm         -> new          inbound and interested, nothing sent
 *   negotiating  -> negotiating  contract out
 *   booked       -> booked       paid
 *   lost         -> lost         needs a reason; backfilled as 'other'
 *   nurturing    -> stale        long-term follow-up, out of the working set
 */
export const LEGACY_STATUS_MAP = Object.freeze({
  NEW: 'new',
  new: 'new',
  warm: 'new',
  hot: 'new',
  lead: 'new',
  vsco_import: 'new',
  negotiating: 'negotiating',
  contract_sent: 'negotiating',
  proposal_sent: 'negotiating',
  booked: 'booked',
  won: 'booked',
  confirmed: 'booked',
  lost: 'lost',
  closed: 'lost',
  nurturing: 'stale',
  stale: 'stale',
});

export default { LEAD_STAGE_CODES, LEGACY_STATUS_MAP };