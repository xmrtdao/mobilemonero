import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay', 'relay-data');
mkdirSync(DATA_DIR, { recursive: true });

const RELAY_URL = 'http://localhost:8080';

async function main() {
  try {
    // Fetch recent fleet chat messages
    const msgsRes = await fetch(`${RELAY_URL}/api/fleet-chat/messages?limit=50`, {
      signal: AbortSignal.timeout(10000)
    });
    const data = await msgsRes.json().catch(() => ({ messages: [] }));
    const msgs = (data.messages || []).slice(-30);

    if (msgs.length === 0) {
      console.log('[trustgraph-scanner] no fleet messages to scan');
      process.exit(0);
    }

    const violations = [];
    const agents = new Set();

    for (const m of msgs) {
      const text = m.message || m.text || '';
      const agent = m.agentLabel || m.agent || 'unknown';
      agents.add(agent);

      // Check for reasoning leakage patterns
      const reasoningPatterns = [
        /\bI need to\b/i, /\bI don't have a tool\b/i,
        /\bI could use\b/i, /\bI can use\b/i,
        /\bI will call\b/i, /\bI'll call\b/i,
        /\bLet me\s+\w+\b/i, /\bI should\s+\w+\b/i,
        /\bI think\s+\w+\b/i, /\bI will\s+\w+\b/i
      ];
      for (const p of reasoningPatterns) {
        if (p.test(text)) {
          violations.push({
            agent,
            messageId: m.id,
            type: 'reasoning_leakage',
            pattern: p.toString(),
            text: text.slice(0, 80),
            ts: m.time || m.ts
          });
          break;
        }
      }

      // Check for tool call JSON exposure
      if (/TOOL_CALL:\s*\{/.test(text)) {
        violations.push({
          agent,
          messageId: m.id,
          type: 'tool_call_exposure',
          text: text.slice(0, 80),
          ts: m.time || m.ts
        });
      }

      // Check for security claims without evidence
      const securityKeywords = ['key rotated', 'script purged', 'creds revoked', 'password exposed', 'api key', 'token rotated'];
      for (const kw of securityKeywords) {
        if (text.toLowerCase().includes(kw)) {
          violations.push({
            agent,
            messageId: m.id,
            type: 'security_claim',
            keyword: kw,
            text: text.slice(0, 80),
            ts: m.time || m.ts
          });
          break;
        }
      }
    }

    // Write scan results
    const scanFile = join(DATA_DIR, 'trustgraph-scan.json');
    const scanResult = {
      timestamp: new Date().toISOString(),
      messagesScanned: msgs.length,
      agentsActive: Array.from(agents),
      violationsFound: violations.length,
      violations: violations.slice(0, 10) // Keep last 10
    };
    try {
      writeFileSync(scanFile, JSON.stringify(scanResult, null, 2));
      console.log(`[trustgraph-scanner] wrote ${violations.length} violations to ${scanFile}`);
    } catch (e) {
      console.error(`[trustgraph-scanner] write failed: ${e.message}`);
    }

    // Log to activity log via relay
    try {
      await fetch(`${RELAY_URL}/api/activity-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_type: 'trustgraph_scan',
          title: 'trustgraph-violation-scanner',
          description: `Scanned ${msgs.length} messages, ${violations.length} violations from ${agents.size} agents`,
          status: violations.length > 0 ? 'warning' : 'ok',
          metadata: { violations: violations.length, agents: agents.size }
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch {}

    if (violations.length > 0) {
      console.log(`[trustgraph-scanner] ${violations.length} violations found across ${agents.size} agents`);
      for (const v of violations.slice(0, 3)) {
        console.log(`  ${v.type}: ${v.agent} — ${v.text}`);
      }
    } else {
      console.log(`[trustgraph-scanner] clean scan — ${msgs.length} messages, 0 violations`);
    }

    // NOTE: do NOT call process.exit() here. On Windows, calling process.exit()
    // while an AbortSignal.timeout() timer is still pending triggers a libuv
    // assertion crash (UV_HANDLE_CLOSING) that the cron engine logs as a FAIL.
    // Let the process exit naturally once the abort timers drain.
  } catch (e) {
    console.error(`[trustgraph-scanner] FAIL: ${e.message}`);
    process.exit(1);
  }
}

main();
