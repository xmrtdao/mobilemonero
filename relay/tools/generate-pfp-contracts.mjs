#!/usr/bin/env node
/**
 * generate-pfp-contracts.mjs - PFP StudioStation contracts v1.2
 *
 * $249/hr (2x6 strips), $349/hr (Premium 4x6 prints)
 * Discounts: flat $100 max
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DATA = join(__dirname, '..', '..', 'relay-data');
const OUT = join(__dirname, '..', '..', 'reviews', 'pfp-contracts');
const LOGO = join(RELAY_DATA, 'pfp-assets', 'pfplogo.png');
const LOGO_FALLBACK = join(RELAY_DATA, 'pfp-logo-v2.png');
const SIG = join(RELAY_DATA, 'joe-signature.png');
mkdirSync(OUT, { recursive: true });

const C = {
  red: rgb(0.82, 0.18, 0.20),
  dark: rgb(0.15, 0.15, 0.15),
  gray: rgb(0.50, 0.50, 0.50),
  lg: rgb(0.92, 0.92, 0.92),
  gold: rgb(0.85, 0.65, 0.13),
  white: rgb(1, 1, 1),
};

async function build(hours, premium) {
  const label = premium ? 'Premium' : 'Standard';
  const rate = premium ? 349 : 249;
  const tot = rate * hours;
  const disc = tot - 100;
  const incs = premium ? [
    'Professional StudioStation with bounce-diffused strobe lighting',
    'Professional DSLR cameras for editorial-quality photos',
    'Unlimited premium 4x6 prints on professional photo paper',
    'Custom branded template matching your event aesthetic',
    'Digital photo delivery via QR code and SMS text',
    'Professional attendant for all booked hours',
    'Full setup and breakdown at designated location',
    'Custom backdrop and prop selection',
    'Online gallery for all photos captured',
    'Social media sharing station with event hashtag',
    'AI watercolor portrait generation',
  ] : [
    'Professional StudioStation with bounce-diffused strobe lighting',
    'Professional DSLR cameras for editorial-quality photos',
    'Unlimited 2x6 photo strips with custom branded template',
    'Digital photo delivery via QR code and SMS text',
    'Professional attendant for all booked hours',
    'Full setup and breakdown at designated location',
    'Custom backdrop and prop selection',
    'Online gallery for all photos captured',
    'Social media sharing station with event hashtag',
  ];
  const ptype = premium ? 'Premium 4x6 Prints' : '2x6 Photo Strips';
  const fname = `PFP-${hours}hr-${label}-Contract.pdf`;

  const doc = await PDFDocument.create();
  const h = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = await doc.embedFont(StandardFonts.TimesRoman);
  const tb = await doc.embedFont(StandardFonts.TimesRomanBold);
  const M = 50, W = 512;
  let pg, y;

  function NP() { pg = doc.addPage([612, 950]); y = 890; }
  NP();

  function TXT(text, opts = {}) {
    const { sz = 11, color = C.dark, font = t, indent = 0, after = 0, align = 'left', leading } = opts;
    const lead = leading || sz + 5;
    const maxW = W - indent;
    const words = text.split(' ');
    let line = '';

    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, sz) > maxW && line) {
        if (y < 55) NP();
        const x = align === 'right' ? 562 - font.widthOfTextAtSize(line, sz) : M + indent;
        pg.drawText(line, { x, y, size: sz, font, color });
        y -= lead;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      if (y < 55) NP();
      const x = align === 'right' ? 562 - font.widthOfTextAtSize(line, sz) : M + indent;
      pg.drawText(line, { x, y, size: sz, font, color });
      y -= lead;
    }
    if (after) y -= after;
  }

  function HR(thick = 0.5) {
    if (y < 80) NP();
    pg.drawLine({ start: { x: M, y: y + 6 }, end: { x: 562, y: y + 6 }, thickness: thick, color: C.red });
    y -= 18;
  }

  function SEC(num, title) {
    if (y < 180) NP();
    TXT(``, { after: 10 }); // double spacing before section
    TXT(`${num}. ${title}`, { sz: 14, font: h, color: C.red, after: 6 });
    HR(1.5);
  }

  function FLD(l, v) {
    TXT(l, { sz: 11, font: tb, after: 1 });
    TXT(v, { sz: 11, font: t, color: C.gray, after: 4 });
  }

  // ═══ HEADER ═══
  let logoPath = LOGO;
  if (!existsSync(LOGO) && existsSync(LOGO_FALLBACK)) logoPath = LOGO_FALLBACK;
  if (existsSync(logoPath)) {
    const lb = readFileSync(logoPath);
    const isJpeg = lb[0] === 0xFF && lb[1] === 0xD8;
    let li;
    if (isJpeg) li = await doc.embedJpg(lb);
    else li = await doc.embedPng(lb);
    const aspect = li.width / li.height;
    const logoW = 140;
    const logoH = Math.round(logoW / aspect);
    pg.drawImage(li, { x: M, y: y - logoH - 4, width: logoW, height: logoH });
  }
  TXT(`STUDIOSTATION CONTRACT`, { sz: 22, font: h, color: C.red, align: 'right', after: 2 });
  TXT(`${hours}-Hour ${label} Package`, { sz: 14, font: t, color: C.gray, align: 'right', after: 1 });
  TXT(`${ptype} - $${rate}/hr = $${tot}`, { sz: 11, font: t, color: C.gray, align: 'right', after: 1 });
  TXT(`Discounted Rate: $${disc} (save $100 with military/school/pay-in-full)`, { sz: 9, font: t, color: C.gold, align: 'right', after: 6 });
  HR(1.5);

  // ═══ 1. PARTIES ═══
  TXT(`THIS AGREEMENT is made on ____________________, 20____`, { sz: 11, font: t, after: 6 });
  TXT(`between:`, { sz: 11, font: tb, color: C.red, after: 4 });
  y -= 6;
  pg.drawRectangle({ x: M, y: y - 52, width: W, height: 52, color: C.lg });
  TXT(`PARTY FAVOR PHOTO ("Provider")`, { sz: 11, font: h, indent: 10 }); y += 4;
  TXT(`Joe Lee, Owner`, { sz: 10, font: t, indent: 10 }); y += 3;
  TXT(`bookings@partyfavorphoto.com  |  (202) 798-0610  |  partyfavorphoto.com`, { sz: 10, font: t, indent: 10, color: C.red }); y += 3;
  TXT(`Licensed & Insured - $1M General Liability Coverage`, { sz: 9, font: t, indent: 10, color: C.gray });
  y = y - 52 - 10;
  TXT(`and`, { font: t, after: 4 });
  y -= 6;
  pg.drawRectangle({ x: M, y: y - 42, width: W, height: 42, color: C.lg });
  TXT(`_________________________________ ("Client")`, { sz: 11, font: t, indent: 10 }); y += 4;
  TXT(`Event: ___________________________     Date(s): ____________________`, { sz: 10, font: t, indent: 10 });
  y = y - 42 - 14;

  // ═══ 2. EVENT ═══
  SEC(`2`, `EVENT DETAILS`);
  FLD(`Event Name:`, `_________________________________`);
  FLD(`Event Date:`, `_________________________________`);
  FLD(`Event Location:`, `_________________________________`);
  FLD(`Setup Time:`, `_____ (2 hours before event start)`);
  FLD(`Event Hours:`, `_____ (${hours} hours from start time)`);
  FLD(`Contact Person:`, `_________________________________`);
  FLD(`Contact Phone:`, `_________________________________`);
  FLD(`Number of Guests Expected:`, `_________________________________`);

  // ═══ 3. SERVICES ═══
  SEC(`3`, `SERVICES`);
  TXT(`The ${hours}-Hour ${label} StudioStation includes:`, { font: tb, after: 4 });
  for (const inc of incs) TXT(`   • ${inc}`, { sz: 10, font: t, indent: 16, after: 1 });
  TXT(``, { after: 4 });
  TXT(`Total booked time: ${hours} hours at $${rate}/hr = $${tot}. Additional time billed at $${rate}/hr.`, { sz: 10, font: tb });

  // ═══ 4. PRICING ═══
  SEC(`4`, `PRICING & PAYMENT`);
  TXT(`Service:`, { sz: 11, font: tb });
  TXT(`   ${hours}-Hour ${label} StudioStation - $${rate}/hr × ${hours}hrs = $${tot}`, { sz: 11, font: t, indent: 12, after: 1 });
  TXT(`   ${ptype}`, { sz: 10, font: t, indent: 12, after: 4 });
  TXT(`TOTAL FEE: $${tot}`, { sz: 13, font: h, after: 2 });
  TXT(`Discounted Fee (military/school/pay-in-full): $${disc} (save $100)`, { sz: 10, font: t, color: C.gold, after: 6 });
  TXT(`Additional Services (check if desired):`, { sz: 10, font: tb, after: 2 });
  TXT(`   [ ] Second Attendant - $350`, { sz: 10, font: t, indent: 12, after: 1 });
  TXT(`   [ ] Social Media Content Reel (60s highlight) - $200`, { sz: 10, font: t, indent: 12, after: 1 });
  TXT(`   [ ] Premium Backdrop Upgrade - $150`, { sz: 10, font: t, indent: 12, after: 1 });
  TXT(`   [ ] Extended Outdoor Setup (generator + battery) - $100`, { sz: 10, font: t, indent: 12, after: 4 });
  TXT(`Discount Type:   [ ] Military   [ ] School/Education   [ ] Pay-in-Full`, { sz: 10, font: t, after: 6 });
  TXT(`Deposit Due (50%): $${Math.round(tot / 2)}`, { sz: 12, font: h, after: 2 });
  TXT(`Balance Due (7 days before event): $____________________`, { sz: 11, font: t, after: 6 });
  TXT(`Payment Methods:   [ ] Credit/Debit   [ ] Bank Transfer   [ ] Cash   [ ] Check`, { sz: 10, font: t, after: 6 });
  TXT(`Cancellation Policy:`, { sz: 10, font: tb, after: 2 });
  TXT(`   • 14+ days before event: Full refund less $50 processing fee`, { sz: 10, font: t, indent: 12, after: 1 });
  TXT(`   • 7-13 days before event: 50% refund`, { sz: 10, font: t, indent: 12, after: 1 });
  TXT(`   • Less than 7 days: No refund`, { sz: 10, font: t, indent: 12, after: 1 });
  TXT(`   • Provider may cancel with full refund in case of emergency`, { sz: 10, font: t, indent: 12 });

  // ═══ 5. TERMS ═══
  SEC(`5`, `TERMS & CONDITIONS`);
  const terms = [
    [`5.1`, `Space Requirements`, `Client shall provide a clean, dry 10×10 ft (minimum) covered area. Provider requires access at least 2 hours before event start. Outdoor events require overhead cover.`],
    [`5.2`, `Power`, `StudioStation operates on internal battery for up to 4 hours. For sessions longer than 4 hours, Client shall provide a standard 120V outlet within 50 ft.`],
    [`5.3`, `Insurance`, `Provider carries $1M general liability insurance. Provider is not responsible for injuries sustained by guests. Client ensures venue has appropriate liability coverage.`],
    [`5.4`, `Photo Usage`, `Provider retains right to use photos for portfolio and marketing unless expressly opted out in writing. Guests receive unlimited personal usage rights.`],
    [`5.5`, `Damages`, `Client is responsible for damage to Provider equipment caused by event guests beyond normal wear and tear. Pre-existing condition documented before setup.`],
    [`5.6`, `Discounts`, `All discounts (military, school, pay-in-full) are a flat $100 off the total fee. Only one discount may be applied per booking. Must be claimed at time of deposit.`],
    [`5.7`, `Force Majeure`, `Neither party liable for failure to perform due to causes beyond reasonable control including acts of God, natural disasters, pandemic, government action, or civil unrest.`],
    [`5.8`, `Governing Law`, `This agreement is governed by the laws of the District of Columbia.`],
  ];
  for (const [num, title, body] of terms) {
    TXT(`${num} ${title}.`, { sz: 10, font: tb, after: 1 });
    TXT(`     ${body}`, { sz: 10, font: t, indent: 8, after: 4 });
  }

  // ═══ 6. SIGNATURES ═══
  if (y < 220) NP();
  SEC(`6`, `SIGNATURES`);
  const sigBoxTop = y;
  pg.drawRectangle({ x: M, y: y - 85, width: W, height: 85, color: C.lg, borderColor: C.gray, borderWidth: 0.5 });
  if (existsSync(SIG)) {
    const si = await doc.embedPng(readFileSync(SIG));
    const sigAspect = si.width / si.height;
    const sigW = 130;
    const sigH = Math.round(sigW / sigAspect);
    // Place signature image inside the box, near the top
    pg.drawImage(si, { x: M + 14, y: sigBoxTop - 14 - sigH, width: sigW, height: sigH });
    // Move y below the signature image for text
    y = sigBoxTop - 14 - sigH - 4;
  }
  TXT(`Joe Lee - Owner, Party Favor Photo`, { sz: 11, font: tb, indent: 10 }); y += 4;
  TXT(`Date: ____________________`, { sz: 10, font: t, indent: 10 });
  y = sigBoxTop - 85 - 16;
  pg.drawRectangle({ x: M, y: y - 55, width: W, height: 55, color: C.lg, borderColor: C.gray, borderWidth: 0.5 });
  TXT(`Client Signature: ___________________________`, { sz: 11, font: t, indent: 10 }); y += 4;
  TXT(`Printed Name: _____________________________`, { sz: 10, font: t, indent: 10 }); y += 3;
  TXT(`Date: ____________________`, { sz: 10, font: t, indent: 10 });
  y = y - 55 - 14;

  // ═══ FOOTER ═══
  HR(1);
  TXT(`Party Favor Photo - bookings@partyfavorphoto.com - (202) 798-0610 - partyfavorphoto.com`, { sz: 8, font: t, color: C.gray, after: 1 });
  TXT(`Contract v1.2 - Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { sz: 7, font: t, color: C.gray });

  const bytes = await doc.save();
  writeFileSync(join(OUT, fname), bytes);
  console.log(`  ${fname} (${(bytes.length / 1024).toFixed(0)}KB, ${doc.getPageCount()} pages)`);
}

async function main() {
  console.log();
  for (const h of [2, 3, 4, 5, 6]) {
    console.log(`${h}-Hour:`);
    await build(h, false);
    await build(h, true);
  }
  console.log();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
