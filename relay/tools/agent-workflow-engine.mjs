/**
 * agent-workflow-engine.mjs — Artifact-Based Task Advancement & TrustScore Integration
 *
 * Runs on a schedule (every 15 minutes via cron engine) to:
 *   1. Advance tasks through pipeline stages ONLY when artifacts are provided
 *   2. Calculate trust score deltas from completed tasks with verified artifacts
 *   3. Update app.cuttlefish_agents.trust_score via cuttlefishclaws MCP (graduated scoring)
 *   4. Log trust events to app.cuttlefish_trust_events
 *
 * CRITICAL DESIGN RULE: Tasks advance by VERIFIED OUTPUT, not by elapsed time.
 * The VERIFY stage requires an artifact (screenshot, test result, commit hash, URL).
 * No artifact = no advancement. No token-based trust rewards.
 *
 * Trust Delta Formula per agent per cycle:
 *   base = (completed_tasks_with_artifacts * 3) + (in_progress_tasks * 0.5)
 *   complexity_bonus = sum(task.priority * category_weight) / 10
 *   NO token_bonus — token spend without output does not earn trust
 *
 * Score bounds: 0-100. Floor at 5. Cap at 100.
 * Violations subtract directly via trust events.
 *
 * NOTE: All trust events go through the cuttlefishclaws MCP (port 3120) which
 * applies graduated scoring (escalation ladder + self-correction bonus).
 * Direct INSERT bypasses the graduated system — always use the MCP.
 */

const RELAY = 'http://localhost:8080';
const ENGINE_NAME = 'agent-workflow-engine';

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`[${ENGINE_NAME} ${ts}] ${msg}`);
}

// ── DID lookup ──
const AGENT_DID_MAP = {
  vex: 'did:xmrt:vex',
  eliza: 'did:xmrt:eliza',
  'eliza-cloud': 'did:xmrt:eliza',
  alice: 'did:xmrt:alice',
  'alice-sidecar': 'did:xmrt:alice',
  hermes: 'did:xmrt:hermes',
  'hermes-agent': 'did:xmrt:hermes',
  trib: 'did:ethr:trib-v3',
};

const ASSIGNEE_DID_MAP = {
  'vex-001': 'did:xmrt:vex',
  'eliza-001': 'did:xmrt:eliza',
  'alice-001': 'did:xmrt:alice',
  'hermes-001': 'did:xmrt:hermes',
  vex: 'did:xmrt:vex',
  eliza: 'did:xmrt:eliza',
  alice: 'did:xmrt:alice',
  hermes: 'did:xmrt:hermes',
};

const CATEGORY_WEIGHT = {
  infrastructure: 3.0,
  security: 3.0,
  deployment: 2.5,
  integration: 2.0,
  development: 2.0,
  research: 1.5,
  content: 1.0,
  monitoring: 0.8,
  default: 1.0,
};

// ── Stage order ──
// Two stage systems coexist:
//   System A (advance_task tool): DISCUSS → PLANNING → EXECUTION → REVIEW → COMPLETION
//   System B (workflow engine):   PENDING → PLAN → EXECUTE → DISCUSS → INTEGRATE → VERIFY → COMPLETED
// The engine maps System A stages to System B for auto-advancement.
const STAGE_ORDER = ['PENDING', 'PLAN', 'EXECUTE', 'DISCUSS', 'INTEGRATE', 'VERIFY', 'COMPLETED'];
const TERMINAL_STAGES = ['COMPLETED', 'CANCELLED', 'BLOCKED', 'COMPLETION'];

// Map advance_task stage names to workflow engine stage names
const STAGE_ALIAS = {
  'PLANNING': 'PLAN',
  'EXECUTION': 'EXECUTE',
  'REVIEW': 'VERIFY',
  'COMPLETION': 'COMPLETED',
};

function toAgentName(did) {
  const rev = Object.entries(AGENT_DID_MAP).find(([, v]) => v === did);
  return rev ? rev[0] : did.split(':').pop();
}

// ── MCP helper for graduated scoring ──
async function writeTrustEventViaMcp(did, eventType, delta, reference, note) {
  const mcpRes = await fetch('http://127.0.0.1:3120/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'cuttlefishclaws_trust_event_write',
        arguments: { agent_did: did, event_type: eventType, delta, reference, note },
      },
      id: 1,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const mcpData = await mcpRes.json();
  const text = mcpData?.result?.content?.[0]?.text;
  if (!text) throw new Error('MCP returned no content');
  return JSON.parse(text);
}

export async function runWorkflowEngine() {
  log('Starting agent workflow cycle...');
  const results = { tasksAdvanced: 0, trustEvents: 0, errors: [] };
  
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite', max: 3 });
    
    // ── Phase 1: Advance tasks that have artifacts in VERIFY/REVIEW stage ──
    try {
      const tasksToComplete = await pool.query(
        `SELECT t.id, t.title, t.assignee_agent_id, t.priority, t.category
         FROM app.tasks t
         WHERE (t.stage = 'VERIFY' OR t.stage = 'REVIEW')
           AND t.status = 'IN_PROGRESS'
           AND t.id IN (
             SELECT DISTINCT task_id FROM app.task_artifacts
             WHERE task_id IS NOT NULL
           )`
      );
      
      for (const task of tasksToComplete.rows) {
        // Set to COMPLETED (engine's stage system) — advance_task's COMPLETION is also treated as terminal
        await pool.query(
          `UPDATE app.tasks SET stage = 'COMPLETED', status = 'COMPLETED', 
           stage_started_at = NOW(), updated_at = NOW(), progress_percentage = 100
           WHERE id = $1`,
          [task.id]
        );
        results.tasksAdvanced++;
        log(`  Completed task ${task.id} "${(task.title||'').slice(0,30)}" — artifact verified`);
        
        // Create trust event via MCP for graduated scoring
        if (task.assignee_agent_id) {
          const did = ASSIGNEE_DID_MAP[task.assignee_agent_id] || null;
          if (did) {
            const complexity = CATEGORY_WEIGHT[task.category || 'default'] || 1.0;
            const priorityWeight = (task.priority || 1) / 5;
            const delta = Math.round((3 + complexity * priorityWeight) * 10) / 10;
            
            try {
              const mcpResult = await writeTrustEventViaMcp(
                did, 'task_completed_with_artifact', delta, task.id,
                `Completed "${(task.title||'').slice(0,40)}" with verified artifact (priority=${task.priority}, category=${task.category||'default'})`
              );
              if (mcpResult.success) {
                results.trustEvents++;
                log(`  Trust +${delta} for ${toAgentName(did)} (task ${task.id}) — via MCP graduated scoring`);
              }
            } catch (e) {
              log(`  MCP call failed for ${did}, fallback direct: ${e.message}`);
              await pool.query(
                `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, reference, note)
                 VALUES ($1, $2, $3, (SELECT trust_score + $3 FROM app.cuttlefish_agents WHERE did = $1), $4, $5)`,
                [did, 'task_completed_with_artifact', delta, task.id,
                 `Completed "${(task.title||'').slice(0,40)}" with verified artifact (priority=${task.priority}, category=${task.category||'default'})`]
              );
              await pool.query(
                `UPDATE app.cuttlefish_agents SET trust_score = GREATEST(5, LEAST(100, trust_score + $1)), trust_score_updated_at = NOW() WHERE did = $2`,
                [delta, did]
              );
              results.trustEvents++;
              log(`  Trust +${delta} for ${toAgentName(did)} (task ${task.id}) — direct fallback`);
            }
          }
        }
      }
      
      // Also check for tasks that have been manually marked as having artifacts
      const tasksWithNewArtifacts = await pool.query(
        `SELECT DISTINCT ON (t.id) t.id, t.title, t.stage, t.assignee_agent_id, t.priority, t.category
         FROM app.tasks t
         JOIN app.task_artifacts a ON a.task_id = t.id
         WHERE t.status = 'IN_PROGRESS'
           AND t.stage NOT IN ('COMPLETED', 'VERIFY', 'REVIEW', 'COMPLETION')
           AND a.created_at > NOW() - INTERVAL '15 minutes'
         ORDER BY t.id`
      );
      
      for (const task of tasksWithNewArtifacts.rows) {
        // Map System A stage names to System B for index lookup
        const normalizedStage = STAGE_ALIAS[task.stage] || task.stage;
        const currentIdx = STAGE_ORDER.indexOf(normalizedStage);
        if (currentIdx === -1 || currentIdx >= STAGE_ORDER.length - 1) continue;
        const nextStage = STAGE_ORDER[currentIdx + 1];
        await pool.query(
          `UPDATE app.tasks SET stage = $1, stage_started_at = NOW(), updated_at = NOW(), progress_percentage = $2 WHERE id = $3`,
          [nextStage, Math.min((STAGE_ORDER.indexOf(nextStage) + 1) * 14, 90), task.id]
        );
        results.tasksAdvanced++;
        log(`  Advanced task ${task.id} "${(task.title||'').slice(0,30)}": ${task.stage} -> ${nextStage} (new artifact)`);
      }
      
    } catch (e) {
      results.errors.push(`Phase 1 (artifact advancement): ${e.message}`);
    }
    
    // ── Phase 2: NO token-based trust rewards ──
    log('Phase 2 (token trust) — DISABLED. Trust earned only through verified artifacts.');
    
    // ── Phase 3: Recalculate trust bands ──
    try {
      await pool.query(`
        UPDATE app.cuttlefish_agents 
        SET trust_band = CASE
          WHEN trust_score >= 80 THEN 'Trusted'
          WHEN trust_score >= 50 THEN 'Standard'
          WHEN trust_score >= 30 THEN 'Monitored'
          WHEN trust_score >= 15 THEN 'Cautious'
          ELSE 'SUSPENDED'
        END,
        trust_score_updated_at = NOW()
        WHERE trust_score_updated_at IS NULL OR trust_score_updated_at < NOW() - INTERVAL '1 minute'
      `);
    } catch (e) {
      results.errors.push(`Phase 3 (trust bands): ${e.message}`);
    }
    
    await pool.end();
  } catch (e) {
    results.errors.push(`Fatal: ${e.message}`);
  }
  
  log(`Cycle complete: ${results.tasksAdvanced} tasks advanced, ${results.trustEvents} trust events, ${results.errors.length} errors`);
  return results;
}

// Run as standalone script
if (process.argv[1] && process.argv[1].includes('agent-workflow-engine')) {
  runWorkflowEngine().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.errors.length > 0 ? 1 : 0);
  });
}
