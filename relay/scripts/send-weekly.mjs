#!/usr/bin/env node
/**
 * relay/scripts/send-weekly.mjs — put a tenant's weekly in a mailbox.
 *
 * The site is a place you have to visit. A weekly that arrives is the same
 * information in a channel that reaches people who never open a browser.
 *
 * The recipient list is a flag, not a guess: this sends where it is told
 * to send, and it prints the addresses it used.
 *
 *   node relay/scripts/send-weekly.mjs --tenant mobilemonero --to someone@example.com
 *   node relay/scripts/send-weekly.mjs --tenant 31harbor --to a@x.com --dry-run
 *   node relay/scripts/send-weekly.mjs --tenant jobby --to a@x.com --subject "Your week"
 *
 * The From address is the TENANT's, so the brand, the colours and the
 * stylesheet all come from the tenant - the sender does not choose them.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');

const { buildWeekly } = await import(pathToFileURL(path.join(RELAY, 'lib', 'weekly.mjs')).href);
const { TENANTS } = await import(pathToFileURL(path.join(RELAY, 'lib', 'tenants.mjs')).href);

const args = process.argv.slice(2);
const to = [];
let dryRun = false;
let subject = '';
let tenant = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--to') to.push(args[++i]);
  else if (args[i] === '--tenant') tenant = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--subject') subject = args[++i];
}

if (!to.length || !tenant) {
  console.error('usage: send-weekly.mjs --tenant <key> --to <address> [--to <address> ...] [--dry-run] [--subject <text>]');
  console.error(`  tenants: ${Object.keys(TENANTS).join(', ')}`);
  process.exit(2);
}

console.log(`[weekly] ${tenant}: gathering live data...`);
let weekly;
try {
  weekly = await buildWeekly({ tenant, subject: subject || undefined });
} catch (e) {
  console.error(`[weekly] ${tenant} failed: ${e.message}`);
  process.exit(1);
}

console.log(`[weekly] ${tenant} issue ${weekly.issue} - subject "${weekly.subject}"`);
console.log(`[weekly] html ${weekly.html.length} bytes, text ${weekly.text.length} bytes`);
for (const note of weekly.missing) console.log(`[weekly] MISSING: ${note}`);

if (dryRun) {
  const out = 'C:/Users/PureTrek/AppData/Local/Temp/opencode/pipeline-scratch';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/weekly-${tenant}.html`, weekly.html);
  fs.writeFileSync(`${out}/weekly-${tenant}.txt`, weekly.text);
  console.log(`[weekly] dry run - wrote the preview for ${tenant}, sent nothing`);
  process.exit(0);
}

const { sendMail } = await import(pathToFileURL(path.join(RELAY, 'lib', 'agent-email.mjs')).href);
const { resendKeyFor } = await import(pathToFileURL(path.join(RELAY, 'lib', 'domain-keys.mjs')).href);

const from = weekly.tenant.from;
const apiKey = resendKeyFor(weekly.tenant.domain);
if (!apiKey) {
  console.error(`[weekly] no Resend key for ${weekly.tenant.domain} - not sending`);
  process.exit(1);
}

for (const address of to) {
  const sent = await sendMail({
    apiKey,
    from,
    to: address,
    subject: weekly.subject,
    body: weekly.text,
    html: weekly.html,
  });
  if (sent.error) {
    console.error(`[weekly] ${address} FAILED: ${JSON.stringify(sent.error).slice(0, 200)}`);
  } else {
    console.log(`[weekly] sent to ${address} (${sent.id})`);
  }
}
process.exit(0);
