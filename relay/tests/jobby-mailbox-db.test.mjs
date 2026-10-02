#!/usr/bin/env node
// Integration tests for the per-candidate mailbox, against the real database.
//
// These are not mocked, because the behaviour that matters here is the
// interaction with the unique index: two candidates called Maria Garcia both
// derive "maria.garcia", and the only thing standing between them is the database
// refusing the second insert. A mocked test would assert the code's intention
// rather than the constraint that actually holds.
//
// Every row created here is removed afterwards, and the tests use their own
// session keys so they cannot collide with a real candidate.
import {
  getOrCreateClient, ensureMailbox, getClientByMailbox, getClient, getMailbox,
  setDisplayName, closeStore,
} from '../jobby/store.mjs';
import { MAILBOX_DOMAIN } from '../jobby/mailbox.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 240)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const made = [];
async function client(name) {
  const key = `test-mailbox-${Math.random().toString(36).slice(2)}-${made.length}`;
  const c = await getOrCreateClient(key, name);
  made.push(c.id);
  return c;
}

async function cleanup() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  });
  if (made.length) {
    // Children first. job_client_mailboxes has no FK to job_clients, so deleting
    // the client can leave an orphan mailbox behind pointing at nobody. The old
    // cleanup deleted only the client, and was wrapped in a .catch(() => {}) that
    // swallowed any failure - so a broken cleanup looked identical to a clean one.
    const mb = await pool.query('DELETE FROM app.job_client_mailboxes WHERE client_id = ANY($1::int[])', [made]);
    const cl = await pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [made]);
    await pool.end();
    return { clients: cl.rowCount, mailboxes: mb.rowCount };
  }
  await pool.end();
  return { clients: 0, mailboxes: 0 };
}

/**
 * Clear anything a previous run of *this suite* left behind, before asserting.
 *
 * The checks below name exact addresses — `joe.lee@`, then `joe.lee2@` — so the
 * suite is only correct on a database where nothing else holds them. That is a
 * reasonable assumption about production and a fragile one about a test database,
 * because the cleanup used to run at the *end*, at the top level, with no
 * try/finally: any throw between the first client and the last line skipped it and
 * left its rows on file.
 *
 * The effect compounded. Once one `joe.lee@` survived, the next run's first Joe Lee
 * was correctly offered `joe.lee2@` — the system working exactly as designed,
 * because a real row did hold that address — and the suite failed while reporting
 * a suffix that was the right answer. Two runs were spent chasing that before the
 * cause was looked for.
 *
 * So the suite now establishes its own precondition. Only rows carrying this
 * file's own session-key prefix are removed, so nothing a real candidate owns can
 * be touched, and it is safe to run repeatedly.
 */
async function clearPreviousRun() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  });
  const stale = await pool.query(
    "DELETE FROM app.job_clients WHERE session_key LIKE 'test-mailbox-%' RETURNING id");
  await pool.end();
  return stale.rowCount;
}
const staleRemoved = await clearPreviousRun();
if (staleRemoved) {
  console.log(`  (cleared ${staleRemoved} client(s) left by a previous run of this suite)`);
}

section('the default user gets joe.lee@jobbymcjobberson.com');
{
  const c = await client('Joe Lee');
  const r = await ensureMailbox(c.id, 'Joe Lee');
  check('the address is joe.lee@jobbymcjobberson.com',
    r.address === 'joe.lee@jobbymcjobberson.com', r);
  check('it reports that it created it', r.created === true, r);
  check('it is on the right domain', r.address.endsWith('@' + MAILBOX_DOMAIN), r.address);

  // And the full legal name, which is a different derivation.
  const c2 = await client('Joseph Andrew Lee');
  const r2 = await ensureMailbox(c2.id, 'Joseph Andrew Lee');
  check('the full name derives joseph.lee, not joe.lee',
    r2.address === 'joseph.lee@jobbymcjobberson.com', r2);
  check('and it did not collide with joe.lee', r2.address !== r.address, { r: r.address, r2: r2.address });
}

section('an address is assigned once and then held');
{
  const c = await client('Ada Lovelace');
  const first = await ensureMailbox(c.id, 'Ada Lovelace');
  const second = await ensureMailbox(c.id, 'Analytical Engine Lovelace');
  check('the first call created it', first.created === true, first);
  check('the second returns the same address', second.address === first.address,
    { first: first.address, second: second.address });
  check('the second does not claim to have created it', second.created === false, second);
  // This is the property that matters: renaming a candidate must not orphan the
  // replies already sent to their old address.
  // The address now FOLLOWS the name, which is the opposite of what this asserted.
  //
  // It was written to protect a real property - a rename must not orphan the
  // replies already sent to the old address - and it protected that by freezing the
  // address instead of tracking it, so a candidate named Joe Lee went on applying as
  // jordan.ellis@ and every recruiter could see the mismatch. Freezing solved the
  // orphaning by never moving at all.
  //
  // Both halves are asserted now: the address moves, AND the old one still resolves
  // to the same person. The second is the property worth having. The first is the
  // product decision, taken on purpose.
  await setDisplayName(c.id, 'Renamed Person', { updatedBy: 'test' });
  const moved = await getMailbox(c.id);
  check('a rename moves the address to match the name',
    !!moved && moved !== first.address, { before: first.address, after: moved });

  const byNew = await getClientByMailbox(moved);
  const byOld = await getClientByMailbox(first.address);
  check('the new address resolves to that client', !!byNew && byNew.id === c.id,
    { moved, resolved: byNew && byNew.id });
  check('and the old one does too, so replies to it are not orphaned',
    !!byOld && byOld.id === c.id, { old: first.address, resolved: byOld && byOld.id });
}

section('two candidates with the same name get different addresses');
{
  const a = await client('Maria Garcia');
  const b = await client('Maria Garcia');
  const ra = await ensureMailbox(a.id, 'Maria Garcia');
  const rb = await ensureMailbox(b.id, 'Maria Garcia');
  check('the first takes the plain address', ra.address === 'maria.garcia@jobbymcjobberson.com', ra);
  check('the second is suffixed', rb.address === 'maria.garcia2@jobbymcjobberson.com', rb);
  check('they are different', ra.address !== rb.address, { ra: ra.address, rb: rb.address });
  // The suffix goes on the last name, so it reads as a second Maria Garcia.
  check('the suffix is on the last name',
    localOf(rb.address) === 'maria.garcia2', localOf(rb.address));

  // And the database, not the code, is what guarantees it.
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
  });
  let rejected = false;
  try {
    await pool.query(
      `UPDATE app.job_clients SET mailbox = $2 WHERE id = $1`, [b.id, ra.address]);
  } catch (e) {
    rejected = e.code === '23505' || /mailbox_uniq/.test(String(e.message));
  }
  check('the unique index refuses a duplicate', rejected);
  // Case must not be a way around it.
  let caseRejected = false;
  try {
    await pool.query(
      `UPDATE app.job_clients SET mailbox = $2 WHERE id = $1`,
      [b.id, ra.address.toUpperCase()]);
  } catch (e) {
    caseRejected = e.code === '23505' || /mailbox_uniq/.test(String(e.message));
  }
  check('and refuses one that differs only in case', caseRejected);
  await pool.end();
}

section('an inbound reply is resolved back to its candidate');
{
  const c = await client('Grace Hopper');
  const { address } = await ensureMailbox(c.id, 'Grace Hopper');
  const found = await getClientByMailbox(address);
  check('the exact address resolves', found && found.id === c.id, found && found.id);
  check('case is ignored', (await getClientByMailbox(address.toUpperCase()))?.id === c.id);
  check('surrounding whitespace is tolerated',
    (await getClientByMailbox('  ' + address + ' '))?.id === c.id);
  check('an unknown address resolves to nothing',
    (await getClientByMailbox('nobody@jobbymcjobberson.com')) === null);
  check('a malformed address resolves to nothing', (await getClientByMailbox('nonsense')) === null);
  // The local part here IS this candidate's, so the only thing that can stop it
  // matching is the exact domain comparison. This is the address an attacker
  // registers to have mail delivered into their own inbox.
  check('a lookalike domain does not resolve this client',
    (await getClientByMailbox('grace.hopper@jobbymcjobberson.com.evil.test')) === null);
  check('another registered domain does not resolve this client',
    (await getClientByMailbox('grace.hopper@31harbor.com')) === null);
  check('a prefix of our domain does not either',
    (await getClientByMailbox('grace.hopper@notjobbymcjobberson.com')) === null);
}

section('a name that cannot be reduced still gets a stable, obvious address');
{
  const c = await client(null);
  const r = await ensureMailbox(c.id, '数字');
  check('it falls back to the client id', r.address === `candidate-${c.id}@${MAILBOX_DOMAIN}`, r);
  check('it is visibly generated', /^candidate-\d+@/.test(r.address), r.address);
  const again = await ensureMailbox(c.id, '数字');
  check('and it is stable', again.address === r.address, { r: r.address, again: again.address });
}

section('a name with no display name stored still works');
{
  const c = await client(null);
  const r = await ensureMailbox(c.id, 'Alan Turing');
  check('it uses the name passed in', r.address === 'alan.turing@jobbymcjobberson.com', r);
}

function localOf(address) {
  return String(address).split('@')[0];
}

// The suite's assertions are top-level in this file, so there is nothing to wrap
// in a try/finally — an attempt at one here fired immediately and cleaned up
// *before* the checks, which is how a first draft of this fix left three rows
// behind per run. Repeatability comes from `clearPreviousRun()` above, which
// establishes the precondition rather than assuming it; this call tidies up after.
// A cleanup that fails must be visible. This used to be
// `await cleanup().catch(() => {})`, which made a broken cleanup indistinguishable
// from a successful one - and fixtures were left in app.job_clients after every run.
const cleaned = await cleanup();
console.log(`  (removed ${cleaned.clients} fixture client(s) and ${cleaned.mailboxes} mailbox(es) after the run)`);
await closeStore();

console.log(fails === 0
  ? '\n  all mailbox integration checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
