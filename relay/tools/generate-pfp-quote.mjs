#!/usr/bin/env node
/**
 * generate-pfp-quote.mjs — PFP Quote/Proposal Generator
 * 
 * Creates a professional quote PDF with:
 *   - Setup photos showcasing the StudioStation
 *   - Package recommendation
 *   - Pricing breakdown
 *   - Call to action
 * 
 * Usage: node generate-pfp-quote.mjs <client-name> <event-name> <hours> [standard|premium]
 * 
 * Example:
 *   node generate-pfp-quote.mjs "Hannah Kuhns" "DC JazzFest" 4 premium
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DATA = join(__dirname, '..', '..', 'relay-data');
const PHOTOS = join(__dirname, '..', '..', 'relay-data', 'pfp-assets');
const ASSETS = join(__dirname, '..', '..', '..', 'partyfavorphoto', 'src', 'assets');
const OUT = join(__dirname, '..', '..', 'reviews', 'quotes');
const LOGO = join(PHOTOS, 'pfplogo.png');
const SIG = join(RELAY_DATA, 'joe-signature.png');
mkdirSync(OUT, { recursive: true });

const C = {
  red: rgb(0.82, 0.18, 0.20),
  dark: rgb(0.15, 0.15, 0.15),
  gray: rgb(0.50, 0.50, 0.50),
  lg: rgb(0.92, 0.92, 0.92),
  white: rgb(1, 1, 1),
};

async function generate(client, event, hours, premium = false) {
  const label = premium ? 'Premium' : 'Standard';
  const rate = premium ? 349 : 249;
  const total = rate * hours;
  const disc = total - 100;
  const ptype = premium ? 'Premium 4x6 Prints' : '2x6 Photo Strips';
  const fname = `PFP-Quote-${event.replace(/[^a-zA-Z0-9]/g, '-')}-${hours}hr.pdf`;
  const fpath = join(OUT, fname);

  const doc = await PDFDocument.create();
  const h = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = await doc.embedFont(StandardFonts.TimesRoman);
  const tb = await doc.embedFont(StandardFonts.TimesRomanBold);

  let pg, y = 0;
  function NP() { pg = doc.addPage([612, 950]); y = 880; }
  NP();

  const M = 50, W = 512;

  const STRIPE_LINKS = { 2: '${stripeLink}', 3: 'https://buy.stripe.com/9B63cv9mH07j3eyeWObZe06', 4: 'https://buy.stripe.com/eVqcN556r4nz16qeWObZe04' };
  const stripeLink = STRIPE_LINKS[hours] || STRIPE_LINKS[4];

  function TXT(text, opts = {}) {
    const { sz = 11, color = C.dark, font = t, indent = 0, after = 0, align = 'left' } = opts;
    const lead = sz + 5;
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

  function HR() {
    if (y < 70) NP();
    pg.drawLine({ start: { x: M, y: y + 6 }, end: { x: 562, y: y + 6 }, thickness: 1, color: C.red });
    y -= 14;
  }

  // ═══ LOGO HEADER ═══
  if (existsSync(LOGO)) {
    const lb = readFileSync(LOGO);
    const li = await doc.embedPng(lb);
    const asp = li.width / li.height;
    pg.drawImage(li, { x: M, y: y - 50, width: 140, height: Math.round(140 / asp) });
  }

  TXT(``, { after: 60 }); // spacer

  // ═══ QUOTE HEADER ═══
  TXT(`PROPOSAL & QUOTE`, { sz: 22, font: h, color: C.red, align: 'right', after: 2 });
  TXT(`Prepared for: ${client}`, { sz: 13, align: 'right', after: 1 });
  TXT(`Event: ${event}`, { sz: 13, align: 'right', after: 1 });
  TXT(`Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { sz: 11, font: t, color: C.gray, align: 'right', after: 6 });
  HR();

  // ═══ ABOUT ═══
  TXT(`About Party Favor Photo`, { sz: 16, font: h, color: C.red, after: 4 });
  TXT(`We provide premium StudioStation photo experiences for festivals, conferences, weddings, and special events across Washington DC and Dallas/Fort Worth. Our professional bounce-diffused strobe lighting and DSLR cameras deliver editorial-quality photos that make every guest feel like a celebrity.`, { after: 2 });
  TXT(`Every booking includes a dedicated professional attendant, full setup and breakdown, custom branded templates, and both physical prints and digital delivery via QR code.`, { after: 6 });

  // ═══ SECOND IMAGE ═══
  const setupPaths = [
    join(PHOTOS, 'outdoorsetuppfp.png'),
    join(PHOTOS, 'setuppfp.png'),
    join(ASSETS, 'celebration-booth.jpg'),
  ];
  let setupImg = null;
  for (const p of setupPaths) {
    if (existsSync(p)) {
      try {
        const data = readFileSync(p);
        if (data[0] === 0xFF && data[1] === 0xD8) setupImg = await doc.embedJpg(data);
        else setupImg = await doc.embedPng(data);
        break;
      } catch {}
    }
  }
  if (setupImg) {
    if (y < 200) NP();
    const asp = setupImg.width / setupImg.height;
    const iw = 512;
    const ih = Math.round(iw / asp);
    pg.drawImage(setupImg, { x: M, y: y - ih, width: iw, height: ih });
    y -= ih + 6;
  }

  // ═══ NEW PAGE: RECOMMENDATION ═══
  NP();
  TXT(`Recommended Package`, { sz: 16, font: h, color: C.red, after: 6 });

  TXT(`${hours}-Hour ${label} StudioStation`, { sz: 14, font: tb, after: 2 });
  TXT(`${ptype} at $${rate}/hr`, { sz: 11, color: C.gray, after: 4 });

  TXT(`What's included:`, { sz: 11, font: tb, after: 2 });
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
  for (const inc of incs) TXT(`   - ${inc}`, { sz: 10, indent: 12, after: 1 });
  TXT(``, { after: 6 });

  // ═══ PRICING ═══
  TXT(`Pricing Summary`, { sz: 16, font: h, color: C.red, after: 4 });

  const pricingBox = y - 100;
  pg.drawRectangle({ x: M, y: pricingBox, width: W, height: 100, color: C.lg });
  
  TXT(`Package Total: $${total}`, { sz: 18, font: h, indent: 12 }); y += 4;
  TXT(`$${rate}/hr x ${hours} hours`, { sz: 11, font: t, color: C.gray, indent: 12 }); y += 3;
  TXT(``, { indent: 12 }); y += 3;
  TXT(`Discounted Rate: $${disc}`, { sz: 14, font: tb, indent: 12 });
  TXT(`With military, school, or pay-in-full discount (-$${100})`, { sz: 9, font: t, color: C.gray, indent: 12 });
  y = pricingBox - 12;

  TXT(``, { after: 4 });
  TXT(`Optional Add-Ons:`, { sz: 11, font: tb, after: 2 });
  TXT(`   Second Attendant - $350`, { sz: 10, indent: 12, after: 1 });
  TXT(`   Social Media Content Reel - $200`, { sz: 10, indent: 12, after: 1 });
  TXT(`   Premium Backdrop Upgrade - $150`, { sz: 10, indent: 12, after: 6 });

  // ═══ CALL TO ACTION ═══
  TXT(`Next Steps`, { sz: 16, font: h, color: C.red, after: 4 });
  TXT(`To accept this proposal and secure your date:`, { after: 2 });
  TXT(`   1. Reply to this email or call (202) 798-0610`, { sz: 10, indent: 12, after: 1 });
  TXT(`   2. Choose your package and any add-ons`, { sz: 10, indent: 12, after: 1 });
  TXT(`   3. Pay 50% deposit to lock in your booking`, { sz: 10, indent: 12, after: 1 });
  TXT(`   4. Sign the contract (we'll send it over)`, { sz: 10, indent: 12, after: 4 });
  TXT(`Book instantly:`, { sz: 11, font: tb, after: 1 });
  TXT(`   ${stripeLink}`, { sz: 10, indent: 12, color: C.red, after: 6 });

  // ═══ FOOTER ═══
  HR();
  TXT(`Party Favor Photo - bookings@partyfavorphoto.com - (202) 798-0610 - partyfavorphoto.com`, { sz: 8, color: C.gray, after: 1 });
  TXT(`Licensed & Insured - $1M General Liability Coverage`, { sz: 8, color: C.gray });

  const bytes = await doc.save();
  writeFileSync(fpath, bytes);
  console.log(`  ${fname} (${(bytes.length / 1024).toFixed(0)}KB, ${doc.getPageCount()} pages)`);
}

async function main() {
  const client = process.argv[2] || 'Client Name';
  const event = process.argv[3] || 'Your Event';
  const hours = parseInt(process.argv[4]) || 4;
  const premium = process.argv[5] === 'premium';

  console.log(`\nGenerating quote for ${client} - ${event} - ${hours}hr ${premium ? 'Premium' : 'Standard'}\n`);
  await generate(client, event, hours, premium);
  console.log(`\nSaved to: ${join(OUT, `PFP-Quote-${event.replace(/[^a-zA-Z0-9]/g, '-')}-${hours}hr.pdf`)}\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
