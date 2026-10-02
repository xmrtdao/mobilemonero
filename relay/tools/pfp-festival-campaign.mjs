#!/usr/bin/env node
/**
 * PFP Festival Partnership Campaign — Issue #24
 * Sends 40 individualized partnership emails to DC + Dallas summer festivals
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = path.join(__dirname, '..', '.env');
const env = fs.readFileSync(envPath, 'utf8').split('\n').reduce((acc, line) => {
  const [k, ...v] = line.split('=');
  if (k) acc[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
  return acc;
}, {});
const KEY = env.RESEND_API_KEY;
const API = 'https://api.resend.com/emails';

// ── 40 Festival Contacts ──────────────────────────────────
const festivals = [
  // ===== DC AREA (20) =====
  { email: 'dcbp@centerforblackequity.org', name: 'DC Black Pride', topic: 'festival', date: 'May 22-25' },
  { email: 'mike@capitalpride.org', name: 'Capital Pride Festival', topic: 'festival', date: 'June 21' },
  { email: 'info@dcjazzfest.org', name: 'DC JazzFest', topic: 'festival', date: 'Sept 5-6' },
  { email: 'info@fiestadc.org', name: 'Fiesta DC', topic: 'festival', date: 'Sept 26-27' },
  { email: 'booths@fiestadc.org', name: 'Fiesta DC (Booths)', topic: 'festival', date: 'Sept 26-27' },
  { email: 'info@quartertonez.com', name: 'DC Arab American Culture Festival', topic: 'festival', date: 'Summer 2026' },
  { email: 'ideas@danceplace.org', name: 'DanceAfrica DC', topic: 'festival', date: 'June 1-7' },
  { email: 'dccolombianfestival@gmail.com', name: 'Colombian Festival DC', topic: 'festival', date: 'July 19' },
  { email: 'filmfestdc@filmfestdc.org', name: 'Filmfest DC', topic: 'festival', date: 'Annual' },
  { email: 'kelly@dcjazzfest.org', name: 'DC JazzFest (Vendor Ops)', topic: 'conference', date: 'Sept 5-6' },
  { email: 'info@bbqdc.com', name: 'Giant Barbecue Battle', topic: 'festival', date: 'June 27-28' },
  { email: 'festival@si.edu', name: 'Smithsonian 250th Festival', topic: 'festival', date: 'June 18-July 12' },
  { email: 'charlene.louis@dc.gov', name: 'DC Art All Night', topic: 'festival', date: 'September' },
  { email: 'info@homerulemusicfestival.com', name: 'Home Rule Music Festival', topic: 'festival', date: 'June 20 + Oct 3' },
  { email: 'festival@hyattsvillecdc.org', name: 'Hyattsville Arts Festival', topic: 'festival', date: 'Fall 2026' },
  { email: 'info@washingtonfestival.com', name: 'Old Washington Street Festival', topic: 'festival', date: 'Summer 2026' },
  { email: 'hello@dccherryblossom.org', name: 'National Cherry Blossom Festival', topic: 'festival', date: 'March-April' },
  { email: 'info@silverdocs.com', name: 'SILVERDOCS Documentary Festival', topic: 'festival', date: 'June' },
  { email: 'events@nationals.com', name: 'Nationals Park Events', topic: 'conference', date: 'Seasonal' },
  { email: 'info@dcstadium.com', name: 'DC Stadium Events', topic: 'conference', date: 'Seasonal' },

  // ===== DALLAS AREA (20) =====
  { email: 'vendors@dallaspride.org', name: 'Dallas Pride Festival', topic: 'festival', date: 'June 6' },
  { email: 'info@dallascountryfestival.com', name: 'Dallas Country Music & Arts Festival', topic: 'festival', date: 'Multiple dates' },
  { email: 'vendors@dallascountryfestival.com', name: 'Dallas Country Fest (Vendors)', topic: 'festival', date: 'Multiple dates' },
  { email: 'warmanvijay@gmail.com', name: 'Dallas Festival of Colors', topic: 'festival', date: 'Spring 2026' },
  { email: 'info@dfwafricafest.com', name: 'DFW Africa Fest', topic: 'festival', date: 'Summer 2026' },
  { email: 'info@dallasworldfestival.org', name: 'Dallas World Festival', topic: 'festival', date: 'Summer 2026' },
  { email: 'events@dallaszoo.com', name: 'Dallas Zoo Events', topic: 'conference', date: 'Year-round' },
  { email: 'sponsor@dfwae.org', name: 'DFW Airport Expo', topic: 'conference', date: 'Annual' },
  { email: 'conference@apha.org', name: 'APHA Conference', topic: 'conference', date: 'Fall 2026' },
  { email: 'events@kennedy-center.org', name: 'Kennedy Center Events', topic: 'festival', date: 'Year-round' },
  { email: 'info@dallasarthfair.com', name: 'Dallas Art Fair', topic: 'conference', date: 'Spring 2026' },
  { email: 'hello@dallasdesigndistrict.com', name: 'Dallas Design District Events', topic: 'festival', date: 'Year-round' },
  { email: 'events@dallasarboretum.org', name: 'Dallas Arboretum Events', topic: 'festival', date: 'Year-round' },
  { email: 'tbaalriverfrontjazz@gmail.com', name: 'Riverfront Jazz Festival', topic: 'festival', date: 'Sept 4-6' },
  { email: 'info@dallasfarmersmarket.org', name: 'Dallas Farmers Market Events', topic: 'festival', date: 'Year-round' },
  { email: 'sponsorship@dallaspride.org', name: 'Dallas Pride (Sponsorship)', topic: 'conference', date: 'June 6' },
  { email: 'info@deepellumfest.com', name: 'Deep Ellum Arts Festival', topic: 'festival', date: 'Spring 2026' },
  { email: 'vendors@texasstatefair.org', name: 'State Fair of Texas', topic: 'conference', date: 'Sept-Oct' },
  { email: 'info@dallasobserver.com', name: 'Dallas Observer Events', topic: 'festival', date: 'Year-round' },
  { email: 'info@klydewarrenpark.org', name: 'Klyde Warren Park Events', topic: 'festival', date: 'Year-round' },
];

// ── Email Body Generator ──────────────────────────────────
function buildEmail(festival) {
  const isConference = festival.topic === 'conference';
  const festivalName = festival.name;
  const festivalDate = festival.date;

  const subject = `Party Favor Photo x ${festivalName} — Partnership Opportunity`;

  const body = isConference
    ? `Hi there,

I'm Joe, the owner of Party Favor Photo. We provide premium photo experiences for conferences and corporate events across the DC and Dallas areas.

What makes us different: we serve events from both ends.

**Morning — Professional Corporate Headshots**
Set up in the conference hall. Attendees get polished, professional headshots for LinkedIn, badges, and company directories. No hunting people down later.

**Evening — Branded Photo Booth**
Custom templates, props, instant sharing. Keeps people networking longer and creates shareable content that promotes your event.

Double the value from a single vendor booking.

We're reaching out because ${festivalName} (${festivalDate}) sounds like the perfect fit. We handle all equipment, staffing, printing, and brand integration.

Would you be open to a quick call to discuss a partnership?

Warmly,
Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com`

    : `Hi there,

I'm Joe, the owner of Party Favor Photo — an award-winning photo booth company serving the DC and Dallas areas.

We specialize in becoming a festival's **official photo station**. We blend into your brand identity, set up a professional photo experience, and send visitors home with a branded 4×6 physical print that reminds them to come back next year.

**Why festivals love working with us:**
- We handle ALL equipment, staffing, printing
- Custom branded template that matches your festival's aesthetic
- Instant QR code sharing for social media amplification
- Physical prints = year-round marketing (that print lives on their fridge)
- We're self-contained — tent, lights, generator, no power needed from you

We'd love to be part of ${festivalName} (${festivalDate}). We can offer a partnership model that works for your budget — including revenue share options.

Reply to this email or give me a call — I'd love to chat about making ${festivalName} even more memorable.

Warmly,
Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com
5.0 ★ on The Knot & WeddingWire`;

  return { subject, body };
}

// ── Sender ────────────────────────────────────────────────
function sendEmail(entry) {
  return new Promise((resolve) => {
    const { subject, body } = buildEmail(entry);
    const payload = JSON.stringify({
      from: 'bookings@partyfavorphoto.com',
      to: [entry.email],
      subject,
      text: body,
    });

    const req = https.request(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ok = data.includes('"id"');
        resolve({ email: entry.email, ok, name: entry.name });
      });
    });
    req.on('error', () => resolve({ email: entry.email, ok: false, name: entry.name }));
    req.write(payload);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`PFP Festival Campaign — ${festivals.length} targets\n`);

  let sent = 0, errors = 0;
  for (let i = 0; i < festivals.length; i++) {
    const entry = festivals[i];
    const result = await sendEmail(entry);
    if (result.ok) {
      sent++;
      process.stdout.write('✓');
    } else {
      errors++;
      process.stdout.write('✗');
    }
    // Avoid rate limiting — 200ms between sends
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\nDone: ${sent} sent, ${errors} errors`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
