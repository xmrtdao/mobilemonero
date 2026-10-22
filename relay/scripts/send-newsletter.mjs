#!/usr/bin/env node
/**
 * relay/scripts/send-newsletter.mjs — put the weekly in a mailbox.
 *
 * The site is a place you have to visit. A weekly that arrives is the same
 * information in a channel that reaches people who never open a browser.
 *
 * The recipient list is a flag, not a guess: this sends where it is told to
 * send, and it prints the addresses it used.
 *
 *   node relay/scripts/send-newsletter.mjs --to someone@example.com
 *   node relay/scripts/send-newsletter.mjs --to a@x.com --to b@y.com --dry-run
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');

const { buildNewsletter } = await import(pathToFileURL(path.join(RELAY, 'lib', 'newsletter.mjs')).href);
const { sendMail } = await import(pathToFileURL(path.join(RELAY, 'lib', 'agent-email.mjs')).href);

const args = process.argv.slice(2);
const to = [];
let dryRun = false;
let subject = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--to') to.push(args[++i]);
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--subject') subject = args[++i];
}

if (!to.length) {
  console.error('usage: send-newsletter.mjs --to <address> [--to <address> ...] [--dry-run] [--subject <text>]');
  process.exit(2);
}

console.log('[newsletter] gathering live data...');
const newsletter = await buildNewsletter({ subject: subject || undefined });

console.log(`[newsletter] issue ${newsletter.issue}`);
console.log(`[newsletter] html ${newsletter.html.length} bytes, text ${newsletter.text.length} bytes`);
for (const note of newsletter.missing) console.log(`[newsletter] MISSING: ${note}`);

if (dryRun) {
  const fs = await import('node:fs');
  const out = 'C:/Users/PureTrek/AppData/Local/Temp/opencode/pipeline-scratch';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/newsletter.html`, newsletter.html);
  fs.writeFileSync(`${out}/newsletter.txt`, newsletter.text);
  console.log(`[newsletter] dry run - wrote the preview, sent nothing`);
  process.exit(0);
}

const { resendKeyFor } = await import(pathToFileURL(path.join(RELAY, 'lib', 'domain-keys.mjs')).href);

const FROM = 'MobileMonero <hello@mobilemonero.com>';
const apiKey = resendKeyFor('mobilemonero.com');
if (!apiKey) {
  console.error('[newsletter] no Resend key for mobilemonero.com - not sending');
  process.exit(1);
}

for (const address of to) {
  const sent = await sendMail({
    apiKey,
    from: FROM,
    to: address,
    subject: newsletter.subject,
    body: newsletter.text,
    html: newsletter.html,
  });
  if (sent.error) {
    console.error(`[newsletter] ${address} FAILED: ${JSON.stringify(sent.error).slice(0, 200)}`);
  } else {
    console.log(`[newsletter] sent to ${address} (${sent.id})`);
  }
}
process.exit(0);
