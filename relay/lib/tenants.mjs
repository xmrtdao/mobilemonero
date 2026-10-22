/**
 * relay/lib/tenants.mjs — the brand registry.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every email the fleet sends has to look like it came from the business it
 * came from, and it has to keep looking like that after someone adds a
 * fifth tenant. That means the brand cannot live in the mailer, and it
 * cannot live in a comment.
 *
 * So the brand lives HERE, once, and everything else asks this file:
 *
 *   - relay/lib/rich-email.mjs takes its palette from here, so a mail sent
 *     from hello@partyfavorphoto.com is red and a mail sent from
 *     hello@31harbor.com is brass, without anybody choosing.
 *   - relay/lib/weekly.mjs takes its sections and its voice from here, so
 *     each tenant's weekly has the same shape and its own content.
 *   - relay/lib/brand-guide.mjs renders the guide from here, so the guide
 *     an agent reads cannot drift from the guide the mailer follows.
 *
 * THE COLOURS ARE THE BRAND'S OWN
 * --------------------------------
 * Each palette below was read out of that brand's own site - not chosen
 * here, and not invented. MobileMonero's orange and gold are the ones on
 * mobilemonero.com; 31 Harbor's brass is the one in its stylesheet; Party
 * Favor Photo's red is the one on its site; Jobby's blue is the one in its
 * portal. A brand that gets a palette invented for it in a mailer is a
 * brand whose email does not look like its website.
 *
 * TWO MODES, NOT ONE
 * ------------------
 * Some of these brands are dark (MobileMonero, 31 Harbor, Party Favor
 * Photo) and one is light (Jobby). A light brand that receives a dark
 * email is a brand whose email does not look like its website either - so
 * each tenant declares a mode, and the renderer honours it:
 *
 *   mode: 'dark' - the palette is INLINE (so Outlook, which ignores
 *     <style> entirely, still shows the brand) and the light palette sits
 *     in a prefers-color-scheme media query.
 *
 *   mode: 'light' - the same thing the other way round. The light palette
 *     is inline and the dark one is the media query. A Jobby email is a
 *     light email in every client.
 *
 * THE RULES EVERY TENANT SHARES
 * ------------------------------
 *   - The From address decides the brand. A caller cannot name someone
 *     else's brand; see brandFor() in rich-email.mjs.
 *   - A figure that was not fetched is never printed. A section that could
 *     not be fetched says so in the email.
 *   - Nothing in a weekly is written from memory. Every number has a
 *     source and a fetch time.
 *
 * WHAT IS NOT HERE
 * ----------------
 * Resend keys, webhook secrets and inbox routing stay in relay/server.js,
 * where they already are and where they are read at boot. This file is
 * about how a tenant LOOKS and what its weekly SAYS, and adding a secret
 * to it would invite someone to send it somewhere.
 */

// ── Palettes ────────────────────────────────────────────────
//
// Two palettes per tenant: the one that goes inline, and the one that
// takes over when the client prefers the other scheme. `mode` says which
// is which.
//
// The names are the roles the renderer asks for, not colours. The renderer
// never says "use #ff6600"; it says "use the accent", and this file
// decides what the accent is.

/** The fleet's own look: navy, cyan, violet. The default for unknown domains. */
const FLEET = {
  mode: 'dark',
  dark: {
    bg: '#0a0f1e', bgDeep: '#060a16', panel: '#121a2e', panelAlt: '#0f1626',
    border: '#243050', text: '#e9eefb', muted: '#9aa8c9', faint: '#6b7a9c',
    accent: '#5ee0ff', violet: '#a78bfa', ok: '#34d399', warn: '#fbbf24',
    crit: '#fb7185', codeBg: '#0b1120',
  },
  light: {
    bg: '#eef1f7', bgDeep: '#e4e9f4', panel: '#ffffff', panelAlt: '#f7f9fd',
    border: '#dde3f0', text: '#111827', muted: '#55637d', faint: '#7c8aa5',
    accent: '#0891b2', violet: '#7c3aed', ok: '#047857', warn: '#b45309',
    crit: '#be123c', codeBg: '#f4f6fb',
  },
};

// MobileMonero: the Monero orange and gold, on the near-black its site
// uses. #ff6600 is Monero's own orange; #d4af37 and #ffd700 are the golds
// from the same site; #0a0e1a and #f5f1e8 are its background and cream.
const MOBILEMONERO = {
  mode: 'dark',
  dark: {
    bg: '#0a0e1a', bgDeep: '#060911', panel: '#141a2b', panelAlt: '#101524',
    border: '#2b3348', text: '#f5f1e8', muted: '#b3ab97', faint: '#8b7355',
    accent: '#ff6600', violet: '#d4af37', ok: '#4caf50', warn: '#ffd700',
    crit: '#ef5350', codeBg: '#0b0f1c',
  },
  light: {
    bg: '#f5f1e8', bgDeep: '#eae3d4', panel: '#fffdf7', panelAlt: '#faf7ee',
    border: '#ddd3bd', text: '#1b1710', muted: '#6b5f4a', faint: '#8b7355',
    accent: '#c2410c', violet: '#92700f', ok: '#2f7d32', warn: '#a16207',
    crit: '#c62828', codeBg: '#f0ebdd',
  },
};

// 31 Harbor: deep harbour navy with a brass accent. #0d1f2c, #1a3a52,
// #2c5470 and the brass #c9a962/#d4bc7a are all from its stylesheet.
const HARBOR = {
  mode: 'dark',
  dark: {
    bg: '#0d1f2c', bgDeep: '#07141d', panel: '#153044', panelAlt: '#102838',
    border: '#2c5470', text: '#eef3f7', muted: '#a8bccd', faint: '#7d95a8',
    accent: '#c9a962', violet: '#8fb8d4', ok: '#4caf50', warn: '#e0b64c',
    crit: '#e57373', codeBg: '#091a26',
  },
  light: {
    bg: '#f8f9fa', bgDeep: '#e8edf1', panel: '#ffffff', panelAlt: '#f4f7f9',
    border: '#d3dde4', text: '#0d1f2c', muted: '#4a6377', faint: '#7d95a8',
    accent: '#8a6d21', violet: '#2c5470', ok: '#2e7d32', warn: '#9a7412',
    crit: '#b3261e', codeBg: '#eef2f5',
  },
};

// Party Favor Photo: a photographic studio, so near-black and one red.
// #0d0d15, #d12e2e and #b91c1c are the site's own.
const PFP = {
  mode: 'dark',
  dark: {
    bg: '#0d0d15', bgDeep: '#07070c', panel: '#171724', panelAlt: '#12121d',
    border: '#2c2c3f', text: '#f2f2f7', muted: '#a9a9bf', faint: '#7c7c93',
    accent: '#d12e2e', violet: '#8b5cf6', ok: '#4caf50', warn: '#fbbf24',
    crit: '#ef4444', codeBg: '#0a0a11',
  },
  light: {
    bg: '#f9fafb', bgDeep: '#eceef2', panel: '#ffffff', panelAlt: '#f5f5f8',
    border: '#e0e0f0', text: '#0d0d15', muted: '#55556b', faint: '#7c7c93',
    accent: '#b91c1c', violet: '#6d28d9', ok: '#15803d', warn: '#a16207',
    crit: '#b91c1c', codeBg: '#f0f0f4',
  },
};

// Jobby McJobberson: a candidate's own address, and a clean professional
// portal - so this one is LIGHT. #2563eb, #f1f5f9, #475569 and #cbd5e1
// are the portal's own.
const JOBBY = {
  mode: 'light',
  // The light palette is the one that goes inline.
  light: {
    bg: '#f1f5f9', bgDeep: '#e2e8f0', panel: '#ffffff', panelAlt: '#f8fafc',
    border: '#cbd5e1', text: '#0f172a', muted: '#475569', faint: '#94a3b8',
    accent: '#2563eb', violet: '#7c3aed', ok: '#166534', warn: '#854d0e',
    crit: '#b91c1c', codeBg: '#f1f5f9',
  },
  // The dark one takes over when the client prefers dark.
  dark: {
    bg: '#0f172a', bgDeep: '#0a1120', panel: '#1e293b', panelAlt: '#172033',
    border: '#334155', text: '#f1f5f9', muted: '#94a3b8', faint: '#64748b',
    accent: '#60a5fa', violet: '#a78bfa', ok: '#4ade80', warn: '#fbbf24',
    crit: '#f87171', codeBg: '#111827',
  },
};

// ── The registry ────────────────────────────────────────────
//
// `weekly.focus` is one sentence a reader would recognise the brand by.
// `weekly.sections` names the collectors in relay/lib/weekly-data.mjs.

export const TENANTS = {
  mobilemonero: {
    key: 'mobilemonero',
    domain: 'mobilemonero.com',
    brand: 'MobileMonero',
    // Names that belong to this domain and may be used for it. A name from
    // another domain is a mix, and is reported rather than honoured.
    aliases: ['MobileMonero', 'XMRT-DAO', 'XMRT DAO', 'Monero'],
    agent: 'xmrt',
    from: 'MobileMonero <hello@mobilemonero.com>',
    role: 'the XMRT-DAO weekly',
    palette: MOBILEMONERO,
    // The repository whose commits are "what shipped" for this tenant.
    repo: 'xmrtdao/mobilemonero',
    // Words that attribute a fleet task to this tenant. There is no tenant
    // column on the task table, so attribution is by what the task says.
    taskWords: ['mobilemonero', 'mobilemonero.com', 'MobileMonero'],
    weekly: {
      subject: 'MobileMonero Weekly',
      focus: 'Monero mining on a phone, the fleet that runs it, and what we published.',
      lede: 'A week of what the fleet is worth, what it shipped, and what it published.',
      sections: ['price', 'pool', 'articles', 'commits', 'work'],
    },
    voice: {
      // How an agent should write when it is writing for this tenant.
      summary: 'Plain, exact, warm. Numbers carry the argument; the prose stays short.',
      do: [
        'Quote the figure and where it came from.',
        'Say plainly when a source could not be reached.',
        'Use the word Monero, not XMR, in prose - XMR is for the tables.',
      ],
      doNot: [
        'Do not promise earnings, returns or yields of any kind.',
        'Do not say a price is up or down without the window it moved over.',
        'Do not call the pool the fleet\'s own hashrate - they are different numbers.',
      ],
    },
  },

  '31harbor': {
    key: '31harbor',
    domain: '31harbor.com',
    brand: '31 Harbor',
    aliases: ['31 Harbor', 'Cuttlefish Labs', 'Cuttlefish'],
    agent: 'harbor',
    from: '31 Harbor <hello@31harbor.com>',
    role: 'the 31 Harbor weekly',
    palette: HARBOR,
    repo: 'xmrtdao/31harborsoftware',
    taskWords: ['31harbor', '31 harbor', 'cuttlefish', 'Cuttlefish Labs'],
    weekly: {
      subject: '31 Harbor Weekly',
      focus: 'Agent identity, trust scores, contracts and the fleet that holds them.',
      lede: 'A week of the trust ledger, the agents on it, and what changed.',
      sections: ['trust', 'agents', 'contracts', 'commits', 'work'],
    },
    voice: {
      summary: 'Measured and institutional. This brand talks about identity and proof.',
      do: [
        'Lead with the ledger: what was recorded, by whom, when.',
        'Name an agent by its DID when the agent has one.',
        'Report a trust score as a score and a timestamp, never as a verdict.',
      ],
      doNot: [
        'Do not describe an agent as trustworthy or untrustworthy - report the score.',
        'Do not count a credential as a credential until it is in cac_credentials.',
        'Do not summarise a fabrication event away.',
      ],
    },
  },

  pfp: {
    key: 'pfp',
    domain: 'partyfavorphoto.com',
    brand: 'Party Favor Photo',
    aliases: ['Party Favor Photo', 'PFP', 'Photographic & Communication Services'],
    agent: 'pfp',
    from: 'Party Favor Photo <hello@partyfavorphoto.com>',
    role: 'the Party Favor Photo weekly',
    palette: PFP,
    repo: 'xmrtdao/partyfavorphoto',
    taskWords: ['partyfavorphoto', 'party favor photo', 'PFP'],
    weekly: {
      subject: 'Party Favor Photo Weekly',
      focus: 'Bookings, the leads behind them, and the shoots on the calendar.',
      lede: 'A week of bookings, the leads behind them, and the shoots on the calendar.',
      sections: ['bookings', 'leads', 'work'],
    },
    voice: {
      summary: 'Warm and practical. A photographer writes to a client, not to a board.',
      do: [
        'Say what was booked, for when, and where.',
        'Name a client the way they would want to be named.',
        'Keep it short - this audience is a client, not an investor.',
      ],
      doNot: [
        'Do not expose another client\'s details in a shared list.',
        'Do not state a booking is confirmed without its status saying confirmed.',
        'Do not report a lead as won before the contract is signed.',
      ],
    },
  },

  jobby: {
    key: 'jobby',
    domain: 'jobbymcjobberson.com',
    brand: 'Jobby McJobberson',
    aliases: ['Jobby McJobberson', 'Jobby'],
    agent: 'jobby',
    from: 'Jobby McJobberson <hello@jobbymcjobberson.com>',
    role: "a candidate's own weekly",
    palette: JOBBY,
    repo: 'xmrtdao/jobbymcjobberson',
    taskWords: ['jobbymcjobberson', 'jobby', 'Jobby'],
    weekly: {
      subject: 'Jobby Weekly',
      focus: 'The applications, the resumes and the mailboxes that make them possible.',
      lede: 'A week of applications, the blockers in the way, and what got sent.',
      sections: ['candidates', 'applications', 'work'],
    },
    voice: {
      summary: 'Plain and private. This is a person\'s own address; it reads like a note to them.',
      do: [
        'Address the candidate directly. It is their mailbox.',
        'Name a blocker specifically - "no verified mailbox" beats "blocked".',
        'Report what was actually sent, and to whom.',
      ],
      doNot: [
        'Do not put one candidate\'s application list in front of another.',
        'Do not claim an application was submitted without a submitted_at.',
        'Do not guess at a company\'s hiring process.',
      ],
    },
  },
};

/** The tenant keys, in the order they are usually listed. */
export const TENANT_KEYS = Object.keys(TENANTS);

/** The palette used for a domain that is not one of ours. */
export const FLEET_PALETTE = FLEET;

/**
 * The tenant that owns a domain, or null.
 *
 * @param {string} domain
 * @returns {object|null}
 */
export function tenantForDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return null;
  for (const t of Object.values(TENANTS)) {
    if (t.domain === d) return t;
  }
  return null;
}

/**
 * The tenant a From address belongs to, or null.
 *
 * @param {string} fromAddress
 * @returns {object|null}
 */
export function tenantForAddress(fromAddress) {
  const s = String(fromAddress || '');
  const angled = s.match(/<([^>]+)>/);
  const addr = (angled ? angled[1] : s).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at === -1) return null;
  return tenantForDomain(addr.slice(at + 1));
}

/**
 * The tenant by key, or null.
 *
 * @param {string} key
 * @returns {object|null}
 */
export function tenantByKey(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  if (TENANTS[k]) return TENANTS[k];
  for (const t of Object.values(TENANTS)) {
    if (t.domain === k) return t;
  }
  return null;
}

/**
 * The palette for a tenant, in the order the renderer wants it.
 *
 * `inline` is the palette that goes on the elements themselves and
 * `override` is the one that takes over when the client prefers the other
 * scheme. Which is which is the tenant's `mode`.
 *
 * @param {object|null} tenant
 * @returns {{inline:object, override:object, mode:string}}
 */
export function paletteFor(tenant) {
  const p = (tenant && tenant.palette) || FLEET;
  if (p.mode === 'light') {
    return { inline: p.light, override: p.dark, mode: 'light' };
  }
  return { inline: p.dark, override: p.light, mode: 'dark' };
}

export default { TENANTS, TENANT_KEYS, FLEET_PALETTE, tenantForDomain, tenantForAddress, tenantByKey, paletteFor };
