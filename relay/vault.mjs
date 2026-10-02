/**
 * relay/vault.mjs — read/write access to the Obsidian vault ("second brain")
 *
 * The vault is a flat directory of markdown notes under xmrt-dao/. It started
 * read-only: the Galaxy tile graphed it, but nothing could write to it, so
 * knowledge Eliza learned in conversation never made it into the wiki.
 *
 * WRITE SAFETY — the whole point of this design:
 *
 *   1. MACHINE-OWNED BLOCK. A generated section is wrapped in
 *        <!-- xmrt:knowledge:start --> ... <!-- xmrt:knowledge:end -->
 *      Everything outside those markers is human content and is NEVER touched.
 *      A rewrite replaces only the block between them, so asking the machine to
 *      "update this note" cannot silently destroy prose someone wrote above or
 *      below it.
 *
 *   2. IDEMPOTENT. Writing the same entity twice produces the same file with
 *      the same block, not a second file and not a duplicated section.
 *
 *   3. SAFE FILENAMES. Entity names come from model output, so the slug is
 *      restricted to [a-z0-9._-] and path separators / traversal are rejected.
 *      Without this, a name like "../../secrets" would escape the vault.
 *
 *   4. VERSIONED. The vault is its own git repo, so every write is diffable
 *      and revertable.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

export const BLOCK_START = '<!-- xmrt:knowledge:start -->';
export const BLOCK_END = '<!-- xmrt:knowledge:end -->';

/** Turn any label into a safe, stable, lowercase slug. */
export function slugifyNote(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100);
}

/** Reject anything that isn't a plain slug before it reaches the filesystem. */
export function isSafeSlug(slug) {
  return typeof slug === 'string'
    && slug.length > 0
    && slug.length <= 100
    && /^[a-z0-9][a-z0-9._-]*$/.test(slug);
}

function renderBlock(fields) {
  const lines = [];
  if (fields.entity_type) lines.push(`- **Type:** ${fields.entity_type}`);
  if (fields.description) lines.push(`- **Description:** ${fields.description}`);
  if (fields.confidence_score != null) lines.push(`- **Confidence:** ${fields.confidence_score}`);
  if (fields.aliases && fields.aliases.length) lines.push(`- **Also known as:** ${fields.aliases.join(', ')}`);
  if (fields.related && fields.related.length) lines.push(`- **Related:** ${fields.related.map(r => `[[${r}]]`).join(', ')}`);
  lines.push(`- **Last updated:** ${new Date().toISOString()}`);
  if (fields.source) lines.push(`- **Source:** ${fields.source}`);

  return [
    BLOCK_START,
    '',
    '## Knowledge',
    '',
    '_This section is maintained by the XMRT fleet. Ask the machine to update it;'
      + ' anything you write outside this block is preserved._',
    '',
    ...lines,
    '',
    BLOCK_END,
  ].join('\n');
}

/**
 * Replace (or append) the machine-owned block in a note.
 * Content outside the block is returned untouched.
 */
export function upsertManagedBlock(existingContent, fields) {
  const block = renderBlock(fields);
  if (!existingContent) {
    const title = fields.title || fields.name || 'Untitled';
    return `# ${title}\n\n${block}\n`;
  }

  const startIdx = existingContent.indexOf(BLOCK_START);
  const endIdx = existingContent.indexOf(BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace in place: keep the head before the start marker, the new block,
    // and the tail after the end marker.
    const head = existingContent.slice(0, startIdx);
    const tail = existingContent.slice(endIdx + BLOCK_END.length);
    return `${head}${block}${tail}`;
  }

  // No block yet — append, leaving the whole existing note intact.
  const sep = existingContent.endsWith('\n') ? '\n' : '\n\n';
  return `${existingContent}${sep}\n${block}\n`;
}

/** List note slugs (filenames without .md). */
export function listNotes(vaultPath) {
  if (!existsSync(vaultPath)) return [];
  return readdirSync(vaultPath)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3));
}

export function notePath(vaultPath, slug) {
  if (!isSafeSlug(slug)) throw new Error(`Unsafe note slug: ${slug}`);
  return join(vaultPath, `${slug}.md`);
}

export function readNote(vaultPath, slug) {
  const p = notePath(vaultPath, slug);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/**
 * Write a note's machine-owned block. Creates the note if missing.
 * Returns { created, updated, slug, path }.
 */
const LAST_UPDATED_RE = /^- \*\*Last updated:\*\* .*$/m;

/**
 * Compare two notes ignoring the generated timestamp.
 *
 * Without this, every sync rewrote all notes because `Last updated` is always
 * a fresh ISO string — identical content was never "unchanged", so a routine
 * entity sync produced a git commit touching every single note.
 */
function sameExceptTimestamp(a, b) {
  return a.replace(LAST_UPDATED_RE, '').trim() === b.replace(LAST_UPDATED_RE, '').trim();
}

export function writeNote(vaultPath, name, fields = {}) {
  const slug = slugifyNote(name);
  if (!isSafeSlug(slug)) {
    throw new Error(`Cannot write note: "${name}" does not reduce to a safe filename`);
  }
  const p = notePath(vaultPath, slug);
  const existed = existsSync(p);
  const existing = existed ? readFileSync(p, 'utf8') : '';
  const next = upsertManagedBlock(existing, { ...fields, name });

  // Only touch disk when something other than the timestamp changed, so we do
  // not churn mtimes (and therefore git history) on repeated syncs.
  if (existed && (existing === next || sameExceptTimestamp(existing, next))) {
    return { created: false, updated: false, unchanged: true, slug, path: p };
  }

  writeFileSync(p, next, 'utf8');
  return { created: !existed, updated: existed, unchanged: false, slug, path: p };
}

/** Remove just the machine-owned block, leaving the human note intact. */
export function stripManagedBlock(content) {
  const startIdx = content.indexOf(BLOCK_START);
  const endIdx = content.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  return (content.slice(0, startIdx) + content.slice(endIdx + BLOCK_END.length))
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
}

/**
 * Relay tool handlers for the vault.
 *
 * Takes a getVaultPath thunk rather than resolving the path itself, so the
 * tools and /api/obsidian-graph always agree on which directory they use.
 */
export function getVaultNoteTools(getVaultPath) {
  return {
    'vault-list': async (args) => {
      const vault = getVaultPath();
      if (!existsSync(vault)) return { error: `Vault not found at ${vault}` };
      const query = String(args?.query || '').toLowerCase();
      const slugs = listNotes(vault);
      const matched = query
        ? slugs.filter(s => s.toLowerCase().includes(query))
        : slugs;
      return {
        success: true,
        vault,
        count: matched.length,
        total: slugs.length,
        notes: matched.slice(0, parseInt(args?.limit) || 100),
      };
    },

    'vault-read': async (args) => {
      const vault = getVaultPath();
      const name = args?.name;
      if (!name) return { error: 'name is required' };
      const slug = slugifyNote(name);
      const content = readNote(vault, slug);
      if (content == null) {
        return { error: `Note not found: ${slug}`, hint: 'Use vault-list to see existing notes.' };
      }
      return { success: true, vault, slug, content };
    },

    'vault-write': async (args) => {
      const vault = getVaultPath();
      const name = args?.name;
      if (!name) return { error: 'name is required' };
      try {
        const result = writeNote(vault, name, {
          title: args?.title,
          entity_type: args?.entity_type,
          description: args?.description,
          confidence_score: args?.confidence_score,
          aliases: args?.aliases,
          related: args?.related,
          source: args?.source || 'agent',
        });
        return { success: true, ...result, note: result.slug };
      } catch (err) {
        return { error: err.message };
      }
    },

    'vault-update': async (args) => {
      const vault = getVaultPath();
      const name = args?.name;
      if (!name) return { error: 'name is required' };
      const slug = slugifyNote(name);
      const p = notePath(vault, slug);
      if (!existsSync(p)) {
        return { error: `Note not found: ${slug}`, hint: 'Use vault-write to create it.' };
      }
      try {
        const result = writeNote(vault, name, {
          title: args?.title,
          entity_type: args?.entity_type,
          description: args?.description,
          confidence_score: args?.confidence_score,
          aliases: args?.aliases,
          related: args?.related,
          source: args?.source || 'agent',
        });
        return { success: true, ...result, note: result.slug };
      } catch (err) {
        return { error: err.message };
      }
    },
  };
}

/**
 * Push public.knowledge_entities into the vault as managed-block notes.
 *
 * Run on demand rather than on every write: the SPA's entity extraction fires
 * per assistant message, and one note write per extracted entity per turn is
 * both slow and noisy in git. Callers pass the rows in so this stays a pure
 * function of its input and easy to test.
 */
export function syncEntitiesToVault(vaultPath, entities) {
  const created = [];
  const updated = [];
  const unchanged = [];
  const skipped = [];

  for (const e of (entities || [])) {
    const label = e.entity_name || e.name;
    if (!label) { skipped.push({ reason: 'no name', row: e }); continue; }
    try {
      const r = writeNote(vaultPath, label, {
        title: label,
        entity_type: e.entity_type,
        description: e.description,
        confidence_score: e.confidence_score,
        source: 'knowledge_entities',
      });
      if (r.created) created.push(r.slug);
      else if (r.unchanged) unchanged.push(r.slug);
      else updated.push(r.slug);
    } catch (err) {
      skipped.push({ name: label, reason: err.message });
    }
  }

  return {
    success: true,
    vault: vaultPath,
    counts: { created: created.length, updated: updated.length, unchanged: unchanged.length, skipped: skipped.length },
    created, updated, skipped: skipped.slice(0, 20),
  };
}
