/**
 * relay/tests/jobby-identity-dedupe.test.mjs — the second duplicate signal
 *
 * The miss this fixes is concrete. The candidate had two records: one on a gmail
 * address, one on a jobbymcjobberson.com mailbox. Every duplicate function keyed
 * on email, so the two were never joined, and establishing they were one person
 * meant reading both dossiers by hand.
 *
 * The risk of fixing it is the opposite failure. There are 868 clients on this
 * database called "Jordan Ellis" because the tests create them, and they share a
 * phone number. A name+phone signal that fires on 885 records is describing the
 * fixtures, not a person - and offering to merge 885 rows would be both useless
 * and slow.
 *
 * So the tests here are mostly about restraint: the signal must fire on the real
 * pair, stay quiet on noise, and never merge on its own.
 */
import pg from 'pg';
import { findDuplicatesByIdentity } from '../jobby/reconcile.mjs';

const CONN = process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
let pool;
try {
  pool = new pg.Pool({ connectionString: CONN, connectionTimeoutMillis: 4000 });
  await pool.query('SELECT 1');
} catch (e) {
  console.log('  SKIP  database not reachable (' + e.message + ')');
  process.exit(0);
}

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

const TAG = 'test-ident-' + Date.now();
// Deliberately NOT the real candidate's addresses. The real client 72 is on this
// phone number with joelee@jobbymcjobberson.com, and the function collapses
// records that share an address - which is right, but it would have silently
// eaten one of these fixtures and made the test assert the wrong thing.
const a = await pool.query(
  `INSERT INTO app.job_clients (session_key, display_name, email, phone)
   VALUES ($1,'Joseph Andrew Lee',$2,'+1-202-798-0610') RETURNING id`,
  [TAG + '-a', 'ident-a-' + TAG + '@example.com']);
const b = await pool.query(
  `INSERT INTO app.job_clients (session_key, display_name, email, phone)
   VALUES ($1,'joseph andrew lee',$2,'+1 202 798 0610') RETURNING id`,
  [TAG + '-b', 'ident-b-' + TAG + '@example.com']);
const idA = a.rows[0].id, idB = b.rows[0].id;

// A third record stands in for "the real candidate whose own row is already on
// this phone number". It used to assert that production client id 72 appeared in
// the result, which meant the test only passed on a database that happened to
// hold that row and failed on a clean one. The point of the assertion is that a
// genuine third record on the same number is not missed - so now one is made.
const realish = await pool.query(
  `INSERT INTO app.job_clients (session_key, display_name, email, phone)
   VALUES ($1,'Joseph Andrew Lee',$2,'+1 202 798 0610') RETURNING id`,
  [TAG + '-real', 'ident-real-' + TAG + '@example.com']);
const idReal = realish.rows[0].id;

try {
  console.log('\n--- the real miss: same person, two addresses, one number ---');
  {
    const r = await findDuplicatesByIdentity(pool, {
      name: 'Joseph Andrew Lee', phone: '+1-202-798-0610',
    });
    check('it finds both records', r.duplicate === true, JSON.stringify(r).slice(0, 200));
    const ids = r.clients.map((c) => c.id);
    // Not "exactly two". A third record is on this phone number, so a correct
    // answer includes it - the signal is doing its job, and an assertion of
    // exactly-two would be asserting that it misses a genuine match.
    check('both test records are in the result',
      ids.includes(idA) && ids.includes(idB), ids.join(','));
    check('and so is a third genuine record on the same number',
      ids.includes(idReal), ids.join(','));
  }

  console.log('\n--- formatting differences must not hide a match ---');
  {
    // Same number written three ways. Formatting is the only thing that varies
    // between two records of one person.
    for (const variant of ['+1 202 798 0610', '+12027980610', '+1.202.798.0610', '+1-202-798-0610']) {
      const r = await findDuplicatesByIdentity(pool, { name: 'Joseph Andrew Lee', phone: variant });
      check('matches ' + variant, r.duplicate === true, JSON.stringify(r).slice(0, 120));
    }
  }
  {
    // Case and punctuation in the name, which two resumes spell differently.
    const r = await findDuplicatesByIdentity(pool, { name: 'joseph andrew lee', phone: '+12027980610' });
    check('name case and spacing do not matter', r.duplicate === true);
  }

  console.log('\n--- one field is not enough ---');
  {
    const r = await findDuplicatesByIdentity(pool, { name: 'Joseph Andrew Lee', phone: '' });
    check('a name with no phone is refused', r.supported === false, JSON.stringify(r).slice(0, 120));
  }
  {
    const r = await findDuplicatesByIdentity(pool, { name: '', phone: '+12027980610' });
    check('a phone with no name is refused', r.supported === false);
  }
  {
    // Different number, same name. Common names are common.
    const r = await findDuplicatesByIdentity(pool, { name: 'Joseph Andrew Lee', phone: '+1-202-555-0199' });
    check('the same name on a different number is not a match',
      r.duplicate === false, JSON.stringify(r).slice(0, 160));
  }
  {
    const c = await pool.query(
      `INSERT INTO app.job_clients (session_key, display_name, email, phone)
       VALUES ($1,'Someone Else entirely','other@example.com','+1-202-798-0610') RETURNING id`, [TAG + '-c']);
    // Shared phone - a household, a recycled number. Different name, so no match.
    const r = await findDuplicatesByIdentity(pool, { name: 'Someone Else entirely', phone: '+12027980610' });
    check('a shared phone with a different name is not a match', r.duplicate === false,
      JSON.stringify(r).slice(0, 160));
    await pool.query('DELETE FROM app.job_clients WHERE id=$1', [c.rows[0].id]);
  }

  console.log('\n--- a signal that fires on everything is noise, and is called noise ---');
  {
    // "Jordan Ellis" plus 804-555-0142 is 885 records on this database. They all
    // carry the SAME address, so the distinct-address collapse already reduces
    // them to one and there is nothing to suggest - which is the right answer,
    // and worth asserting, because the alternative is proposing to merge 885 rows.
    const r = await findDuplicatesByIdentity(pool, { name: 'Jordan Ellis', phone: '(804) 555-0142' });
    check('885 same-address records are not offered as duplicates',
      r.duplicate === false, JSON.stringify(r).slice(0, 200));
    check('and produce no candidates', r.clients.length === 0, String(r.clients.length));
  }
  {
    // The case the cap actually exists for: many records, many DIFFERENT
    // addresses, all on one name and one number. That is either a shared
    // corporate line or a test generator, and either way offering to merge it
    // would be nonsense. The cap has to say so rather than return 40 rows.
    const made = [];
    for (let i = 0; i < 14; i++) {
      const ins = await pool.query(
        `INSERT INTO app.job_clients (session_key, display_name, email, phone)
         VALUES ($1,'Shared Line Holder',$2,'+1-202-555-0181') RETURNING id`,
        [TAG + '-noise-' + i, `holder-${i}-${TAG}@example.com`]);
      made.push(ins.rows[0].id);
    }
    const r = await findDuplicatesByIdentity(pool, { name: 'Shared Line Holder', phone: '+12025550181' });
    check('a large many-address group is flagged as noise', r.noise === true,
      JSON.stringify(r).slice(0, 200));
    check('and offers no merge candidates', r.clients.length === 0, String(r.clients.length));
    check('and says why', /shared number or test data/i.test(String(r.reason)), String(r.reason));
    check('and reports the size, so the number can be judged',
      r.groupSize === 14, String(r.groupSize));
    for (const id of made) await pool.query('DELETE FROM app.job_clients WHERE id=$1', [id]);
  }

  console.log('\n--- a single record is not a duplicate ---');
  {
    const r = await findDuplicatesByIdentity(pool, { name: 'Nobody At All', phone: '+1-999-888-7777' });
    check('no match, no duplicate', r.duplicate === false);
    check('and no candidates', r.clients.length === 0);
  }

  console.log('\n--- it never merges ---');
  {
    // The function returns candidates. Merging is consolidateClients' job, and
    // that only runs from jobby_dedupe with the user's confirmation. This test
    // exists so that a future change which "helpfully" merges here is caught.
    const r = await findDuplicatesByIdentity(pool, { name: 'Joseph Andrew Lee', phone: '+12027980610' });
    check('the result carries candidates, not a merged record',
      r.clients.every((c) => typeof c.id === 'number'), JSON.stringify(r.clients).slice(0, 120));
    const still = await pool.query(
      'SELECT count(*)::int n FROM app.job_clients WHERE session_key LIKE $1', [TAG + '%']);
    // Three, not two: this suite builds its own third record rather than assuming
    // production happens to hold one. What matters is that NONE were merged - the
    // function returns candidates, and merging is a separate, confirmed action.
    check('and all three records still exist, none merged', still.rows[0].n === 3, String(still.rows[0].n));
  }

  console.log('\n--- a too-short number is not a number ---');
  {
    // "555" or "12" is a fragment that thousands of records could share.
    const r = await findDuplicatesByIdentity(pool, { name: 'Joseph Andrew Lee', phone: '555' });
    check('a fragment is not treated as a phone number', r.supported === false,
      JSON.stringify(r).slice(0, 120));
  }
} catch (e) {
  failures += 1;
  console.log('  FAIL  harness error: ' + e.message);
} finally {
  await pool.query('DELETE FROM app.job_clients WHERE session_key LIKE $1', [TAG + '%']);
  await pool.end();
}

console.log(failures === 0
  ? '\nthe second duplicate signal finds the real pair and stays quiet on noise'
  : `\n${failures} identity-dedupe check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
