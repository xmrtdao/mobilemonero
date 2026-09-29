// Claiming an email, and the gate it puts on sending.
//
// Two things are being defended here, and both are security properties rather
// than features:
//
//   1. An address nobody proved must not be able to identify a person. Client
//      reconciliation matches on a CLAIMED address only, because a typed one is
//      not evidence - and the alternative, matching on IP address, would merge
//      two job seekers sharing one carrier-grade NAT address, which is a live
//      situation on every major US carrier.
//
//   2. The code must not be a free oracle. Six digits is a million possibilities;
//      an endpoint with unlimited attempts hands them over in a few thousand
//      requests. Three attempts, then the code is spent.
import pg from 'pg';
import {
  requestClaim, verifyClaim, isVerified, findClaimedPeers,
  assertCanRepresent, plausibleEmail, closeClaim,
} from '../jobby/claim.mjs';
import { getOrCreateClient, closeStore } from '../jobby/store.mjs';
import { findDuplicatesByEmail, dedupeLinks } from '../jobby/reconcile.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite',
});
const made = [];
const tag = () => `claim-test-${Math.random().toString(36).slice(2)}`;
async function client() {
  const c = await getOrCreateClient(tag(), 'Claim Test');
  made.push(c.id);
  return c;
}
const emailFor = () => `${tag()}@example.test`;

section('address validation');
{
  for (const bad of ['', '   ', 'nope', 'a@b', 'a b@c.com', 'a@.com', null, undefined]) {
    check(`${JSON.stringify(bad)} is refused`, plausibleEmail(bad) === false);
  }
  for (const good of ['a@b.co', 'joeyleepcs@gmail.com', 'first.last+tag@sub.example.com']) {
    check(`${good} is accepted`, plausibleEmail(good) === true);
  }
}

section('a code is issued, and only the hash is stored');
{
  const c = await client();
  const email = emailFor();
  const issued = await requestClaim(c.id, email);
  check('a code is issued', issued.ok === true && /^\d{6}$/.test(issued.code), JSON.stringify(issued).slice(0, 120));
  check('it expires in minutes, not hours', issued.expiresInSeconds <= 900, issued.expiresInSeconds);

  const row = await pool.query(
    'SELECT code_hash, email FROM app.job_claim_codes WHERE client_id = $1', [c.id]);
  check('a hash is stored', row.rows.length === 1);
  check('the plaintext code is NOT in the database',
    !JSON.stringify(row.rows).includes(issued.code), 'the code appears verbatim');
  check('the hash is not the code', row.rows[0].code_hash !== issued.code);
}

section('the right code verifies, the wrong one does not');
{
  const c = await client();
  const email = emailFor();
  const { code } = await requestClaim(c.id, email);

  const wrong = await verifyClaim(c.id, email, '000000'.replace(/000000/, code === '000000' ? '111111' : '000000'));
  check('a wrong code is refused', wrong.ok !== true, JSON.stringify(wrong).slice(0, 100));
  check('and the address is still unverified', (await isVerified(c.id)).verified === false);

  const right = await verifyClaim(c.id, email, code);
  check('the right code verifies', right.ok === true, JSON.stringify(right).slice(0, 100));
  check('and the address is recorded on the client', (await isVerified(c.id)).verified === true);
  check('with the address that was proved', (await isVerified(c.id)).email === email);
}

section('a code is single-use');
{
  const c = await client();
  const email = emailFor();
  const { code } = await requestClaim(c.id, email);
  check('first use succeeds', (await verifyClaim(c.id, email, code)).ok === true);
  // The code row is marked verified, so the unique partial index means a second
  // request for the same address cannot create another live row to replay into.
  const replay = await verifyClaim(c.id, email, code);
  check('the same code cannot be used again', replay.ok !== true, JSON.stringify(replay).slice(0, 100));
}

section('a code cannot be guessed');
{
  const c = await client();
  const email = emailFor();
  const { code } = await requestClaim(c.id, email);
  const guesses = ['000000', '111111', '222222', '333333'].filter(g => g !== code);
  let last = null;
  for (const g of guesses) last = await verifyClaim(c.id, email, g);
  check('repeated wrong guesses are all refused', last && last.ok !== true, JSON.stringify(last).slice(0, 140));

  const attempts = await pool.query(
    'SELECT attempts FROM app.job_claim_codes WHERE client_id = $1', [c.id]);
  check('every attempt is counted', attempts.rows[0].attempts >= 3, JSON.stringify(attempts.rows[0]));

  // Even the correct code is now refused: three wrong guesses spent it.
  const after = await verifyClaim(c.id, email, code);
  check('and the code is spent even with the right digits', after.ok !== true, JSON.stringify(after).slice(0, 140));
}

section('requesting a new code supersedes the old one');
{
  const c = await client();
  const email = emailFor();
  const first = await requestClaim(c.id, email);
  const second = await requestClaim(c.id, email);
  check('a new code is issued', second.code !== first.code, `${first.code} vs ${second.code}`);
  const stale = await verifyClaim(c.id, email, first.code);
  check('the superseded code no longer works', stale.ok !== true, JSON.stringify(stale).slice(0, 120));
  const live = await verifyClaim(c.id, email, second.code);
  check('the newest one does', live.ok === true, JSON.stringify(live).slice(0, 120));
}

section('requests are rate limited');
{
  const c = await client();
  const email = emailFor();
  let limited = null;
  for (let i = 0; i < 8; i++) {
    const r = await requestClaim(c.id, email);
    if (r.error) { limited = r; break; }
  }
  check('asking repeatedly is eventually refused', !!limited, limited ? '' : 'never limited');
  check('and the refusal explains itself', limited && /too many/i.test(limited.error || ''), JSON.stringify(limited).slice(0, 120));
}

section('a code issued to one client does not verify another');
{
  const a = await client();
  const b = await client();
  const email = emailFor();
  const { code } = await requestClaim(a.id, email);
  const cross = await verifyClaim(b.id, email, code);
  check('a code cannot be used by a different session', cross.ok !== true, JSON.stringify(cross).slice(0, 120));
  check('and the rightful owner is unaffected', (await verifyClaim(a.id, email, code)).ok === true);
}

section('only a claimed address identifies a person');
{
  const c = await client();
  const email = emailFor();
  // A typed but unproven address finds nobody, so it can never merge a record.
  const peersBefore = await findClaimedPeers(email);
  check('an unclaimed address matches no one', peersBefore.length === 0, JSON.stringify(peersBefore));

  const { code } = await requestClaim(c.id, email);
  await verifyClaim(c.id, email, code);
  const peersAfter = await findClaimedPeers(email);
  check('once claimed it identifies exactly one client', peersAfter.length === 1, JSON.stringify(peersAfter));
  check('and it is the right one', peersAfter[0].id === c.id);
}

section('the send gate');
{
  const c = await client();
  const blocked = await assertCanRepresent(c.id);
  check('an unverified client may not represent anyone', blocked.ok === false, JSON.stringify(blocked).slice(0, 120));
  check('and is told how to fix it', typeof blocked.howToFix === 'string' && blocked.howToFix.length > 0);
  check('with a code the model can act on', blocked.code === 'email_not_verified', blocked.code);

  const email = emailFor();
  const { code } = await requestClaim(c.id, email);
  await verifyClaim(c.id, email, code);
  const allowed = await assertCanRepresent(c.id);
  check('a verified client may', allowed.ok === true, JSON.stringify(allowed).slice(0, 120));
}

section('one address cannot be claimed by two clients');
{
  // The same person verifying on a second device. The unique index is the
  // backstop, and verifyClaim detects the collision so the caller can consolidate
  // rather than the request failing outright - which is what letting the index
  // throw produced.
  const a = await client();
  const b = await client();
  const email = emailFor();
  const ca = await requestClaim(a.id, email);
  await verifyClaim(a.id, email, ca.code);

  const cb = await requestClaim(b.id, email);
  const rb = await verifyClaim(b.id, email, cb.code);
  check('verification succeeds rather than throwing', rb.ok === true, JSON.stringify(rb).slice(0, 140));
  check('and reports which record already holds the address',
    rb.alreadyClaimedBy === a.id, JSON.stringify(rb).slice(0, 140));

  const claimed = await pool.query(
    `SELECT count(*)::int c FROM app.job_clients
      WHERE LOWER(COALESCE(claimed_email,'')) = $1 AND id = ANY($2::int[])`,
    [email, [a.id, b.id]]);
  check('only one client holds the claimed address', claimed.rows[0].c === 1, JSON.stringify(claimed.rows[0]));

  // And the peers lookup is what drives the consolidation.
  const peers = await findClaimedPeers(email);
  check('the duplicate is discoverable so it can be merged', peers.length === 1, JSON.stringify(peers.map(p => p.id)));
}

section('duplicate lookup finds the twenty-one records');
{
  const key = tag();
  const email = `${key}@example.test`;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const c = await getOrCreateClient(`${key}-${i}`, 'Dup Test');
    ids.push(c.id);
    await pool.query('UPDATE app.job_clients SET email = $2 WHERE id = $1', [c.id, email]);
  }
  const found = await findDuplicatesByEmail(pool, email);
  check('every record carrying the address is found', found.length === 3, String(found.length));
  check('ordered oldest first, so the survivor is stable',
    found[0].id === Math.min(...ids), found.map(f => f.id).join(','));

  const none = await findDuplicatesByEmail(pool, `absent-${key}@example.test`);
  check('an address nobody has returns nothing', none.length === 0, String(none.length));
}

section('the same URL filed under several fields is collapsed');
{
  // This is the triplicate the user saw: one extraction put github.com/xmrtdao
  // into links.github, links.website AND links.portfolio.
  const d = {
    links: {
      linkedin: 'linkedin.com/in/joecodes',
      github: 'github.com/xmrtdao',
      portfolio: 'https://github.com/xmrtdao',
      website: 'github.com/xmrtdao/',
      other: ['https://github.com/xmrtdao', 'joe.example.com'],
    },
  };
  const r = dedupeLinks(d);
  check('something was cleared', r.changed === true, JSON.stringify(r.cleared));
  check('the URL survives in the most specific field', d.links.github === 'github.com/xmrtdao', d.links.github);
  check('and is cleared from portfolio', !d.links.portfolio, String(d.links.portfolio));
  check('and from website', !d.links.website, String(d.links.website));
  check('LinkedIn is untouched', d.links.linkedin === 'linkedin.com/in/joecodes');
  check('a genuinely different URL in other is kept', d.links.other.includes('joe.example.com'), JSON.stringify(d.links.other));
  check('and the duplicate inside other was removed',
    !d.links.other.some(u => /xmrtdao/.test(u)), JSON.stringify(d.links.other));

  // Running it twice must be a no-op, or a retry would keep editing.
  const before = JSON.stringify(d);
  dedupeLinks(d);
  check('it is idempotent', JSON.stringify(d) === before, `${before} -> ${JSON.stringify(d)}`);

  const distinct = { links: { github: 'github.com/a', website: 'joe.example.com' } };
  const r2 = dedupeLinks(distinct);
  check('two different URLs are both kept', r2.changed === false && distinct.links.github && distinct.links.website,
    JSON.stringify(r2.cleared));
}

await pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [made]);
await pool.end();
await closeClaim();
await closeStore();

console.log(fails === 0
  ? '\n  a claimed address is the only thing that identifies a person, and it gates sending'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
