/**
 * agent-workflow-engine.mjs — Dynamic Task Advancement & TrustScore Integration
 *
 * Runs on a schedule (every 15 minutes via cron engine) to:
 *   1. Auto-advance stale tasks through pipeline stages
 *   2. Calculate trust score deltas from token usage
 *   3. Update app.cuttlefish_agents.trust_score
 *   4. Log trust events to app.cuttlefish_trust_events
 *   5. Track task complexity → trust delta mapping
 *
 * Trust Delta Formula per agent per cycle:
 *   base = (completed_tasks * 2) + (in_progress_tasks * 0.5)
 *   complexity_bonus = sum(task.priority * category_weight) / 10
 *   token_bonus = min(token_cost_usd * 10, 5)  // cap at +5 per cycle
 *   total_delta = base + complexity_bonus + token_bonus
 *
 * Score bounds: 0-100. Floor at 5. Cap at 100.
 * Violations subtract directly via trust events.
 */

const RELAY = 'http://localhost:8080';
const ENGINE_NAME = 'agent-workflow-engine';

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`[${ENGINE_NAME} ${ts}] ${msg}`);
}

// ── DID lookup: token_usage agent name → cuttlefish_agents DID ──
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

// ── Task assignee prefix → DID ──
const ASSIGNEE_DID_MAP = {
  'vex-001': 'did:xmrt:vex',
  'eliza-001': 'did:xmrt:eliza',
  'alice-001': 'did:xmrt:alice',
  'hermes-001': 'did:xmrt:hermes',
};

// ── Category → complexity weight ──
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

// ── Stage order for auto-advance ──
const STAGE_ORDER = ['PENDING', 'PLAN', 'EXECUTE', 'DISCUSS', 'INTEGRATE', 'VERIFY', 'COMPLETED'];
const TERMINAL_STAGES = ['COMPLETED', 'CANCELLED', 'BLOCKED'];

function toAgentName(did) {
  const rev = Object.entries(AGENT_DID_MAP).find(([, v]) => v === did);
  return rev ? rev[0] : did.split(':').pop();
}

export async function runWorkflowEngine() {
  log('Starting agent workflow cycle...');
  const results = { tasksAdvanced: 0, trustEvents: 0, errors: [] };
  
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5432/xmrt_suite' });
    
    // ── Phase 1: Auto-advance stale tasks ──
    try {
      const tasks = await pool.query(
        `SELECT id, title, stage, status, priority, category, assignee_agent_id, 
                stage_started_at, auto_advance_threshold_hours, progress_percentage
         FROM app.tasks 
         WHERE status = 'IN_PROGRESS' 
           AND stage != 'COMPLETED'
         ORDER BY priority DESC`
      );
      
      for (const task of tasks.rows) {
        const currentIdx = STAGE_ORDER.indexOf(task.stage);
        if (currentIdx === -1 || currentIdx >= STAGE_ORDER.length - 1) continue;
        
        const thresholdHrs = task.auto_advance_threshold_hours || 48;
        const elapsedHrs = task.stage_started_at 
          ? (Date.now() - new Date(task.stage_started_at).getTime()) / 3600000
          : 999;
        
        // Advance if past threshold OR progress >= 80
        if (elapsedHrs >= thresholdHrs || (task.progress_percentage || 0) >= 80) {
          const nextStage = STAGE_ORDER[currentIdx + 1];
          await pool.query(
            `UPDATE app.tasks SET stage = $1, stage_started_at = NOW(), updated_at = NOW(), progress_percentage = $2 WHERE id = $3`,
            [nextStage, nextStage === 'COMPLETED' ? 100 : Math.min((task.progress_percentage || 0) + 25, 90), task.id]
          );
          results.tasksAdvanced++;
          log(`  Advanced task ${task.id} "${(task.title||'').slice(0,30)}": ${task.stage} → ${nextStage}`);
          
          // If completed, create trust event for assigned agent
          if (nextStage === 'COMPLETED' && task.assignee_agent_id) {
            const did = ASSIGNEE_DID_MAP[task.assignee_agent_id] || null;
            if (did) {
              const complexity = CATEGORY_WEIGHT[task.category || 'default'] || 1.0;
              const priorityWeight = (task.priority || 1) / 5;
              const delta = Math.round((2 + complexity * priorityWeight) * 10) / 10;
              
              await pool.query(
                `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, reference, note)
                 VALUES ($1, $2, $3, (SELECT trust_score + $3 FROM app.cuttlefish_agents WHERE did = $1), $4, $5)`,
                [did, 'task_completed', delta, task.id, `Completed "${(task.title||'').slice(0,40)}" (priority=${task.priority}, category=${task.category||'default'})`]
              );
              await pool.query(
                `UPDATE app.cuttlefish_agents SET trust_score = GREATEST(5, LEAST(100, trust_score + $1)), trust_score_updated_at = NOW() WHERE did = $2`,
                [delta, did]
              );
              results.trustEvents++;
              log(`  Trust +${delta} for ${toAgentName(did)} (completed task ${task.id})`);
            }
          }
        }
      }
    } catch (e) {
      results.errors.push(`Phase 1 (auto-advance): ${e.message}`);
    }
    
    // ── Phase 2: Token usage → trust score deltas ──
    try {
      // Get token usage per agent in last 15 min
      const tokenUsage = await pool.query(
        `SELECT agent, SUM(input_tokens + output_tokens) as total_tokens, 
                SUM(COALESCE(estimated_cost_usd, 0)) as total_cost_usd
         FROM app.token_usage 
         WHERE logged_at > NOW() - INTERVAL '15 minutes'
           AND agent IS NOT NULL
         GROUP BY agent`
      );
      
      for (const row of tokenUsage.rows) {
        const agentKey = row.agent.toLowerCase().trim();
        const did = AGENT_DID_MAP[agentKey];
        if (!did) continue;
        
        const totalTokens = parseInt(row.total_tokens) || 0;
        const costUsd = parseFloat(row.total_cost_usd) || 0;
        
        if (totalTokens < 100) continue; // minimum activity threshold
        
        // Token bonus: cap at +3 per cycle
        const tokenBonus = Math.min(costUsd * 8, 3);
        // Activity bonus: small positive for any activity
        const activityDelta = Math.round((0.5 + tokenBonus) * 10) / 10;
        
        if (activityDelta > 0.1) {
          await pool.query(
            `INSERT INTO app.cuttlefish_trust_events (agent_did, event_type, delta, score_after, reference, note)
             VALUES ($1, $2, $3, (SELECT trust_score + $3 FROM app.cuttlefish_agents WHERE did = $1), $4, $5)`,
            [did, 'token_activity', activityDelta, `tokens:${totalTokens}`, `${totalTokens} tokens consumed ($${costUsd.toFixed(4)}) in last 15min`]
          );
          await pool.query(
            `UPDATE app.cuttlefish_agents SET trust_score = GREATEST(5, LEAST(100, trust_score + $1)), trust_score_updated_at = NOW() WHERE did = $2`,
            [activityDelta, did]
          );
          results.trustEvents++;
          log(`  Trust +${activityDelta} for ${toAgentName(did)} (${totalTokens} tokens, $${costUsd.toFixed(4)})`);
        }
      }
    } catch (e) {
      results.errors.push(`Phase 2 (token trust): ${e.message}`);
    }
    
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
