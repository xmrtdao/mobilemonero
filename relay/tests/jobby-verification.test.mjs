/**
 * relay/tests/jobby-verification.test.mjs — the badge rules
 *
 * These tests are all about one thing: a mark reading "verified" must never
 * appear next to a claim nobody outside the candidate checked. That is the
 * whole risk of the feature, and it is silent when it goes wrong - a medal on a
 * self-assertion looks exactly like a medal on a proven fact, and the person
 * wearing it has no way to tell the difference.
 *
 * So the negative cases are the point of this file. A test that only checks that
 * a real verification produces a mark would pass just as happily if the code
 * marked everything.
 */
import {
  MARKABLE, VERDICTS, claimHash, judgeClaim, markFor,
} from '../jobby/verification.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

const INDEPENDENT = { name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/wiki/File:Kobe_Bryant_8.jpg', says: 'Author: Sgt. Joseph A. Lee, 11 October 2005', independent: true };
const OWN_SITE = { name: 'his own portfolio', url: 'https://web3joelee.vercel.app', says: 'Joseph A. Lee, Combat Correspondent', independent: false };

console.log('\n--- a self-assertion is never verified ---');
{
  // The core case. He says he holds a certificate. Nobody can self-verify, so
  // there is nothing to check and no mark.
  const r = judgeClaim({ claim: 'Graduate certificate in Web Tech' });
  check('nothing found is unverifiable', r.verdict === 'unverifiable', r.verdict);
  check('and earns no mark', r.markable === false);
  check('markFor returns null for it', markFor(r.verdict) === null);
}
{
  const r = judgeClaim({ claim: '' });
  check('an empty claim is not verifiable', r.verdict === 'unverifiable', r.verdict);
  check('and says so', /no claim to check/i.test(r.reason), r.reason);
}

console.log('\n--- a source the candidate controls cannot verify ---');
{
  // He links a page he wrote. It agrees with him, because he wrote it to.
  const r = judgeClaim({ claim: 'Combat Correspondent at MCB Hawaii', sources: [OWN_SITE] });
  check('a self-published source does not verify', r.verdict === 'corroborated', r.verdict);
  check('and earns no mark', r.markable === false);
  check('the reason says why', /within the candidate/i.test(r.reason), r.reason);
}
{
  // The trap: two self-published sources agreeing feels like corroboration and
  // is not. It is one claim counted twice. Counting must never be a route to a
  // mark, or volume becomes the thing that decides what is true.
  const r = judgeClaim({
    claim: 'Combat Correspondent at MCB Hawaii',
    sources: [OWN_SITE, { ...OWN_SITE, name: 'his own LinkedIn', url: 'https://linkedin.com/in/joecodes' }],
  });
  check('two self-published sources agreeing is still not verified',
    r.verdict === 'corroborated', r.verdict);
  check('still no mark', r.markable === false);
}
{
  // And the mirror: one real independent source is enough. Volume is not the
  // test, independence is.
  const r = judgeClaim({ claim: 'Combat Correspondent at MCB Hawaii', sources: [OWN_SITE, INDEPENDENT] });
  check('one independent source verifies regardless of the rest',
    r.verdict === 'verified', r.verdict);
  check('and it is markable', r.markable === true);
}

console.log('\n--- a contradiction outranks agreement ---');
{
  // Being wrong is different from being unchecked, and the difference matters
  // to whoever reads the mark.
  const r = judgeClaim({
    claim: 'The photograph was taken in 2004',
    sources: [INDEPENDENT, { name: 'EXIF data', says: '2005', independent: true, contradicts: true }],
  });
  check('a contradicting source makes it disputed', r.verdict === 'disputed', r.verdict);
  check('and it is not markable', r.markable === false);
  check('the reason names the source', /contradicts/i.test(r.reason), r.reason);
}
{
  // A contradiction from a source the candidate controls still counts as a
  // contradiction. He may disagree with the record; that is not a reason to
  // award a mark.
  const r = judgeClaim({
    claim: 'X', sources: [INDEPENDENT, { name: 'his own site', says: 'no', independent: false, contradicts: true }],
  });
  check('a contradiction is a contradiction whoever makes it',
    r.verdict === 'disputed', r.verdict);
}

console.log('\n--- a mark says what it checked, and nothing more ---');
{
  const mark = markFor(MARKABLE, { sourceName: 'Wikimedia Commons', checkedAt: '2026-09-29' });
  check('a verified verdict produces a mark', !!mark);
  check('the mark names the source', /Wikimedia Commons/.test(mark.source), String(mark.source));
  check('the mark states its scope',
    /does not cover any other claim/i.test(mark.scope), mark.scope);
  check('and does not read as an endorsement of the person',
    /not a judgement of the candidate/i.test(mark.scope), mark.scope);
  check('it carries the date it was checked', mark.checkedAt === '2026-09-29');
}
{
  for (const v of VERDICTS.filter((x) => x !== MARKABLE)) {
    check('no mark for ' + v, markFor(v) === null);
  }
}

console.log('\n--- a claim cannot outlive the wording it was checked against ---');
{
  // The reason claim_hash exists. Editing a claim and keeping its medal is the
  // worst outcome available: a mark next to wording nobody checked, and it
  // looks deliberate.
  const claim = 'Photographed Kobe Bryant on 11 October 2005';
  const h1 = claimHash(claim);
  check('the same text hashes the same', h1 === claimHash(claim));
  check('different text hashes differently', h1 !== claimHash('Photographed Kobe Bryant on 12 October 2005'));
  check('case and spacing do not change it', h1 === claimHash('  photographed   kobe bryant ON 11 october 2005 '));
  // The year 2004 -> 2005 change is exactly the edit that must invalidate.
  check('the year is part of the identity', claimHash('Taken 2004') !== claimHash('Taken 2005'));
}

console.log('\n--- only one verdict exists that can be shown ---');
{
  check('the markable verdict is verified', MARKABLE === 'verified');
  check('and it is in the set of verdicts', VERDICTS.includes(MARKABLE));
  check('the four verdicts are exactly the documented set',
    VERDICTS.slice().sort().join(',') === 'corroborated,disputed,unverifiable,verified',
    VERDICTS.join(','));
}

console.log(failures === 0
  ? '\nno mark can appear on an unverified claim'
  : `\n${failures} verification check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
