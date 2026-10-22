#!/usr/bin/env node
/**
 * relay/scripts/write-brand-guides.mjs — regenerate the brand guides.
 *
 * The guides in docs/brands/ are generated from relay/lib/tenants.mjs, so
 * they cannot say something the mailer does not do. That is the whole
 * point: a style guide an agent reads has to be the style the mailer
 * follows, and the only way to guarantee that is to have one source.
 *
 *   node relay/scripts/write-brand-guides.mjs            write them
 *   node relay/scripts/write-brand-guides.mjs --check     fail if they are stale
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');
const ROOT = path.join(RELAY, '..');

const { allBrandGuides } = await import(pathToFileURL(path.join(RELAY, 'lib', 'brand-guide.mjs')).href);

const check = process.argv.includes('--check');
const dir = path.join(ROOT, 'docs', 'brands');
fs.mkdirSync(dir, { recursive: true });

const guides = allBrandGuides();
let stale = 0;

for (const [domain, body] of Object.entries(guides)) {
  const file = path.join(dir, `${domain}.md`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === body) {
    console.log(`  ${domain}.md  up to date`);
    continue;
  }
  if (check) {
    console.log(`  ${domain}.md  STALE`);
    stale++;
    continue;
  }
  fs.writeFileSync(file, body, 'utf8');
  console.log(`  ${domain}.md  written (${body.length} bytes)`);
}

// An index, so an agent that does not know which tenant it is working for
// can find the right guide.
const index = [
  '# Brand guides',
  '',
  'One guide per tenant. Each is generated from `relay/lib/tenants.mjs`,',
  'which is the same file the mailer reads, so a guide cannot describe a',
  'brand the mailer does not use.',
  '',
  'Regenerate with `node relay/scripts/write-brand-guides.mjs`.',
  '',
  ...Object.entries(guides).map(([domain, body]) => {
    const title = (body.match(/^# (.+)$/m) || [])[1] || domain;
    const focus = (body.match(/^## What this brand is\n\n(.+)$/m) || [])[1] || '';
    return `- [${title}](./${domain}.md) - \`${domain}\`${focus ? ` - ${focus}` : ''}`;
  }),
  '',
].join('\n');

const indexFile = path.join(dir, 'README.md');
const existingIndex = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : null;
if (existingIndex !== index) {
  if (check) {
    console.log('  README.md  STALE');
    stale++;
  } else {
    fs.writeFileSync(indexFile, index, 'utf8');
    console.log(`  README.md  written (${index.length} bytes)`);
  }
} else {
  console.log('  README.md  up to date');
}

if (check && stale) {
  console.error(`\n${stale} guide file(s) are stale. Run: node relay/scripts/write-brand-guides.mjs`);
  process.exit(1);
}
process.exit(0);
