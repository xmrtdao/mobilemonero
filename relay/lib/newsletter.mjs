/**
 * relay/lib/newsletter.mjs — the MobileMonero weekly, under its old name.
 *
 * This used to BE the weekly. It is now one tenant's weekly, built by
 * relay/lib/weekly.mjs, which every tenant uses - because the shape of a
 * weekly should be the same for every business and only the content should
 * differ, and because a second builder for the second tenant would be a
 * second thing to keep right.
 *
 * The name is kept because relay/scripts/send-newsletter.mjs and anything
 * else that imported it should keep working, and because "the newsletter"
 * is still what MobileMonero's is.
 */

import { buildWeekly, buildWeeklyBody } from './weekly.mjs';
import { gatherWeeklyData } from './weekly-data.mjs';
import { TENANTS } from './tenants.mjs';

const MOBILEMONERO = TENANTS.mobilemonero;

/**
 * Build the MobileMonero weekly.
 *
 * @param {object} opts
 * @param {string} [opts.subject]
 * @param {string} [opts.from]
 * @param {object} [opts.data]   pre-gathered data
 * @returns {Promise<{html:string, text:string, missing:string[]}>}
 */
export async function buildNewsletter(opts = {}) {
  return buildWeekly({ ...opts, tenant: 'mobilemonero' });
}

/**
 * The MobileMonero weekly body as markdown.
 *
 * @param {object} data  gathered data
 * @returns {{body:string, issue:string}}
 */
export function buildNewsletterBody(data, opts = {}) {
  return buildWeeklyBody({ ...data, tenant: MOBILEMONERO }, opts);
}

/**
 * Everything the MobileMonero weekly needs, fetched together.
 *
 * Kept for callers that used it directly.
 */
export async function gatherNewsletterData() {
  return gatherWeeklyData(MOBILEMONERO);
}

export default { buildNewsletter, buildNewsletterBody, gatherNewsletterData };
