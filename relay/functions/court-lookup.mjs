/**
 * court-lookup.mjs — CourtListener® Case Law Lookup
 * Free Law Project API integration for Virginia + federal case law
 * Trademark and attribution to CourtListener / Free Law Project
 *
 * © 2026 Cuttlefish Labs
 */

const META = {
  name: 'court-lookup',
  description: 'Search CourtListener case law for opinions related to lease/landlord-tenant disputes in Virginia courts. Returns official court opinions with citations, snippets, and links.',
  version: '1.0.0',
};

const CL_BASE_URL = 'https://www.courtlistener.com/api/rest/v4';

/* ═══════════════════════════════════════════════════════════════════
   CourtListener® API Helpers
   ═══════════════════════════════════════════════════════════════════ */

async function courtListenerSearch(query, courtIds, type = 'o', limit = 5) {
  const url = new URL(`${CL_BASE_URL}/search/`);
  url.searchParams.set('q', query);
  if (courtIds?.length) url.searchParams.set('court', courtIds.join(','));
  if (type) url.searchParams.set('type', type);
  url.searchParams.set('order_by', 'dateFiled desc');
  url.searchParams.set('page', '1');

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'ElzeContractAnalyzer/1.0 (research use; cuttlefishlabs.io)',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CourtListener ${res.status}: ${body.slice(0,200)}`);
  }

  const data = await res.json();
  return data;
}

function formatOpinion(op) {
  // CourtListener API v4 returns fields with camelCase keys
  const courtName = typeof op.court === 'string' ? op.court : (op.court?.name || 'Unknown Court');
  const courtId = typeof op.court_id === 'string' ? op.court_id : (op.court?.id || '');
  const courtJurisdiction = typeof op.court_jurisdiction === 'string' ? op.court_jurisdiction : '';
  return {
    caseName: op.caseName || op.case_name || 'Unknown Case',
    caseNameShort: op.caseNameShort || op.case_name_short || '',
    dateFiled: op.dateFiled || op.date_filed || op.dateArgued || op.date_argued || null,
    docketNumber: op.docketNumber || op.docket_number || '',
    courtName: courtName,
    courtId: courtId,
    jurisdiction: courtJurisdiction,
    snippet: op.snippet || '',
    absoluteUrl: op.absolute_url || op.absoluteUrl || '',
    citeCount: op.citeCount || op.cite_count || 0,
    precedentialStatus: op.precedentialStatus || op.precedential_status || 'Unknown',
    status: op.status || '',
    clusterId: op.cluster_id || op.clusterId || op.id,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   Virginia Court Mappings
   ═══════════════════════════════════════════════════════════════════ */

const VA_COURTS = {
  supreme: { id: 'va', name: 'Virginia Supreme Court' },
  appeals: { id: 'vactapp', name: 'Virginia Court of Appeals' },
  fedE: { id: 'vaed', name: 'E.D. Virginia (Federal)' },
  fedW: { id: 'vawd', name: 'W.D. Virginia (Federal)' },
  circuit4: { id: 'va4', name: '4th Circuit Court of Appeals' },
};

const FEDERAL_COURTS = {
  scotus: { id: 'scotus', name: 'U.S. Supreme Court' },
  fed: { id: 'ca4', name: '4th Circuit (Federal)' },
};

/* ═══════════════════════════════════════════════════════════════════
   Query Builders
   ═══════════════════════════════════════════════════════════════════ */

function buildLeaseQueries(clauseType) {
  // Map clause types to case law search queries
  const queries = {
    'SECURITY_DEPOSIT': 'security deposit landlord tenant Virginia',
    'LATE_FEE': 'late fee landlord tenant unreasonable Virginia',
    'RENT_INCREASE': 'rent increase commercial lease Virginia',
    'LEASE_TERM': 'lease term termination commercial Virginia',
    'SUBLEASE': 'sublease assignment commercial lease Virginia',
    'RENEWAL': 'lease renewal option commercial Virginia',
    'DEFAULT': 'default notice cure period commercial lease Virginia',
    'MAINTENANCE': 'maintenance repair obligation commercial lease Virginia',
    'INSURANCE': 'insurance requirement landlord tenant Virginia',
    'INDEMNITY': 'indemnification commercial lease Virginia',
    'ENTRY_NOTICE': 'landlord entry notice commercial Virginia',
    'ENVIRONMENTAL': 'environmental compliance commercial lease Virginia',
    'CAM_CHARGES': 'common area maintenance CAM charges commercial lease',
    'PERCENTAGE_RENT': 'percentage rent commercial lease Virginia',
    'ASSIGNMENT': 'assignment consent commercial lease Virginia',
    'ESCALATION': 'rent escalation CPI commercial lease Virginia',
    'WARRANTY': 'implied warranty commercial lease habitability Virginia',
    'LIS_PENDENS': 'lis pendens commercial real estate Virginia',
    'QUIET_ENJOYMENT': 'quiet enjoyment commercial lease Virginia',
    'FORCE_MAJEURE': 'force majeure commercial lease Virginia',
  };
  return queries[clauseType] || `${clauseType.replace(/_/g, ' ')} landlord tenant Virginia`;
}

/* ═══════════════════════════════════════════════════════════════════
   Main Lookup
   ═══════════════════════════════════════════════════════════════════ */

export async function lookupCaseLaw(clauseType, options = {}) {
  const { courtScope = 'va', maxResults = 5, includeFederal = false } = options;

  const query = buildLeaseQueries(clauseType);
  const courtIds = [];

  if (courtScope === 'va' || courtScope === 'all') {
    courtIds.push('va', 'vactapp');
  }
  if (includeFederal || courtScope === 'all') {
    courtIds.push('va4', 'vaed', 'vawd');
  }

  try {
    const data = await courtListenerSearch(query, courtIds, 'o', maxResults);
    const opinions = (data.results || []).slice(0, maxResults).map(formatOpinion);

    return {
      success: true,
      clauseType,
      query,
      courtScope,
      totalCount: data.count || 0,
      opinions,
      source: {
        name: 'CourtListener',
        url: 'https://www.courtlistener.com',
        attribution: 'Free Law Project, a 501(c)(3) nonprofit. Data is in the public domain.',
        trademark: 'CourtListener® is a registered trademark of Free Law Project.',
        license: 'Public domain for government works; CC-BY-NC for FLP metadata.',
      },
      apiUrl: `${CL_BASE_URL}/search/?q=${encodeURIComponent(query)}&court=${courtIds.join(',')}&type=o`,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      clauseType,
      query,
      source: {
        name: 'CourtListener',
        url: 'https://www.courtlistener.com',
        attribution: 'Free Law Project, a 501(c)(3) nonprofit.',
      },
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Handler (relay function-runtime compatible)
   ═══════════════════════════════════════════════════════════════════ */

export const meta = META;

export async function handler(reqOrArgs, res) {
  let args;
  if (res) {
    try { args = reqOrArgs.body || {}; } catch { args = {}; }
  } else {
    args = reqOrArgs || {};
  }

  const { clauseType, courtScope, maxResults, includeFederal } = args;

  if (!clauseType) {
    const err = {
      success: false,
      error: 'clauseType is required. Provide a lease clause category (e.g., "SECURITY_DEPOSIT", "LATE_FEE").',
      meta: META,
    };
    if (res) return res.status(400).json(err);
    return err;
  }

  const result = await lookupCaseLaw(clauseType, {
    courtScope: courtScope || 'va',
    maxResults: Math.min(parseInt(maxResults, 10) || 5, 20),
    includeFederal: includeFederal === true || includeFederal === 'true',
  });
  const response = { ...result, meta: META };

  if (res) return res.json(response);
  return response;
}

/* ── CLI execution ────────────────────────────────────────────── */
if (process.argv[1] && (process.argv[1].includes('court-lookup') || process.argv[1].includes('_local_shim'))) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; } else { args[key] = true; }
    }
  }
  handler(args).then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  });
}
