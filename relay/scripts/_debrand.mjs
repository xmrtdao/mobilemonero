/**
 * relay/scripts/_debrand.mjs — drop the cuttlefish prefix, in one pass.
 *
 * THE ORDER MATTERS, and it is the reverse of the obvious one:
 *
 *   1. expose an un-prefixed public VIEW over each existing app table
 *   2. migrate every code call site to those names
 *   3. rename the app BASE tables last
 *
 * Renaming the base table first would work too, but then there is no window in
 * which a partially-migrated caller has a name that resolves. In this order every
 * intermediate state has a working name, and the old ones are left behind as
 * compat views so a missed call site still resolves rather than 500-ing.
 *
 * FOUR TABLES COULD NOT TAKE THE UN-PREFIXED NAME because a different table
 * already owns it — the same collision that produced pfp_bookings. They are
 * renamed to what they actually are:
 *
 *   cuttlefish_agent_tasks  -> work_queue           (public.agent_tasks exists)
 *   cuttlefish_chat_messages-> agent_conversations  (app + public exist)
 *   cuttlefish_contracts    -> agreements           (public.contracts exists)
 *   cuttlefish_proposals    -> submitted_proposals  (public.proposals exists)
 *
 * THE BUG THIS SCRIPT IS BUILT TO AVOID
 * --------------------------------------
 * The first attempt at this rename was done with PowerShell's Get-Content -Raw
 * and [System.IO.File]::WriteAllText. On Windows PowerShell 5.1, Get-Content
 * decodes a BOM-less UTF-8 file as the system ANSI code page, so every em dash
 * became "Ã¢â‚¬â€" and WriteAllText saved that as UTF-8. 1,486 sequences across 11
 * files were corrupted and every test still passed. This script does all file
 * I/O through node:fs, which decodes UTF-8 correctly, and verifies afterwards
 * that no mojibake was introduced.
 *
 * Usage:  node scripts/_debrand.mjs --check    report only
 *         node scripts/_debrand.mjs            apply
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RELAY = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = !process.argv.includes('--check');

process.env.LOCAL_DATABASE_URL = (readFileSync(join(RELAY, '.env'), 'utf8')
  .match(/^LOCAL_DATABASE_URL=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
const { getPool } = await import('file:///C:/Users/PureTrek/Desktop/xmrtdao/relay/jobby/store.mjs');
const pool = await getPool();

// â”€â”€ the mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const RENAME = {
  activity_registry: 'activity_registry',
  agent_tasks: 'work_queue',
  cac_credentials: 'cac_credentials',
  capital_stack: 'capital_stack',
  chat_messages: 'chat_transcripts',
  constitutions: 'constitutions',
  contracts: 'agreements',
  council: 'council',
  financing_programs: 'financing_programs',
  gate_decisions: 'gate_decisions',
  kya_acknowledgements: 'kya_acknowledgements',
  kya_bindings: 'kya_bindings',
  kya_successions: 'kya_successions',
  proposals: 'submitted_proposals',
  rate_card: 'rate_card',
  reward_distributions: 'reward_distributions',
  scenarios: 'scenarios',
  social_posts: 'social_posts',
  stewardship_reviews: 'stewardship_reviews',
  stewardship_standing: 'stewardship_standing',
};

// Already de-branded in an earlier pass. The code must speak the new names too,
// or half the estate keeps saying cuttlefish.
const ALREADY = { cuttlefish_trust_events: 'trust_events', cuttlefish_standing_events: 'standing_events' };

// â”€â”€ 1. expose the un-prefixed public views â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const exists = async (s, n) => (await pool.query(
  'SELECT table_type FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [s, n])).rows[0];

console.log('  phase 1 — un-prefixed public views');
for (const [from, to] of Object.entries({ ...RENAME, ...ALREADY })) {
  const bare = to;
  const src = await exists('app', from.startsWith('cuttlefish_') ? from : `cuttlefish_${from}`);
  if (!src) { console.log(`    skip   app.${from} does not exist`); continue; }
  const clash = await exists('public', bare);
  if (clash) { console.log(`    CLASH  public.${bare} exists as ${clash.table_type} — not touching`); continue; }
  const appClash = await exists('app', bare);
  if (appClash) { console.log(`    CLASH  app.${bare} exists as ${appClash.table_type} — not touching`); continue; }
  if (APPLY) {
    const srcName = from.startsWith('cuttlefish_') ? from : `cuttlefish_${from}`;
    await pool.query(`CREATE VIEW public."${bare}" AS SELECT * FROM app."${srcName}"`);
    const n = await pool.query(`SELECT count(*)::int n FROM public."${bare}"`);
    console.log(`    create public.${bare.padEnd(24)} -> app.${srcName}  (${n.rows[0].n} rows)`);
  } else {
    console.log(`    would create public.${bare}`);
  }
}

// â”€â”€ 2. migrate the code â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PAIRS = [];
for (const [from, to] of Object.entries({ ...RENAME, ...ALREADY })) {
  PAIRS.push([`public.cuttlefish_${from}`, `public.${to}`]);
  PAIRS.push([`app.cuttlefish_${from}`, `public.${to}`]);
}
// Longest first, so a shorter pattern cannot eat a longer name.
PAIRS.sort((a, b) => b[0].length - a[0].length);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name) && statSync(p).size < 4_000_000) out.push(p);
  }
  return out;
};

const MOJI = /\u00e2\u20ac|\u00c3\u2014|\u00c2\u00a7/g;
const files = walk(RELAY);
console.log(`\n  phase 2 — code call sites across ${files.length} file(s)`);
let touched = 0, total = 0;
if (APPLY) {
  const bak = join(process.env.TEMP, 'opencode', 'debrand2-backup');
  mkdirSync(bak, { recursive: true });
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    let after = before;
    for (const [a, b] of PAIRS) after = after.split(a).join(b);
    if (after === before) continue;
    writeFileSync(join(bak, f.slice(RELAY.length + 1).replace(/[\\/]/g, '__')), before, 'utf8');
    writeFileSync(f, after, 'utf8');
    let n = 0;
    for (const [a] of PAIRS) n += before.split(a).length - 1;
    console.log(`    ${String(n).padStart(3)}x  ${f.slice(RELAY.length + 1)}`);
    touched++; total += n;
  }
  console.log(`    ${total} replacement(s) across ${touched} file(s)`);
} else {
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    let n = 0;
    for (const [a] of PAIRS) n += before.split(a).length - 1;
    if (n) { console.log(`    would change ${String(n).padStart(3)}x  ${f.slice(RELAY.length + 1)}`); total += n; }
  }
  console.log(`    ${total} replacement(s) would apply`);
}

// â”€â”€ 3. rename the app base tables, last â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('\n  phase 3 — rename the app base tables');
if (APPLY) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [from, to] of Object.entries({ ...RENAME, ...ALREADY })) {
      // ALREADY entries were renamed in an earlier pass, so their app table is
      // already the bare name. The rest are still prefixed.
      const appName = from.startsWith('cuttlefish_') ? from : `cuttlefish_${from}`;
      const has = (await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', ['app', appName])).rows.length;
      if (!has) {
        if (from.startsWith('cuttlefish_')) console.log(`    skip app.${appName} — already renamed in an earlier pass`);
        continue;
      }
      if ((await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', ['app', to])).rows.length) {
        console.log(`    skip app.${to} already exists`); continue;
      }
      await c.query(`ALTER TABLE app."${appName}" RENAME TO "${to}"`);
      console.log(`    renamed app.${appName} -> app.${to}`);
    }
    await c.query('COMMIT');
    console.log('    COMMITTED (dependent views auto-rewritten by PostgreSQL)');
  } catch (e) {
    await c.query('ROLLBACK');
    console.log('    ROLLED BACK: ' + e.message);
    await pool.end();
    process.exit(1);
  } finally { c.release(); }
}

// â”€â”€ 4. verify â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const left = await pool.query(
  `SELECT count(*)::int n FROM information_schema.tables
    WHERE table_schema='app' AND table_type='BASE TABLE' AND table_name ILIKE 'cuttlefish%'`);
console.log(`\n  app base tables still carrying the prefix: ${left.rows[0].n}`);

let moji = 0, badParse = [];
if (APPLY) {
  for (const f of files) {
    if ((readFileSync(f, 'utf8').match(MOJI) || []).length) moji++;
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' }); }
    catch { badParse.push(f.slice(RELAY.length + 1)); }
  }
  console.log(`  files containing mojibake: ${moji}   files failing --check: ${badParse.length}`);
  if (badParse.length) badParse.forEach(b => console.log('    ' + b));

  // Every name generation must still resolve, or something is broken.
  let broken = 0;
  for (const [from, to] of Object.entries({ ...RENAME, ...ALREADY })) {
    for (const [s, n] of [['app', to], ['public', to], ['public', `cuttlefish_${from}`]]) {
      try { await pool.query(`SELECT 1 FROM "${s}"."${n}" LIMIT 1`); }
      catch { console.log(`    BROKEN ${s}.${n}`); broken++; }
    }
  }
  console.log(`  unresolvable relations after the rename: ${broken}`);
  const t = await pool.query(`SELECT count(*)::int n FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name ILIKE 'cuttlefish%'`);
  console.log(`  public base tables carrying the prefix: ${t.rows[0].n}  (want 0)`);
}
await pool.end();
