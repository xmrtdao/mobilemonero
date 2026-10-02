/**
 * relay/jobby/employer-tools.mjs — what the employer-side agent can do
 *
 * Four tools, and the fourth is the important one.
 *
 * These are separate from the candidate tools rather than added to them. The
 * candidate tool list contains three irreversible sends behind a claim gate; an
 * employer conversation must never be able to reach them, and the cheapest way to
 * guarantee that is for there to be no code path at all rather than a check that
 * somebody can forget.
 *
 * The write tool takes a full parse rather than loose fields, on purpose. A tool
 * that accepted `title` and `pay_min` separately would let the agent assemble a
 * posting out of pieces it chose, which is how a requirement nobody wrote ends up
 * on a live posting. Here the employer either supplies the description or edits
 * it; the parse runs on what they wrote and the tool stores what came out.
 */

import { parseJobDescription } from './jd.mjs';
import * as store from './employer-store.mjs';
import { ALL_TITLES, matchTitles } from './titles.mjs';

const asText = (v, max = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A compact answer for the model: what is wrong, and what to do about it. */
function postingSummary(row) {
  if (!row) return null;
  const review = Array.isArray(row.review_notes) ? row.review_notes
    : typeof row.review_notes === 'string' ? safeParse(row.review_notes) || [] : [];
  const requirements = Array.isArray(row.requirements) ? row.requirements
    : typeof row.requirements === 'string' ? safeParse(row.requirements) || [] : [];
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    status: row.status,
    location: row.location_text,
    locationSpecificity: row.location_specificity,
    arrangement: row.arrangement,
    pay: row.pay_stated
      ? { stated: true, min: Number(row.pay_min), max: row.pay_max === null ? null : Number(row.pay_max), basis: row.pay_basis }
      : { stated: false, vague: row.pay_vague, note: 'No figure was stated, so the pay is shown to candidates as not stated.' },
    titleRecognised: row.title_recognised,
    requiredTickets: row.required_tickets,
    preferredTickets: row.preferred_tickets,
    unstatedTickets: row.unstated_tickets,
    requirementsComplete: row.requirements_complete,
    needsReview: row.needs_review,
    reviewNotes: review,
    requirements: requirements.map((r) => ({ strength: r.strength, text: r.text })),
    applyUrl: row.apply_url,
    contactEmail: row.contact_email,
    views: row.view_count,
    applications: row.application_count,
    publishedAt: row.published_at,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function createEmployerTools() {
  return {
    /**
     * Parse a job description the employer pasted, and save it as a draft.
     *
     * Returns the review queue in full. The agent is expected to read it to the
     * employer rather than summarise it as "mostly fine".
     */
    async employer_save_posting(args, ctx) {
      const description = asText(args?.description ?? args?.text ?? args?.body, 60000);
      if (!description) {
        return { error: 'There is no description to save. Paste the job description, or tell me what the role is and I will draft it with you.' };
      }

      const parsed = parseJobDescription(description, {
        titleHint: asText(args?.title, 300),
        companyHint: asText(args?.company, 200),
      });
      if (!parsed.ok) return { error: parsed.error };

      const saved = await store.savePosting(ctx.employerId, parsed, {
        id: args?.posting_id ? Number(args.posting_id) : null,
        applyUrl: args?.apply_url ?? (args?.posting_id ? undefined : null),
        contactEmail: args?.contact_email ?? (args?.posting_id ? undefined : null),
        status: args?.posting_id ? undefined : 'draft',
      });
      if (!saved) return { error: 'I could not save that posting.' };

      const verdict = store.assessForPublication(saved);
      return {
        ok: true,
        saved: true,
        posting: postingSummary(saved),
        canPublish: verdict.canPublish,
        summary: verdict.summary,
        // The whole queue, in full. Truncating it here is how a fix gets lost.
        reviewNotes: verdict.blockers.concat(verdict.warnings),
        blockers: verdict.blockers,
        warnings: verdict.warnings,
        coverage: parsed.coverage,
      };
    },

    /**
     * Apply a small correction to a saved posting.
     *
     * Takes raw fields, and re-runs the parse when the description changes. It
     * cannot edit an individual requirement: requirements are read from the
     * employer's own words, and the way to change one is to change the words.
     * That restriction is the point — an agent that could rewrite one requirement
     * in isolation could also quietly weaken it.
     */
    async employer_update_posting(args, ctx) {
      const postingId = Number(args?.posting_id);
      if (!Number.isFinite(postingId)) return { error: 'posting_id is required.' };

      const current = await store.getPosting(postingId, ctx.employerId);
      if (!current) return { error: 'That posting is not on your account.' };

      let parsed;
      if (asText(args?.description, 60000)) {
        // The description changed, so everything read from it is re-read. A
        // posting whose text no longer matches its extracted requirements is
        // worse than one that was never parsed.
        parsed = parseJobDescription(args.description, {
          titleHint: asText(args?.title, 300) || current.title,
          companyHint: asText(args?.company, 200) || current.company,
        });
        if (!parsed.ok) return { error: parsed.error };
      } else {
        parsed = {
          sourceText: current.description,
          sourceWords: current.description_words,
          title: {
            title: asText(args?.title, 300) || current.title,
            titleSource: asText(args?.title, 300) ? 'employer_supplied' : 'existing',
            matched: (current.title_matched || {}).matched || [],
            recognised: current.title_recognised,
            family: current.title_family,
          },
          company: { name: asText(args?.company, 200) || current.company },
          location: { text: current.location_text, specificity: current.location_specificity, arrangement: current.arrangement || [] },
          compensation: {
            stated: current.pay_stated, vague: current.pay_vague, raw: current.pay_raw,
            min: current.pay_min === null ? null : Number(current.pay_min),
            max: current.pay_max === null ? null : Number(current.pay_max),
            unit: current.pay_unit, basis: current.pay_basis,
          },
          requirements: current.requirements || [],
          requiredTickets: current.required_tickets || [],
          preferredTickets: current.preferred_tickets || [],
          unstatedTickets: current.unstated_tickets || [],
          coverage: current.coverage || {},
          review: current.review_notes || [],
          needsReview: current.needs_review,
        };
        if (asText(args?.title, 300)) {
          // A new title must be re-classified, or a corrected title keeps the
          // old one's family and the library match goes with it.
          const m = matchTitles(asText(args.title, 300), { limit: 3 });
          parsed.title.recognised = m.length > 0;
          parsed.title.family = m.length ? m[0].family : null;
          parsed.title.matched = m.map((x) => ({ name: x.name, family: x.family, confidence: x.confidence }));
        }
      }

      const saved = await store.updatePostingContent(postingId, ctx.employerId, parsed, {
        applyUrl: args?.apply_url,
        contactEmail: args?.contact_email,
        status: args?.status,
      });
      if (!saved) return { error: 'I could not update that posting.' };

      const verdict = store.assessForPublication(saved);
      return {
        ok: true,
        updated: true,
        posting: postingSummary(saved),
        canPublish: verdict.canPublish,
        summary: verdict.summary,
        reviewNotes: verdict.blockers.concat(verdict.warnings),
        blockers: verdict.blockers,
        warnings: verdict.warnings,
      };
    },

    /**
     * Publish, or explain why not.
     *
     * Returns the verdict rather than throwing, and never reports success the
     * row does not have. The employer is about to tell a candidate-facing page
     * that their job is live, so this is the one place where a false ok is
     * worst.
     */
    async employer_publish_posting(args, ctx) {
      const postingId = Number(args?.posting_id);
      if (!Number.isFinite(postingId)) return { error: 'posting_id is required.' };

      const result = await store.publishPosting(postingId, ctx.employerId);
      if (!result.ok) {
        return {
          ok: false,
          published: false,
          // In the employer's terms: what is wrong, and what to do.
          summary: result.summary || 'It cannot be published yet.',
          blockers: result.blockers || [],
          warnings: result.warnings || [],
        };
      }
      return {
        ok: true,
        published: true,
        postingId,
        summary: result.summary,
        // Warnings survive publication on purpose: they are the employer's call,
        // not a veto, and the employer should still hear them.
        warnings: result.warnings,
        posting: postingSummary(result.posting),
      };
    },

    /** What this employer has written, and how each one is doing. */
    async employer_list_postings(args, ctx) {
      const rows = await store.listEmployerPostings(ctx.employerId, { limit: Number(args?.limit) || 50 });
      return {
        ok: true,
        postings: rows.map(postingSummary),
        stats: await store.employerStats(ctx.employerId),
      };
    },

    /**
     * What the title library knows, for titles the employer might have meant.
     *
     * The point is the "did you mean" path: an employer who writes
     * "Instrumentation Tech" should be able to be understood by the same
     * vocabulary candidates are filtered by, and the only way to find that
     * vocabulary is to ask for it.
     */
    async employer_match_title(args, ctx) {
      const q = asText(args?.title ?? args?.query, 200);
      if (!q) {
        return {
          ok: true,
          total: ALL_TITLES.length,
          sample: ALL_TITLES.slice(0, 20).map((t) => ({ name: t.name, family: t.family })),
        };
      }
      const matches = matchTitles(q, { limit: 6 });
      return {
        ok: true,
        query: q,
        recognised: matches.length > 0,
        matches: matches.map((m) => ({
          name: m.name, family: m.family, confidence: m.confidence,
          evidence: m.evidence, modern: m.modern ?? null,
        })),
        // Said plainly when nothing matched, because silence here reads as a
        // hang and the employer assumes their title is fine.
        note: matches.length
          ? null
          : `"${q}" is not a title this system knows. Candidates filter by title, so a posting `
            + 'under it will not reach them. Ask if they meant something else, or keep it and '
            + 'accept that few people will find it.',
      };
    },
  };
}

export const EMPLOYER_TOOL_NAMES = Object.keys(createEmployerTools());
export default { createEmployerTools, EMPLOYER_TOOL_NAMES };
