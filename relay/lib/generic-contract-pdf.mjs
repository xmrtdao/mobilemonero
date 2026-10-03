/**
 * relay/lib/generic-contract-pdf.mjs — render any contract type, no branding.
 *
 * This is the answer to "agents shouldn't be stuck with one template". It draws a
 * consulting agreement, an NDA, an SOW or an independent-contractor agreement
 * from the clause set its type names, with no photo-booth rates, no inclusions
 * list and no logo unless the caller passes one.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Render without the required inputs. `planGenericContract` reports what is
 * missing and this throws rather than emitting a document with a blank
 * jurisdiction or a fee clause that says nothing about fees. A generic template
 * with missing inputs is the same class of defect as the PFP template's
 * hard-coded District of Columbia law - it just fails quieter.
 *
 * `branding` defaults to off. An unbranded agreement is a normal and often
 * preferable thing to hand a counterparty, and it is the safe default when an
 * agent does not know whose letterhead this should be on.
 */

import { createLayout, money, fieldOrBlank, longDate, BLANK } from './pdf-layout.mjs';
import { CONTRACT_TYPES, STANDARD_CLAUSES, planGenericContract } from './contract-templates.mjs';

/**
 * Build the model. Separated from rendering so it can be checked without
 * producing a document - the same split as the PFP engine.
 */
export function buildGenericContract(input = {}) {
  const {
    type, allowDraft = false, drafted_on, branding = null, ...values
  } = input;

  const plan = planGenericContract(type, values);
  const draft = !plan.complete;

  if (draft && !allowDraft) {
    const lines = plan.missing.map((m) => `  - ${m.question}`).join('\n');
    throw new Error(
      `cannot render a ${plan.type.label}: ${plan.missing.length} required field(s) missing.\n${lines}\n` +
        `Pass allowDraft: true for an internal draft; the result is marked DRAFT.`
    );
  }

  const v = values;
  return {
    draft,
    gaps: plan.missing,
    type: plan.type,
    title: plan.type.title,
    clauses: plan.clauses,
    // Branding is opt-in. Absent means the page carries no logo, no company name
    // in a header, and no contact footer.
    branding: branding === null ? null : branding,
    options: { drafted_on: drafted_on ?? new Date() },
    parties: {
      client_name: v.client_name ?? null,
      client_entity: v.client_entity ?? null,
      client_address: v.client_address ?? null,
      provider_name: v.provider_name ?? null,
      provider_entity: v.provider_entity ?? null,
      provider_address: v.provider_address ?? null,
    },
    reference: v.reference ?? null,
    values: v,
  };
}

/**
 * Render a model to PDF bytes.
 */
export async function renderGenericContractPdf(model) {
  const L = await createLayout();
  const v = model.values;
  const p = model.parties;
  const isDraft = model.draft === true;

  const draftedOn = longDate(model.options.drafted_on);

  // ── draft banner ─────────────────────────────────────────────────────────
  if (isDraft) {
    L.panel(26, L.C.accent);
    L.text(`DRAFT - NOT FOR SIGNATURE - ${model.gaps.length} field(s) not supplied`, {
      size: 10, font: L.fonts.bold, indent: 8,
    });
    L.y -= 14;
  }

  // ── header ───────────────────────────────────────────────────────────────
  // A logo is drawn only when one was passed. There is no default logo, because a
  // generic document carrying the photo-booth company's mark would be a lie about
  // whose agreement this is.
  if (model.branding?.logo_path) {
    await L.logo(model.branding.logo_path, { max_width: 120, max_height: 44 });
    L.y -= 10;
  }
  L.text(model.title, {
    size: 20, font: L.fonts.bold, color: L.C.rule, align: 'right', after: 2,
  });
  if (model.reference) {
    L.text(`Reference: ${model.reference}`, { size: 10, color: L.C.gray, align: 'right', after: 1 });
  }
  L.text(`Drafted ${draftedOn}`, { size: 10, color: L.C.gray, align: 'right', after: 6 });
  L.rule(1.5);

  // ── parties ──────────────────────────────────────────────────────────────
  L.text(`This Agreement is made on ${draftedOn}`, { after: 4 });
  L.text('between:', { size: 11, font: L.fonts.serifBold, color: L.C.rule, after: 4 });
  L.y -= 6;

  // Drawn as separate text calls, NOT joined with "\n". WinAnsi cannot encode a
  // literal newline, so a joined string threw inside pdf-lib - which is why the
  // party block needed restructuring rather than a font change.
  const drawParty = async (role, name, entity, address) => {
    L.panel(54);
    const top = L.y;
    L.text(entity ? `${entity} ("${name ?? BLANK}")` : fieldOrBlank(name), {
      size: 11, font: L.fonts.bold, indent: 10,
    });
    if (address) L.text(address, { size: 10, color: L.C.gray, indent: 10 });
    L.text(`the "${role}"`, { size: 10, color: L.C.gray, indent: 10 });
    L.y = top - 54 - 10;
  };

  await drawParty('Client', p.client_name, p.client_entity, p.client_address);
  L.text('and', { after: 4 });
  L.y -= 6;
  await drawParty('Provider', p.provider_name, p.provider_entity, p.provider_address);
  L.y -= 4;

  // ── clauses ──────────────────────────────────────────────────────────────
  model.clauses.forEach((clause, i) => {
    const spec = STANDARD_CLAUSES.find((c) => c.key === clause.key);
    L.section(`${i + 1}`, clause.title);
    let body;
    try {
      body = spec.body(v);
    } catch {
      // A clause whose inputs are absent renders as its prompt rather than as
      // text with "undefined" in it. The gap list already names it.
      body = clause.prompt
        ? `${clause.prompt} _(${clause.prompt})_`
        : 'Not supplied.';
    }
    // A clause body that would print an undefined value is a failure, so the
    // required strings are checked before rendering rather than after.
    if (/undefined|\[object Object\]/.test(body)) {
      body = clause.prompt ? `${clause.prompt} _(not supplied)_` : 'Not supplied.';
    }
    L.text(body, { size: 10, indent: 4, after: 4 });
  });

  // ── signatures ───────────────────────────────────────────────────────────
  L.section(`${model.clauses.length + 1}`, 'Signatures');
  L.y -= 4;

  for (const [role, name, entity, sigPath] of [
    ['Provider', p.provider_name, p.provider_entity, model.branding?.signature_path],
    ['Client', p.client_name, p.client_entity, null],
  ]) {
    if (L.y < 150) L.newPage();
    L.panel(80);
    const top = L.y;
    if (sigPath) await L.signature(sigPath);
    L.text(`${name ?? BLANK}${entity ? `, ${entity}` : ''}`, {
      size: 11, font: L.fonts.serifBold, indent: 10,
    });
    L.text(`${role} - ${name ?? ''}`, { size: 10, color: L.C.gray, indent: 10 });
    L.y += 3;
    L.text(`Signature: ${BLANK}   Date: ${BLANK}`, { size: 10, indent: 10 });
    L.y = top - 80 - 12;
  }

  // ── footer ───────────────────────────────────────────────────────────────
  L.rule(1);
  const footerBits = [
    model.branding?.footer_line,
    `${model.type.label} - drafted ${draftedOn}`,
    isDraft ? 'DRAFT, NOT FOR SIGNATURE' : null,
  ].filter(Boolean);
  L.text(footerBits.join('  |  '), { size: 8, color: L.C.gray });

  return L.save();
}

/**
 * Build and render in one call.
 * @returns {Promise<{bytes: Uint8Array, model: object, page_count: number}>}
 */
export async function renderGenericContract(input) {
  const model = buildGenericContract(input);
  const bytes = await renderGenericContractPdf(model);
  const probe = await import('pdf-lib').then((m) => m.PDFDocument.load(bytes));
  return { bytes, model, page_count: probe.getPageCount() };
}

void money; void fieldOrBlank; void CONTRACT_TYPES;
export default { buildGenericContract, renderGenericContract, renderGenericContractPdf };