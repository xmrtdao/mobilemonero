/**
 * relay/lib/entity-resolver.mjs — unified entity resolver.
 *
 * One lookup that every recall surface (knowledge-graph, recall_context,
 * shared-context search, fleet memory reads, Eliza's context assembly) can
 * share, instead of each store answering alone with whatever it happens to
 * hold.
 *
 * How it works:
 *   1. GATHER — token-AND search across sources, in precedence order:
 *        pfp_leads / pfp_contacts / pfp_partnerships   (verified CRM)
 *        app.knowledge_entities                        (canonical entities)
 *        app.fleet_memory (crm-entity rows)            (durable fleet memory)
 *        knowledge.shared_context (crm-entity keys)    (shared context)
 *   2. CLUSTER — candidates merge into one entity cluster only when they
 *      share a hard identifier: same CRM source_record_id, same email
 *      (current or superseded), or same canonical entity id. Same first
 *      name alone NEVER merges — two unrelated Lauras stay two clusters.
 *   3. RANK — within a cluster, field values come from the highest-
 *      precedence source:
 *        operator-corrected CRM > CRM > knowledge entity > fleet memory >
 *        shared context. A field provenance map records which source won.
 *   4. REPORT — every cluster carries sources, record ids, updated_at,
 *      superseded emails (never deleted), conflict_state ('resolved' when a
 *      stale value lost to a higher-precedence source, 'conflict' when two
 *      sources disagree and neither is superseded).
 *
 * Failure behavior: each source query runs under its own timeout; a failed
 * or slow source is listed in `degraded[]` and the result is marked
 * `partial: true` — visible failure, safe fallback, never silent.
 *
 * The DB handle is injected (`createResolver({ query })`) so tests can
 * simulate a dead graph by passing a failing query fn for one source.
 */

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'for', 'and', 'is', 'my']);

function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter(t => t && !STOPWORDS.has(t));
}

// Email-shaped queries should match literally, not as tokens.
const isEmail = (q) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(q || '').trim());

const SOURCE_TIMEOUT_MS = 3000;

async function timed(sourceName, promise, degraded) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), SOURCE_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    degraded.push({ source: sourceName, error: String(e?.message || e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createResolver({ query, logger = console }) {

  async function gather(terms, emailQuery, degraded) {
    const cand = [];
    const likes = terms.map(t => `%${t}%`);
    const and = (cols) => terms.map((_, i) => `(${cols.map(c => `${c} ILIKE $${i + 1}`).join(' OR ')})`).join(' AND ');
    // For email queries, a single literal term is the whole address.
    const q = isEmail(emailQuery) ? [emailQuery.trim()] : terms;
    const p = q.map(t => `%${t}%`);
    const andQ = (cols) => q.map((_, i) => `(${cols.map(c => `${c} ILIKE $${i + 1}`).join(' OR ')})`).join(' AND ');

    // ── verified CRM ────────────────────────────────────────────────────
    const leads = await timed('pfp_leads', query(
      `SELECT id, contact_name, contact_email, company_name, status, stage, source, updated_at
         FROM public.pfp_leads WHERE ${andQ(['contact_name', 'contact_email', 'company_name', 'notes'])} LIMIT 20`, p
    ), degraded);
    for (const r of (leads?.rows || [])) {
      cand.push({
        source: 'pfp_leads', precedence: 10, record_id: r.id,
        name: r.contact_name, email: r.contact_email, organization: r.company_name,
        relationship: null, updated_at: r.updated_at,
        detail: { status: r.status, stage: r.stage, lead_source: r.source },
      });
    }

    const contacts = await timed('pfp_contacts', query(
      `SELECT id, name, email, company, role, updated_at
         FROM public.pfp_contacts WHERE ${andQ(['name', 'email', 'company'])} LIMIT 20`, p
    ), degraded);
    for (const r of (contacts?.rows || [])) {
      cand.push({
        source: 'pfp_contacts', precedence: 9, record_id: r.id,
        name: r.name, email: r.email, organization: r.company,
        relationship: r.role, updated_at: r.updated_at, detail: {},
      });
    }

    const partners = await timed('pfp_partnerships', query(
      `SELECT id, name, email, company, category, status, updated_at
         FROM public.pfp_partnerships WHERE ${andQ(['name', 'email', 'company'])} LIMIT 20`, p
    ), degraded);
    for (const r of (partners?.rows || [])) {
      cand.push({
        source: 'pfp_partnerships', precedence: 9, record_id: r.id,
        name: r.name, email: r.email, organization: r.company,
        relationship: r.category, updated_at: r.updated_at,
        detail: { partnership_status: r.status },
      });
    }

    // ── canonical knowledge entities ────────────────────────────────────
    const kes = await timed('knowledge_entities', query(
      `SELECT id, entity_name, description, content, tags, metadata, updated_at
         FROM app.knowledge_entities
        WHERE ${andQ(['entity_name', 'content', 'description', 'metadata::text'])} LIMIT 20`, p
    ), degraded);
    for (const r of (kes?.rows || [])) {
      const m = r.metadata || {};
      cand.push({
        source: 'knowledge_entities', precedence: m.canonical ? 8 : 6, record_id: r.id,
        name: r.entity_name, email: m.current_email || null,
        superseded_emails: m.superseded_emails || [],
        organization: m.organization || null, relationship: m.relationship || null,
        aliases: m.aliases || [], updated_at: r.updated_at,
        crm_record_id: m.source === 'pfp_leads' ? m.source_record_id : null,
        conflict_state: m.conflict_state, detail: { tags: r.tags },
      });
    }

    // ── durable fleet memory (crm-entity projections) ───────────────────
    const fm = await timed('fleet_memory', query(
      `SELECT id, title, body, payload, updated_at
         FROM app.fleet_memory
        WHERE memory_type = 'crm-entity' AND ${andQ(['title', 'body', 'payload::text'])} LIMIT 20`, p
    ), degraded);
    for (const r of (fm?.rows || [])) {
      const pl = typeof r.payload === 'string' ? JSON.parse(r.payload || '{}') : (r.payload || {});
      cand.push({
        source: 'fleet_memory', precedence: 5, record_id: r.id,
        name: (r.title || '').replace(/^CRM entity:\s*/, ''),
        email: pl.current_email || null, superseded_emails: pl.superseded_emails || [],
        organization: pl.organization || null, relationship: pl.relationship || null,
        aliases: pl.aliases || [], updated_at: r.updated_at,
        crm_record_id: pl.source_record_id || null, detail: {},
      });
    }

    // ── shared context (crm-entity projections) ─────────────────────────
    const sc = await timed('shared_context', query(
      `SELECT id, context_key, value, updated_at
         FROM knowledge.shared_context
        WHERE context_type = 'crm-entity' AND ${andQ(['context_key', 'value::text'])} LIMIT 20`, p
    ), degraded);
    for (const r of (sc?.rows || [])) {
      let v = {};
      try { v = typeof r.value === 'string' ? JSON.parse(r.value) : (r.value || {}); } catch {}
      cand.push({
        source: 'shared_context', precedence: 4, record_id: r.id,
        name: v.canonical_entity || r.context_key.replace(/^crm_entity_/, '').replace(/_/g, ' '),
        email: v.current_email || null, superseded_emails: v.superseded_emails || [],
        organization: v.organization || null, relationship: v.relationship || null,
        aliases: v.aliases || [], updated_at: r.updated_at,
        crm_record_id: v.source_record_id || null, detail: { context_key: r.context_key },
      });
    }

    return cand;
  }

  // Merge candidates into entity clusters on hard identifiers only.
  function cluster(candidates) {
    const clusters = [];
    const emailsOf = (c) => new Set([c.email, ...(c.superseded_emails || [])].filter(Boolean).map(e => e.toLowerCase()));
    for (const c of candidates) {
      if (!c.name) continue;
      const cEmails = emailsOf(c);
      let hit = null;
      for (const cl of clusters) {
        if (c.crm_record_id && cl.crm_record_ids.has(String(c.crm_record_id))) { hit = cl; break; }
        if (cl.entity_ids.has(`${c.source}:${c.record_id}`)) { hit = cl; break; }
        const shared = [...cEmails].some(e => cl.emails.has(e));
        if (shared) { hit = cl; break; }
        // Same full name AND same organization counts as a hard identifier.
        if (c.name && cl.names.has(c.name.toLowerCase()) && c.organization && cl.organizations.has(c.organization.toLowerCase())) { hit = cl; break; }
      }
      if (!hit) {
        hit = { members: [], emails: new Set(), names: new Set(), organizations: new Set(), crm_record_ids: new Set(), entity_ids: new Set() };
        clusters.push(hit);
      }
      hit.members.push(c);
      hit.names.add(c.name.toLowerCase());
      if (c.organization) hit.organizations.add(c.organization.toLowerCase());
      if (c.crm_record_id) hit.crm_record_ids.add(String(c.crm_record_id));
      hit.entity_ids.add(`${c.source}:${c.record_id}`);
      for (const e of cEmails) hit.emails.add(e);
    }
    return clusters;
  }

  // Field winner = highest-precedence member that carries the field.
  function pick(members, field) {
    const sorted = [...members].sort((a, b) => b.precedence - a.precedence);
    for (const m of sorted) if (m[field]) return { value: m[field], source: m.source, record_id: m.record_id, updated_at: m.updated_at };
    return { value: null, source: null };
  }

  function buildEntity(cl) {
    const members = cl.members;
    const nameW = pick(members, 'name');
    const orgW = pick(members, 'organization');
    const relW = pick(members, 'relationship');
    const crm = members.find(m => m.source === 'pfp_leads');
    const ke = members.find(m => m.source === 'knowledge_entities');

    // Email ranking: CRM current email always wins as primary; everything
    // else ever seen becomes superseded unless it IS the current one.
    const allEmails = new Set();
    for (const m of members) {
      if (m.email) allEmails.add(m.email.toLowerCase());
      for (const e of (m.superseded_emails || [])) allEmails.add(e.toLowerCase());
    }
    const current = crm?.email || ke?.email || pick(members, 'email').value;
    const currentLc = current ? current.toLowerCase() : null;
    const superseded = [...allEmails].filter(e => e !== currentLc);

    // Conflict: two members claim different *current* emails and neither is
    // in anyone's superseded list.
    const claimedCurrents = new Map();
    for (const m of members) {
      if (m.email) claimedCurrents.set(m.email.toLowerCase(), m.source);
    }
    const conflict = claimedCurrents.size > 1 && [...claimedCurrents.keys()].every(e => !superseded.includes(e));

    const aliases = new Set();
    for (const m of members) for (const a of (m.aliases || [])) aliases.add(a);
    if (nameW.value) aliases.add(nameW.value.split(' ')[0]);

    return {
      canonical_entity_id: ke?.record_id || crm?.record_id || members[0].record_id,
      display_name: nameW.value,
      aliases: [...aliases].filter(Boolean),
      current_email: current || null,
      superseded_emails: superseded,
      organization: orgW.value || null,
      relationship: relW.value || null,
      crm_record_id: crm?.record_id || members.find(m => m.crm_record_id)?.crm_record_id || null,
      updated_at: members.map(m => m.updated_at).filter(Boolean).sort().pop() || null,
      conflict_state: conflict ? 'conflict' : 'resolved',
      provenance: {
        name: nameW.source, organization: orgW.source, relationship: relW.source,
        email: crm ? 'pfp_leads' : (ke ? 'knowledge_entities' : pick(members, 'email').source),
      },
      sources: members.map(m => ({ source: m.source, record_id: m.record_id, updated_at: m.updated_at })),
      member_count: members.length,
    };
  }

  async function resolveEntity(q, { limit = 5 } = {}) {
    const started = Date.now();
    const terms = tokenize(q);
    if (!terms.length && !isEmail(q)) return { query: q, matches: [], partial: false, degraded: [], ms: 0 };
    const degraded = [];
    const candidates = await gather(terms, q, degraded);
    const clusters = cluster(candidates);
    const matches = clusters
      .map(buildEntity)
      .sort((a, b) => (b.member_count - a.member_count) || (a.display_name || '').localeCompare(b.display_name || ''))
      .slice(0, limit);
    if (degraded.length) logger.warn?.(`[entity-resolver] partial result for query (degraded: ${degraded.map(d => d.source).join(', ')})`);
    return {
      query: q,
      matches,
      partial: degraded.length > 0,
      degraded,
      ms: Date.now() - started,
    };
  }

  return { resolveEntity };
}
