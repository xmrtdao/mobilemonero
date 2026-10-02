#!/usr/bin/env node
// Generate a JOBBY_TOKEN_KEY and append it to relay/.env if absent.
//
// A Google refresh token is a mailbox credential. This key is the only thing
// standing between that token and a readable database column, so it is
// generated from the system CSPRNG and never derived from anything guessable.
//
//   node relay/scripts/gen-token-key.mjs
//   node relay/scripts/gen-token-key.mjs --force   (rotate: existing tokens break)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const force = process.argv.includes('--force');

if (!existsSync(ENV_PATH)) {
  console.error(`No ${ENV_PATH} found. Create it first (it holds the relay's other secrets).`);
  process.exit(1);
}

const env = readFileSync(ENV_PATH, 'utf8');
const existing = env.match(/^\s*JOBBY_TOKEN_KEY\s*=\s*(.+)$/m);

if (existing && !force) {
  console.log('JOBBY_TOKEN_KEY is already set. Nothing to do.');
  console.log('Use --force to generate a new one.');
  console.log('');
  console.log('WARNING: rotating invalidates every stored Google token.');
  console.log('Anyone affected must reconnect their Google account.');
  process.exit(0);
}

if (existing && force) {
  const key = randomBytes(32).toString('hex');
  const replaced = env.replace(/^\s*JOBBY_TOKEN_KEY\s*=\s*.+$/m, `JOBBY_TOKEN_KEY=${key}`);
  writeFileSync(ENV_PATH, replaced, 'utf8');
  console.log('JOBBY_TOKEN_KEY rotated in .env');
  console.log('Every stored Google token is now unreadable and must be reconnected.');
  process.exit(0);
}

const key = randomBytes(32).toString('hex');
const block = [
  '',
  '# Jobby — encryption key for stored Google OAuth tokens (AES-256-GCM).',
  '# Losing this makes every connected account unreadable. Rotating it does the same.',
  '# Generate with: node relay/scripts/gen-token-key.mjs',
  `JOBBY_TOKEN_KEY=${key}`,
  '',
].join('\n');

appendFileSync(ENV_PATH, block, 'utf8');
try { chmodSync(ENV_PATH, 0o600); } catch { /* best effort on Windows */ }

console.log('JOBBY_TOKEN_KEY added to relay/.env');
console.log(`  ${key.slice(0, 8)}…${key.slice(-4)} (${key.length / 2} bytes)`);
console.log('');
console.log('Restart the relay for it to take effect:');
console.log('  node -e "require(\'fs\').writeFileSync(\'relay-data/service-actions.json\',JSON.stringify([{action:\'restart\',service:\'relay\',requestedBy:\'token-key\',processedAt:null}],null,2))"');
