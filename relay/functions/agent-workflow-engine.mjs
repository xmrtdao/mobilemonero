#!/usr/bin/env node
/**
 * agent-workflow-engine — local edge function
 * Wraps tools/agent-workflow-engine.mjs for relay function discovery
 */
import { runWorkflowEngine } from '../tools/agent-workflow-engine.mjs';

// Relay calls this when /tools/run/agent-workflow-engine is invoked
export async function handler(args = {}) {
  const result = await runWorkflowEngine();
  return {
    success: result.errors.length === 0,
    tasksAdvanced: result.tasksAdvanced,
    trustEvents: result.trustEvents,
    errors: result.errors,
    message: `Advanced ${result.tasksAdvanced} tasks, ${result.trustEvents} trust events${result.errors.length ? ', ' + result.errors.length + ' errors' : ''}`,
  };
}

// Direct execution
if (process.argv[1] && (process.argv[1].includes('agent-workflow-engine') || process.argv[1].includes('_local_shim'))) {
  handler({}).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.errors.length > 0 ? 1 : 0);
  });
}
