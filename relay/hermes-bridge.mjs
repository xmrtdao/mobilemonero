/**
 * hermes-bridge.mjs — Agent-to-Hermes prompt bridge
 *
 * Two sides:
 *   1. RELAY SIDE — HTTP endpoint + outbox poller (runs inside relay)
 *   2. HERMES SIDE — inbox poller + executor (runs as cron on this Hermes instance)
 *
 * Flow:
 *   Agent → POST /api/hermes/prompt → relay writes inbox/{uuid}.json
 *   Hermes cron → reads inbox/{uuid}.json → executes prompt → writes outbox/{uuid}.json
 *   Relay poller → sees outbox/{uuid}.json → posts result to fleet chat
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'relay-data');
const INBOX_DIR = join(DATA_DIR, 'hermes-inbox');
const OUTBOX_DIR = join(DATA_DIR, 'hermes-outbox');

// Ensure directories exist
for (const d of [INBOX_DIR, OUTBOX_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── RELAY SIDE ────────────────────────────────────────────────

/**
 * Handle an incoming agent prompt. Called from the relay's POST /api/hermes/prompt.
 * Writes the prompt to the inbox and returns immediately with a tracking ID.
 */
export function handleAgentPrompt(prompt, sender, channel = 'fleet') {
  const id = `hermes-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    prompt,
    sender,
    channel,
    ts: Date.now(),
    status: 'queued',
  };
  writeFileSync(join(INBOX_DIR, `${id}.json`), JSON.stringify(entry, null, 2));
  return { success: true, id, message: 'Prompt queued for Hermes' };
}

/**
 * Poll the outbox for completed prompts and deliver results to fleet chat.
 * Called periodically from the relay (setInterval).
 */
export function pollOutbox(addFleetMessage, publishToMesh) {
  const files = readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(OUTBOX_DIR, file), 'utf8'));
      if (entry.status === 'completed') {
        // Deliver result to fleet chat
        const msg = `🤖 **Hermes response** to ${entry.sender}:\n\n${entry.result}`;
        addFleetMessage('hermes', msg, entry.channel || 'fleet');
        publishToMesh('fleet-broadcast', { agent: 'hermes', message: msg, channel: entry.channel || 'fleet', ts: Date.now() }).catch(() => {});
        // Clean up
        unlinkSync(join(OUTBOX_DIR, file));
        console.log(`[hermes-bridge] Delivered result for ${entry.id}`);
      }
    } catch (e) {
      console.error(`[hermes-bridge] Error processing outbox ${file}:`, e.message);
    }
  }
}

// ── HERMES SIDE ────────────────────────────────────────────────

/**
 * Poll the inbox for new prompts. Returns the next pending prompt or null.
 * Called from the Hermes cron job.
 */
export function pollInbox() {
  const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  // Sort by creation time (oldest first)
  files.sort();
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(INBOX_DIR, file), 'utf8'));
      if (entry.status === 'queued') {
        // Mark as in-progress
        entry.status = 'in_progress';
        writeFileSync(join(INBOX_DIR, file), JSON.stringify(entry, null, 2));
        return entry;
      }
    } catch (e) {
      console.error(`[hermes-bridge] Error reading inbox ${file}:`, e.message);
    }
  }
  return null;
}

/**
 * Write the result back to the outbox. Called from the Hermes cron job
 * after executing the prompt.
 */
export function completePrompt(id, result, error = null) {
  const inboxFile = join(INBOX_DIR, `${id}.json`);
  const outboxFile = join(OUTBOX_DIR, `${id}.json`);
  
  try {
    const entry = JSON.parse(readFileSync(inboxFile, 'utf8'));
    entry.status = error ? 'failed' : 'completed';
    entry.result = result;
    entry.error = error;
    entry.completedAt = Date.now();
    writeFileSync(outboxFile, JSON.stringify(entry, null, 2));
    // Remove from inbox
    unlinkSync(inboxFile);
    console.log(`[hermes-bridge] Completed prompt ${id}`);
  } catch (e) {
    console.error(`[hermes-bridge] Error completing prompt ${id}:`, e.message);
  }
}

export default { handleAgentPrompt, pollOutbox, pollInbox, completePrompt };
