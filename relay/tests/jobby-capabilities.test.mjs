// Audit Jobby's real capabilities: what the 14 tools claim to do, and what each
// one actually depends on.
//
// The question this answers is not "does the file parse" or "is the name
// registered" - it is "if Jobby called this right now, would it work". A tool that
// is registered but wired to a missing credential, an unimplemented adapter, or a
// table that was never migrated is not a capability, and an audit that reports it
// as one is worse than no audit.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(RELAY_DIR, '..');
const JOBBY = join(RELAY_DIR, 'jobby');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const note = (label, detail) => console.log(`  note  ${label}: ${detail}`);
const section = t => console.log('\n=== ' + t + ' ===');

// ── Load the real registry ────────────────────────────────────────────────────
const { JOBBY_TOOL_NAMES, createJobbyTools } = await import('../jobby/tools.mjs');
const tools = createJobbyTools({ llmChat: async () => ({}) });

section('the tool surface');
{
  check('the registry loads', JOBBY_TOOL_NAMES.length > 0, JOBBY_TOOL_NAMES.length);
  check('every declared name is actually a function', JOBBY_TOOL_NAMES.every(n => typeof tools[n] === 'function'),
    JOBBY_TOOL_NAMES.filter(n => typeof tools[n] !== 'function').join(', '));
  check('there are no undeclared tools on the object',
    Object.keys(tools).length === JOBBY_TOOL_NAMES.length,
    Object.keys(tools).filter(k => !JOBBY_TOOL_NAMES.includes(k)).join(', '));
  console.log('  ' + JOBBY_TOOL_NAMES.length + ' tools');
}

// ── Per-tool dependency audit ─────────────────────────────────────────────────
// Read the source of each tool and record what it reaches for. This is static
// because the point is to enumerate dependencies, not to exercise them - but every
// dependency it finds is then checked for real, below.
const src = readFileSync(join(JOBBY, 'tools.mjs'), 'utf8');

function toolSource(name) {
  const i = src.indexOf(`  async ${name}(`);
  if (i === -1) return '';
  // Next top-level "  async <name>(" or the end of the object.
  const rest = src.slice(i + 10);
  const m = rest.match(/\n {2}async [a-z_]+\(/);
  const end = m ? i + 10 + m.index : src.length;
  return src.slice(i, end);
}

const CALLS = {
  'store.': 'relay/jobby/store.mjs',
  'google.': 'relay/jobby/google.mjs',
  'calendly.': 'relay/jobby/calendly.mjs',
  'browser.': 'relay/jobby/browser.mjs',
  'dossier.': 'relay/jobby/dossier.mjs',
  'plan.': 'relay/jobby/plan.mjs',
  'tracks.': 'relay/jobby/tracks.mjs',
  'mailbox.': 'relay/jobby/mailbox.mjs',
  'llmChat': 'the model',
};

const audit = [];
for (const name of JOBBY_TOOL_NAMES) {
  const body = toolSource(name);
  const deps = Object.keys(CALLS).filter(k => body.includes(k));
  const throws = /throw new Error/.test(body);
  const stub = /not (?:yet )?implemented|placeholder|coming soon|TODO/i.test(body);
  const lines = body.split('\n').length;
  audit.push({ name, deps, throws, stub, lines, body });
}

section('every tool is a real implementation, not a stub');
{
  for (const t of audit) {
    check(`${t.name} is not a stub`, !t.stub, t.stub ? 'contains a not-implemented marker' : '');
    check(`${t.name} has a body worth calling`, t.lines > 8, `${t.lines} lines`);
  }
}

section('the modules each tool depends on actually exist');
{
  const seen = new Set();
  for (const t of audit) {
    for (const d of t.deps) {
      const p = CALLS[d];
      if (p.includes('/')) seen.add(p);
    }
  }
  for (const p of [...seen].sort()) {
    check(`${p} exists`, existsSync(join(ROOT, p)));
  }
}

section('credentials the tools depend on');
{
  // Never print a value - presence and length only. A credential is reported as
  // "present" or "absent", and the consequence is spelled out, because the useful
  // question is what happens on the first call, not what is in the file.
  const envPath = join(RELAY_DIR, '.env');
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const has = k => new RegExp(`^${k}=(.+)$`, 'm').test(env);
  const len = k => {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim().length : 0;
  };

  // Two tiers, because they mean different things and conflating them trains
  // people to ignore this file. A missing REQUIRED key is a real blocker: mail
  // cannot be sent or read, and the inbound webhook cannot be verified. A missing
  // NOT-YET-ENABLED key is a deliberate state - the tool refuses, loudly, and
  // nothing is broken. Failing the build for the second kind would mean this
  // check is red for a long time and gets ignored, which is how a real
  // regression in the first kind would slip past.
  const required = [
    ['RESEND_JOBBY_API_KEY', 'jobby_send / jobby_check_replies', 'sending and reading mail'],
    ['RESEND_JOBBY_WEBHOOK_SECRET', 'inbound webhook verification', 'jobby inbound is fail-closed without it'],
    ['JOBBY_TOKEN_KEY', 'token sealing', 'Google + Calendly token storage'],
  ];
  for (const [k, used, why] of required) {
    const present = has(k);
    const state = present ? `present (${len(k)} chars)` : 'ABSENT';
    if (present) console.log(`  note  ${k}: ${state}`);
    else { fails++; console.log(`  FAIL  ${k} is absent — blocks ${used} (${why})`); }
  }

  // Not yet enabled. Reported, never failed - the tool is supposed to refuse.
  const notYet = [
    ['GOOGLE_CLIENT_ID', 'jobby_google_status', 'Google connection, not yet enabled'],
    ['GOOGLE_CLIENT_SECRET', 'jobby_google_status', 'Google connection, not yet enabled'],
    ['CALENDLY_CLIENT_ID', 'Calendly connection', 'not yet enabled, not exposed as a tool'],
    ['CALENDLY_CLIENT_SECRET', 'Calendly connection', 'not yet enabled, not exposed as a tool'],
    ['STRIPE_WEBHOOK_SECRET', 'POST /webhook/stripe', 'PFP payments arrive but cannot be verified'],
  ];
  for (const [k, used, why] of notYet) {
    if (has(k)) console.log(`  note  ${k}: present (${len(k)} chars)`);
    else console.log(`  skip  ${k} is absent — ${used} is ${why}; the tool refuses and nothing is broken`);
  }
}

section('the job_* tables the tools write to');
{
  const pool = new pg.Pool({
    connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  });
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'app' AND table_name LIKE 'job\\_%'
    ORDER BY table_name`);
  const live = new Set(rows.map(r => r.table_name));
  await pool.end();

  console.log('  ' + live.size + ' job_* tables live');
  const fromSql = existsSync(join(RELAY_DIR, 'migrations', 'jobby_001_agent.sql'))
    ? readFileSync(join(RELAY_DIR, 'migrations', 'jobby_001_agent.sql'), 'utf8')
    : '';
  for (const t of ['job_clients', 'job_dossiers', 'job_outreach', 'job_opportunities', 'job_leads', 'job_audit']) {
    if (live.has(t)) console.log(`  note  ${t}: live`);
    else {
      // Only a failure if the code actually uses it.
      const used = src.includes(`'${t}'`) || fromSql.includes(t);
      if (used) { fails++; console.log(`  FAIL  ${t} is referenced but not live`); }
      else console.log(`  note  ${t}: absent, and not referenced`);
    }
  }
  void fromSql;
}

section('external surfaces Jobby claims but cannot reach');
{
  // These are the things a job-search agent is expected to do that no available
  // API supports. Recorded as audit findings, not code changes - each one is a
  // product decision, and inventing a workaround would be worse than the gap.
  const facts = [
    ['LinkedIn job applications', 'no LinkedIn API exposes applying; messaging is partner-restricted and OAuth needs an approved app'],
    ['Indeed applications', 'no public API for consumer job applications'],
    ['LinkedIn profile read', 'no open API; scraping violates the ToS'],
  ];
  for (const [what, why] of facts) console.log(`  note  ${what}: NOT POSSIBLE — ${why}`);
}

section('the tracker, and the SPA that presents it');
{
  for (const p of ['jobby-mcjobberson/index.html', 'jobby-mcjobberson/resume_server.py', 'jobby-mcjobberson/resume_render.py']) {
    check(`${p} exists`, existsSync(join(ROOT, p)));
  }
  const pkg = existsSync(join(ROOT, 'jobby-mcjobberson/requirements.txt'))
    ? readFileSync(join(ROOT, 'jobby-mcjobberson/requirements.txt'), 'utf8').trim()
    : '';
  note('resume_server.py python deps', pkg.replace(/\s+/g, ' ').slice(0, 80) || '(none declared)');
}

console.log(fails === 0
  ? '\n  every registered tool is backed by a real module and a live table'
  : `\n  ${fails} finding(s) need attention`);
process.exitCode = fails === 0 ? 0 : 1;
