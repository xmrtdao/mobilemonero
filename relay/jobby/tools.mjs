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
import { describePageAgent, ensurePageAgent, hubStatus, reopenLauncher, waitForFreshConnection } from './browser.mjs';
import { decideTracks } from './tracks.mjs';
import { TRACKS } from './tracks.mjs';
import * as store from './store.mjs';
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
    const isHeading = /^\**\s*[A-Z][^*]{0,70}\**\s*:?\s*$/.test(line) && !/^\s*(?:[-*]|\d+\.)/.test(line);
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
        note: result.audits.some(a => !a.confirmedByUser)
          ? 'Some of these were not stated outright by the user. They are saved and recorded as unconfirmed — say so if any are wrong.'
          : undefined,
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
      const url = requireString(
        { url: args?.url ?? args?.link ?? args?.job_url },
        'url', { max: 800, field: 'url' });
      if (url.error) return { error: url.error };
      if (!/^https?:\/\//i.test(url.value)) {
        return { error: 'url must start with http:// or https://' };
      }

      // The page agent drives the user's own browser through a Chrome extension,
      // so readiness is established - and repaired where that is possible -
      // before anything is dispatched. Finding out the extension is not running
      // by sending it a real job application and reading the failure afterwards
      // is not acceptable, and neither is giving up on a browser that is merely
      // asleep: Chrome suspends the extension's service worker when idle and it
      // reattaches on its own a moment later.
      const ready = await ensurePageAgent({ requestedBy: 'jobby_apply' });
      if (!ready.ok) {
        return {
          error: 'I could not get to your browser, so nothing was submitted.',
          reason: ready.reason,
          needsUser: true,
          howToFix: ready.advice,
        };
      }

      // Submitting an application is the most irreversible thing Jobby does, and
      // it is done in this person's name. It requires a proved email address, the
      // same gate as sending a message.
      {
        const { assertCanRepresent } = await import('./claim.mjs');
        const claim = await assertCanRepresent(ctx.clientId);
        if (!claim.ok) {
          return {
            error: claim.error,
            reason: 'email address not verified',
            needsUser: true,
            howToFix: claim.howToFix,
            nothingWasSubmitted: true,
          };
        }
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
        '4. Do not submit anything irreversible without the explicit instruction',
        '   to submit. Stop on the final submit button and describe it first.',
        '5. Report exactly which fields you filled, which you left blank, and any',
        '   step you could not complete.',
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
            outstanding: extractOutstanding(stopped),
          };
        }
        return {
          error: data.error || 'the page agent could not run the task',
          needsUser: /not connected|extension|sign in|login|captcha|verification/i
            .test(String(data.error || '')),
          nothingWasSubmitted: true,
          recovered: recoveredNote,
        };
      }
      const output = String(data?.result ?? '');
      return {
        ok: true,
        url: url.value,
        result: output,
        recovered: recoveredNote,
        // The agent reports back in prose, so the stop conditions are detected
        // here rather than trusted. A run that mentions needing the user must
        // not be summarised as a completed application.
        needsUser: /captcha|verification|sign in|log ?in|password|need the user|stopped/i
          .test(output),
        submitted: /submitted|application (was |)sent|thank you for applying/i.test(output)
          && !/did not submit|not submitted|stopped before/i.test(output),
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
      const { findDuplicatesByEmail, consolidateClients, dedupeLinks } =
        await import('./reconcile.mjs');
      const pool = await store.getPool();

      const email = asText(args?.email, 320) || (await store.getDossier(ctx.clientId))?.dossier?.email;
      if (!email) {
        return { error: 'No email on file, so duplicates cannot be matched. Add one first.' };
      }

      const matches = await findDuplicatesByEmail(pool, email);
      if (matches.length < 2) {
        return {
          ok: true,
          email,
          clients: matches.length,
          duplicate: false,
          note: matches.length === 1
            ? 'There is only one record for this email, so there is nothing to merge.'
            : 'No record carries this email yet.',
        };
      }

      const ids = matches.map(m => m.id);
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
          email,
          duplicate: true,
          found: matches.length,
          clients: matches.map(m => ({
            id: m.id, displayName: m.display_name, created: m.created_at,
            mailbox: m.mailbox || null,
          })),
          survivor: Math.min(...ids),
          linkDuplicates: linkReport.cleared,
          nextStep: `There are ${matches.length} records for ${email}. Say "yes, merge them" and I will consolidate them into the oldest one (client ${Math.min(...ids)}) and move everything across.`,
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
