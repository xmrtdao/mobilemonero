/**
 * relay/lib/domain-keys.mjs — which Resend key belongs to which domain.
 *
 * The registry that decides this lives in relay/server.js, where the domain
 * list, the labels and the paths all sit together. But the key LOOKUP is
 * needed outside the server too - the newsletter sends mail, the auto-
 * responder sends mail, and both need to know which account a From address
 * belongs to.
 *
 * So the lookup is here, and it is the SAME rule the server uses: the key
 * comes from the registry entry for the domain, and a domain with no entry
 * has no key. A send cannot quietly fall through to another account's key,
 * because "which account" is answered by the domain and nothing else.
 *
 * The registry itself is passed in by the caller rather than imported, so
 * there is one list of domains in the system (the server's) and this module
 * only knows how to read a key out of it.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

/** The relay's environment, read once. */
export function relayEnv() {
  const out = {};
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * The domain part of a From header.
 */
export function domainOf(from) {
  const s = String(from || '');
  const angled = s.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : s).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

/**
 * The key for a domain.
 *
 * @param {string} domainOrKey  a domain ("mobilemonero.com") or a registry
 *                               key ("mobilemonero")
 * @param {object} registry      EMAIL_DOMAINS, or null to use the environment
 * @returns {string|null} the key, or null if that domain has none
 */
export function resendKeyFor(domainOrKey, registry = null, env = relayEnv()) {
  if (!domainOrKey) return null;

  if (registry) {
    // A registry key names a domain directly.
    if (registry[domainOrKey]) return env[registry[domainOrKey].key] || null;
    for (const entry of Object.values(registry)) {
      if (entry.domain === domainOrKey) return env[entry.key] || null;
    }
    return null;
  }

  // Without a registry, the environment names the domain in the variable
  // name: RESEND_API_KEY for partyfavorphoto.com, RESEND_XMRT_API_KEY for
  // mobilemonero.com, and so on. The mapping is explicit rather than
  // guessed from a pattern, because a pattern would eventually resolve a
  // domain to the wrong account.
  const BY_DOMAIN = {
    'partyfavorphoto.com': 'RESEND_API_KEY',
    'mobilemonero.com': 'RESEND_XMRT_API_KEY',
    '31harbor.com': 'RESEND_31HARBOR_API_KEY',
    'jobbymcjobberson.com': 'RESEND_JOBBY_API_KEY',
  };
  const varName = BY_DOMAIN[String(domainOrKey).toLowerCase()];
  return varName ? (env[varName] || null) : null;
}

export default { resendKeyFor, domainOf, relayEnv };
