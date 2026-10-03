/**
 * relay/lib/pfp-contract-pdf.mjs — renders a contract model to a PDF.
 *
 * A renderer draws. It decides nothing.
 *
 * Every vendor identity string, every price, every date and every clause comes
 * from the model built by `buildContractModel()`. This file contains no business
 * name, no owner, no phone number, no jurisdiction and no weekday. If a fact is
 * not on the model it is not on the page - the layout code has no vocabulary for
 * it, which is the point. Adding a literal here would reintroduce exactly the
 * defect that put Party Favor Photo's identity and District of Columbia law on
 * an FCPS contract.
 *
 * The layout itself is carried over from `contracts/generate.mjs`, which
 * produces acceptable output. It was not improved here on purpose: nobody has
 * approved a visual change yet, and churning the layout of a signed legal
 * document without one would be a change nobody asked for.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, existsSync } from 'fs';
import { buildContractModel, normalizeProvider } from './pfp-contract.mjs';
import { formatCents } from './pfp-pricing.mjs';

const C = {
  red: rgb(0.82, 0.18, 0.20),
  dark: rgb(0.15, 0.15, 0.15),
  gray: rgb(0.50, 0.50, 0.50),
  lg: rgb(0.92, 0.92, 0.92),
  gold: rgb(0.85, 0.65, 0.13),
};

/** A visibly empty field. Never a plausible-looking guess. */
const BLANK = '____________________';

/**
 * A date, formatted long. Takes a Date or an ISO string; refuses anything it
 * cannot parse rather than printing "Invalid Date" on a legal document.
 *
 * Read in UTC to match how event dates are read in pfp-lead-contracts.mjs. If
 * the two disagreed by a day across a timezone boundary, the agreement date and
 * the event date would disagree for reasons no one could explain.
 */
function formatLongDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `drafted_on must be a Date or an ISO date string; got ${JSON.stringify(value)}`
    );
  }
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Render a contract model to PDF bytes.
 *
 * @param {object} model  from buildContractModel()
 * @param {{draft_banner?: boolean}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function renderContractPdf(model, opts = {}) {
  // `options` is threaded through to the document so a caller can pin the
  // drafted-on date - which a template generator must, or all ten templates
  // would regenerate with today's date baked in.
  const options = { ...model.options, ...opts };
  const p = model.provider;
  const q = model.quote;
  const s = model.schedule;
  const ev = model.event;
  const isDraft = model.draft === true;

  const doc = await PDFDocument.create();
  const h = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = await doc.embedFont(StandardFonts.TimesRoman);
  const tb = await doc.embedFont(StandardFonts.TimesRomanBold);

  const M = 50;
  const W = 512;
  let pg;
  let y = 0;
  const newPage = () => {
    pg = doc.addPage([612, 950]);
    y = 880;
  };
  newPage();

  // --- text helpers, carried over from generate.mjs -------------------------
  function TXT(text, o = {}) {
    const { sz = 11, color = C.dark, font = t, indent = 0, after = 0, align = 'left' } = o;
    if (text === null || text === undefined || text === '') return;
    const lead = sz + 5;
    let line = '';
    for (const word of String(text).split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, sz) > W - indent && line) {
        if (y < 55) newPage();
        pg.drawText(line, {
          x: align === 'right' ? 562 - font.widthOfTextAtSize(line, sz) : M + indent,
          y, size: sz, font, color,
        });
        y -= lead;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      if (y < 55) newPage();
      pg.drawText(line, {
        x: align === 'right' ? 562 - font.widthOfTextAtSize(line, sz) : M + indent,
        y, size: sz, font, color,
      });
      y -= lead;
    }
    if (after) y -= after;
  }
  const HR = (thick = 1) => {
    if (y < 80) newPage();
    pg.drawLine({ start: { x: M, y: y + 6 }, end: { x: 562, y: y + 6 }, thickness: thick, color: C.red });
    y -= 18;
  };
  const SEC = (num, title) => {
    if (y < 180) newPage();
    TXT('', { after: 10 });
    TXT(`${num}. ${title}`, { sz: 14, font: h, color: C.red, after: 6 });
    HR(1.5);
  };

  // A missing value renders as a blank to fill in, never as invented content.
  // This is the single most important line in the file: the FCPS contract said
  // "Friday" because a renderer was willing to supply a weekday nobody gave it.
  const FIELD = (v) => (v === null || v === undefined || v === '' ? BLANK : String(v));
  const dateLine = ev.event_date_display
    ? `${ev.event_weekday}, ${ev.event_date_display}`
    : BLANK;

  // --- draft banner ---------------------------------------------------------
  if (isDraft && opts.draft_banner !== false) {
    pg.drawRectangle({ x: M, y: y - 26, width: W, height: 26, color: C.gold });
    TXT(`DRAFT - NOT FOR SIGNATURE - ${model.gaps.length} unconfirmed field(s)`, {
      sz: 10, font: h, indent: 8,
    });
    y -= 40;
  }

  // --- header ---------------------------------------------------------------
  if (p.logo_path && existsSync(p.logo_path)) {
    const li = await doc.embedPng(readFileSync(p.logo_path));
    pg.drawImage(li, { x: M, y: y - 44, width: 140, height: Math.round(140 / (li.width / li.height)) });
  }
  TXT(`${p.business_name.toUpperCase()} CONTRACT`, { sz: 22, font: h, color: C.red, align: 'right', after: 2 });
  TXT(`${q.hours}-Hour ${q.rate_label} Package`, { sz: 14, color: C.gray, align: 'right', after: 1 });
  // The header states the LIST price, never the discounted total. It read
  // "$249.00/hr = $598.00" for a 3-hour booking, which is arithmetically false -
  // 3 x $249 is $747 - and section 3 repeated the same wrong sum. A client doing
  // the arithmetic would not sign it. Both places now show rate x hours and let
  // the TOTAL FEE line carry the quoted figure.
  TXT(
    `${q.rate_label} - ${formatCents(q.hourly_cents)}/hr x ${q.hours}hrs = ${q.subtotal_display}`,
    { sz: 11, color: C.gray, align: 'right', after: 1 }
  );
  if (q.discount_applied) {
    TXT(`Less ${q.discount_display} - ${q.discount_label} = ${q.total_display}`, {
      sz: 9, color: C.gold, align: 'right', after: 6,
    });
  }
  HR(1.5);

  // --- parties --------------------------------------------------------------
  // The date the agreement was DRAFTED, which is a fact the system knows - it is
  // rendering the document now. Left as a blank for years because the two
  // renderers hard-coded the layout and nothing supplied it.
  //
  // Distinct from the EVENT date and from the SIGNATURE date, and all three are
  // allowed to differ: a contract drafted today for an event next month is
  // signed today or later. They must not be collapsed into one value.
  const draftedOn = formatLongDate(options.drafted_on ?? new Date());
  TXT(`THIS AGREEMENT is drafted on ${draftedOn}`, { after: 4 });
  TXT('between:', { sz: 11, font: tb, color: C.red, after: 4 });
  y -= 6;
  pg.drawRectangle({ x: M, y: y - 50, width: W, height: 50, color: C.lg });
  TXT(`${p.legal_name || p.business_name} ("Provider")`, { sz: 11, font: h, indent: 10 });
  y += 4;
  TXT(`${p.contact_name}, ${p.contact_title}`, { sz: 10, indent: 10 });
  y += 3;
  TXT(`${p.email} | ${p.phone}${p.website ? ' | ' + p.website.replace(/^https?:\/\//, '') : ''}`, {
    sz: 10, indent: 10, color: C.red,
  });
  y += 3;
  if (p.ein || p.insurance) {
    const bits = [p.ein ? `EIN ${p.ein}` : null, p.insurance].filter(Boolean).join(' - ');
    TXT(bits, { sz: 9, indent: 10, color: C.gray });
  }
  y = y - 50 - 10;

  TXT('and', { after: 4 });
  y -= 6;
  pg.drawRectangle({ x: M, y: y - 40, width: W, height: 40, color: C.lg });
  TXT(`${FIELD(ev.client_name)} ("Client")`, { sz: 11, indent: 10 });
  y += 4;
  TXT(`Event: ${FIELD(ev.event_name)}     Date: ${FIELD(dateLine)}`, { sz: 10, indent: 10 });
  y = y - 40 - 14;

  // --- event details --------------------------------------------------------
  SEC('2', 'EVENT DETAILS');
  const rows = [
    ['Event Name:', FIELD(ev.event_name)],
    ['Event Date:', FIELD(dateLine)],
    ['Event Location:', FIELD(ev.venue_name)],
    // Address and room only when stated. A venue with no address is normal; an
    // invented street address is not, and the attendant drives to whatever this
    // line says.
    ...(ev.venue_address ? [['Event Address:', String(ev.venue_address)]] : []),
    ...(ev.venue_room ? [['Room / Area:', String(ev.venue_room)]] : []),
    ['Service Hours:', `${q.hours} hours`],
    ['Contact Person:', FIELD(ev.contact_name)],
    ['Contact Phone:', FIELD(ev.contact_phone)],
    ['Number of Guests Expected:', FIELD(ev.guests_expected)],
  ];
  for (const [l, v] of rows) {
    TXT(l, { sz: 11, font: tb, after: 1 });
    TXT(v, { sz: 11, color: C.gray, after: 4 });
  }

  // --- services -------------------------------------------------------------
  SEC('3', 'SERVICES');
  TXT(`The ${q.hours}-Hour ${q.rate_label} StudioStation includes:`, { font: tb, after: 4 });
  for (const inc of model.inclusions) TXT(`   - ${inc}`, { sz: 10, indent: 16, after: 1 });
  TXT('', { after: 4 });
  // Same correction as the header: this is the service description, so it quotes
  // list price. The discounted figure belongs to section 4, not here.
  TXT(
    `Total booked time: ${q.hours} hours at ${formatCents(q.hourly_cents)}/hr = ${q.subtotal_display}. ` +
      `Overtime billed at ${formatCents(q.hourly_cents)}/hr.`,
    { sz: 10, font: tb }
  );

  // --- pricing & payment ----------------------------------------------------
  SEC('4', 'PRICING & PAYMENT');
  TXT(
    `Service: ${q.hours}-Hour ${q.rate_label} StudioStation - ` +
      `${formatCents(q.hourly_cents)}/hr x ${q.hours}hrs = ${q.subtotal_display}`,
    { after: 1 }
  );
  if (q.discount_applied) {
    // Three lines, always, so the arithmetic is checkable by eye: the list
    // price, the reduction, and the total that was actually quoted.
    TXT(`List price (${q.hours} hrs @ ${formatCents(q.hourly_cents)}/hr): ${q.subtotal_display}`, {
      sz: 10, after: 1,
    });
    TXT(`Discount - ${q.discount_label}: -${q.discount_display}`, { sz: 10, color: C.gold, after: 1 });
  }
  TXT(`TOTAL FEE: ${q.total_display}`, { sz: 13, font: h, after: 2 });
  TXT(`Deposit Due (${model.payment_terms.deposit_percent}%): ${s.deposit_display} ${s.deposit_due}`, { sz: 12, font: h, after: 2 });
  TXT(`Balance Due: ${s.balance_display} ${s.balance_due}`, { after: 6 });

  // --- terms ----------------------------------------------------------------
  SEC('5', 'TERMS & CONDITIONS');
  model.terms.forEach((body, i) => {
    const [heading, ...rest] = body.split('. ');
    TXT(`5.${i + 1} ${heading}.`, { sz: 10, font: tb, after: 1 });
    TXT(`     ${rest.join('. ')}`, { sz: 10, indent: 8, after: 4 });
  });
  TXT(`5.${model.terms.length + 1} Governing Law. This agreement is governed by the laws of ${p.governing_law}.`, {
    sz: 10, font: tb, after: 1,
  });

  // --- signatures -----------------------------------------------------------
  if (y < 220) newPage();
  SEC('6', 'SIGNATURES');
  const sbt = y;
  pg.drawRectangle({ x: M, y: y - 85, width: W, height: 85, color: C.lg });
  if (p.signature_path && existsSync(p.signature_path)) {
    const si = await doc.embedPng(readFileSync(p.signature_path));
    const hh = Math.round(130 / (si.width / si.height));
    pg.drawImage(si, { x: M + 14, y: sbt - 14 - hh, width: 130, height: hh });
    y = sbt - 14 - hh - 4;
  }
  TXT(`${p.contact_name} - ${p.contact_title}, ${p.legal_name || p.business_name}`, { sz: 11, font: tb, indent: 10 });
  y += 4;
  TXT(`Date: ${BLANK}`, { sz: 10, indent: 10 });
  y = sbt - 85 - 16;

  pg.drawRectangle({ x: M, y: y - 55, width: W, height: 55, color: C.lg });
  TXT(`Client Signature: ${BLANK}`, { sz: 11, indent: 10 });
  y += 4;
  TXT(`Printed Name: ${FIELD(ev.client_name)}`, { sz: 10, indent: 10 });
  y += 3;
  TXT(`Date: ${BLANK}`, { sz: 10, indent: 10 });
  y = y - 55 - 14;

  HR(1);
  const contact = [p.business_name, p.email, p.phone, p.website].filter(Boolean).join(' - ');
  TXT(contact, { sz: 8, color: C.gray, after: 1 });
  TXT(
    `${q.hours}hr ${q.rate_label}${isDraft ? ' - DRAFT, NOT FOR SIGNATURE' : ''} - ` +
      `${q.total_display} total`,
    { sz: 7, color: C.gray }
  );

  return doc.save();
}

/**
 * Build and render in one call. Refuses on any unconfirmed required field unless
 * explicitly asked for a draft.
 *
 * @param {object} input  {provider, event, hours, rate, discount, discount_reason, allowGaps}
 * @returns {Promise<{bytes:Uint8Array, model:object, page_count:number}>}
 */
export async function renderContract(input) {
  const model = buildContractModel(input);
  const bytes = await renderContractPdf(model);
  const probe = await PDFDocument.load(bytes);
  return { bytes, model, page_count: probe.getPageCount() };
}

export default { renderContract, renderContractPdf };
export { normalizeProvider };