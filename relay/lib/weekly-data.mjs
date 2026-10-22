/**
 * relay/lib/weekly-data.mjs — what each tenant's weekly is made of.
 *
 * ONE SHAPE FOR EVERY TENANT
 * --------------------------
 * Every collector returns { ok, value, at, note }. `ok` says whether the
 * source answered. A source that failed is NOT the same as a source that
 * answered with nothing: a failed source becomes a visible line in the
 * email, and an empty one becomes a real zero.
 *
 * That distinction is the whole point of this file. A weekly that quietly
 * drops its price section reads as a week when the price did not move, and
 * a weekly that prints a zero it invented reads as a collapse. Both are
 * lies, and both are easier to avoid when every source has to declare
 * itself.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Each tenant reads its OWN figures:
 *
 *   MobileMonero     the Monero price and its history, the mining pool, the
 *                    published corpus, the commits, the fleet's tasks.
 *   31 Harbor        the trust ledger, the agent roster, the contracts, the
 *                    commits, the fleet's tasks.
 *   Party Favor Photo  the bookings, the leads behind them, the tasks.
 *   Jobby            the candidates, their applications, the tasks.
 *
 * THE CANONICAL TABLE
 * -------------------
 * Where a tenant has more than one table for the same thing, this file
 * names ONE and says why in a comment. Party Favor Photo has three
 * booking tables and 31 Harbor has every cuttlefish table twice; reading
 * the wrong one puts a wrong number in a client's inbox.
 *
 * The one thing this file will not do is invent. If a table is empty, the
 * section says zero - because zero is what an empty table means - and if a
 * query fails, the section says the query failed.
 */

import { query, queryOne } from './localDb.mjs';
import { TENANTS } from './tenants.mjs';
import {
  fetchPrice, fetchPriceHistory, fetchPool, fetchArticles, PROJECT_START_DATE,
} from './newsletter-data.mjs';

const UA = { 'User-Agent': 'xmrt-weekly/1.0' };

function ok(value, note, at = new Date().toISOString()) {
  return { ok: true, value, at, note };
}
function bad(note, at = new Date().toISOString()) {
  return { ok: false, value: null, at, note };
}

// ── MobileMonero ────────────────────────────────────────────

/**
 * The Monero price, and the journey from the project's start to today.
 *
 * Two sections, because they are two sources: the spot price comes from
 * CoinGecko and the daily closes come from an exchange, because CoinGecko
 * caps its free history at 365 days and the point of the chart is to reach
 * back to the project's start.
 */
export async function collectPrice() {
  const [price, history] = await Promise.all([fetchPrice(), fetchPriceHistory()]);
  return [
    { name: 'price', result: price },
    { name: 'history', result: history },
  ];
}

/** The mining pool: the fleet's own slice, and the pool's figures. */
export async function collectPool() {
  return fetchPool();
}

/** The published corpus. */
export async function collectArticles() {
  return fetchArticles();
}

/** What shipped. The commits of the tenant's own repository. */
export async function collectCommits(tenant, limit = 8) {
  const repo = tenant.repo;
  if (!repo) return bad('no repository is registered for this tenant');
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=${limit}`, {
      signal: AbortSignal.timeout(20000), headers: UA,
    });
    if (!res.ok) return bad(`GitHub answered ${res.status}`);
    const list = await res.json().catch(() => []);
    if (!Array.isArray(list)) return bad('GitHub did not return a commit list');
    return ok(list.slice(0, limit).map((c) => ({
      sha: String(c.sha || '').slice(0, 7),
      message: String(c?.commit?.message || '').split('\n')[0].slice(0, 160),
      at: c?.commit?.committer?.date || c?.commit?.author?.date || null,
      url: c?.html_url || null,
    })).filter((c) => c.sha), `GitHub · ${repo}`);
  } catch (e) {
    return bad(`GitHub unreachable: ${e.message}`);
  }
}

// ── The fleet's work, attributed to a tenant ────────────────
//
// public.tasks has no tenant column. It has an assignee and a title, so a
// task belongs to a tenant when it is assigned to that tenant's agent or
// when its TITLE names the business.
//
// The title only, deliberately. The description and the metadata were
// searched at first, and they pulled in a whole class of noise: an inbound
// message from a stranger becomes a task whose body happens to contain the
// letters "PFP", and a weekly that showed a client a stranger's spam
// subject line was a weekly nobody was going to want to read twice.
//
// It is an inference, and the weekly says so rather than presenting it as
// a column.

export async function collectWork(tenant, days = 30) {
  const words = (tenant.taskWords || []).filter(Boolean);
  if (!words.length) return bad('no task words are registered for this tenant');
  try {
    const agent = tenant.agent;
    const rows = await query(
      `SELECT id::text, title, status, stage, priority, assignee_agent_id,
              blocking_reason, progress_percentage, updated_at::text
       FROM public.tasks
       WHERE updated_at > now() - ($1 || ' days')::interval
         AND (
           assignee_agent_id LIKE $2
           OR title ILIKE ANY($3)
         )
       ORDER BY updated_at DESC
       LIMIT 60`,
      [String(days), `${agent}-%`, words.map((w) => `%${w}%`)],
    );
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return ok({
      rows,
      byStatus,
      count: rows.length,
      blocked: rows.filter((r) => r.blocking_reason).length,
      windowDays: days,
    }, 'the fleet task board, attributed by title');
  } catch (e) {
    return bad(`the task board could not be read: ${e.message}`);
  }
}

// ── 31 Harbor ───────────────────────────────────────────────

/**
 * The trust ledger.
 *
 * public.cuttlefish_trust_events and public.app__cuttlefish_trust_events
 * are BOTH VIEWS over the same rows with the same ids - the app__ one is
 * a flattened duplicate, not a second ledger. public.cuttlefish_* is the
 * one read here.
 */
export async function collectTrust(days = 30) {
  try {
    const [perDay, byType] = await Promise.all([
      query(
        `SELECT date_trunc('day', created_at)::date::text d, count(*)::int c
         FROM public.cuttlefish_trust_events
         WHERE created_at > now() - ($1 || ' days')::interval
         GROUP BY 1 ORDER BY 1`,
        [String(days)],
      ),
      query(
        `SELECT event_type, count(*)::int c
         FROM public.cuttlefish_trust_events
         WHERE created_at > now() - ($1 || ' days')::interval
         GROUP BY 1 ORDER BY 2 DESC`,
        [String(days)],
      ),
    ]);
    const total = perDay.reduce((a, r) => a + r.c, 0);
    return ok({
      perDay: perDay.map((r) => ({ at: Date.parse(`${r.d}T00:00:00Z`), value: r.c })),
      byType: byType.map((r) => ({ label: r.event_type, value: r.c })),
      total,
      windowDays: days,
    }, 'the trust ledger');
  } catch (e) {
    return bad(`the trust ledger could not be read: ${e.message}`);
  }
}

/** The agent roster, and the credentials behind it. */
export async function collectAgents() {
  try {
    const [agents, creds] = await Promise.all([
      query(
        `SELECT did, name, agent_type, status, trust_score, trust_score_updated_at::text
         FROM public.cuttlefish_agents
         ORDER BY (trust_score IS NULL), trust_score DESC NULLS LAST, name`,
      ),
      queryOne(`SELECT count(*)::int c FROM public.cuttlefish_cac_credentials`),
    ]);
    // The median is the median of EVERY scored agent, not of the twelve at
    // the top of the list. A "median" taken from a list that was sorted
    // descending and then truncated is a number that means nothing.
    const scored = agents
      .map((a) => (a.trust_score == null ? null : Number(a.trust_score)))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    const median = scored.length
      ? (scored.length % 2
        ? scored[(scored.length - 1) / 2]
        : (scored[scored.length / 2 - 1] + scored[scored.length / 2]) / 2)
      : null;
    return ok({
      agents: agents.map((a) => ({
        name: a.name, did: a.did, type: a.agent_type, status: a.status,
        trust: a.trust_score == null ? null : Number(a.trust_score),
        trustAt: a.trust_score_updated_at,
      })),
      total: agents.length,
      scored: scored.length,
      median: median == null ? null : Math.round(median * 100) / 100,
      highest: scored.length ? scored[scored.length - 1] : null,
      lowest: scored.length ? scored[0] : null,
      credentials: creds ? creds.c : 0,
    }, 'the agent roster');
  } catch (e) {
    return bad(`the agent roster could not be read: ${e.message}`);
  }
}

/** Contracts, and the gate decisions behind them. */
export async function collectContracts() {
  try {
    const [contracts, gates] = await Promise.all([
      query(
        `SELECT * FROM public.cuttlefish_contracts ORDER BY 1 DESC LIMIT 8`,
      ),
      queryOne(`SELECT count(*)::int c FROM public.cuttlefish_gate_decisions`),
    ]);
    return ok({
      contracts: contracts.map((c) => ({
        title: c.title || c.name || c.id,
        createdAt: c.created_at ? String(c.created_at) : null,
        status: c.status || null,
        hash: c.contract_hash || c.hash || null,
      })),
      gateDecisions: gates ? gates.c : 0,
    }, 'the contract ledger');
  } catch (e) {
    return bad(`the contract ledger could not be read: ${e.message}`);
  }
}

// ── Party Favor Photo ───────────────────────────────────────

/**
 * The bookings.
 *
 * THREE TABLES, TWO OF THEM WRONG, AND ONE STILL BEING REPAIRED.
 *
 *   public.pfp_bookings   - the agent-facing table. Real event dates in
 *                            2026, statuses, contracts, deposits. This is
 *                            the one the pfp_bookings MCP tool reads and
 *                            writes, so it is the one read here.
 *   app.pfp_bookings       - the web funnel's table. Its rows carry event
 *                            dates in 2029 and a total_price the first
 *                            table does not have. It is a DIFFERENT table,
 *                            not a copy, and it is not the one the agent
 *                            tooling reads.
 *   public.app__pfp_bookings - a VIEW over app.pfp_bookings.
 *
 * The repair of this is an open task on the board, so the divergence is
 * reported rather than hidden.
 */
export async function collectBookings() {
  try {
    const rows = await query(
      `SELECT id::text, client_name, event_date::text, event_start_time::text,
              event_end_time::text, event_type, status, total_fee, deposit_paid,
              venue, contract_signed, created_at::text
       FROM public.pfp_bookings
       ORDER BY event_date DESC NULLS LAST`,
    );
    const other = await queryOne(`SELECT count(*)::int c FROM app.pfp_bookings`);
    return ok({
      bookings: rows.map((b) => ({
        id: b.id,
        client: b.client_name,
        eventDate: b.event_date,
        startTime: b.event_start_time,
        endTime: b.event_end_time,
        eventType: b.event_type,
        status: b.status,
        fee: b.total_fee == null ? null : Number(b.total_fee),
        depositPaid: b.deposit_paid == null ? null : Number(b.deposit_paid),
        venue: b.venue,
        contractSigned: b.contract_signed,
        createdAt: b.created_at,
      })),
      // The count in the OTHER table. Not the bookings themselves - their
      // dates disagree with these - but the fact that it disagrees is
      // worth a line in the email.
      divergentRows: other ? other.c : 0,
    }, 'the booking ledger');
  } catch (e) {
    return bad(`the booking ledger could not be read: ${e.message}`);
  }
}

/** The leads behind the bookings. */
export async function collectLeads(days = 30) {
  try {
    const [byStatus, recent] = await Promise.all([
      query(`SELECT status, count(*)::int c FROM public.pfp_leads GROUP BY 1 ORDER BY 2 DESC`),
      query(
        `SELECT id::text, company_name, contact_name, event_type, event_date::text,
                status, stage, lead_rating, source, created_at::text
         FROM public.pfp_leads
         WHERE created_at > now() - ($1 || ' days')::interval
         ORDER BY created_at DESC LIMIT 10`,
        [String(days)],
      ),
    ]);
    const total = byStatus.reduce((a, r) => a + r.c, 0);
    return ok({
      byStatus: byStatus.map((r) => ({ label: r.status, value: r.c })),
      total,
      newThisWeek: recent.length,
      recent: recent.map((l) => ({
        company: l.company_name,
        contact: l.contact_name,
        eventType: l.event_type,
        eventDate: l.event_date,
        status: l.status,
        stage: l.stage,
        rating: l.lead_rating,
        // Where it came from. A lead with no company and no contact still
        // has a source, and eight identical "A new enquiry" lines tell a
        // reader nothing.
        source: l.source,
        at: l.created_at,
      })),
      windowDays: days,
    }, 'the lead ledger');
  } catch (e) {
    return bad(`the lead ledger could not be read: ${e.message}`);
  }
}

// ── Jobby ───────────────────────────────────────────────────

/**
 * The candidates.
 *
 * app.job_clients holds the mailboxes. A client with a claimed_email has
 * claimed its own address and can be written to; one without has not.
 * The addresses are NOT printed - this is a candidate's own weekly, but a
 * list of addresses is a list of other people's addresses.
 */
export async function collectCandidates() {
  try {
    const row = await queryOne(
      `SELECT count(*)::int total,
              count(claimed_email)::int claimed,
              count(*) FILTER (WHERE created_at > now() - interval '30 days')::int recent,
              max(created_at)::text latest
       FROM app.job_clients`,
    );
    return ok({
      total: row ? row.total : 0,
      claimed: row ? row.claimed : 0,
      newThisMonth: row ? row.recent : 0,
      latest: row ? row.latest : null,
    }, 'the candidate ledger');
  } catch (e) {
    return bad(`the candidate ledger could not be read: ${e.message}`);
  }
}

/** The applications. */
export async function collectApplications() {
  try {
    const [rows, byStatus] = await Promise.all([
      query(
        `SELECT id::text, company, role, status, blocker_kind, blocker_detail,
                submitted_at::text, updated_at::text, url
         FROM app.job_applications
         ORDER BY updated_at DESC LIMIT 10`,
      ),
      query(`SELECT status, count(*)::int c FROM app.job_applications GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    return ok({
      applications: rows.map((a) => ({
        company: a.company,
        role: a.role,
        status: a.status,
        blocker: a.blocker_kind,
        blockerDetail: a.blocker_detail,
        submittedAt: a.submitted_at,
        at: a.updated_at,
        url: a.url,
      })),
      byStatus: byStatus.map((r) => ({ label: r.status, value: r.c })),
      total: byStatus.reduce((a, r) => a + r.c, 0),
    }, 'the application ledger');
  } catch (e) {
    return bad(`the application ledger could not be read: ${e.message}`);
  }
}

// ── The dispatcher ──────────────────────────────────────────

/**
 * Everything one tenant's weekly needs, fetched together.
 *
 * @param {object} tenant  a tenant from relay/lib/tenants.mjs
 * @returns {Promise<object>}  { sections: {name: result}, missing: string[] }
 */
export async function gatherWeeklyData(tenant) {
  const names = (tenant.weekly && tenant.weekly.sections) || [];
  const jobs = names.map((name) => {
    switch (name) {
      case 'price': return [name, collectPrice()];
      case 'pool': return [name, collectPool()];
      case 'articles': return [name, collectArticles()];
      case 'commits': return [name, collectCommits(tenant)];
      case 'work': return [name, collectWork(tenant)];
      case 'trust': return [name, collectTrust()];
      case 'agents': return [name, collectAgents()];
      case 'contracts': return [name, collectContracts()];
      case 'bookings': return [name, collectBookings()];
      case 'leads': return [name, collectLeads()];
      case 'candidates': return [name, collectCandidates()];
      case 'applications': return [name, collectApplications()];
      default: return [name, Promise.resolve(bad(`there is no collector named "${name}"`))];
    }
  });

  const settled = await Promise.all(jobs.map(async ([name, p]) => [name, await p]));
  const sections = {};
  const missing = [];
  for (const [name, result] of settled) {
    // A collector may answer with one section or with several - the price
    // section is two sources and says so.
    if (Array.isArray(result)) {
      for (const part of result) {
        sections[part.name] = part.result;
        if (!part.result.ok) missing.push(`${part.name}: ${part.result.note}`);
      }
      continue;
    }
    sections[name] = result;
    if (!result.ok) missing.push(`${name}: ${result.note}`);
  }
  return { tenant, sections, missing, gatheredAt: new Date().toISOString() };
}

export default { gatherWeeklyData, collectPrice, collectPool, collectArticles, collectCommits, collectWork, collectTrust, collectAgents, collectContracts, collectBookings, collectLeads, collectCandidates, collectApplications };
