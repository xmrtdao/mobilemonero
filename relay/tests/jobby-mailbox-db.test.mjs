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
  getOrCreateClient, ensureMailbox, getClientByMailbox, getClient, getMailbox, closeStore,
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
    await pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [made]);
  }
  await pool.end();
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
  check('a later name change does not move the address',
    (await getMailbox(c.id)) === first.address, await getMailbox(c.id));
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

await cleanup();
await closeStore();

console.log(fails === 0
  ? '\n  all mailbox integration checks passed'
  : `\n  ${fails} check(s) FAILED`);
process.exit(fails === 0 ? 0 : 1);
