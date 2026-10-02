#!/usr/bin/env node
/**
 * generate-pfp-contract.mjs - Generates a Party Favor Photo Service Contract PDF
 * 
 * Creates a professional contract with:
 *   - PFP logo header
 *   - Client and event details
 *   - Service terms and conditions
 *   - Pricing and payment terms
 *   - Signature lines for both parties
 * 
 * Usage: node generate-pfp-contract.mjs [output.pdf]
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DATA = join(__dirname, '..', '..', 'relay-data');
const LOGO_PATH = join(RELAY_DATA, 'pfp-logo.png');
const SIGNATURE_PATH = join(RELAY_DATA, 'joe-signature.png');

const CONTRACT_VERSION = 'v1.0 - May 2026';

// ── Colors ──────────────────────────────────────────────────
const COLORS = {
  primary: rgb(0.82, 0.18, 0.20),    // Rich red (PFP brand)
  dark: rgb(0.15, 0.15, 0.15),       // Near-black
  gray: rgb(0.45, 0.45, 0.45),       // Muted text
  lightGray: rgb(0.92, 0.92, 0.92),  // Background tint
  white: rgb(1, 1, 1),
  black: rgb(0, 0, 0),
  accent: rgb(0.95, 0.75, 0.15),     // Gold accent
};

// ── Text helpers ────────────────────────────────────────────
function wrapText(text, maxWidth, font, size) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Build Contract ──────────────────────────────────────────
async function generateContract(outputPath, data = {}) {
  console.log('📄 Generating PFP Service Contract...');
  
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([612, 950]); // US Letter-ish with extra height
  const { width, height } = page.getSize();
  const margin = 50;
  const contentWidth = width - margin * 2;
  let y = height - margin;

  // ── Helper: draw text with optional bold prefix ──────────
  function drawText(text, opts = {}) {
    const {
      x = margin,
      size = 10,
      color = COLORS.dark,
      bold = false,
      maxWidth = contentWidth,
      leading = 14,
      indent = 0,
    } = opts;
    
    const f = bold ? fontBold : font;
    const lines = wrapText(text, maxWidth - indent, f, size);
    for (const line of lines) {
      if (y < margin + 20) {
        // Add new page if we run out of space
        return false;
      }
      page.drawText(line, { x: x + indent, y, size, font: f, color });
      y -= leading;
    }
    return true;
  }

  function drawLine(yPos, color = COLORS.lightGray, thickness = 1) {
    page.drawLine({
      start: { x: margin, y: yPos },
      end: { x: width - margin, y: yPos },
      thickness,
      color,
    });
  }

  // ══════════════════════════════════════════════════════════
  // HEADER: Logo + Title
  // ══════════════════════════════════════════════════════════
  
  // Logo
  if (existsSync(LOGO_PATH)) {
    const logoBytes = readFileSync(LOGO_PATH);
    const logoImage = await pdfDoc.embedPng(logoBytes);
    const logoDims = logoImage.scale(0.4);
    page.drawImage(logoImage, {
      x: margin,
      y: y - logoDims.height,
      width: logoDims.width,
      height: logoDims.height,
    });
  }

  // Title block - right aligned
  const titleX = width - margin;
  page.drawText('SERVICE AGREEMENT', {
    x: titleX - fontBold.widthOfTextAtSize('SERVICE AGREEMENT', 22),
    y: y - 5,
    size: 22,
    font: fontBold,
    color: COLORS.primary,
  });
  y -= 30;
  page.drawText('Photo Booth & Event Photography Contract', {
    x: titleX - font.widthOfTextAtSize('Photo Booth & Event Photography Contract', 12),
    y,
    size: 12,
    font,
    color: COLORS.gray,
  });
  y -= 18;
  page.drawText(`Version: ${CONTRACT_VERSION}`, {
    x: titleX - font.widthOfTextAtSize(`Version: ${CONTRACT_VERSION}`, 8),
    y,
    size: 8,
    font,
    color: COLORS.gray,
  });

  // Logo height adjustment
  if (existsSync(LOGO_PATH)) {
    const logoBytes = readFileSync(LOGO_PATH);
    const logoImage = await pdfDoc.embedPng(logoBytes);
    const logoDims = logoImage.scale(0.4);
    y = Math.min(y - 20, height - margin - logoDims.height - 30);
  } else {
    y -= 40;
  }

  drawLine(y, COLORS.primary, 2);
  y -= 25;

  // ══════════════════════════════════════════════════════════
  // PARTIES
  // ══════════════════════════════════════════════════════════
  
  drawText('THIS AGREEMENT is made on ____________________, 20____', { size: 10, bold: false });
  y -= 8;
  drawText('between:', { size: 10, bold: true, color: COLORS.primary });
  y -= 4;

  // Provider box
  const boxY = y;
  const boxH = 65;
  page.drawRectangle({
    x: margin, y: y - boxH, width: contentWidth, height: boxH,
    color: COLORS.lightGray, borderColor: COLORS.lightGray, borderWidth: 1,
  });
  y -= 10;
  drawText('PARTY FAVOR PHOTO ("Provider")', { x: margin + 10, size: 10, bold: true });
  y -= 16;
  drawText('Joe Lee, Owner', { x: margin + 10, size: 9 });
  y -= 14;
  drawText('bookings@partyfavorphoto.com | (202) 798-0610', { x: margin + 10, size: 9 });
  y -= 14;
  drawText('partyfavorphoto.com', { x: margin + 10, size: 9, color: COLORS.primary });
  
  y = boxY - boxH - 20;
  
  drawText('and', { size: 10 });
  y -= 18;
  
  // Client box
  const clientBoxY = y;
  const clientBoxH = 55;
  page.drawRectangle({
    x: margin, y: y - clientBoxH, width: contentWidth, height: clientBoxH,
    color: COLORS.lightGray, borderColor: COLORS.lightGray, borderWidth: 1,
  });
  y -= 10;
  drawText('_________________________________ ("Client")', { x: margin + 10, size: 10, bold: false });
  y -= 16;
  drawText('Client Email: _____________________________', { x: margin + 10, size: 9 });
  y -= 14;
  drawText('Client Phone: _____________________________', { x: margin + 10, size: 9 });
  y = clientBoxY - clientBoxH - 25;

  // ══════════════════════════════════════════════════════════
  // EVENT DETAILS
  // ══════════════════════════════════════════════════════════
  
  drawText('1. EVENT DETAILS', { size: 12, bold: true, color: COLORS.primary });
  y -= 6;
  drawLine(y);
  y -= 16;

  const fields = [
    ['Event Name:', '_________________________________'],
    ['Event Date(s):', '_________________________________'],
    ['Event Location:', '_________________________________'],
    ['Setup Time:', '_________________________________'],
    ['Event Hours:', '_________________________________'],
    ['Contact Person:', '_________________________________'],
    ['Contact Phone:', '_________________________________'],
  ];
  for (const [label, value] of fields) {
    drawText(label, { size: 10, bold: true });
    y -= 2;
    drawText(value, { size: 10, color: COLORS.gray });
    y -= 16;
  }

  // ══════════════════════════════════════════════════════════
  // SERVICES
  // ══════════════════════════════════════════════════════════
  
  drawText('2. SERVICES', { size: 12, bold: true, color: COLORS.primary });
  y -= 6;
  drawLine(y);
  y -= 16;

  const services = [
    'Provider shall deliver the Party Favor Photo StudioStation experience at the event',
    'listed above, including the following:',
    '',
    '  * Professional StudioStation with bounce-diffused strobe lighting',
    '  * Professional DSLR cameras for editorial-quality photography',
    '  * Custom branded photo templates matching event aesthetics',
    '  * Unlimited branded 4×6 physical prints',
    '  * Digital photo delivery via QR code and text',
    '  * Professional attendant for all event hours',
    '  * Full setup and breakdown at designated location',
    '  * AI watercolor portrait generation (where applicable)',
    '',
    'Additional services (check if applicable):',
    '  [ ] Professional corporate headshot station  - Add $250',
    '  [ ] Second attendant - Add $350',
    '  [ ] Extended hours (beyond 4hr package) - $150/hr',
    '  [ ] Social media content reel (60s highlight) - $200',
  ];
  for (const line of services) {
    drawText(line, { size: 9 });
    if (line === '') y -= 4;
  }
  y -= 10;

  // ══════════════════════════════════════════════════════════
  // PRICING
  // ══════════════════════════════════════════════════════════
  
  drawText('3. PRICING & PAYMENT', { size: 12, bold: true, color: COLORS.primary });
  y -= 6;
  drawLine(y);
  y -= 16;

  const pricing = [
    'Package Selected:  [ ] 2hr ($498)  [ ] 3hr ($747)  [ ] 4hr ($996)  [ ] Custom: $________',
    'Additional Services (from Section 2): $________',
    'Military / Non-Profit Discount (-$100): [ ] Yes  [ ] No',
    '',
    'TOTAL FEE: $_________________________________',
    '',
    'Deposit Due (50%): $________',
    'Balance Due (due 7 days before event): $________',
    '',
    'Payment Methods:  [ ] Credit/Debit  [ ] Bank Transfer  [ ] Cash  [ ] Check',
    '',
    'Cancellation Policy:',
    '  * Cancellations 14+ days before event: Full refund less $50 processing fee',
    '  * Cancellations 7-13 days before event: 50% refund',
    '  * Cancellations less than 7 days before event: No refund',
    '  * Provider reserves right to cancel with full refund in case of emergency',
  ];
  for (const line of pricing) {
    drawText(line, { size: 9 });
    if (line === '') y -= 4;
  }
  y -= 10;

  // ══════════════════════════════════════════════════════════
  // TERMS
  // ══════════════════════════════════════════════════════════
  
  drawText('4. TERMS & CONDITIONS', { size: 12, bold: true, color: COLORS.primary });
  y -= 6;
  drawLine(y);
  y -= 16;

  const terms = [
    '4.1 Setup & Space Requirements. Client shall provide a clean, dry 10×10 ft (minimum)',
    '     covered area for the StudioStation. Provider requires access to the setup location',
    '     at least 2 hours before event start time. Outdoor events require overhead cover.',
    '4.2 Power. StudioStation operates on battery for up to 4 hours. For extended events,',
    '     Client shall provide access to a standard 120V electrical outlet within 50 ft.',
    '4.3 Liability & Insurance. Provider carries $1M general liability insurance. Provider is',
    '     not responsible for injuries sustained by guests using the photo station. Client shall',
    '     ensure the venue has appropriate liability coverage for all vendors.',
    '4.4 Photo Usage Rights. Provider retains the right to use photos from the event for',
    '     portfolio, marketing, and social media purposes unless expressly opted out in writing.',
    '     Client and event attendees receive unlimited personal usage rights to their photos.',
    '4.5 Damages. Client is responsible for damage to Provider equipment caused by guests',
    '     of the event beyond normal wear and tear. Provider shall document pre-existing',
    '     condition of all equipment prior to setup.',
    '4.6 Force Majeure. Neither party shall be liable for failure to perform due to causes',
    '     beyond reasonable control including but not limited to: acts of God, natural disasters,',
    '     pandemic, government action, civil unrest, or utility failure.',
    '4.7 Governing Law. This agreement shall be governed by the laws of the District of',
    '     Columbia and any applicable state laws where the event takes place.',
  ];
  for (const line of terms) {
    drawText(line, { size: 8.5, leading: 12 });
  }
  y -= 15;

  // ══════════════════════════════════════════════════════════
  // SIGNATURES
  // ══════════════════════════════════════════════════════════
  
  // Check if we need a new page
  if (y < 200) {
    const newPage = pdfDoc.addPage([612, 792]);
    y = 792 - margin;
  }

  drawText('5. SIGNATURES', { size: 12, bold: true, color: COLORS.primary });
  y -= 6;
  drawLine(y);
  y -= 20;

  // Provider signature
  page.drawRectangle({
    x: margin, y: y - 90, width: contentWidth, height: 90,
    color: COLORS.lightGray, borderColor: COLORS.lightGray, borderWidth: 1,
  });
  y -= 10;
  
  // Joe's signature image
  if (existsSync(SIGNATURE_PATH)) {
    const sigBytes = readFileSync(SIGNATURE_PATH);
    const sigImage = await pdfDoc.embedPng(sigBytes);
    page.drawImage(sigImage, {
      x: margin + 15,
      y,
      width: 120,
      height: 35,
    });
  }
  
  y -= 5;
  drawText('Joe Lee - Owner, Party Favor Photo', { x: margin + 15, size: 10, bold: true });
  y -= 14;
  drawText('Date: ____________________', { x: margin + 15, size: 9 });
  
  y = y - 90 - 30;

  // Client signature
  page.drawRectangle({
    x: margin, y: y - 60, width: contentWidth, height: 60,
    color: COLORS.lightGray, borderColor: COLORS.lightGray, borderWidth: 1,
  });
  y -= 15;
  drawText('Client Signature: ___________________________', { x: margin + 15, size: 10 });
  y -= 16;
  drawText('Printed Name: _____________________________', { x: margin + 15, size: 9 });
  y -= 14;
  drawText('Date: ____________________', { x: margin + 15, size: 9 });
  
  y = y - 60 - 25;

  // ══════════════════════════════════════════════════════════
  // FOOTER
  // ══════════════════════════════════════════════════════════
  
  drawLine(y, COLORS.primary, 1);
  y -= 14;
  drawText('Party Favor Photo - bookings@partyfavorphoto.com - (202) 798-0610 - partyfavorphoto.com', {
    size: 8,
    color: COLORS.gray,
    maxWidth: contentWidth,
  });
  y -= 12;
  drawText(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, {
    size: 7,
    color: COLORS.gray,
  });

  // ══════════════════════════════════════════════════════════
  // SAVE
  // ══════════════════════════════════════════════════════════
  
  const pdfBytes = await pdfDoc.save();
  writeFileSync(outputPath, pdfBytes);
  console.log(`✅ Contract saved: ${outputPath} (${pdfBytes.length} bytes)`);
  return outputPath;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const outputPath = process.argv[2] || join(RELAY_DATA, 'PFP-Service-Contract.pdf');
  await generateContract(outputPath);
  console.log('\n📋 Open the PDF to review. It includes:');
  console.log('  * PFP logo header');
  console.log('  * Event details form fields');
  console.log('  * Service description with add-ons');
  console.log('  * Pricing & payment terms');
  console.log('  * Full terms & conditions');
  console.log('  * Joe\'s signature (pre-signed)');
  console.log('  * Client signature line');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
