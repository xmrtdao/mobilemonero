/**
 * relay/jobby/tools.mjs — The tools Jobby can call
 *
 * Each handler takes (args, ctx) where ctx carries the client id and the
 * services it needs. Handlers return a plain object; the chat layer turns that
 * into the text the model sees on the next turn.
 *
 * Dossier writes go through applyEdits + saveDossier so the audit trail is never
 * bypassed, and the confirmation flag is set here from what the user said, not
 * from what the model claimed.
 */

import { applyEdits, describeAudit, newBatchId } from './dossier.mjs';
import { passesDisclosure } from './persona.mjs';
import { describePageAgent, ensurePageAgent, hubStatus, reopenLauncher, waitForFreshConnection } from './browser.mjs';
import {
  BLOCKER_LABELS, buildResumeTask, classifyBlocker, getApplication,
  listApplications, markNotified, nextActionable, recordOutcome, resumeAttempt,
  savePacket, startAttempt,
} from './applications.mjs';
import { decideTracks } from './tracks.mjs';
import { TRACKS } from './tracks.mjs';
// The shared fleet board. agent_id is set inside this module and is not readable
// from tool arguments — see the header of fleet.mjs for why that is the point
// rather than an inconvenience.
import * as fleet from './fleet.mjs';
// dossierText is the same flattening decideTracks uses, so the title matcher reads
// exactly the text the track decision was made from rather than a different view.
import { dossierText } from './tracks.mjs';
import * as store from './store.mjs';
import { sourceCompany } from './source-company.mjs';
import { ALL_TITLES, ALL_FAMILIES, matchTitles, modernEquivalent, detectTickets, knownTitle } from './titles.mjs';
import { buildView, buildAllViews, viewForTrack } from './views.mjs';
import { buildPacket, validateOpportunity, assessEligibility } from './packet.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Rate limiter for jobby_shell, keyed by candidate.
 *
 * In-process and deliberately not persisted: a restart should hand a candidate a
 * fresh allowance rather than inherit a spent one, and the cap exists to bound
 * damage in one session, not to meter anything.
 */
const SHELL_RATE = new Map();
import * as googleStore from './google-store.mjs';
import * as google from './google.mjs';

/**
 * Google is an optional dependency. Everything that does not touch it must work
 * whether or not it is configured, so this is resolved at call time rather than
 * at import time.
 */
function requireGoogle() {
  if (!google.isConfigured()) {
    const err = new Error(
      'Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in relay/.env. ' +
      'The user can still connect a Google account from the portal once it is.'
    );
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
  return google;
}

const asText = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : v);

function requireString(args, key, { max = 2000, field = null } = {}) {
  const v = args?.[key];
  if (typeof v !== 'string' || !v.trim()) {
    return { error: `"${field || key}" is required and must be text` };
  }
  if (v.length > max) return { error: `"${field || key}" is too long (max ${max} characters)` };
  return { value: v.trim() };
}

/**
 * Did the user actually state this in this turn?
 *
 * A vague message is not consent. Jobby may stage a change, but a change to
 * claimed experience is only written as confirmed when the user said something
 * concrete. This is deliberately conservative: an unconfirmed write is still
 * written, but it is auditable as unconfirmed and the model is told to say so.
 */
export function looksLikeUserAssertion(message, value) {
  if (!message || typeof message !== 'string') return false;
  const text = message.toLowerCase();
  const candidates = Array.isArray(value) ? value : [value];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.length >= 3 && text.includes(c.toLowerCase())) {
      return true;
    }
  }
  // First-person statements of fact are treated as assertions.
  if (/\b(my|i'm|i am|it'?s|use|set|change|correct|actually)\b/.test(text)) return true;
  // An object value, which is how a role or a degree is added, was never
  // inspected: Array.isArray is false, the value is not a string, so every
  // candidate was skipped and the entry was recorded unconfirmed however plainly
  // the user stated it. Jobby would then ask them to confirm a company and a
  // city they had just typed. Walk the leaves instead.
  return candidates.some(c => leavesOf(c).some(leaf =>
    leaf.length >= 3 && text.includes(leaf.toLowerCase())));
}

/** Every string leaf inside a nested value, depth-limited. */
function leavesOf(value, depth = 0) {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(v => leavesOf(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(v => leavesOf(v, depth + 1));
  }
  return [];
}

/**
 * Pull the unanswered questions out of a page-agent report.
 *
 * The agent groups its findings under headings - "Fields Filled", "Fields NOT
 * Filled (require action)" - and only the second kind is something the user has
 * to act on. Reading every labelled line instead produced a list containing the
 * fields it had already filled, which tells the user nothing about what they are
 * being asked for.
 *
 * The index the agent cites appears on either side of the label depending on the
 * run, so both are accepted.
 */
export function extractOutstanding(report) {
  if (typeof report !== 'string' || !report.trim()) return [];
  const out = [];
  // A heading line introduces the section the following entries belong to.
  const WANT = /not\s*filled|require|outstanding|still\s*need|missing|cannot|unable|unknown|unanswered/i;
  let inWanted = false;
  for (const raw of report.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // A heading, not a list item.
    //
    // The list-item guard used to be !/^\s*(?:[-*]|\d+\.)/ - "anything starting
    // with a dash, a star or a number is an entry, not a heading". That is wrong
    // for markdown bold, which is how the agent actually writes: `**Fields NOT
    // Filled (require action)**` begins with a star, so every bold heading was
    // classified as a list item and discarded. The section was then never opened,
    // inWanted kept whatever the last prose sentence set it to, and
    // extractOutstanding returned [] - so a stopped application reported no
    // outstanding fields at all, and the candidate got a blocker with no
    // question attached to it.
    //
    // Requiring whitespace after the marker separates the two properly: a real
    // list item is `- `, `* ` or `1. `, while a bold heading is `**` with the
    // second star immediately after the first.
    const isHeading = /^\**\s*[A-Z][^*]{0,70}\**\s*:?\s*$/.test(line)
      && !/^\s*(?:[-*]\s|\d+\.\s)/.test(line);
    if (isHeading) {
      inWanted = WANT.test(line);
      continue;
    }
    if (!inWanted) continue;
    if (!/^(?:[-*]|\d+\.)\s/.test(line)) continue;
    const m = /^(?:[-*]|\d+\.)\s*(?:\*\*)?\s*(?:\[(\d+)\]\s*)?([^*\n:]{3,90}?)\s*(?:\[(\d+)\])?\s*(?:\*\*)?\s*:\**\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const question = m[2].trim();
    if (!question) continue;
    out.push({ index: m[1] ?? m[3] ?? null, question, why: m[4].trim() });
  }
  // A report with no headings at all - a flat list of needs - is still useful.
  if (!out.length) {
    for (const raw of report.split(/\r?\n/)) {
      const line = raw.trim();
      if (!/^(?:[-*]|\d+\.)\s/.test(line)) continue;
      if (!/need|missing|cannot|not\s*stated|unknown|provide|require/i.test(line)) continue;
      const m = /^(?:[-*]|\d+\.)\s*(?:\*\*)?\s*(?:\[(\d+)\]\s*)?([^*\n:]{3,90}?)\s*(?:\[(\d+)\])?\s*(?:\*\*)?\s*:\**\s*(.+?)\s*$/i.exec(line);
      if (m) out.push({ index: m[1] ?? m[3] ?? null, question: m[2].trim(), why: m[4].trim() });
    }
  }
  return out;
}

/**
 * Email the candidate about a wall, once.
 *
 * The point of this function is the `markNotified` guard, not the email. Jobby
 * runs unattended over a list of jobs, so the same listing can be attempted more
 * than once - a retry, a double-click, a portal reload - and each attempt can
 * stop on the same CAPTCHA. Without the column check that is three identical
 * emails about one problem, and the second one reads as a new failure rather
 * than the same one. `markNotified` returns true for exactly one caller.
 *
 * A failure to send is logged and swallowed. The application row is already
 * correct, the candidate can see the blockage on the site, and turning a
 * notification problem into a failed application - or a thrown error that
 * abandons the remaining jobs in the batch - would be a much worse outcome than
 * a missing email.
 */
async function notifyBlocker(ctx, application, blocker) {
  try {
    const first = await markNotified(ctx.clientId, application.id);
    if (!first) return { emailed: false, reason: 'already notified' };

    const to = asText(ctx.email, 320) || asText(ctx.claimedEmail, 320);
    if (!to) return { emailed: false, reason: 'no address on file' };
    if (typeof ctx.deliver !== 'function') {
      return { emailed: false, reason: 'no mail transport in this context' };
    }

    const label = BLOCKER_LABELS[blocker.kind] || BLOCKER_LABELS.unknown;
    const where = [application.company, application.role].filter(Boolean).join(' - ');
    const subject = where
      ? `Jobby needs you for ${where}`
      : 'Jobby needs you to finish an application';

    await ctx.deliver({
      to,
      subject,
      body: [
        `Jobby got as far as it could on ${where || application.url}.`,
        '',
        `It stopped because of ${label}.`,
        '',
        blocker.detail,
        '',
        `The application is saved as job ${application.id}. It is not lost, and `
          + 'nothing was sent to the employer.',
        '',
        `When you have sorted it, come back to the site and say:`,
        `  continue on job ${application.id}`,
        '',
        'Jobby carries on with your other jobs in the meantime.',
        '',
        `Listing: ${application.url}`,
      ].join('\n'),
    });
    return { emailed: true };
  } catch (e) {
    console.error(`[jobby] blocker email failed for application ${application.id}:`, e.message);
    return { emailed: false, reason: String(e.message || e) };
  }
}

/**
 * The identity of a posting's URL, for cross-source de-duplication.
 *
 * Strips tracking parameters, not the query string.
 *
 * The first version used `split('?')[0]`, which is right for the case it was
 * written for — `?utm_source=rss` making the same job look like a new one — and
 * catastrophically wrong for a board that identifies the posting *inside* the
 * query. Stripe publishes every job as `stripe.com/jobs/search?gh_jid=8172510`,
 * so all 716 of them reduced to one key and the board kept exactly one. 715 real
 * jobs, each with a named employer and a stated location, thrown away by a rule
 * that read as obviously correct.
 *
 * So: a named list of parameters that carry no identity, and everything else kept
 * and sorted so parameter order cannot make one URL look like two. `gh_jid` is
 * conspicuously absent — it looks like a tracking parameter and is the job.
 */
const URL_TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'ref', 'referrer', 'source', 'src', 'via', 'trk', 'trkcampaign', 'gh_src',
]);

export function urlKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    // Unparseable. Lowercased whole, which is still a usable key and better than
    // dropping the row on the floor.
    return s.toLowerCase();
  }
  u.hash = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  // "www." is a presentation choice, not a different document.
  if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4);
  const keep = [...u.searchParams.entries()]
    .filter(([k]) => !URL_TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : (av < bv ? -1 : av > bv ? 1 : 0)));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString().toLowerCase();
}

export function createJobbyTools({ llmChat }) {
  const tools = {

    async jobby_update_dossier(args, ctx) {
      const edits = Array.isArray(args?.edits) ? args.edits
        : (args?.path ? [{ op: args.op, path: args.path, value: args.value, reason: args.reason }] : []);
      if (!edits.length) return { error: 'no edits supplied. Use {"edits":[{"op":"add","path":"skills","value":"Rust"}]}' };

      const current = await store.getDossier(ctx.clientId);
      const base = current?.dossier ?? {};
      // Stamp the confirmation flag here, from the user's own words.
      const stamped = edits.map(e => ({
        ...e,
        confirmedByUser: looksLikeUserAssertion(ctx.userMessage, e.value),
        actor: 'jobby',
        batchId: newBatchId(),
      }));
      const result = applyEdits(base, stamped);
      if (!result.ok) {
        return { error: result.error, appliedSoFar: result.applied?.length ?? 0, nothingWritten: true };
      }
      const revision = await store.saveDossier(ctx.clientId, result.dossier, {
        updatedBy: 'jobby', audits: result.audits,
      });
      return {
        ok: true, revision,
        changes: result.audits.map(describeAudit),
        unconfirmed: result.audits.filter(a => !a.confirmedByUser).map(a => a.path),
        // Reported whenever it happened, and separately from `note` so a dropped
        // field is never buried inside a soft warning about confidence. The model
        // is told plainly: something was saved, and here is what was not. In a live
        // session it was saying the equivalent of "renamed what it could, nothing
        // written", which is the reply that convinces a candidate Jobby cannot
        // remember them — and the fields that were refused were ones it had read
        // straight out of their sentence.
        droppedFields: result.dropped || [],
        note: result.dropped?.length
          ? `Saved what could be stored. NOT saved: ${result.dropped.join(' ')} Tell the candidate which part did not save, in plain words — do not report the whole edit as failed, and do not imply the rest was lost.`
          : (result.audits.some(a => !a.confirmedByUser)
            ? 'Some of these were not stated outright by the user. They are saved and recorded as unconfirmed — say so if any are wrong.'
            : undefined),
      };
    },

    /**
     * Change the record the mission card is built from.
     *
     * This tool did not exist, which is why Jobby came across as read-only. Every
     * field the dashboard's mission card shows — the name, the phone, the location,
     * the mission state, the send mode, the daily cap — lives on `job_clients`, and
     * nothing in the agent's tool surface could write that table. So a candidate
     * saying "my name is Joe Lee, not Jordan Ellis" got a confident edit to the
     * *dossier*, and the card they were looking at never moved, and the honest
     * description of the product at that moment was: you can read it, nothing can
     * change it.
     *
     * The name is routed to `setDisplayName` rather than straight at the column,
     * because the dossier is the record a candidate is looking at when they correct
     * a mistake. Writing only the column would reproduce the exact split this
     * replaces, one level down.
     */
    /**
     * Change the record the candidate's MISSION CARD is built from.
     *
     * This tool did not exist, which is why Jobby came across as read-only. Every
     * field the dashboard's mission card shows — the name, the phone, the location,
     * the mission state, the send mode, the daily cap, the emergency stop — lived
     * on `job_clients`, and nothing in the agent's tool surface could write that
     * table. So a candidate saying "my name is Joe Lee, not Jordan Ellis" got a
     * confident edit to the *dossier*, and the card they were looking at never
     * moved, and the honest description of the product at that moment was: you can
     * read it, nothing can change it.
     *
     * The candidate's own details are routed to the dossier as well as the columns,
     * because the dossier is the record a candidate is looking at when they correct
     * a mistake. Writing only the column would reproduce the exact split this
     * replaces, one level down.
     */
    async jobby_update_client(args, ctx) {
      const patch = {};
      const changed = [];
      const refused = [];

      // ── name, phone, location: one write, one record ──
      const before = store.effectiveContact(await store.getClient(ctx.clientId),
        (await store.getDossier(ctx.clientId))?.dossier);
      const wanted = {};

      if (args?.display_name !== undefined) {
        const name = String(args.display_name).trim();
        if (!name) refused.push('display_name: a blank name is not a name. Pass the name to be known by.');
        else if (name.length > 200) refused.push('display_name: over 200 characters.');
        else wanted.name = name;
      }
      for (const key of ['phone', 'location']) {
        if (args?.[key] === undefined) continue;
        const v = String(args[key]).trim();
        const max = key === 'phone' ? 120 : 200;
        if (v.length > max) refused.push(`${key}: over ${max} characters.`);
        else wanted[key] = v || null;
      }
      if (Object.keys(wanted).length) {
        const written = await store.setCandidateDetails(ctx.clientId, wanted, { updatedBy: 'jobby' });
        for (const [key, value] of Object.entries(wanted)) {
          changed.push({ field: key, from: before[key]?.value ?? null, to: value });
        }
        // Not an error. The candidate was told a value that is already on file, and
        // reporting that as a change would be a claim about something that did not
        // happen — so it is said plainly instead.
        if (written && !written.changed.length) {
          changed.push({ field: '(no change)', to: 'already what is on file' });
        }
      }

      // ── the rest of the mission record, which lives only on the client row ──
      for (const [key, allowed] of [
        ['mission_state', ['seeking', 'placed', 'advancing', 'paused']],
        ['autonomy', ['auto', 'draft']],
      ]) {
        if (args?.[key] === undefined) continue;
        if (!allowed.includes(args[key])) {
          refused.push(`${key}: must be one of ${allowed.join(', ')}`);
          continue;
        }
        patch[key] = args[key];
        changed.push({ field: key, to: args[key] });
      }
      if (args?.kill_switch !== undefined) {
        patch.kill_switch = Boolean(args.kill_switch);
        changed.push({ field: 'emergency stop', to: patch.kill_switch ? 'on' : 'off' });
      }
      if (args?.notes !== undefined) {
        patch.notes = String(args.notes).slice(0, 4000);
        changed.push({ field: 'notes' });
      }
      if ('daily_send_cap' in (args || {})) {
        const cap = Number(args.daily_send_cap);
        if (!Number.isInteger(cap) || cap < 0 || cap > 500) {
          refused.push('daily_send_cap: must be a whole number 0-500.');
        } else {
          patch.daily_send_cap = cap;
          changed.push({ field: 'daily send cap', to: cap });
        }
      }

      if (!changed.length && !refused.length) {
        return {
          error: 'nothing to change. Pass at least one of: display_name, phone, location, '
            + 'mission_state, autonomy, kill_switch, daily_send_cap, notes.',
          fields: ['display_name', 'phone', 'location', 'mission_state', 'autonomy',
            'kill_switch', 'daily_send_cap', 'notes'],
        };
      }

      let updated = null;
      if (Object.keys(patch).length) updated = await store.updateClient(ctx.clientId, patch);

      const after = store.effectiveContact(updated || await store.getClient(ctx.clientId),
        (await store.getDossier(ctx.clientId))?.dossier);

      return {
        ok: changed.length > 0,
        changed,
        refused: refused.length ? refused : undefined,
        // Read back from the records rather than echoed from the arguments, so the
        // agent is confirming what is on file and not what it intended.
        now: {
          name: after.name.value, nameSource: after.name.source,
          phone: after.phone.value, location: after.location.value,
          missionState: updated?.mission_state ?? null,
          autonomy: updated?.autonomy ?? null,
          killSwitch: updated?.kill_switch ?? null,
          dailySendCap: updated?.daily_send_cap ?? null,
        },
        // Said out loud to the agent so it tells the candidate rather than
        // reporting a change it made off-screen where they cannot see it.
        say: changed.length
          ? `Changed: ${changed.map((c) => c.field).join(', ')}. The mission card on your dashboard shows the same thing now.`
          : `Nothing changed. ${refused.join(' ')}`,
        ...(updated?.mailbox && wanted.name && wanted.name !== before.name?.value ? {
          mailboxNote: `Your address stays ${updated.mailbox}. Renaming you does not move mail that has already gone out from it.`,
        } : {}),
      };
    },


    async jobby_set_tracks(args, ctx) {
      const requested = Array.isArray(args?.tracks) ? args.tracks : [args?.tracks];
      const client = await store.getClient(ctx.clientId);
      if (!client) return { error: 'no client' };
      const dossierRow = await store.getDossier(ctx.clientId);
      const decision = decideTracks(dossierRow?.dossier ?? {}, { userOverride: requested });
      const updated = await store.updateClient(ctx.clientId, {
        tracks: decision.tracks,
        track_reasons: decision.reasons,
      });
      return {
        ok: true, tracks: updated.tracks,
        why: decision.tracks.map(t => `Track ${t} (${TRACKS[t].name}): ${decision.reasons[t] || 'enabled'}`),
      };
    },

    async jobby_browser_status() {
      // The user asks "is your browser working" often enough, and the honest
      // answer is more useful than a failed application. It also attempts
      // recovery, so asking is itself the cheap fix.
      const ready = await ensurePageAgent({ requestedBy: 'jobby_browser_status' });
      if (ready.ok) {
        return {
          ok: true,
          ready: true,
          recovered: ready.recovered,
          detail: ready.recovered
            ? `Your browser is ready. I ${ready.recovered} to get there.`
            : 'Your browser is ready. I can fill in and submit applications in it.',
        };
      }
      const described = await describePageAgent();
      return { ok: true, ready: false, ...described };
    },

    async jobby_apply(args, ctx) {
      let recoveredNote = null;
      // Which address this will go from, and the weaker-identity note if it is an
      // assigned mailbox. Declared here so the gate below can set it and the
      // return below can carry it.
      let sendIdentityNote = null;
      const url = requireString(
        { url: args?.url ?? args?.link ?? args?.job_url },
        'url', { max: 800, field: 'url' });
      if (url.error) return { error: url.error };
      if (!/^https?:\/\//i.test(url.value)) {
        return { error: 'url must start with http:// or https://' };
      }

      // The listing becomes a durable row before anything is dispatched, so a run
      // that dies mid-flight - a crashed agent, a closed laptop, a hub restart -
      // still leaves a record saying which job was in progress. Claiming the row
      // after the browser had already been given the form would lose exactly the
      // runs most worth knowing about.
      const application = await startAttempt(ctx.clientId, {
        url: url.value,
        company: args?.company ?? args?.employer ?? null,
        role: args?.role ?? args?.title ?? null,
        opportunityId: args?.opportunity_id ?? null,
      });

      // The page agent drives the user's own browser through a Chrome extension,
      // so readiness is established - and repaired where that is possible -
      // before anything is dispatched. Finding out the extension is not running
      // by sending it a real job application and reading the failure afterwards
      // is not acceptable, and neither is giving up on a browser that is merely
      // asleep: Chrome suspends the extension's service worker when idle and it
      // reattaches on its own a moment later.
      const ready = await ensurePageAgent({ requestedBy: 'jobby_apply' });
      if (!ready.ok) {
        // Recorded as blocked, not failed. Nothing about this listing is wrong -
        // the browser was unavailable, which is the same class of wall as a
        // CAPTCHA: it needs the candidate, and they should be able to come back
        // and continue once their machine is awake. Writing it off as 'failed'
        // would quietly drop it out of the stuck list they are meant to work
        // through, and this is the single most common way a run does not happen.
        const blocker = classifyBlocker({ error: ready.advice || ready.reason || '' });
        await recordOutcome(ctx.clientId, application.id, {
          status: 'blocked', blocker,
        });
        await notifyBlocker(ctx, application, blocker);
        return {
          error: 'I could not get to your browser, so nothing was submitted.',
          reason: ready.reason,
          needsUser: true,
          howToFix: ready.advice,
          applicationId: application.id,
          applicationStatus: 'blocked',
        };
      }

      // Submitting an application is the most irreversible thing Jobby does, and
      // it is done in this person's name. It requires a proved email address, the
      // same gate as sending a message.
      {
        const { assertCanRepresent } = await import('./claim.mjs');
        const claim = await assertCanRepresent(ctx.clientId);
        if (!claim.ok) {
          // Deliberately NOT recorded as blocked. An unverified address is not a
          // wall the candidate cleared by doing something at the keyboard, it is
          // an account-level gate on everything at once, and listing one job
          // listing under it would imply the others are fine. The row goes back
          // to pending so it is picked up again the moment the address is proved.
          await recordOutcome(ctx.clientId, application.id, { status: 'pending' });
          return {
            error: claim.error,
            reason: 'no send identity',
            needsUser: true,
            howToFix: claim.howToFix,
            nothingWasSubmitted: true,
            applicationId: application.id,
            applicationStatus: 'pending',
          };
        }
        // Said on the way through, not only in a failure. A candidate is entitled
        // to know the address their application will come from before it goes,
        // and the address may be one they have never seen - jordan.ellis2@ because
        // the clean one was taken. The agent repeats this to them; the tool
        // returns it so there is something to repeat.
        if (claim.via === 'assigned_mailbox' && claim.note) sendIdentityNote = claim.note;
      }
      if (ready.recovered) {
        // Carried back to the reply so the user learns the browser was restarted
        // or waited on, rather than being left guessing why it took a moment.
        recoveredNote = ready.recovered;
      }

      const dossierRow = await store.getDossier(ctx.clientId);
      const dossier = dossierRow?.dossier ?? {};
      const fields = args?.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
        ? args.fields
        : {
          full_name: dossier.name ?? null,
          email: dossier.email ?? null,
          phone: dossier.phone ?? null,
          location: dossier.location ?? null,
          linkedin: dossier.links?.linkedin ?? null,
        };

      // Stage the resume as a real file. A file input needs a path on disk, and
      // the portal is where the renderer lives, so it is asked to write the
      // document out and report where it landed. If it cannot, the application
      // still proceeds without an attachment and the agent says so, because a
      // missing CV is better than a wrong one.
      let resumePathHint = asText(args?.resume_path, 400) || null;
      let resumeNote = null;
      if (!resumePathHint) {
        const cookie = ctx?.sessionCookie ?? null;
        try {
          const res = await fetch('http://127.0.0.1:5175/api/resume/document?as_path=1', {
            headers: cookie ? { Cookie: cookie } : {},
            signal: AbortSignal.timeout(60000),
          });
          if (res.ok) {
            const body = await res.json();
            if (body?.path) resumePathHint = String(body.path);
          } else {
            resumeNote = 'The resume could not be staged, so the CV field will be left empty.';
          }
        } catch {
          resumeNote = 'The resume could not be staged, so the CV field will be left empty.';
        }
      }

      // The task is written out rather than left to the agent's judgement,
      // because this one submits a real application with someone's name on it.
      // The rule that matters is the last instruction: a question the dossier
      // cannot answer must be reported, never guessed. A fabricated answer on a
      // form is a false statement from the candidate, which is the one thing
      // this whole system is built not to do.
      const resumePath = resumePathHint;
      const lines = [
        `Open this job application: ${url.value}`,
        '',
        'Fill the application form using ONLY these facts about the applicant:',
        ...Object.entries(fields)
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
          .map(([key, value]) => `  ${key}: ${String(value).slice(0, 200)}`),
        '',
        'Rules, in priority order:',
        '1. If the site asks for anything not listed above, STOP and report the',
        '   exact question instead of answering it. Do not guess, do not invent a',
        '   value, and do not reuse a value from a different field.',
        '2. If a login is required, STOP and report that you need the user to',
        '   sign in. Do not enter or request credentials.',
        '3. If a CAPTCHA or any human-verification step appears, STOP and report',
        '   it. The user will solve it in the browser; do not attempt to bypass it.',
        '4. Calling this tool IS the instruction to submit. Fill every field the',
        '   facts above can answer, then press the final Submit/Apply button and',
        '   stay on the page until the result is visible. Do not stop at the submit',
        '   button to ask permission - that is the step the user is delegating.',
        '   The one exception is rules 1 to 3: an unanswerable question, a login,',
        '   or a CAPTCHA still stops the run and gets reported.',
        '5. If you tick any agreement, consent or privacy checkbox, say which one',
        '   in your report, so the user can see what was accepted in their name.',
        '6. Report exactly which fields you filled, which you left blank, whether',
        '   the submission went through, and any step you could not complete.',
      ];
      if (resumePath) {
        lines.splice(3, 0, `  resume file to attach: ${resumePath}`, '');
      }
      const task = lines.join('\n');

      // A form fill takes minutes, not seconds: navigate, read the page, type
      // into each field, attach a file. The default budget is the full ten
      // minutes. Reading this as Number(args?.timeout_ms || 0) + 20000 gave a
      // 20-second default when the caller passed nothing, which aborted every
      // real application partway through.
      const budgetMs = args?.timeout_ms
        ? Math.min(600000, Math.max(30000, Number(args.timeout_ms)))
        : 600000;

      // A stale socket is recoverable, so it is recovered from rather than
      // reported. Chrome suspends the extension's service worker when idle and
      // the hub's socket can keep claiming to be open afterwards, so the first
      // dispatch after a quiet spell goes into a socket nobody is listening on.
      // Reopening the launcher gets a real extension attached; the generation
      // counter is what tells us the retry is going somewhere live.
      const dispatch = async () => {
        const res = await fetch('http://127.0.0.1:38401/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task }),
          signal: AbortSignal.timeout(budgetMs),
        });
        if (!res.ok) return { httpError: `Page agent returned HTTP ${res.status}` };
        return await res.json();
      };

      let data;
      try {
        data = await dispatch();
      } catch (err) {
        return { error: String(err.message || err), nothingWasSubmitted: true };
      }

      if (data?.success === false && /disconnected while task/i.test(String(data.error || ''))) {
        const before = await hubStatus();
        await reopenLauncher();
        const fresh = await waitForFreshConnection(before.generation);
        if (fresh.connected) {
          recoveredNote = 'reconnected your browser and tried again';
          try {
            data = await dispatch();
          } catch (err) {
            return { error: String(err.message || err), nothingWasSubmitted: true };
          }
        }
      }

      // The hub uses success:false for two quite different things, and reading
      // only `error` collapsed them into one and threw the useful half away.
      //
      //   error, no result -> it could not run: no browser, or the task crashed
      //   result, no error -> it ran and STOPPED, and the report is the result
      //
      // The second is the interesting one and it is the whole point: the agent
      // reached a question the dossier cannot answer, or a CAPTCHA, and stopped
      // to ask. Treating that as a failure discarded a complete, correct report
      // and replaced it with "the page agent could not run the task".
      if (data?.success === false) {
        const stopped = typeof data.result === 'string' && data.result.trim()
          ? data.result.trim()
          : '';
        if (stopped) {
          // The agent reported rather than failed. It ran, it filled what it
          // could, and it stopped at something. That is the case this whole
          // tracking system exists for, so it is recorded and mailed before the
          // reply goes back - the model is about to be told to move on to the
          // next job, and the email is what the candidate reads when they get
          // to a keyboard.
          const outstanding = extractOutstanding(stopped);
          const blocker = classifyBlocker({ report: stopped, outstanding });
          const row = await recordOutcome(ctx.clientId, application.id, {
            status: 'blocked', blocker, outstanding,
          });
          const mailed = await notifyBlocker(ctx, row || application, blocker);
          return {
            ok: true,
            url: url.value,
            result: stopped,
            recovered: recoveredNote,
            // Stopped on purpose rather than finished. Saying so is the whole
            // contract: a stopped application must never read as a sent one.
            stopped: true,
            submitted: false,
            needsUser: /captcha|verification|sign in|log ?in|password|require action|not listed|stopped/i
              .test(stopped),
            // The agent reports in markdown under headings like "Fields Filled"
            // and "Fields NOT Filled (require action)", and the shape varies with
            // what it found: numbered or bulleted, bold or plain labels, with the
            // field index before or after the label. Only the outstanding section
            // is read, because a list that also contains the fields it managed to
            // fill tells the user nothing about what they are being asked for.
            outstanding,
            // The id is the handle the candidate uses to come back to this
            // exact listing. Without it in the reply, "carry on with that one"
            // has nothing to refer to.
            applicationId: application.id,
            applicationStatus: 'blocked',
            blockedOn: blocker.step || blocker.kind,
            blockerKind: blocker.kind,
            emailed: mailed.emailed,
            // Said explicitly so the model does not sit on a blocked job waiting
            // for permission. The candidate was emailed; the next job is the
            // productive move and this one waits for them.
            nextStep: `Emailed the candidate about this one. Carry on with the next `
              + `job on your list; ask them to say "continue on job ${application.id}" `
              + 'to pick this one back up.',
          };
        }
        // No report at all: the agent never ran. 'failed' rather than 'blocked',
        // because there is no wall for a human to clear - retrying is the right
        // response and the candidate does not need an email about it.
        await recordOutcome(ctx.clientId, application.id, {
          status: 'failed',
          error: data.error || 'the page agent could not run the task',
        });
        return {
          error: data.error || 'the page agent could not run the task',
          needsUser: /not connected|extension|sign in|login|captcha|verification/i
            .test(String(data.error || '')),
          nothingWasSubmitted: true,
          recovered: recoveredNote,
          applicationId: application.id,
          applicationStatus: 'failed',
        };
      }
      const output = String(data?.result ?? '');
      // A prose "success" can still be a stop: the agent says it needed the user
      // mid-run and then finished its report without submitting. The two flags
      // are computed first, and the row is written from the same pair, because
      // deciding `submitted` and then recording a different status is how a row
      // ends up reading "submitted" for an application no employer ever received.
      const needsUser = /captcha|verification|sign in|log ?in|password|need the user|stopped/i
        .test(output);
      const submitted = /submitted|application (was |)sent|thank you for applying/i.test(output)
        && !/did not submit|not submitted|stopped before/i.test(output);

      // A run that both submitted and mentioned needing the user is a
      // contradiction, and the safe reading is the pessimistic one: an
      // application is only marked submitted when the report says it went out
      // and nothing in the same report says otherwise.
      if (submitted && !needsUser) {
        await recordOutcome(ctx.clientId, application.id, { status: 'submitted' });
      } else {
        const outstanding = extractOutstanding(output);
        const blocker = classifyBlocker({ report: output, outstanding });
        const row = await recordOutcome(ctx.clientId, application.id, {
          status: 'blocked', blocker, outstanding,
        });
        const mailed = await notifyBlocker(ctx, row || application, blocker);
        return {
          ok: true,
          url: url.value,
          result: output,
          recovered: recoveredNote,
          needsUser: true,
          submitted: false,
          stopped: true,
          outstanding,
          applicationId: application.id,
          applicationStatus: 'blocked',
          blockedOn: blocker.step || blocker.kind,
          blockerKind: blocker.kind,
          emailed: mailed.emailed,
          nextStep: `Emailed the candidate about this one. Carry on with the next `
            + `job on your list; ask them to say "continue on job ${application.id}" `
            + 'to pick this one back up.',
        };
      }

      return {
        ok: true,
        url: url.value,
        result: output,
        recovered: recoveredNote,
        // The agent reports back in prose, so the stop conditions are detected
        // here rather than trusted. A run that mentions needing the user must
        // not be summarised as a completed application.
        needsUser,
        submitted,
        applicationId: application.id,
        applicationStatus: 'submitted',
        // Which address this went from, so the candidate is told rather than
        // having to ask. Null when they are sending from a claimed address of
        // their own, which they already know.
        sentFrom: sendIdentityNote ? sendIdentityNote : undefined,
      };
    },

    /**
     * List this candidate's applications, newest first.
     *
     * The dashboard and the model both need the same thing - what Jobby has
     * tried, what is stuck, and what is done - so there is one tool rather than
     * an endpoint for the site and prose for the agent. Blocked rows carry their
     * blocker inline, because "blocked" alone does not tell the candidate
     * whether there is anything they can do about it.
     */
    async jobby_applications(args, ctx) {
      const rows = await listApplications(ctx.clientId, {
        status: args?.status ?? null,
        limit: Number(args?.limit) || 50,
      });
      const shape = (r) => ({
        id: r.id,
        company: r.company,
        role: r.role,
        url: r.url,
        status: r.status,
        blockedOn: r.blocker_step,
        blocker: r.blocker_kind,
        blockerDetail: r.blocker_detail,
        outstanding: r.outstanding || [],
        attempts: r.attempts,
        emailed: !!r.notified_at,
        submittedAt: r.submitted_at,
        updatedAt: r.updated_at,
      });
      const blocked = rows.filter((r) => r.status === 'blocked');
      return {
        ok: true,
        count: rows.length,
        applications: rows.map(shape),
        // Counted here rather than left to the caller. A summary that says
        // "you have 6 applications" when two of them are stuck in a CAPTCHA is
        // the reason people lose track of what the agent is actually doing.
        blockedCount: blocked.length,
        // Only unactioned ones. Re-running a blocked listing unprompted is the
        // behaviour that produced the duplicate-mail problem in the first place.
        needsYou: blocked
          .filter((r) => !r.notified_at)
          .map((r) => ({ id: r.id, company: r.company, role: r.role, blockedOn: r.blocker_step })),
      };
    },

    /**
     * Pick a blocked application back up, on the form that is still open.
     *
     * This is the tool the sentence "continue on job 41" reaches, and the whole
     * design is in `buildResumeTask`: the browser is still sitting on the
     * half-finished form, so the task must not navigate. Re-opening the URL
     * would discard everything already typed and re-present the CAPTCHA the
     * candidate just solved, which is the single most frustrating thing this
     * system could do to someone who came back specifically to help.
     *
     * Answers supplied here are passed to the agent as facts for this run. They
     * are deliberately NOT written to the dossier here: a dossier edit is a
     * separate, auditable act, and smuggling it inside a browser task would make
     * "what did Jobby write down about me" unanswerable.
     */
    /**
     * Ingest a video or image the user has sent, so it can be looked at.
     *
     * This is the one place a filesystem path or URL is accepted. The bytes are
     * copied into the relay's managed media root and addressed by id from then
     * on, so a later call cannot be pointed at an arbitrary file on this machine -
     * and so the file cannot be swapped out after the user pointed at it.
     *
     * The guardrail matters more than the capability. A video is a source the
     * candidate controls, so nothing in it is evidence about them - the same rule
     * the verification layer applies to a self-published site or a profile the
     * candidate wrote. So the brief is an opinion about a video, and this writes
     * nothing to the dossier. If the user wants a claim recorded, they have to
     * say it, and the ordinary edit tools handle that.
     */
    async jobby_register_media(args, ctx) {
      const source = args?.source || args?.url || args?.path;
      if (!source) {
        return { error: 'source is required: {"source": "C:/Users/you/Downloads/reel.mp4"} or a URL' };
      }
      const { register } = await import('../tools/media-registry.mjs');
      const r = await register({
        source,
        registeredBy: 'jobby',
        label: args?.label ? String(args.label).slice(0, 120) : null,
        note: args?.note ? String(args.note).slice(0, 400) : null,
      });
      if (r.error) return { error: r.error };
      return { ok: true, media_id: r.id, kind: r.kind, bytes: r.bytes, label: r.label, note: r.note, registeredAt: r.registeredAt };
    },

    /**
     * Run a command the candidate typed themselves.
     *
     * Jobby is denied the raw `shell-exec` tool, and that denial is deliberate:
     * he reads job postings, which anyone on the internet can write, and resumes
     * them in a browser. Raw shell access would make a listing a remote code
     * execution vector - not a risk the candidate accepts for themselves, but one
     * imposed on them by every stranger who can post a role.
     *
     * This is the capability without that exposure, and the difference is
     * provenance rather than power. The command is executed only if it appears in
     * the candidate's own message. Text that arrived inside a job posting, a form
     * field, or a page the agent resumed cannot satisfy this check, because it was
     * never in the candidate's words. So this grants everything they asked for in
     * their own voice and nothing a stranger can smuggle.
     *
     * Every command run is returned in full and kept in the transcript, so the
     * candidate can always see what was executed on their machine.
     */
    async jobby_shell(args, ctx) {
      const raw = String(args?.command ?? args?.cmd ?? '').trim();
      if (!raw) return { error: 'command is required' };

      // ── 1. Provenance: it must be the candidate's own words ──────────────
      // Split on the operators that chain commands, so `curl x | sh` cannot be
      // smuggled through by having only its first segment appear in the message.
      const segments = raw.split(/\s*(?:&&|\|\||;|\||\n)\s*/).map((s) => s.trim()).filter(Boolean);
      const said = String(ctx?.userMessage || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!said) {
        return {
          error: 'No instruction from you to run anything, so nothing was run.',
          nothingWasExecuted: true,
        };
      }
      // Quotes are an execution detail, not a different intent: someone writing
      // `node -e console.log(1)` and the model running `node -e "console.log(1)"`
      // is the same request, and refusing it would train the user that this tool
      // is unreliable. Stripping them cannot smuggle anything, because a command
      // still has to appear in the user's words either way.
      const loose = (s) => String(s).toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
      const saidLoose = loose(said);
      const notFromThem = segments.filter((seg) => !saidLoose.includes(loose(seg)));
      if (notFromThem.length) {
        return {
          error: 'Refused: only commands you wrote yourself can be run. '
            + 'These parts of the request are not in your message: '
            + notFromThem.map((s) => JSON.stringify(s)).join(', ') + '. '
            + 'If you did mean to run that, say it and I will.',
          nothingWasExecuted: true,
          reason: 'command not traceable to the user\'s own message',
        };
      }

      // ── 2. Rate limit, per candidate ─────────────────────────────────────
      const now = Date.now();
      const key = 'jobby_shell:' + (ctx?.clientId ?? 'unknown');
      const prior = SHELL_RATE.get(key) || [];
      const recent = prior.filter((t) => now - t < 10 * 60_000);
      if (recent.length >= 10) {
        return {
          error: 'That is 10 commands in ten minutes. Wait a few minutes before running more.',
          nothingWasExecuted: true,
          reason: 'rate limit',
        };
      }
      recent.push(now);
      SHELL_RATE.set(key, recent);

      // ── 3. Run it ────────────────────────────────────────────────────────
      // execFile with an argv array, never a shell string, so nothing in the
      // command can be re-interpreted as syntax.
      const parts = raw.match(/"[^"]*"|'[^']*'|\S+/g) || [raw];
      try {
        const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
          timeout: 30000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
        console.log(`[jobby-shell] client ${ctx?.clientId} ran: ${raw}`);
        return {
          ok: true,
          command: raw,
          exitCode: 0,
          stdout: String(stdout || '').slice(0, 8000),
          stderr: String(stderr || '').slice(0, 2000),
        };
      } catch (e) {
        console.log(`[jobby-shell] client ${ctx?.clientId} ran (failed): ${raw}`);
        return {
          ok: false,
          command: raw,
          exitCode: e.code ?? null,
          stdout: String(e.stdout || '').slice(0, 8000),
          stderr: String(e.stderr || e.message || '').slice(0, 2000),
          note: 'It ran and failed. The output above is what it printed.',
        };
      }
    },

    /**
     * Find out who to approach at a company, and show where each fact came from.
     *
     * Reads the company's own public pages. Sends nothing, contacts nobody, and
     * holds no LinkedIn credential — deliberately, because the alternative was a
     * $69/seat/month third party holding a credential for someone's professional
     * identity.
     *
     * Every result carries its source URL and an evidence tier, and the coverage
     * block says what could not be established. Read that before treating a short
     * list as a full one: public sources have real gaps, and "Andrew Kuchling,
     * Vice President" from an archived board page may be a role held in 2014.
     */
    /**
     * Name the roles a candidate's background actually maps onto, and say when a
     * role they used to have has a modern equivalent.
     *
     * Two modes. With `previous` it answers the displacement question — "I was a
     * data entry specialist, what now" — which is the most useful thing Jobby can
     * say to someone whose title has been phased out. Without it, it reads the
     * dossier and reports what it recognised, with the exact words that matched.
     *
     * Every result carries `confidence: stated` when the title was named outright
     * or `inferred` when it came from signal words, plus the evidence. Do not
     * present an inferred match as a fact: say what in the resume suggested it,
     * and ask the candidate to correct it if it is wrong. A candidate told they
     * are a Data Engineer when they are an Analytics Engineer stops trusting
     * everything else the dossier says.
     */
    /**
     * Build the version of the dossier that fits a specific opportunity.
     *
     * "Which version of you" is the wrong question and this answers the right
     * one. Nobody is asking "who are you in general" — a recruiter is asking
     * "are you the person for THIS job", and the honest answer needs the view
     * that job is read through, plus what it cannot show.
     *
     * The view never invents. If a candidate has no equipment history, a FIFO
     * view says so in `whatItCannotShow` rather than borrowing the closest office
     * adjective — the same rule the dossier follows about unconfirmed fields.
     */
    async jobby_view_dossier(args, ctx) {
      const dossierRow = await store.getDossier(ctx?.clientId);
      const dossier = dossierRow?.dossier ?? null;
      if (!dossier || !Object.keys(dossier).length) {
        return { ok: false, error: 'No dossier yet. Upload a resume first.' };
      }

      const requested = String(args?.view || args?.track || '').trim();
      let viewId;
      let basis;
      if (/^\d+$/.test(requested)) {
        viewId = viewForTrack(Number(requested));
        basis = `track ${requested}`;
      } else {
        viewId = requested || null;
        basis = 'asked for directly';
      }

      if (!viewId) {
        // No view given: show all of them, so the candidate sees which ones have
        // real content in them before choosing.
        return {
          ok: true,
          basis,
          views: buildAllViews(dossier),
          note:
            'These are five ways of reading the same dossier, not five people. '
            + 'Tell me which kind of work you are targeting and I will build the packet for it.',
        };
      }

      const view = buildView(dossier, viewId);
      const titled = matchTitles(`${dossierText(dossier)}`, { limit: 3 });

      return {
        ok: true,
        basis,
        view: {
          id: view.view,
          label: view.label,
          blurb: view.blurb,
          audience: view.audience,
          sections: view.sections,
          // Non-empty is the common case: a FIFO view of an office-only dossier
          // still shows employment, but says what it cannot show on top of that.
          whatItCannotShow: view.whatItCannotShow,
          empty: view.empty,
          note: view.note,
        },
        likelyTitles: titled.map((t) => ({ name: t.name, confidence: t.confidence, evidence: t.evidence })),
        say:
          `Here is you as a ${view.label.toLowerCase()} candidate — the same person, `
          + `reframed for ${view.audience} `
          + (view.empty
            ? `I have nothing to show for it yet, and I would rather say that than pad it. `
            : view.whatItCannotShow.length
              ? `What I cannot show from this view: ${view.whatItCannotShow.join(', ')}. `
              : '') +
          (view.sections[0] ? `What leads with: ${view.sections[0].label.toLowerCase()}. ` : '') +
          `Anything in there wrong, say so and I will correct it.`,
      };
    },

    async jobby_match_titles(args, ctx) {
      const previous = String(args?.previous || args?.previous_title || '').trim();

      // ── Displacement: what replaced the role they had ────────────────────
      if (previous) {
        const equivalents = modernEquivalent(previous);
        if (!equivalents.length) {
          return {
            ok: true,
            previous,
            equivalents: [],
            say:
              `I do not have a mapping for "${previous}". That is a gap in my library, ` +
              `not a judgement about your background — I would rather say so than ` +
              `invent a modern equivalent. Tell me roughly what you did and I will ` +
              `work it out, or I can search for roles and let you judge.`,
            gap: true,
          };
        }
        return {
          ok: true,
          previous,
          equivalents: equivalents.map((e) => ({
            id: e.id,
            name: e.name,
            definition: e.definition,
            absorbedWork: e.superseded,
            // What a resume needs to show to be credible in the newer title.
            showsFor: e.showsFor,
          })),
          say:
            `"${previous}" is largely gone as a job title. The work moved into ` +
            `${equivalents.map((e) => e.name).join(' and ')}. ` +
            equivalents.map((e) => `${e.name} means this: ${e.definition}`).join(' ') +
            `What would help you read as one today: ${equivalents[0].showsFor.slice(0, 4).join(', ')}. ` +
            `Check that against your own experience before you take my word for it.`,
        };
      }

      // ── Recognition: what does the dossier support? ───────────────────────
      const dossier = await store.getDossier(ctx?.clientId);
      const text = dossier?.dossier ? dossierText(dossier.dossier) : '';
      if (!text.trim()) {
        return {
          ok: false,
          error: 'No resume on file yet. Upload one and I can tell you what it maps onto.',
          librarySize: ALL_TITLES.length,
        };
      }

      const matches = matchTitles(text, { limit: 5 });
      const tickets = detectTickets(text);
      if (!matches.length) {
        return {
          ok: true,
          matches: [],
          tickets,
          // The honest negative. It means the library did not recognise the role,
          // not that the candidate has none.
          say:
            `I could not match this resume against the ${ALL_TITLES.length} job titles I know ` +
            `about. That is a gap in my library rather than a judgement on your background. ` +
            (tickets.length
              ? `I can see you hold ${tickets.map((t) => t.label).join(' and a ')}, which ` +
                `narrows this down — tell me what you actually did and I will work from there. `
              : '') +
            `Tell me what you were doing in your own words and I will work it out from there.`,
          gap: true,
        };
      }

      const detailed = matches.map((m) => {
        const t = knownTitle(m.id);
        return {
          id: m.id,
          name: m.name,
          family: ALL_FAMILIES[t?.family] || null,
          confidence: m.confidence,
          evidence: m.evidence,
          definition: t?.definition,
          supersededRoles: t?.supersedes || [],
          notableFor: t?.notableFor || null,
          // The part that decides whether they can actually be hired. Omitting it
          // and telling someone they are a good fit for a licensed trade they hold
          // no licence for is the worst kind of wrong.
          ticketRequired: t?.ticketMeans || null,
          notThis: t?.notEqualTo || [],
        };
      });

      const gated = detailed.filter((d) => d.ticketRequired).slice(0, 2);

      return {
        ok: true,
        matches: detailed,
        tickets,
        say:
          `Based on what the resume actually says, you look like a ` +
          `${detailed.map((d) => d.name).join(' and a ')}. ` +
          detailed.map((d) => `${d.name}: ${d.definition}`).join(' ') +
          (tickets.length
            ? `I can see you hold ${tickets.map((t) => t.label).join(' and a ')}. `
            : '') +
          (gated.length
            ? `One thing to check before you apply: ${gated.map((d) => d.ticketMeans).join(' ')} `
            : '') +
          `Tell me if that is wrong — I am reading words on a page, not you.`,
      };
    },

    async jobby_source_company(args, ctx) {
      const company = String(args?.company || args?.name || '').trim();
      if (!company) {
        return { error: 'Tell me which company. For example: "Agnico Eagle".' };
      }

      // Discovery uses the relay's own search so this does not depend on the
      // caller having wired a search function. Reading explicit urls still works
      // without it, which is the escape hatch when a site blocks us.
      const relaySearch = async ({ query, limit }) => {
        try {
          const { webSearch } = await import('../lib/web-search.mjs').catch(() => ({}));
          if (typeof webSearch === 'function') {
            const res = await webSearch({ query, limit });
            return { results: res?.results || [] };
          }
        } catch { /* fall through to the relay endpoint */ }
        try {
          const base = process.env.PUBLIC_RELAY_URL || 'http://127.0.0.1:8080';
          const res = await fetch(`${base}/tools/run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.RELAY_API_KEY || '',
              'x-agent-id': 'jobby',
            },
            body: JSON.stringify({ tool: 'web-search', args: { query, limit } }),
          });
          if (!res.ok) return { results: [] };
          const json = await res.json();
          return { results: json.results || [] };
        } catch {
          return { results: [] };
        }
      };

      const result = await sourceCompany(
        {
          company,
          urls: args?.urls,
          roleHint: args?.role || args?.role_hint || null,
          limit: args?.limit || 5,
          clientId: ctx?.clientId,
        },
        { searchFn: relaySearch },
      );

      if (!result.ok) {
        return {
          error: result.error,
          hint: result.hint,
          nothingWasSent: true,
        };
      }

      return {
        ok: true,
        company: result.company,
        pagesRead: result.pagesRead,
        people: result.people,
        inboxes: result.inboxes,
        coverage: result.coverage,
        sending: result.sending,
        nextStep: result.nextStep,
        // Phrased for the candidate, because the model relays this verbatim.
        say:
          `I read ${result.pagesRead.length} page(s) on ${company}'s own site and found ` +
          `${result.people.length} named ${result.people.length === 1 ? 'person' : 'people'} ` +
          `with a stated job title, plus ${result.inboxes.length} published address(es). ` +
          (result.coverage.complete
            ? 'Everything I have is sourced and dated.'
            : `What I could not establish: ${result.coverage.gaps.join(' ')} `) +
          `I have not contacted anyone and I will not until you say so.`,
      };
    },

    async jobby_video_brief(args, ctx) {
      // Media is addressed by id, not path. A path that is not already in the
      // managed root is refused by the registry, which is what keeps this tool
      // from being a way to read the disk.
      const mediaId = args?.media_id || args?.mediaId;
      if (!mediaId) {
        return {
          error: 'media_id is required. Register the file first: jobby_register_media {"source": "C:/Users/you/Downloads/reel.mp4"}',
        };
      }
      // A brief costs a vision call and takes tens of seconds, so it reviews one
      // range at a time rather than letting a model sweep a directory.
      const { videoBrief } = await import('../tools/perception.mjs');
      const brief = await videoBrief({
        media_id: mediaId,
        frames: args?.frames ?? 12,
        cols: args?.cols ?? 4,
        from: args?.from ?? null,
        to: args?.to ?? null,
        scene_threshold: args?.scene_threshold ?? 12,
        transcript: args?.transcript ?? null,
        model: 'space-bunny-free',
      });

      if (!brief.success) {
        return { error: brief.error, suggestion: brief.suggestion || null };
      }
      // The base64 sheet is megabytes and this result may be stored, so it is left
      // out. The path is enough for the user to open.
      return {
        ok: true,
        media_id: brief.mediaId,
        kind: brief.kind,
        measured: brief.measured,
        read: brief.read,
        contactSheetPath: brief.contactSheet.path,
        warnings: brief.warnings,
        evidence: 'opinion about a video. Not a verified claim about the person in it, and nothing was written to the dossier.',
      };
    },

    async jobby_continue(args, ctx) {
      const id = Number(args?.id ?? args?.application_id ?? args?.job);
      if (!Number.isInteger(id) || id < 1) {
        return { error: 'id must be the number of the job, e.g. 41' };
      }
      // Scoped to this client. Without the client_id predicate, any candidate
      // could resume - and read the blocker text of - anyone else's application
      // by guessing a small integer.
      const existing = await getApplication(ctx.clientId, id);
      if (!existing) {
        return { error: `No job ${id} on your list.`, nothingWasSubmitted: true };
      }
      if (existing.status === 'submitted') {
        return {
          ok: true, applicationId: id, applicationStatus: 'submitted',
          note: 'That one already went out. There is nothing to continue.',
        };
      }

      // Same gate as a first attempt: a verified address is what makes this
      // application the candidate's, and resuming is not a loophole around it.
      {
        const { assertCanRepresent } = await import('./claim.mjs');
        const claim = await assertCanRepresent(ctx.clientId);
        if (!claim.ok) {
          return {
            error: claim.error, reason: 'email address not verified',
            needsUser: true, howToFix: claim.howToFix, nothingWasSubmitted: true,
          };
        }
      }

      const ready = await ensurePageAgent({ requestedBy: 'jobby_continue' });
      if (!ready.ok) {
        const blocker = classifyBlocker({ error: ready.advice || ready.reason || '' });
        await recordOutcome(ctx.clientId, id, { status: 'blocked', blocker });
        return {
          error: 'I could not get to your browser, so nothing was submitted.',
          reason: ready.reason, needsUser: true, howToFix: ready.advice,
          applicationId: id, applicationStatus: 'blocked',
        };
      }

      // Free the row before dispatching, not after. If the dispatch throws, the
      // row must already show that the candidate came back and tried, or the
      // site shows a blockage that was in fact being worked on.
      const row = await resumeAttempt(ctx.clientId, id);

      const dossierRow = await store.getDossier(ctx.clientId);
      const dossier = dossierRow?.dossier ?? {};
      const facts = {
        full_name: dossier.name ?? null,
        email: dossier.email ?? null,
        phone: dossier.phone ?? null,
        location: dossier.location ?? null,
        linkedin: dossier.links?.linkedin ?? null,
      };
      // A flat label -> value map. Anything else is a nested object, which would
      // be stringified into the task as "[object Object]" and put that on a form.
      const answers = {};
      if (args?.answers && typeof args.answers === 'object' && !Array.isArray(args.answers)) {
        for (const [k, v] of Object.entries(args.answers)) {
          if (v === null || v === undefined || v === '') continue;
          if (typeof v === 'object') continue;
          answers[String(k).slice(0, 120)] = String(v).slice(0, 400);
        }
      }

      // Same staged-file path as a first attempt, so a form that still needs the
      // CV gets the same real file rather than an empty attachment.
      let resumePath = asText(args?.resume_path, 400) || null;
      if (!resumePath) {
        try {
          const res = await fetch('http://127.0.0.1:5175/api/resume/document?as_path=1', {
            headers: ctx?.sessionCookie ? { Cookie: ctx.sessionCookie } : {},
            signal: AbortSignal.timeout(60000),
          });
          if (res.ok) {
            const body = await res.json();
            if (body?.path) resumePath = String(body.path);
          }
        } catch { /* the form can be completed without it; the agent will say so */ }
      }

      const task = buildResumeTask(row || existing, { facts, answers, resumePath });

      const budgetMs = args?.timeout_ms
        ? Math.min(600000, Math.max(30000, Number(args.timeout_ms)))
        : 600000;

      let data;
      try {
        const res = await fetch('http://127.0.0.1:38401/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task }),
          signal: AbortSignal.timeout(budgetMs),
        });
        if (!res.ok) {
          await recordOutcome(ctx.clientId, id, { status: 'failed', error: `HTTP ${res.status}` });
          return { error: `The page agent returned HTTP ${res.status}`, applicationId: id };
        }
        data = await res.json();
      } catch (err) {
        await recordOutcome(ctx.clientId, id, {
          status: 'failed', error: String(err.message || err),
        });
        return {
          error: String(err.message || err), nothingWasSubmitted: true,
          applicationId: id, applicationStatus: 'failed',
        };
      }

      const text = String(data?.result ?? '');
      const stopped = data?.success === false
        ? (typeof data.result === 'string' && data.result.trim() ? data.result.trim() : '')
        : '';
      // A resumed run is judged exactly like a first one. Reusing a different
      // success test here is how "it submitted" starts meaning two things
      // depending on which path got there.
      const needsUser = /captcha|verification|sign in|log ?in|password|need the user|stopped/i
        .test(stopped || text);
      const submitted = !needsUser
        && /submitted|application (was |)sent|thank you for applying/i.test(text)
        && !/did not submit|not submitted|stopped before/i.test(text);

      if (submitted) {
        await recordOutcome(ctx.clientId, id, { status: 'submitted' });
        return {
          ok: true, applicationId: id, applicationStatus: 'submitted',
          submitted: true, result: text, url: existing.url,
        };
      }

      const outstanding = extractOutstanding(stopped || text);
      const blocker = classifyBlocker({ report: stopped || text, error: data?.error, outstanding });
      const updated = await recordOutcome(ctx.clientId, id, {
        status: 'blocked', blocker, outstanding,
        error: data?.success === false ? (data.error || null) : null,
      });
      const mailed = await notifyBlocker(ctx, updated || existing, blocker);
      return {
        ok: true,
        applicationId: id,
        applicationStatus: 'blocked',
        submitted: false,
        stopped: true,
        needsUser: true,
        blockedOn: blocker.step || blocker.kind,
        blockerKind: blocker.kind,
        emailed: mailed.emailed,
        outstanding,
        result: stopped || text,
        url: existing.url,
        nextStep: 'Still blocked. If the candidate cleared the thing in their browser, '
          + 'ask them to check the page is still open, then try this again.',
      };
    },

    /**
     * List the claims on this dossier that have been checked, and which of them
     * may be shown to an employer.
     *
     * Returns marked and unmarked separately, and the unmarked ones say WHY -
     * unchecked, self-published only, or sources in conflict. "Unverified" on its
     * own reads as a failure; "the only sources that agree are ones he can edit"
     * is something he can act on.
     */
    async jobby_verifications(args, ctx) {
      const V = await import('./verification.mjs');
      const rows = await V.listVerifications(ctx.clientId, { includeStale: true });
      const shape = (v) => ({
        path: v.path,
        claim: String(v.claim).slice(0, 300),
        verdict: v.verdict,
        mark: v.mark,
        method: v.method,
        source: v.source,
        url: v.url,
        checkedAt: v.checkedAt,
        stale: v.stale,
        expired: v.expired,
      });
      const marked = rows.filter((v) => v.mark);
      const rest = rows.filter((v) => !v.mark);
      return {
        ok: true,
        tracked: rows.length,
        // The number that goes on a CV.
        markedCount: marked.length,
        marked: marked.map(shape),
        unmarkedCount: rest.length,
        unmarked: rest.map(shape),
        // Worth checking: public records, awards, published work. Said plainly so
        // the candidate knows which of his claims are the checkable kind.
        note: marked.length
          ? `${marked.length} claim${marked.length === 1 ? '' : 's'} may be shown to an employer as `
            + 'independently checked. Everything else is the candidate\'s word alone and carries no mark.'
          : 'Nothing on this dossier has been checked against an independent source yet, so nothing '
            + 'carries a mark. That is the honest state of it, not a fault.',
      };
    },

    /**
     * Record the outcome of a check the agent has just performed.
     *
     * The verdict is COMPUTED here from the sources supplied, never accepted from
     * the caller. A tool that let the model assert "verified" would be a tool for
     * asserting verified, and the whole point of the feature is that a mark means
     * something was checked.
     *
     * `independent` is the field to be careful with, and the honest default is
     * false. A page the candidate wrote, a profile they control, a repository
     * they can push to, a wiki article they edited: all of these will agree with
     * them, because they made them agree. Recording one as independent turns
     * Jobby into a rubber stamp for whatever the candidate has published.
     */
    async jobby_record_verification(args, ctx) {
      const V = await import('./verification.mjs');
      const path = asText(args?.path, 200);
      const claim = asText(args?.claim, 2000);
      if (!path) return { error: 'path is required, e.g. "employment[2]" or "achievements[0]"' };
      if (!claim) return { error: 'claim is required: the exact text that was checked' };

      const sources = Array.isArray(args?.sources) ? args.sources : [];
      const shaped = sources
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          name: asText(s.name, 300),
          url: asText(s.url, 800),
          says: asText(s.says, 2000),
          // Only an explicit true counts. Anything absent, null or a string
          // leaves it false, which is the answer that produces no mark.
          independent: s.independent === true,
          contradicts: s.contradicts === true,
        }));

      const judged = V.judgeClaim({ claim, sources: shaped });
      const row = await V.recordVerification(ctx.clientId, {
        path, claim,
        verdict: judged.verdict,
        independent: judged.independent,
        method: asText(args?.method, 1000),
        sourceName: judged.independent
          ? shaped.filter((s) => s.independent).map((s) => s.name).filter(Boolean).join('; ') || null
          : null,
        sourceUrl: judged.independent
          ? shaped.filter((s) => s.independent).map((s) => s.url).filter(Boolean)[0] || null
          : null,
        evidence: args?.evidence && typeof args.evidence === 'object' ? args.evidence : null,
        checkedBy: 'jobby',
      });
      if (row?.error) return { error: row.error };

      return {
        ok: true,
        path,
        verdict: judged.verdict,
        mark: judged.markable ? V.markFor(judged.verdict) : null,
        reason: judged.reason,
        // Spelled out, because this is the sentence that keeps a mark honest.
        nextStep: judged.markable
          ? 'Verified against an independent source, so it may be shown to an employer. The mark '
            + 'says what was checked and against what - nothing more.'
          : 'No mark. Only an independent source - one the candidate cannot edit - can produce one. '
            + 'A site, profile, repository or article of their own will agree with them because they '
            + 'wrote it, and that is not verification.',
      };
    },

    async jobby_research(args, ctx) {
      const q = requireString(
        { query: args?.query ?? args?.q ?? args?.search ?? args?.terms },
        'query', { max: 400, field: 'query' });
      if (q.error) return { error: q.error };
      if (!llmChat) return { error: 'search is not available in this context' };
      const results = await llmChat.search(q.value);
      const trimmed = results.slice(0, 8).map(r => ({
        title: asText(r.title, 160), url: asText(r.url, 400),
        snippet: asText(r.snippet ?? r.description, 300),
      }));
      // An empty result set is a real answer and must be reported as one.
      // Inventing plausible-looking listings is the single worst failure mode
      // for an agent whose job is to send the user at real opportunities.
      return trimmed.length
        ? { ok: true, query: q.value, count: trimmed.length, results: trimmed }
        : { ok: true, query: q.value, count: 0, results: [], note: 'Nothing found. Do not invent listings — widen the search or tell the user.' };
    },

    async jobby_add_opportunity(args, ctx) {
      const role = requireString(
        { role: args?.role ?? args?.title ?? args?.position },
        'role', { max: 200, field: 'role' });
      if (role.error) return { error: role.error };
      const row = await store.addOpportunity(ctx.clientId, {
        company: asText(args.company ?? args.employer, 200) ?? null,
        role: role.value,
        url: asText(args.url ?? args.link, 500) ?? null,
        source: asText(args.source, 100) ?? 'jobby',
        track: Number(args.track) || null,
        status: 'researched',
        match_score: Number.isFinite(Number(args.match_score)) ? Number(args.match_score) : null,
        match_notes: asText(args.match_notes, 800) ?? null,
        evidence: typeof args.evidence === 'object' && args.evidence ? args.evidence : {},
      });
      return { ok: true, id: row.id, role: row.role, company: row.company, track: row.track };
    },

    /**
     * Build the tailored packet for one opportunity and write it to that
     * application's node.
     *
     * Separate from jobby_apply because the two are different acts. Applying
     * dispatches something irreversible into a browser; preparing writes a
     * document the candidate can read, correct and throw away. A candidate
     * should be able to prepare three and send one.
     *
     * The return deliberately surfaces every gap rather than a bare ok. A tool
     * that returned {ok:true} here would let the agent tell a candidate their
     * application is ready when the packet is sitting on two blocking notes.
     */
    async jobby_prepare_packet(args, ctx) {
      const opportunityId = Number.isFinite(Number(args?.opportunity_id ?? args?.id))
        ? Number(args?.opportunity_id ?? args?.id) : null;
      const url = asText(args?.url ?? args?.link, 800);

      // A url or an id is the minimum needed to file anything. The error names
      // the two ways in, because the agent most often holds neither and will
      // otherwise retry the same empty call.
      if (!opportunityId && !url) {
        return {
          ok: false,
          saved: false,
          error: 'I have no posting to attach this to. Pass the url, or the opportunity_id '
            + 'from jobby_add_opportunity — without one there is nowhere to file the packet '
            + 'and you would not be able to read it back.',
        };
      }

      // Prefer the stored opportunity. The agent's own args are merged over it
      // so a URL supplied now wins, but everything it did not say keeps the
      // record's value rather than becoming null and reading as "not stated".
      const stored = await store.getOpportunity(ctx.clientId, { id: opportunityId, url });
      if (opportunityId && !stored) {
        return { error: `No opportunity ${opportunityId} on file for you.` };
      }
      let opportunity = stored;

      if (opportunity) {
        opportunity = {
          ...opportunity,
          role: asText(args?.role, 200) ?? opportunity.role,
          company: asText(args?.company, 200) ?? opportunity.company,
          url: url ?? opportunity.url,
          track: Number.isFinite(Number(args?.track)) ? Number(args.track) : opportunity.track,
          required_tickets: args?.required_tickets ?? opportunity.required_tickets,
          required_certifications: args?.required_certifications ?? opportunity.required_certifications,
          requires_visa: args?.requires_visa ?? opportunity.requires_visa,
        };
      } else {
        // No stored row. A packet is still buildable, but it has no opportunity
        // id to attach to, so the row is keyed by url alone. Said plainly rather
        // than quietly producing a packet that saves nowhere.
        opportunity = {
          role: asText(args?.role, 200),
          company: asText(args?.company, 200),
          url,
          track: Number(args?.track) || null,
          required_tickets: args?.required_tickets,
          required_certifications: args?.required_certifications,
          requires_visa: args?.requires_visa,
          match_notes: asText(args?.match_notes, 800),
          evidence: (args?.evidence && typeof args.evidence === 'object') ? args.evidence : {},
        };
      }

      if (!opportunity.role) {
        return { error: 'I need the role title to tailor anything. Pass role.' };
      }

      const dossierRow = await store.getDossier(ctx.clientId);
      const dossier = dossierRow?.dossier ?? null;

      const packet = buildPacket(dossier, opportunity, { viewId: args?.view ?? args?.view_id });

      if (!opportunity.url) {
        // A packet with no application node would be invisible to the candidate
        // and to every later read of their pipeline. Say so instead of
        // returning one that appears to be saved.
        return {
          ok: false,
          saved: false,
          error: 'This has no posting URL, so there is nowhere to file the packet. '
            + 'Give me the link and I will write it to that application.',
          packet,
        };
      }

      const row = await savePacket(ctx.clientId, {
        url: opportunity.url,
        company: opportunity.company,
        role: opportunity.role,
        opportunityId: opportunity.id ?? opportunityId,
        packet,
        notes: packet.notes,
        validation: packet.validation,
        // Not "when did we check", and not the packet build time. This is the
        // moment a *confirmed live* check was made against the posting, and
        // validateOpportunity cannot supply one: it reads the shape of the link
        // and never fetches the page. So it stays null.
        //
        // The first version stamped it whenever the opportunity had a truthy
        // `validation` field, which is not a column on job_opportunities - so it
        // was always false and validated_at was always NULL. A column that
        // silently never gets set is the same defect as a feature no page calls.
        // What actually stamps this: a fetch of the posting that returned its
        // content, which nothing does yet.
        validatedAt: null,
        viewUsed: packet.viewUsed,
        eligibility: packet.eligibility,
      });

      if (!row) {
        return {
          ok: false,
          saved: false,
          error: 'I built the packet but could not write it to the application row.',
          packet,
        };
      }

      return {
        ok: true,
        saved: true,
        applicationId: row.id,
        url: row.url,
        viewUsed: packet.viewUsed,
        viewLabel: packet.viewLabel,
        // The agent must not describe a generic reading as tailored. When this is
        // true the job was never tied to a track, and the honest line is "I read
        // your record as written, without knowing yet which kind of role this is".
        viewIsFallback: packet.viewIsFallback,
        // How many sections actually carry content. Zero used to be possible and
        // read as "nothing about you applies", which is a claim, not a gap.
        sectionsFilled: packet.sections.length,
        titles: packet.titles,
        validation: packet.validation,
        guidance: packet.guidance,
        canApply: packet.canApply,
        worthBuilding: packet.worthBuilding,
        // Every gap, in full. The agent must be able to tell the candidate what
        // is on this application rather than that it is "ready".
        notes: packet.notes,
        leadingWith: packet.leadingWith,
        sections: packet.sections.map((s) => ({ label: s.label, lead: s.lead })),
        omitted: packet.omitted,
        eligibility: packet.eligibility,
      };
    },

    async jobby_send(args, ctx) {
      // The model reaches for `to` (and sometimes `email`) far more often than
      // `recipient`. Accept all three rather than failing a send over a field
      // name — a rejected send is worse than a lenient one, and every attempt
      // is logged either way.
      const recipient = requireString(
        { recipient: args?.recipient ?? args?.to ?? args?.email },
        'recipient', { max: 320, field: 'recipient' });
      if (recipient.error) return { error: recipient.error };
      const subject = requireString(
        { subject: args?.subject ?? args?.title },
        'subject', { max: 300, field: 'subject' });
      if (subject.error) return { error: subject.error };
      const body = requireString(
        { body: args?.body ?? args?.message ?? args?.text },
        'body', { max: 20000, field: 'body' });
      if (body.error) return { error: body.error };

      // An email address is required; a bare name is not deliverable.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.value)) {
        return { error: `recipient "${recipient.value}" is not an email address. Find a real address or skip this one.` };
      }

      const gate = await store.canSend(ctx.clientId);
      if (!gate.allowed) {
        const row = await store.recordOutreach(ctx.clientId, {
          recipient: recipient.value, subject: subject.value, body: body.value,
          status: 'queued', error: gate.reason,
        });
        return {
          ok: false, blocked: gate.code ?? 'blocked', reason: gate.reason,
          queuedId: row.id,
          guidance: gate.code === 'kill_switch'
            ? 'The kill switch is on. Nothing will send until the client turns it off.'
            : gate.code === 'draft_mode'
              ? 'Client is in draft mode. Ask them to approve, or tell them it is staged.'
              : `Cap is ${gate.cap}/day. Tell the client how many went out and stop for today.`,
        };
      }

      // An application or a message to a recruiter is a representation made in
      // this person's name, so it is only sent from a session whose email address
      // has been proved. Everything about the dossier is readable without this -
      // browsing the portal needs no setup - which is what makes the gate
      // affordable: it costs a code once, and then only on a device that has not
      // been verified.
      {
        const { assertCanRepresent } = await import('./claim.mjs');
        const claim = await assertCanRepresent(ctx.clientId);
        if (!claim.ok) {
          const row = await store.recordOutreach(ctx.clientId, {
            recipient: recipient.value, subject: subject.value, body: body.value,
            status: 'queued', error: 'email address not verified',
          });
          return {
            ok: false,
            blocked: claim.code,
            reason: claim.error,
            needsUser: true,
            howToFix: claim.howToFix,
            queuedId: row.id,
            // Nothing was sent, and the message is kept so it goes out the moment
            // the address is proved rather than having to be written again.
            note: 'The message is written and waiting. Nothing has been sent.',
          };
        }
      }

      // ── The disclosure check ──────────────────────────────────────────────
      //
      // Every email must say, at the top, that a machine wrote it and on whose
      // behalf. Refused rather than warned about, because a warning is a
      // suggestion and this is the one thing in the product that must not be
      // optional.
      //
      // It sits HERE, after the cap, the kill switch, the identity gate and the
      // duplicate check, and that placement is deliberate. A first version put it
      // first — the reasoning being that it is the strictest rule — and it broke
      // two things:
      //
      //   - A kill switch, which is the candidate's emergency stop, began
      //     reporting `no_disclosure` instead of `kill_switch`. The one control that
      //     must always be the loudest thing on the page was being pre-empted by a
      //     formatting rule.
      //   - A send refused for the cap, or for an unproved address, told the model
      //     its *wording* was at fault — sending it off to rewrite an email that was
      //     never going to be sent anyway.
      //
      // Refusals are ordered by how much the candidate needs to know: stop
      // everything first, then identity, then style. A candidate whose kill switch
      // is on must hear that, not that their greeting needs work.
      //
      // The refusal is still recoverable in one step — it hands back the opening,
      // so a send costs a retry rather than a deadlock.
      const BODY = body.value;
      if (!passesDisclosure(BODY)) {
        return {
          error: 'not sent: the email does not say who wrote it.',
          reason: 'no_disclosure',
          nothingWasSent: true,
          // The first line of the body is what is checked, so this is quoted rather
          // than paraphrased — otherwise the model edits around the check.
          firstLine: BODY.split('\n').find((l) => l.trim()) || '(empty)',
          requiredOpening:
            "Hello! I'm Jobby, an assistant working on behalf of FIRSTNAME LASTNAME. " +
            "I'm writing about the POSITION LISTING role — LINK.",
          guidance:
            'Rewrite the body so it opens by naming yourself and the person you are ' +
            'writing for, then send again. Do not remove the disclosure — an employer ' +
            'who discovers a concealed introduction will not read the rest.',
        };
      }

      const dupe = await store.findRecentDuplicate(ctx.clientId, recipient.value, subject.value);
      if (dupe) {
        return {
          ok: false, blocked: 'duplicate',
          reason: `already sent at ${dupe.created_at} — not sending it twice`,
        };
      }

      const queued = await store.recordOutreach(ctx.clientId, {
        opportunity_id: Number(args.opportunity_id) || null,
        channel: asText(args.channel, 40) ?? 'email',
        recipient: recipient.value, subject: subject.value, body: body.value,
        status: 'queued',
      });

      // Prefer the candidate's own Gmail when one is connected, so employer
      // replies land in their inbox rather than the agent's. Falls back to the
      // relay's Resend transport otherwise, which is a materially worse outcome
      // for a job application and worth reporting back.
      let usedGmail = false;
      if (ctx.preferGmail) {
        const account = await googleStore.getActiveAccount(ctx.clientId);
        if (account) {
          usedGmail = true;
          try {
            const sent = await google.sendGmail({
              clientId: ctx.clientId,
              to: recipient.value,
              subject: subject.value,
              body: body.value,
              html: asText(args.html, 20000) || null,
              inReplyTo: asText(args.in_reply_to, 300) || null,
              threadId: asText(args.thread_id, 200) || null,
            });
            await store.markOutreachSent(queued.id, sent.id || 'gmail');
            return {
              ok: true, queuedId: queued.id, delivered: true, via: 'gmail',
              from: sent.from, providerId: sent.id,
              remaining: gate.remaining - 1,
            };
          } catch (e) {
            // Fall through to the relay transport rather than losing the send.
            await store.recordOutreach(ctx.clientId, {
              opportunity_id: queued.opportunity_id, recipient: recipient.value,
              subject: subject.value, body: body.value,
              status: 'failed',
              error: `gmail send failed, falling back: ${e.message}`,
            });
            usedGmail = false;
          }
        }
      }

      if (!ctx.deliver) {
        return {
          ok: true, queuedId: queued.id, delivered: false,
          note: usedGmail
            ? 'Connected Gmail account could not send, and no fallback transport is available. The message is logged.'
            : 'No mail transport wired into this context; the message is logged and queued.',
        };
      }
      try {
        // The transport may return a bare id, or an object when it also knows the
        // address it sent from. Both shapes are accepted so a transport that
        // predates per-candidate sending keeps working.
        const result = await ctx.deliver({ to: recipient.value, subject: subject.value, body: body.value });
        const providerId = typeof result === 'string' ? result : (result && result.providerId);
        const fromAddress = typeof result === 'string' ? null : (result && result.from) || null;
        await store.markOutreachSent(queued.id, providerId, fromAddress);
        return { ok: true, queuedId: queued.id, delivered: true, providerId, remaining: gate.remaining - 1 };
      } catch (e) {
        await store.recordOutreach(ctx.clientId, {
          opportunity_id: queued.opportunity_id, recipient: recipient.value,
          subject: subject.value, body: body.value,
          status: 'failed', error: String(e.message || e),
        });
        return { ok: false, error: `send failed: ${e.message || e}` };
      }
    },

    /* ── Google: Drive and mail, using the client's own account ──────── */

    async jobby_drive_search(args, ctx) {
      const g = requireGoogle();
      const query = asText(args?.query ?? args?.q ?? args?.name_contains, 300) || null;
      // A name search still excludes the trash, so "find my resume" does not
      // return something the user deleted an hour ago.
      const q = query
        ? `name contains '${String(query).replace(/'/g, "\\'")}' and trashed = false`
        : 'trashed = false';
      const res = await g.listFiles({
        clientId: ctx.clientId, query: q,
        pageSize: Number(args?.pageSize) || 25,
      });
      return {
        ok: true, query: query || '(all files)',
        count: res.files.length,
        files: res.files.map(f => ({
          id: f.id, name: f.name, mimeType: f.mimeType, size: f.size,
          modifiedTime: f.modifiedTime, url: f.webViewLink,
        })),
      };
    },

    async jobby_drive_read(args, ctx) {
      const g = requireGoogle();
      const fileId = requireString(args, 'file_id', { max: 200, field: 'file_id' });
      if (fileId.error) return { error: fileId.error };
      const res = await g.downloadFile({ clientId: ctx.clientId, fileId: fileId.value });
      const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
      return {
        ok: true,
        name: res.meta?.name, mimeType: res.meta?.mimeType,
        modifiedTime: res.meta?.modifiedTime,
        truncated: content.length > 20000,
        content: content.slice(0, 20000),
      };
    },

    async jobby_drive_write(args, ctx) {
      const g = requireGoogle();
      const name = requireString(args, 'name', { max: 200, field: 'name' });
      if (name.error) return { error: name.error };
      const content = args?.content ?? args?.body ?? args?.text;
      if (content === undefined) {
        return { error: '"content" is required: the text to write into the file' };
      }
      const fileId = args?.file_id ? String(args.file_id) : null;
      if (fileId) {
        const res = await g.updateFile({ clientId: ctx.clientId, fileId, content: String(content), name: name.value });
        return { ok: true, updated: true, id: res?.id, name: res?.name, url: res?.webViewLink };
      }
      const res = await g.createFile({
        clientId: ctx.clientId, name: name.value, content: String(content),
        mimeType: asText(args?.mimeType, 100) || 'text/plain',
        description: asText(args?.description, 400) || null,
      });
      return { ok: true, created: true, id: res?.id, name: res?.name, url: res?.webViewLink };
    },

    async jobby_drive_trash(args, ctx) {
      const g = requireGoogle();
      const fileId = requireString(args, 'file_id', { max: 200, field: 'file_id' });
      if (fileId.error) return { error: fileId.error };
      await g.trashFile({ clientId: ctx.clientId, fileId: fileId.value });
      // Say plainly that this is recoverable. Jobby never permanently deletes.
      return { ok: true, trashed: true, fileId: fileId.value, recoverable: true };
    },

    async jobby_check_replies(args, ctx) {
      const g = requireGoogle();
      const max = Math.min(Number(args?.max) || 15, 50);
      // Default to unread inbound mail, which is where employer replies land.
      const query = asText(args?.query, 300) || 'is:unread -category:promotions';
      const messages = await g.listMessages({ clientId: ctx.clientId, query, maxResults: max });
      if (!messages.length) {
        return { ok: true, query, count: 0, replies: [], note: 'No new mail matched. Say so; do not invent replies.' };
      }
      const already = await store.seenReplyIds(ctx.clientId, messages.map(m => m.id));
      const fresh = [];
      for (const m of messages) {
        if (already.has(m.id)) continue;
        const full = await g.getMessage({ clientId: ctx.clientId, messageId: m.id });
        await store.markReplySeen({
          clientId: ctx.clientId, threadId: m.threadId, messageId: m.id,
          from: m.from, snippet: full.snippet,
        });
        fresh.push({
          id: m.id, threadId: m.threadId, from: m.from, subject: m.subject,
          date: m.date, snippet: full.snippet,
          body: String(full.text || '').slice(0, 3000),
        });
      }
      return {
        ok: true, query, totalMatched: messages.length, newCount: fresh.length,
        replies: fresh,
        note: fresh.length === 0 ? 'Everything matching was already read.' : undefined,
      };
    },

    async jobby_google_status(args, ctx) {
      const g = requireGoogle();
      const status = await googleStore.statusFor(ctx.clientId);
      return {
        ok: true, connected: status.connected, email: status.email,
        scopes: status.scopes, connectedAt: status.connectedAt,
        lastRefreshedAt: status.lastRefreshedAt, lastError: status.lastError,
        restrictedScopes: g.RESTRICTED_SCOPES,
      };

    },

    async jobby_plan_status(args, ctx) {
      const actions = await store.listActions(ctx.clientId, { limit: 60 });
      const gate = await store.canSend(ctx.clientId);
      return {
        ok: true,
        sending: gate,
        open: actions.filter(a => a.status !== 'done' && a.status !== 'skipped').length,
        total: actions.length,
        next: actions.filter(a => a.status !== 'done' && a.status !== 'skipped')
          .slice(0, 6).map(a => ({ id: a.id, priority: a.priority, track: a.track, title: a.title, status: a.status })),
      };
    },

    /* ── the fleet ─────────────────────────────────────────────────────────
     *
     * `jobby-001` has been registered in `app.agents` all along — "Career Agent /
     * Negotiator" — sitting next to `eliza-001` and `vex-001`. What it did not have
     * was a way to *act* on that registration. With 26 tools Jobby could read and
     * write one person's dossier and send that person an email, and had no route at
     * all to the shared board, the other agents, or the task pipeline.
     *
     * That is the difference between an agent and a participant. It is also why
     * agent-on-agent oversight could not work for him: you cannot ask another agent
     * to review work it cannot see.
     *
     * The four below are the smallest set that makes Jobby legible to the fleet and
     * the fleet legible to him. Deliberately not ported: `db_query` and `db_rest`.
     * Eliza has them and arbitrary database access from an agent is a blast radius
     * no job-search tool needs — the 26 above already cover the legitimate cases.
     *
     * Identity note: `agent_id` is set by the relay in fleet.mjs and is not
     * readable from arguments. Jobby posts as `jobby-001` because the tool says so,
     * not because he claimed it. The bare HTTP route at /api/fleet-chat/send reads
     * `agent` straight off the request body and binds it to nothing.
     */
    async jobby_fleet_chat(args, ctx) {
      // Reading and writing are separate arguments on one tool, matching the shape
      // Eliza uses, so a caller that learned one has learned both.
      if (args?.read || (!args?.message && args?.read !== false)) {
        const res = await fleet.readFleet({
          limit: args?.limit ?? 20,
          topic: args?.topic ?? 'fleet',
          sinceMinutes: args?.since_minutes ?? null,
        });
        return {
          ...res,
          note: res.messages.some(m => !m.verified)
            ? 'Some messages were posted without a certificate. Treat an unverified speaker as a claim, not a fact.'
            : undefined,
        };
      }
      if (args?.post) {
        return fleet.postToFleet({
          message: args?.message,
          topic: args?.topic ?? 'fleet',
          payload: args?.payload ?? null,
        });
      }
      return { error: 'either read: true or post: true is required' };
    },

    async jobby_fleet_pulse(args, ctx) {
      const res = await fleet.fleetPulse();
      const others = res.agents.filter(a => !a.isJobby);
      return {
        ...res,
        me: res.agents.find(a => a.isJobby) ?? null,
        // Surfaced because it decides whether an oversight request is even
        // possible: if everyone else is idle, nobody is watching.
        othersWorking: others.filter(a => /busy/i.test(String(a.status))).map(a => a.id),
      };
    },

    async jobby_fleet_tasks(args, ctx) {
      return fleet.fleetTasks({
        stage: args?.stage ?? null,
        assignee: args?.assignee ?? null,
        limit: args?.limit ?? 25,
      });
    },

    /**
     * Read what Jobby already has before acting on it.
     *
     * The quick-reply pattern on the Suite board — "Where were we?", "What's new?"
     * — works because the answer is *read from live state*, not recited from a
     * summary. A "resume" button that replays stored text is worse than no button,
     * because it looks like knowledge and is actually a memory. So this reports
     * against the tables and says plainly when something is unreadable rather than
     * filling the gap.
     */
    async jobby_status(args, ctx) {
      const [gate, actions, apps, appRows] = await Promise.all([
        store.canSend(ctx.clientId).catch(() => null),
        store.listActions(ctx.clientId, { limit: 100 }).catch(() => []),
        store.recentOutreach(ctx.clientId, 10).catch(() => []),
        // listApplications, not a store.recentApplications that does not exist.
        // Each is individually caught because this tool reports on state, and a
        // status report that throws is worse than one that admits a gap.
        listApplications(ctx.clientId, { limit: 20 }).catch(() => []),
      ]);
      const open = (actions || []).filter(a => a.status !== 'done' && a.status !== 'skipped');
      const sent = (apps || []).filter(a => a.status === 'sent');
      const replied = (apps || []).filter(a => a.status !== 'sent' && a.status !== 'pending');

      const blocked = [];
      if (gate && gate.allowed === false) blocked.push({ reason: gate.code ?? 'blocked', detail: gate.reason });
      if (!gate) blocked.push({ reason: 'send_state_unreadable', detail: 'Could not read the send gate.' });

      return {
        ok: true,
        sending: gate,
        pipeline: {
          sent: sent.length,
          awaitingReply: (apps || []).filter(a => a.status === 'pending').length,
          responded: replied.length,
          recent: sent.slice(-5).map(a => ({ id: a.id, to: a.recipient, subject: a.subject, when: a.sent_at })),
        },
        plan: { open: open.length, total: (actions || []).length },
        blocked,
        // The honest shape of a status answer: what is blocked is more useful than
        // what is merely pending, and saying "all clear" when the gate could not be
        // read would be the exact false confidence this product is built against.
        headline: blocked.length
          ? `Blocked: ${blocked.map(b => b.reason).join(', ')}`
          : `${sent.length} application(s) out, ${replied.length} response(s) in.`,
      };
    },

    /**
     * Find and merge duplicate records for one person.
     *
     * The client table is keyed on a browser session, so every new session used to
     * create a new person: one resume uploaded repeatedly produced 21 client
     * records for one human. Opportunities, outreach, actions and chat all hang off
     * client_id, so a duplicate is not cosmetic - an application goes out under one
     * record and a recruiter's reply is filed against another that has no history.
     *
     * Detection is by email, and only email. Names collide and phone formats vary;
     * neither is a safe basis for asserting that two people are one, but two
     * records carrying the same address are the same person for every purpose
     * here.
     *
     * Dry run by default. Consolidation moves rows between records and deletes the
     * duplicates, so the model reports what it found and asks before it acts -
     * unless the user has already said to do it, which is what `confirm` is for.
     */
    async jobby_dedupe(args, ctx) {
      const { findDuplicatesByEmail, findDuplicatesByIdentity, consolidateClients, dedupeLinks } =
        await import('./reconcile.mjs');
      const pool = await store.getPool();

      const dossierNow = (await store.getDossier(ctx.clientId))?.dossier || {};
      const email = asText(args?.email, 320) || asText(dossierNow.email, 320);

      // A second signal, because email alone missed a real pair: this candidate
      // had one record on a gmail address and another on a jobbymcjobberson.com
      // mailbox, and nothing here joined them until the two dossiers were read by
      // hand. Offered alongside the email search and never merged on its own - it
      // is a suggestion about a person, not a proof.
      const byIdentity = await findDuplicatesByIdentity(pool, {
        name: asText(args?.name, 200) || asText(dossierNow.name, 200),
        phone: asText(args?.phone, 60) || asText(dossierNow.phone, 60),
      });
      const identityExtra = byIdentity.duplicate
        ? byIdentity.clients.filter((c) => c.id !== ctx.clientId)
        : [];

      if (!email && !identityExtra.length) {
        return {
          error: 'There is not enough on file to look for duplicates. An email address, or a name '
            + 'together with a phone number, would do it.',
        };
      }

      const matches = email ? await findDuplicatesByEmail(pool, email) : [];
      const emailIds = new Set(matches.map((m) => m.id));
      // Union, de-duplicated, and only ever ADDING the identity matches to what
      // the email search already found. Email-matched records are never dropped
      // from the set on the strength of a weaker signal.
      const combined = [...matches];
      for (const c of identityExtra) if (!emailIds.has(c.id)) combined.push(c);

      if (combined.length < 2) {
        return {
          ok: true,
          email: email || null,
          clients: combined.length,
          duplicate: false,
          note: byIdentity.noise
            ? byIdentity.reason
            : combined.length === 1
              ? 'There is only one record here, so there is nothing to merge.'
              : 'No second record carries this email or this name-and-phone.',
        };
      }

      const ids = combined.map((m) => m.id);
      const confirm = args?.confirm === true || /^(yes|y|do it|go ahead)$/i.test(String(args?.confirm ?? ''));

      // Always report the links problem too: it is a within-one-dossier duplicate
      // and the user asked about it by name.
      const dossierRow = await store.getDossier(ctx.clientId);
      const linkReport = dossierRow?.dossier
        ? dedupeLinks(JSON.parse(JSON.stringify(dossierRow.dossier)))
        : { changed: false, cleared: [] };

      if (!confirm) {
        return {
          ok: true,
          dryRun: true,
          email: email || null,
          duplicate: true,
          found: combined.length,
          clients: combined.map(m => ({
            id: m.id, displayName: m.display_name, created: m.created_at,
            mailbox: m.mailbox || null,
            // Which signal found it, so the user can judge the weaker one.
            matchedBy: emailIds.has(m.id) ? 'email' : 'name and phone',
          })),
          survivor: Math.min(...ids),
          linkDuplicates: linkReport.cleared,
          nextStep: `There are ${combined.length} records that look like one person. Say "yes, merge them" and I will consolidate them into the oldest one (client ${Math.min(...ids)}) and move everything across.`,
        };
      }

      const result = await consolidateClients(pool, ids, {
        dryRun: false,
        reason: 'merged by jobby_dedupe at the user\'s request',
      });
      if (result.error) return { error: result.error };

      if (linkReport.changed) {
        const merged = await store.saveDossier(ctx.clientId, linkReport.dossier ?? dossierRow.dossier, {
          updatedBy: 'jobby', reason: 'removed duplicate link entries',
          audits: [{
            op: 'merge', path: 'links', before_value: dossierRow.dossier.links ?? null,
            after_value: linkReport.dossier?.links ?? null,
            reason: 'the same URL was listed under more than one field',
            actor: 'jobby', confirmedByUser: true, changes: linkReport.cleared,
          }],
        });
        result.revision = revision;
      }

      return {
        ok: true,
        email,
        merged: true,
        survivor: result.survivor,
        removed: result.removed,
        rowsMoved: result.moved,
        linkDuplicatesCleared: linkReport.cleared,
        note: `Consolidated ${result.removed.length} duplicate record(s) into client ${result.survivor}.`,
      };
    },
  };

  return tools;
}

export const JOBBY_TOOL_NAMES = Object.keys(createJobbyTools({}));
