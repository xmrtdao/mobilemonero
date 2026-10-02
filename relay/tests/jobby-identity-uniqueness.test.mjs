/**
 * jobby-identity-uniqueness.test.mjs
 *
 * The product rule: one person, one jobbymcjobberson.com account — across their
 * session, their dossier and their profile, however many browsers and addresses
 * they use.
 *
 * Two things are load-bearing here, and both were previously missing:
 *
 *  1. A candidate used to get a NEW account per session, so one person became
 *     many rows. `joseph.lee`, `joseph.lee2` and `joseph.lee3` all existed at
 *     once, and the suite had leaked 3,288 such rows into app.job_clients.
 *
 *  2. The obvious fix — treat the IP address as identity — is wrong, and much of
 *     this file exists to stop it being reintroduced. Two candidates looking for
 *     work from one office or campus share one address. Merging on that unions
 *     two employment histories into one invented tenure, which is the same
 *     failure as unioning two documents that disagree about a date.
 *
 * So: the address is recorded, and offered as context. It never decides.
 */

import {
  normaliseIp, recordSession, findIdentityCandidates,
  listMailboxes, primaryMailbox, getPool, getOrCreateClient,
  ensureMailbox,
} from '../jobby/store.mjs';
import { MAILBOX_DOMAIN } from '../jobby/mailbox.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const pool = await getPool();
let seq = 0;
const uniq = () => `ident-test-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
const mk = () => getOrCreateClient(uniq());
const drop = async (ids) => pool.query('DELETE FROM app.job_clients WHERE id = ANY($1::int[])', [ids]);

section('one visitor is never stored as two identities');
{
  // The same IPv4 address arrives in these forms depending on the socket and the
  // proxy in front of it. Stored verbatim, one person becomes two identities.
  check('a plain address is kept', normaliseIp('203.0.113.9') === '203.0.113.9');
  check('IPv4-mapped IPv6 folds to IPv4', normaliseIp('::ffff:203.0.113.9') === '203.0.113.9');
  check('a port is not part of the address', normaliseIp('203.0.113.9:51234') === '203.0.113.9');
  check('bracketed IPv6 with a port', normaliseIp('[::1]:443') === '::1');
  check('surrounding whitespace is trimmed', normaliseIp('  198.51.100.7  ') === '198.51.100.7');
}

section('an unusable address is a gap, never a guess');
{
  check('a non-address is null, not "unknown"', normaliseIp('not-an-ip') === null);
  check('empty is null', normaliseIp('') === null);
  check('absent is null', normaliseIp(null) === null);
  check('a number is not an address', normaliseIp(12345) === null);
}

section('one session is one row, however many times it is seen');
{
  const c = await mk();
  const key = uniq();
  try {
    await recordSession(c.id, { sessionKey: key, ip: '203.0.113.10', userAgent: 'probe/1' });
    await recordSession(c.id, { sessionKey: key, ip: '203.0.113.10', userAgent: 'probe/1' });
    await recordSession(c.id, { sessionKey: key, ip: '::ffff:203.0.113.10' });
    const n = await pool.query(
      'SELECT count(*)::int n FROM app.job_client_sessions WHERE client_id=$1 AND session_key=$2', [c.id, key]);
    check('a repeated visit adds no second row', n.rows[0].n === 1, n.rows[0].n);
    const r = await pool.query('SELECT host(last_ip) l, host(first_ip) f FROM app.job_clients WHERE id=$1', [c.id]);
    check('the address is stored normalised', r.rows[0].l === '203.0.113.10', r.rows[0].l);
    check('the first address is kept, not overwritten', r.rows[0].f === '203.0.113.10', r.rows[0].f);
  } finally { await drop([c.id]); }
}

section('a phone and a laptop are two sessions on one account');
{
  const c = await mk();
  try {
    await recordSession(c.id, { sessionKey: uniq(), ip: '203.0.113.11' });
    await recordSession(c.id, { sessionKey: uniq(), ip: '198.51.100.20' });
    const n = await pool.query('SELECT count(*)::int n FROM app.job_client_sessions WHERE client_id=$1', [c.id]);
    check('both sessions are recorded against the one client', n.rows[0].n === 2, n.rows[0].n);
    const r = await pool.query('SELECT host(first_ip) f, host(last_ip) l FROM app.job_clients WHERE id=$1', [c.id]);
    check('first address remembered', r.rows[0].f === '203.0.113.11', r.rows[0].f);
    check('most recent address remembered', r.rows[0].l === '198.51.100.20', r.rows[0].l);
  } finally { await drop([c.id]); }
}

section('an IP match is context, never proof');
{
  const a = await mk(), b = await mk();
  try {
    await recordSession(a.id, { sessionKey: uniq(), ip: '203.0.113.30' });
    // A different person behind the same address: one office, one campus wifi.
    await recordSession(b.id, { sessionKey: uniq(), ip: '203.0.113.30' });
    const found = await findIdentityCandidates({ ip: '203.0.113.30' });
    const ids = found.map((f) => f.id);
    check('both people are surfaced', ids.includes(a.id) && ids.includes(b.id), ids.join(','));
    check('neither is treated as strong evidence',
      found.every((f) => f.strength === 'context_only'),
      found.map((f) => f.strength).join(','));
  } finally { await drop([a.id, b.id]); }
}

section('a name plus a shared address is suggestive, not decisive');
{
  const c = await mk();
  try {
    await pool.query('UPDATE app.job_clients SET display_name=$2 WHERE id=$1', [c.id, 'Sam Okafor']);
    await recordSession(c.id, { sessionKey: uniq(), ip: '203.0.113.31' });
    const hit = (await findIdentityCandidates({ name: 'Sam Okafor', ip: '203.0.113.31' })).find((f) => f.id === c.id);
    check('the same name from the same address is reported', !!hit);
    check('and is ranked suggestive, not strong', hit?.strength === 'suggestive', hit?.strength);
    check('with the reason recorded', hit?.reason === 'name_and_ip', hit?.reason);
  } finally { await drop([c.id]); }
}

section('a proved address does identify a person');
{
  const c = await mk();
  const addr = `${uniq()}@example.test`;
  try {
    await pool.query('UPDATE app.job_clients SET claimed_email=$2 WHERE id=$1', [c.id, addr]);
    const hit = (await findIdentityCandidates({ claimedEmail: addr })).find((f) => f.id === c.id);
    check('the owner is found', !!hit);
    check('and ranked strong', hit?.strength === 'strong', hit?.strength);
    check('with the reason recorded', hit?.reason === 'claimed_address', hit?.reason);
  } finally { await drop([c.id]); }
}

section('one person, one live mailbox');
{
  const c = await mk();
  try {
    const first = await ensureMailbox(c.id, 'Robin Vale');
    const second = await ensureMailbox(c.id, 'Robin Vale');
    check('asking again returns the address already held',
      second.address === first.address, `${first.address} then ${second.address}`);
    const all = await listMailboxes(c.id);
    check('exactly one address is live', all.filter((m) => m.is_active).length === 1);
    check('and it is on the right domain', first.address.endsWith('@' + MAILBOX_DOMAIN));
    check('primaryMailbox reports it', (await primaryMailbox(c.id)).address === first.address);

    // A second LIVE address for the same person is refused by the database
    // itself - app.job_client_mailboxes carries a one-active-per-client
    // constraint. That is the guarantee that matters, because two live addresses
    // mean a reply could arrive at either with no way to tell whose it is.
    // (primaryMailbox re-checks it in code, but the constraint is the real wall.)
    let refusedBy = '', code = '';
    try {
      await pool.query(`INSERT INTO app.job_client_mailboxes (client_id, address, is_active, reason)
        VALUES ($1, $2, true, 'forced by the uniqueness test')`, [c.id, `forced-${c.id}@${MAILBOX_DOMAIN}`]);
    } catch (e) { refusedBy = e.message; code = e.code; }
    check('a second live address is refused', code === '23505' || /live mailboxes/.test(refusedBy),
      `${code} ${refusedBy.slice(0, 70)}`);
    check('and the refusal names the constraint',
      /one_active_per_client/.test(refusedBy), refusedBy.slice(0, 90));

    // A released address is fine - history is kept, only the live one is unique.
    const historical = await pool.query(`INSERT INTO app.job_client_mailboxes
      (client_id, address, is_active, reason) VALUES ($1, $2, false, 'previously used') RETURNING id`,
      [c.id, `former-${c.id}@${MAILBOX_DOMAIN}`]);
    check('a released address is allowed, so history is not lost', historical.rows.length === 1);
    const allNow = await listMailboxes(c.id);
    check('and only one address is still live', allNow.filter((m) => m.is_active).length === 1);
  } finally { await drop([c.id]); }
}

section('an address belongs to exactly one client');
{
  // The rule at the database level, which is what stops two sessions for one
  // person quietly acquiring separate accounts.
  const r = await pool.query(`SELECT indexdef FROM pg_indexes
    WHERE schemaname='app' AND indexname='job_client_mailboxes_address_uniq'`);
  check('a unique index on the mailbox address exists', r.rows.length === 1);
  check('and it is unique', r.rows[0] && /UNIQUE/i.test(r.rows[0].indexdef));
}

section('this file leaves nothing behind');
{
  const r = await pool.query(`SELECT count(*)::int n FROM app.job_clients WHERE session_key LIKE 'ident-test-%'`);
  check('no fixture client rows survive the run', r.rows[0].n === 0, r.rows[0].n);
  const s = await pool.query(`SELECT count(*)::int n FROM app.job_client_sessions ss
    JOIN app.job_clients c ON c.id = ss.client_id WHERE c.session_key LIKE 'ident-test-%'`);
  check('no fixture session rows survive either', s.rows[0].n === 0, s.rows[0].n);
}

console.log(fails === 0
  ? '\n  one person resolves to one account, and an address is never treated as proof'
  : `\n  ${fails} identity-uniqueness check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
await pool.end();
