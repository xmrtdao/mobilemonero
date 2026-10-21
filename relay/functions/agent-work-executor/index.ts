import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";
import { startUsageTrackingWithRequest } from "../../../suite/supabase/functions/_shared/functionUsageLogger.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOpencodeLock } from "../../lib/opencode-lock.mjs";

// The repository root, from this file's own location: relay/functions/
// agent-work-executor/ is three levels down.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The relay's address, used to point the completion artifact at a URL that
// resolves to the work log. The guard on task completion demands an artifact
// with a non-empty artifact_url, and a URL that resolves to nothing would be
// the same as no evidence at all — so this has to be a real, reachable
// address for the task record.
const RELAY_BASE_URL = (() => {
  try { return Deno.env.get('RELAY_PUBLIC_URL') || 'https://relay.mobilemonero.com'; }
  catch { return 'https://relay.mobilemonero.com'; }
})();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Agent Work Executor
 * Makes agents actually DO work on their assigned tasks by:
 * 1. Finding tasks with pending checklist items
 * 2. Determining which tools/functions can accomplish each item  
 * 3. Executing work using appropriate edge functions
 * 4. Documenting progress via checklist completion
 * 5. Logging all work to activity log
 * 
 * This is the COO's primary tool for ensuring agents produce documented work.
 */

interface Task {
  id: string;
  title: string;
  description: string;
  stage: string;
  status: string;
  category: string;
  assignee_agent_id: string | null;
  progress_percentage: number;
  metadata: any;
  completed_checklist_items: string[];
}

interface Agent {
  id: string;
  name: string;
  status: string;
  current_workload: number;
  skills: any;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Fix: Correct argument order is (functionName, req, body, executiveName)
  // We pass empty body {} initially to avoid crash, as body is parsed later
  const tracker = startUsageTrackingWithRequest('agent-work-executor', req, {}, 'COO');

  try {
    const body = await req.json().catch(() => ({}));
    const { action = 'execute_pending_work', task_id, agent_id, max_tasks = 5 } = body;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("❌ CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
      console.error("   Please run: supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...");
      tracker.failure("Missing Supabase Credentials");
      return new Response(
        JSON.stringify({ error: "Configuration Error: Missing Supabase Credentials" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // AI tiers: OpenCode Zen -> OpenRouter -> Ollama Cloud (all OpenAI-compatible).
    // GEMINI/DEEPSEEK keys are no longer read anywhere in this function.
    const aiKeys = {
      opencode: Deno.env.get("OPENCODE_API_KEY"),
      openrouter: Deno.env.get("OPENROUTER_API_KEY"),
      ollama: Deno.env.get("OLLAMA_API_KEY") || Deno.env.get("OLLAMA_XMRT_API_KEY"),
    };
    if (!aiKeys.opencode && !aiKeys.openrouter && !aiKeys.ollama) {
      console.error("❌ CRITICAL WARNING: No AI provider key found (OPENCODE/OPENROUTER/OLLAMA). Agent intelligence will be disabled.");
      // We don't exit here because simple tasks might still work, but we log strictly.
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    console.log(`⚙️ Agent Work Executor: Action = ${action}`);

    switch (action) {
      case 'execute_pending_work': {
        // Find tasks with incomplete checklists assigned to agents.
        //
        // The progress filter used to be `.lt('progress_percentage', 100)`, and
        // in SQL a NULL comparison is never true, so every task with a NULL
        // progress was invisible to the worker forever. That was six of the ten
        // live tasks — including all five GitHub-imported ones, which arrive
        // with no progress at all. They looked assigned and did nothing, which
        // is exactly the "assigned but idle" state the task board was showing.
        //
        // So: a task with no progress recorded counts as not started.
        //
        // There is deliberately no progress filter beyond that. A task at 100%
        // still needs to be picked up, because the only thing that moves a
        // finished task off the board is this executor's own completion branch,
        // and a task the executor cannot see is a task that never leaves.
        let query = supabase
          .from('tasks')
          .select('*')
          .not('assignee_agent_id', 'is', null)
          .in('status', ['CLAIMED', 'IN_PROGRESS', 'REVIEW'])
          // A task an operator has held is not this executor's to touch. The
          // query never looked at blocking_reason, so a task parked for a
          // decision - "awaiting operator decision" - was worked anyway, which
          // is the opposite of what a hold means.
          .is('blocking_reason', null)
          .order('priority', { ascending: false })
          .limit(max_tasks);

        if (task_id) {
          query = query.eq('id', task_id);
        }

        const { data: tasks, error: tasksError } = await query;

        if (tasksError) throw tasksError;

        if (!tasks || tasks.length === 0) {
          tracker.success();
          return new Response(
            JSON.stringify({ success: true, message: 'No pending work found', tasksProcessed: 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        console.log(`⚙️ Found ${tasks.length} tasks needing work`);

        const results = [];

        for (const task of tasks) {
          const result = await processTaskWork(supabase, task);
          results.push(result);
        }

        tracker.success();
        return new Response(
          JSON.stringify({
            success: true,
            tasksProcessed: results.length,
            results
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case 'process_single_task': {
        if (!task_id) {
          return new Response(
            JSON.stringify({ error: 'task_id required for process_single_task' }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data: task, error: taskError } = await supabase
          .from('tasks')
          .select('*')
          .eq('id', task_id)
          .single();

        if (taskError || !task) {
          throw new Error(`Task not found: ${task_id}`);
        }

        const result = await processTaskWork(supabase, task);
        tracker.success();
        return new Response(
          JSON.stringify({ success: true, result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case 'get_pending_work': {
        // Return tasks that need work without executing
        const { data: tasks, error } = await supabase
          .from('tasks')
          .select('id, title, stage, status, progress_percentage, assignee_agent_id, metadata')
          .not('assignee_agent_id', 'is', null)
          .in('status', ['CLAIMED', 'IN_PROGRESS'])
          .lt('progress_percentage', 100)
          .order('priority', { ascending: false })
          .limit(20);

        if (error) throw error;

        const pending = (tasks || []).map((t: any) => ({
          id: t.id,
          title: t.title,
          stage: t.stage,
          status: t.status,
          progress: t.progress_percentage,
          agent_id: t.assignee_agent_id,
          checklist: t.metadata?.checklist || [],
          completed: t.metadata?.completed_checklist_items || []
        }));

        tracker.success();
        return new Response(
          JSON.stringify({ success: true, pending_tasks: pending }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

  } catch (error) {
    console.error("⚙️ Agent Work Executor Error:", error);
    tracker.failure(error instanceof Error ? error.message : String(error));
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function processTaskWork(supabase: any, task: Task): Promise<any> {
  // Normalise the two lists before touching them.
  //
  // `completed_checklist_items` arrives as an ARRAY on tasks this executor has
  // worked on, but as an empty OBJECT ({}) on tasks imported from GitHub, and
  // `metadata.checklist` is missing on tasks whose metadata was overwritten.
  // `completed.includes(item)` on an object throws, so a single malformed row
  // would abort the whole batch — and a missing checklist used to make the
  // executor regenerate one on every single pass.
  const asArray = (v: any): string[] => {
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string');
    if (v && typeof v === 'object') {
      // An object keyed by item is the other shape seen in the wild.
      return Object.keys(v).filter(k => v[k]);
    }
    return [];
  };
  const checklist = asArray(task.metadata?.checklist);
  const completed = asArray(task.completed_checklist_items);

  console.log(`⚙️ Processing task ${task.id}: ${task.title}`);
  console.log(`   Checklist: ${checklist.length} items, ${completed.length} completed`);

  // ── A HELD TASK IS NOT THIS EXECUTOR'S TO TOUCH ──
  //
  // The batch query filters these out, but process_single_task does not go
  // through that query, so the check has to be here as well: an operator's hold
  // means the work does not happen, on any path into this function.
  if (task.blocking_reason) {
    console.log(`   Task is held: "${task.blocking_reason}" - leaving it alone`);
    return {
      task_id: task.id,
      status: 'skipped',
      reason: `awaiting_operator: ${task.blocking_reason}`,
    };
  }

  // ── REVIEW is not automatically the executor's to close ──
  //
  // A task in REVIEW has been parked for a reason, and there are two different
  // reasons in play:
  //
  //   'missing_artifact' — the work is done and the only thing missing is the
  //     evidence. That is exactly what this executor can now supply, so these
  //     are picked up and finished.
  //
  //   'checklist_complete_awaiting_confirmation' — the work is done and it is
  //     waiting for a HUMAN to confirm it. That gate is deliberate and it
  //     belongs to a person. The executor does not touch those tasks, and
  //     neither does anything else here.
  //
  // Getting this backwards would be the worst possible mistake: an agent
  // marking its own homework as confirmed.
  if (task.status === 'REVIEW') {
    const reason = (task.metadata || {})?.terminal_reason || null;
    if (reason !== 'missing_artifact') {
      console.log(`   ⏸ Task is parked in REVIEW for "${reason || 'an unspecified reason'}" — leaving it for a human`);
      return {
        task_id: task.id,
        status: 'skipped',
        reason: `awaiting_human_confirmation (${reason || 'no reason recorded'})`,
      };
    }
    console.log(`   🔧 Task is parked for missing evidence — this executor can supply it`);
  }

  // If no checklist, we can't do documented work
  // ── IS THIS STILL WORK? ──
  //
  // The executor used to take whatever was assigned and work it, because
  // "assigned" was the only test it applied. So a task whose problem had
  // already been fixed by something else, a task another task had taken over,
  // and a task that was really a duplicate of a third one all got executed -
  // and every one of them produced a completion that looked identical to real
  // work. The board looked busy and the work was hollow.
  //
  // The question cannot be answered from inside the task's own row. It is
  // answered against the state of the whole board, so the pre-flight is given
  // the other open tasks and asked one question with four answers.
  //
  // The asymmetry is deliberate: anything unclear is NEEDED. Doing a task that
  // did not need doing costs a little time; dropping a task that did costs a
  // real piece of work, and it is invisible.
  const preflight = await preflightTask(supabase, task, checklist);
  console.log(`   Pre-flight: ${preflight.verdict}${preflight.reason ? ` - ${preflight.reason}` : ''}`);

  if (preflight.verdict === 'ALREADY_DONE' && preflight.proof_url) {
    // The proof has to RESOLVE.
    //
    // Asking a model for a URL and believing the answer is how you get a
    // completion with an invented address on it. In a live test the model
    // answered ALREADY_DONE with "https://example.com/pfp-booking-tables-state"
    // for a task whose only work had been a knowledge search that returned
    // nothing - a URL that does not exist. A URL is evidence only if fetching
    // it gets something back.
    const proof = await verifyEvidenceUrl(preflight.proof_url);
    if (!proof.ok) {
      console.log(`   Pre-flight proof does not resolve (${proof.status || 'no response'}) - treating the task as still needing work`);
      await supabase
        .from('tasks')
        .update({
          metadata: {
            ...(task.metadata || {}),
            preflight_at: new Date().toISOString(),
            preflight_verdict: 'ALREADY_DONE_REJECTED',
            preflight_detail: `the offered proof did not resolve (${proof.status || 'no response'}): ${preflight.proof_url}`,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);
    } else {
      // The work is finished and something shows it. That is a fact about the
      // world, not a claim by the agent, so it closes the task - with the proof
      // attached and the reason recorded.
      await supabase.from('task_artifacts').insert({
        task_id: task.id,
        artifact_type: 'already-done',
        artifact_url: preflight.proof_url,
        description: `Closed without work: ${preflight.reason}`,
        created_at: new Date().toISOString(),
      });
      const { error: doneErr } = await supabase
        .from('tasks')
        .update({
          status: 'DONE',
          closed_reason: 'already_done',
          progress_percentage: 100,
          metadata: {
            ...(task.metadata || {}),
            closed_at: new Date().toISOString(),
            closed_by: 'agent-work-executor',
            closed_detail: preflight.reason,
            proof_url: preflight.proof_url,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);
      if (doneErr) {
        console.log(`   Could not close as already done: ${doneErr.message}`);
        return { task_id: task.id, status: 'work_failed', reason: 'close_already_done_failed', error: doneErr.message };
      }
      return { task_id: task.id, status: 'closed_already_done', reason: preflight.reason, proof_url: preflight.proof_url };
    }
  }

  if (preflight.verdict === 'SUPERSEDED' && preflight.superseded_by) {
    // Another task took this over. The survivor is named, because a task that
    // says "superseded" without saying by what is a claim - and the database
    // refuses it (tasks_superseded_needs_survivor).
    const { error: supErr } = await supabase
      .from('tasks')
      .update({
        status: 'CANCELLED',
        closed_reason: 'superseded',
        superseded_by: preflight.superseded_by,
        metadata: {
          ...(task.metadata || {}),
          closed_at: new Date().toISOString(),
          closed_by: 'agent-work-executor',
          closed_detail: preflight.reason,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);
    if (supErr) {
      console.log(`   Could not close as superseded: ${supErr.message}`);
      return { task_id: task.id, status: 'work_failed', reason: 'close_superseded_failed', error: supErr.message };
    }
    return {
      task_id: task.id,
      status: 'closed_superseded',
      reason: preflight.reason,
      superseded_by: preflight.superseded_by,
    };
  }

  if (preflight.verdict === 'CANNOT_PROCEED') {
    // Record why, and leave the task where it is. It is not done, and it will
    // not be done by pretending it was.
    await supabase
      .from('tasks')
      .update({
        metadata: {
          ...(task.metadata || {}),
          preflight_at: new Date().toISOString(),
          preflight_verdict: 'CANNOT_PROCEED',
          preflight_detail: preflight.reason,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);
    return {
      task_id: task.id,
      status: 'skipped',
      reason: `cannot_proceed: ${preflight.reason || 'no reason given'}`,
    };
  }

  // If no checklist, generate one automatically
  if (checklist.length === 0) {
    if (completed.length > 0) {
      // The checklist was lost but the record of what was done survived. The
      // completed items ARE the only statement of scope this task has, so they
      // become the checklist.
      //
      // Generating a fresh checklist here instead would be actively wrong: the
      // new items would not match the completed ones, the task would redo work
      // it had already done, and progress would be recomputed against a
      // denominator that had just been invented — which is how a task at 100%
      // ended up reporting 13%.
      console.log(`   ⚠️ No checklist on the task; using its ${completed.length} completed item(s) as the list`);
      checklist.push(...completed);
      await supabase
        .from('tasks')
        .update({
          metadata: {
            ...(task.metadata || {}),
            checklist,
            checklist_recovered_from: 'completed_checklist_items',
          },
        })
        .eq('id', task.id);
    } else {
      console.log(`   ⚠️ Task has no checklist - generating one automatically...`);
      const generatedChecklist = await generateChecklist(task);

      if (generatedChecklist.length > 0) {
        // Save the generated checklist
        await supabase
          .from('tasks')
          .update({
            metadata: {
              ...task.metadata,
              checklist: generatedChecklist
            }
          })
          .eq('id', task.id);

        console.log(`   ✅ Generated ${generatedChecklist.length} checklist items`);
        checklist.push(...generatedChecklist);
      } else {
        // Fallback if generation fails
        console.log(`   ❌ Failed to generate checklist`);
        return {
          task_id: task.id,
          status: 'skipped',
          reason: 'no_checklist_and_generation_failed'
        };
      }
    }
  }

  // Find next uncompleted checklist item
  const pendingItems = checklist.filter((item: string) => !completed.includes(item));

  if (pendingItems.length === 0) {
    // ── THE TASK IS FINISHED ──
    //
    // This branch used to RETURN a status and change nothing at all. The task
    // kept its status, its progress and its place on the board, so the
    // selection query picked it up again on the next pass, found every item
    // already complete, returned 'completed' again, and did it forever. That
    // is the whole "engine revving in neutral" symptom: work reported as done,
    // no task ever leaving the board, and the fleet's completion count pinned
    // at zero.
    //
    // A task whose work is finished has to LEAVE the board — but it cannot just
    // be marked DONE. The database refuses that without evidence:
    //
    //   task <id> cannot take status DONE without an artifact carrying a
    //   non-empty artifact_url
    //
    // (app.enforce_task_completion_status_evidence). That guard is good and it
    // stays: a task should not be able to claim completion on the strength of
    // someone's say-so. It was unmeetable because nothing in the fleet wrote
    // an artifact with a URL — every row in task_artifacts had an empty one —
    // so the whole board had been unable to record a completion since the
    // guard was added. 488 tasks went to CANCELLED instead.
    //
    // So the executor records the evidence it actually produced: the task's own
    // work log, at a URL that resolves to the record of that work. Then the
    // status change is a fact rather than a claim, and the guard has something
    // real to check.
    const workLog = Array.isArray((task.metadata || {})?.work_log) ? (task.metadata as any).work_log : [];
    const selfUrl = `${RELAY_BASE_URL}/api/suite/tasks/${task.id}`;

    // The evidence has to point at the WORK, not at the task.
    //
    // The task's own record is not evidence of anything: it is the page the
    // work would be described on, so pointing at it says "this task exists"
    // and nothing more. The database refuses to count it now
    // (app.artifact_is_self_referential), which leaves one way to finish -
    // name the thing that was actually changed: a pull request, a file, a
    // deployed endpoint, a commit.
    const deliverable = findDeliverable(workLog, task.id);
    if (!deliverable) {
      // Nothing was produced that points at the work. Record the trail
      // honestly and send the task to REVIEW: the work is not proven, and a
      // board that says otherwise is the thing this change exists to stop.
      await supabase.from('task_artifacts').insert({
        task_id: task.id,
        artifact_type: 'work-log',
        artifact_url: selfUrl,
        description: `Executor work log: ${completed.length} checklist item(s) completed, ${workLog.length} work record(s). `
          + 'No deliverable URL was produced, so this does not count as evidence.',
        created_at: new Date().toISOString(),
      });
      await supabase
        .from('tasks')
        .update({
          status: 'REVIEW',
          metadata: {
            ...(task.metadata || {}),
            terminal_reason: 'no_deliverable_evidence',
            work_log: workLog,
            completed_checklist_items: completed,
            last_work_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);
      return {
        task_id: task.id,
        status: 'needs_review',
        reason: 'no_deliverable_evidence',
        summary: `All ${completed.length} checklist items were completed, but no work produced a URL that points at the work itself. `
          + 'The task is parked for a human rather than marked done.',
      };
    }

    // And the deliverable has to resolve. A URL that 404s is a guess, not a
    // thing that exists, and a completion whose evidence cannot be fetched is
    // a claim.
    const verified = await verifyEvidenceUrl(deliverable);
    if (!verified.ok) {
      await supabase.from('task_artifacts').insert({
        task_id: task.id,
        artifact_type: 'work-log',
        artifact_url: selfUrl,
        description: `Executor work log: ${completed.length} checklist item(s) completed, ${workLog.length} work record(s). `
          + `The offered deliverable (${deliverable}) did not resolve (${verified.status || 'no response'}), so it does not count as evidence.`,
        created_at: new Date().toISOString(),
      });
      await supabase
        .from('tasks')
        .update({
          status: 'REVIEW',
          metadata: {
            ...(task.metadata || {}),
            terminal_reason: 'evidence_url_unresolved',
            work_log: workLog,
            completed_checklist_items: completed,
            unverified_deliverable: deliverable,
            last_work_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);
      return {
        task_id: task.id,
        status: 'needs_review',
        reason: 'evidence_url_unresolved',
        summary: `The work named ${deliverable} as its deliverable, but that URL did not resolve `
          + `(${verified.status || 'no response'}). The task is parked for a human rather than marked done.`,
      };
    }

    const evidenceUrl = deliverable;

    const { error: artError } = await supabase
      .from('task_artifacts')
      .insert({
        task_id: task.id,
        artifact_type: 'work-log',
        artifact_url: evidenceUrl,
        description: `Executor work log: ${completed.length} checklist item(s) completed, ${workLog.length} work record(s).`,
        created_at: new Date().toISOString(),
      });

    if (artError) {
      console.log(`   ⚠️ Could not record the completion evidence: ${artError.message}`);
      return {
        task_id: task.id,
        status: 'work_failed',
        reason: 'evidence_not_recorded',
        error: artError.message,
      };
    }
    console.log(`   📎 Evidence recorded: ${evidenceUrl}`);

    // Now the status change will be accepted.
    const { error: doneError } = await supabase
      .from('tasks')
      .update({
        status: 'DONE',
        progress_percentage: 100,
        completed_checklist_items: completed,
        metadata: {
          ...(task.metadata || {}),
          checklist,
          work_log: workLog,
          completed_at: new Date().toISOString(),
          completed_by: 'agent-work-executor',
          evidence_url: evidenceUrl,
        },
      })
      .eq('id', task.id);

    if (doneError) {
      console.log(`   ⚠️ Could not mark task DONE: ${doneError.message}`);
      return {
        task_id: task.id,
        status: 'work_failed',
        reason: 'all_items_done_but_update_failed',
        error: doneError.message,
      };
    }

    console.log(`   ✅ All checklist items completed — task marked DONE`);

    await supabase.from('eliza_activity_log').insert({
      activity_type: 'agent_work',
      description: `Task completed: "${task.title}"`,
      metadata: {
        task_id: task.id,
        agent_id: task.assignee_agent_id,
        items_completed: completed.length,
        evidence_url: evidenceUrl,
      },
    });

    return {
      task_id: task.id,
      status: 'work_done',
      reason: 'all_items_done',
      new_progress: 100,
      summary: `All ${completed.length} checklist items were completed; task marked DONE with evidence at ${evidenceUrl}.`,
    };
  }

  const nextItem = pendingItems[0];
  console.log(`   🎯 Next item: "${nextItem}"`);

  // Determine which tool/function to use based on item content
  const workResult = await executeChecklistItem(supabase, task, nextItem);

  if (workResult.success) {
    // Mark the checklist item as completed
    const newCompleted = [...completed, nextItem];
    // Clamped, because a checklist that was regenerated with a different length
    // than the completed list used to produce progress values like 125% — a
    // number that reads as "more than finished" and that no honest summary
    // should ever report.
    const newProgress = Math.min(100, Math.round((newCompleted.length / checklist.length) * 100));

    // Merge into the CURRENT metadata, not the snapshot read at the top of the
    // pass. The snapshot predates the checklist this function may have just
    // generated, so spreading it wrote back a metadata object with no
    // checklist in it — which is why the checklist was regenerated on every
    // pass, and why the denominator (and therefore the progress) kept moving.
    //
    // The work log accumulates here. `last_work_result` only ever held the
    // most recent item, so a task that completed five items carried evidence
    // of one — and the completion artifact pointed at that one. A log of every
    // item is what makes the evidence worth pointing at.
    const priorLog = Array.isArray((task.metadata || {})?.work_log) ? (task.metadata as any).work_log : [];
    const workLog = [
      ...priorLog,
      { item: nextItem, at: new Date().toISOString(), summary: workResult.summary ? String(workResult.summary) : `No summary provided for item: "${nextItem}"` },
    ];

    const mergedMetadata = {
      ...(task.metadata || {}),
      checklist,
      work_log: workLog,
      last_work_at: new Date().toISOString(),
      last_work_item: nextItem,
      last_work_result: workResult.summary ? String(workResult.summary) : `No summary provided for item: "${nextItem}"`
    };

    await supabase
      .from('tasks')
      .update({
        completed_checklist_items: newCompleted,
        progress_percentage: newProgress,
        metadata: mergedMetadata,
      })
      .eq('id', task.id);

    // One artifact per completed work item.
    //
    // The metadata copy of the work log is not enough on its own: task-auto-
    // advance writes the same metadata column from its own snapshot, so the two
    // writers can overwrite each other's additions. The artifact table is
    // insert-only, so the trail of what was actually done survives whatever
    // happens to the task row afterwards — which is what makes the evidence
    // the completion guard asks for worth anything.
    //
    // The URL is the DELIVERABLE when there is one — the file the worker
    // wrote, or an address it quoted. The task's own page is only a fallback,
    // and the completion guard does not count it: pointing at yourself is not
    // evidence of anything.
    const itemSummary = workResult.summary ? String(workResult.summary) : '';
    const evidenceForItem = workResult.deliverable || `${RELAY_BASE_URL}/api/suite/tasks/${task.id}`;
    await supabase
      .from('task_artifacts')
      .insert({
        task_id: task.id,
        artifact_type: workResult.deliverable ? 'work-item' : 'work-note',
        artifact_url: evidenceForItem,
        description: `${nextItem} — ${itemSummary.slice(0, 600)}`,
        created_at: new Date().toISOString(),
      });

    // Log to activity
    await supabase.from('eliza_activity_log').insert({
      activity_type: 'agent_work',
      description: `Completed: "${nextItem}" for task "${task.title}"`,
      metadata: {
        task_id: task.id,
        agent_id: task.assignee_agent_id,
        checklist_item: nextItem,
        new_progress: newProgress,
        work_result: workResult.summary
      }
    });

    console.log(`   ✅ Item completed, progress now ${newProgress}%`);

    return {
      task_id: task.id,
      status: 'work_done',
      item_completed: nextItem,
      new_progress: newProgress,
      summary: workResult.summary
    };
  } else {
    console.log(`   ❌ Failed to complete item: ${workResult.error}`);
    return {
      task_id: task.id,
      status: 'work_failed',
      item_attempted: nextItem,
      error: workResult.error
    };
  }
}

/**
 * Is this task still work?
 *
 * The question is asked against the state of the whole board, because the two
 * most common reasons a task should NOT be worked - "this was solved by
 * something else" and "another task took this over" - are both invisible from
 * inside the task's own row.
 *
 * The answer is deliberately asymmetric. NEEDED is the default: a task that did
 * not need doing costs one pass of the executor, while a task that DID need
 * doing and was quietly dropped is a piece of work nobody will ever notice
 * missing.
 */
async function preflightTask(
  supabase: any,
  task: Task,
  checklist: string[]
): Promise<{ verdict: string; reason: string; proof_url?: string; superseded_by?: string }> {
  const fallback = { verdict: 'NEEDED', reason: 'no preflight answer' };

  let related: any[] = [];
  try {
    const { data: others } = await supabase
      .from('tasks')
      .select('id, title, stage, status, created_at, assignee_agent_id')
      .in('status', ['PENDING', 'CLAIMED', 'IN_PROGRESS', 'REVIEW', 'BLOCKED'])
      .limit(150);

    // Titles that share their distinctive words are the ones worth showing.
    // An agent asked about a duplicate cannot spot a duplicate it was never
    // shown, so the board is read in full and the near-misses are named.
    const stop = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'not', 'but', 'are', 'was',
      'has', 'have', 'into', 'your', 'you', 'its', 'our', 'use', 'using', 'new', 'make',
      'made', 'add', 'added', 'fix', 'fixed', 'update', 'updated', 'implement',
      'implemented', 'create', 'created', 'review', 'reviewed', 'plan', 'planning',
      'analyze', 'analyse', 'requirements', 'requirement', 'implementation', 'solution',
      'pr', 'merge', 'work', 'working', 'ensure', 'verifying', 'validate', 'testing',
      'test', 'run', 'remove', 'check', 'checks', 'need', 'needs', 'across', 'every',
    ]);
    const wordsOf = (t: any) => new Set(
      String(t || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w: string) => w.length > 2 && !stop.has(w))
    );
    const mine = wordsOf(task.title);
    related = (others || [])
      .filter((o: any) => o.id !== task.id)
      .map((o: any) => ({ ...o, overlap: [...wordsOf(o.title)].filter((w: string) => mine.has(w)).length }))
      .filter((o: any) => o.overlap >= 2)
      .sort((a: any, b: any) => b.overlap - a.overlap)
      .slice(0, 6);
  } catch (e) {
    console.warn('   Pre-flight could not read the board:', (e as Error).message);
  }

  const workLog = Array.isArray((task.metadata || {})?.work_log) ? (task.metadata as any).work_log : [];

  const prompt = `
You are deciding whether a task still needs doing, BEFORE anyone spends time on it.

TASK: ${task.title}
DESCRIPTION: ${String(task.description || '').slice(0, 1000)}
STAGE: ${task.stage}   STATUS: ${task.status}
CHECKLIST: ${checklist.slice(0, 8).join(' | ') || '(none yet)'}
WORK ALREADY DONE ON THIS TASK: ${workLog.length ? workLog.map((w: any) => w.item).join(' | ') : '(none)'}

OTHER OPEN TASKS ON THE BOARD:
${related.length
  ? related.map((o: any) => `- ${o.id} | ${o.title} | ${o.stage}/${o.status} | created ${o.created_at}`).join('\n')
  : '(none with a similar title)'}

Answer with ONLY this JSON:
{
  "verdict": "NEEDED" | "ALREADY_DONE" | "SUPERSEDED" | "CANNOT_PROCEED",
  "reason": "one sentence",
  "proof_url": "for ALREADY_DONE: a URL that shows the finished work. NOT this task's own page.",
  "superseded_by": "for SUPERSEDED: the id of the task that took this over"
}

Rules:
- Use NEEDED unless you are certain the work should not be done.
- ALREADY_DONE needs a proof_url pointing at the finished work, not at this task's own record.
- SUPERSEDED needs the id of the other task, and only when it clearly covers the same ground.
- CANNOT_PROCEED is for work that cannot be started at all: no access, no capability, waiting on a person.
`;

  try {
    const raw = await callAI(prompt);
    if (!raw || raw.startsWith('AI analysis unavailable')) return fallback;
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    let decision: any;
    try {
      decision = JSON.parse(clean);
    } catch {
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start < 0 || end <= start) return fallback;
      decision = JSON.parse(clean.slice(start, end + 1));
    }
    const verdict = String(decision?.verdict || '').toUpperCase();
    if (!['NEEDED', 'ALREADY_DONE', 'SUPERSEDED', 'CANNOT_PROCEED'].includes(verdict)) return fallback;
    const proof = typeof decision.proof_url === 'string' && decision.proof_url.trim()
      ? decision.proof_url.trim() : undefined;
    const survivor = typeof decision.superseded_by === 'string' && decision.superseded_by.trim()
      ? decision.superseded_by.trim() : undefined;
    return {
      verdict,
      reason: String(decision.reason || '').slice(0, 400),
      proof_url: proof,
      superseded_by: survivor,
    };
  } catch (e) {
    console.warn('   Pre-flight failed:', (e as Error).message);
    return fallback;
  }
}

// ── OpenCode: the worker with hands ────────────────────────────────────────

// The loopback proxy the operator's dashboard already uses for the opencode
// button (relay/harness-proxy.mjs). It injects the server's own credential,
// so this path carries no secret and needs no password of its own.
const OPENCODE_URL = Deno.env.get('OPENCODE_PROXY_URL') || 'http://127.0.0.1:4130';

// The model the worker uses.
//
// It is pinned rather than left to the server's choice, because the choice is
// not stable: the same server answered with ollama-cloud/minimax-m3.1-flash on
// one run and with an opencode-go model on the next, and the Go models answer
// 403 "an active OpenCode Go subscription is required to use Go models" on this
// account. The server had no provider credentials of its own, so its catalogue
// emptied and everything fell back to the gated tier.
//
// The OpenCode server is now configured with the relay's OpenRouter key and
// this free model (~/.config/opencode/opencode.json), which answers in about a
// second and needs no subscription. If it fails, the worker is retried once
// with the server's own choice, so a change at the provider does not silently
// stop the fleet working.
const OPENCODE_WORKER_PROVIDER = Deno.env.get('OPENCODE_WORKER_PROVIDER') || 'openrouter';
const OPENCODE_WORKER_MODEL = Deno.env.get('OPENCODE_WORKER_MODEL') || 'minimax/minimax-m3.1-flash:free';

// The lock that keeps one agent at a time on this machine. It is a file in
// the relay's own data directory, shared with the inbox daemon, because the
// harness is one process and two agents in it is what crashes a small box.
const OPENCODE_LOCK_PATH = Deno.env.get('OPENCODE_LOCK_PATH')
  || join(REPO_ROOT, 'relay-data', 'opencode.lock');

// A verb that means "change something".
const WORK_VERB = /\b(implement|fix|write|create|add|build|deploy|refactor|migrate|port|replace|rename|remove|delete|wire|integrate|patch|ship|publish|merge|install|configure|update)\b/;
// An item that only asks to be understood.
const ONLY_ANALYSIS = /\b(analy[sz]e requirements|plan implementation|research|document|documentation|summari[sz]e|summary|report|explain|describe|compare|investigate)\b/;

/**
 * Is this checklist item work that needs a capable agent, rather than a
 * lookup? A knowledge search can describe a change; it cannot make one.
 */
function looksLikeImplementation(itemLower: string): boolean {
  if (ONLY_ANALYSIS.test(itemLower)) return false;
  return WORK_VERB.test(itemLower);
}

async function opencodeJson(base: string, method: string, path: string, body?: any): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const t = await r.text();
    if (!r.ok) return null;
    try { return JSON.parse(t); } catch { return null; }
  } finally { clearTimeout(timer); }
}

/**
 * Hand the step to OpenCode and wait for the answer.
 *
 * The server works in the repository, so the agent can write files and run
 * commands. It is asked for the URL of what it changed, because that URL is
 * the evidence the completion rule requires - and because an answer with no
 * address behind it is exactly the kind of completion this system already
 * learned not to trust.
 */
/**
 * Wait for the assistant's finished reply in a session.
 *
 * A message that has not finished streaming holds only the model's
 * reasoning, and reading it early is how a finished piece of work was once
 * recorded as "the worker replied with nothing".
 */
async function waitForAssistant(base: string, sessionId: string, timeoutMs: number): Promise<{ parts: any[]; text: string; error?: any } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await opencodeJson(base, 'GET', `/api/session/${sessionId}/message`);
    const arr = Array.isArray(msgs?.data) ? msgs.data : [];
    const assistant = arr.filter((m: any) => m.type === 'assistant').pop();
    if (assistant) {
      if (assistant.finish === 'error' || assistant.error) {
        return { parts: [], text: '', error: assistant.error };
      }
      if (assistant.time?.completed === undefined && assistant.finish === undefined) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const parts = Array.isArray(assistant.content) ? assistant.content : [];
      const text = parts.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ').trim();
      return { parts, text };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/**
 * Does this file exist? A path the worker names is only a deliverable if it
 * can be opened - otherwise the model is describing an intention.
 */
async function fileExists(rel: string): Promise<boolean> {
  try {
    const abs = rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel) ? rel : `${Deno.cwd()}/${rel}`;
    const st = await Deno.stat(abs);
    return st.isFile;
  } catch {
    return false;
  }
}

/**
 * The files that exist in the working tree but are not tracked by git.
 *
 * This is how the SYSTEM sees what the worker did, rather than being told.
 * A model that wrote a file and then narrated a plan instead of naming the
 * file is common; a file that appeared is not a matter of opinion.
 */
async function untrackedFiles(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const cmd = new Deno.Command('git', {
      args: ['status', '--porcelain', '--untracked-files=all'],
      stdout: 'piped',
      stderr: 'null',
    });
    const res = await cmd.output();
    if (!res.success) return out;
    for (const line of new TextDecoder().decode(res.stdout).split('\n')) {
      if (!line.startsWith('?? ')) continue;
      const p = line.slice(3).trim().replace(/^"|"$/g, '');
      if (p) out.add(p);
    }
  } catch {
    // git is not available to the function; the worker's own report is all
    // there is.
  }
  return out;
}

async function runOpenCodeWorker(task: Task, item: string): Promise<{ ok: boolean; summary?: string; error?: string; deliverable?: string }> {
  // ONE agent at a time on this box. The harness is a node process with a
  // tool-calling loop, and this machine has 8GB with most of it already in
  // use. A second agent does not queue behind the first - it stands down and
  // the task is picked up on the next cycle, which is what the task's own
  // progress record is for.
  const lock = acquireOpencodeLock(OPENCODE_LOCK_PATH, { label: `executor:${task.id}` });
  if (!lock.ok) {
    console.log(`   Another agent is using the OpenCode harness (${lock.holder}, ` +
      `${Math.round(lock.ageMs / 1000)}s ago) - standing down, this task waits for the next cycle.`);
    return {
      ok: false,
      error: `the OpenCode harness is in use by ${lock.holder} - only one agent may use it at a time`,
    };
  }

  try {
    return await runOpenCodeWorkerLocked(task, item);
  } finally {
    lock.release();
  }
}

async function runOpenCodeWorkerLocked(task: Task, item: string): Promise<{ ok: boolean; summary?: string; error?: string; deliverable?: string }> {
  const base = OPENCODE_URL.replace(/\/$/, '');
  const prompt = [
    `TASK: ${task.title}`,
    task.description ? `DESCRIPTION: ${String(task.description).slice(0, 2000)}` : '',
    `THIS STEP: ${item}`,
    '',
    'Work on this repository and make the change the step describes.',
    'When you are done:',
    '1. commit the change: git add the files you touched, then git commit -m "...";',
    '2. if it can be pushed, push it to the remote that belongs to this project. The https remote is rejected on this machine, so use the ssh one (git@github.com:...);',
    '3. reply with the path of every file you changed, one per line, and nothing else after that;',
    '4. reply with the URL of the commit or pull request, so the change can be checked;',
    '5. if you could not make the change, exactly what is missing and what would unblock it.',
  ].filter(Boolean).join('\n');

  try {
    // What the tree looked like before the worker started. The difference
    // afterwards is what the worker did, observed rather than reported.
    const before = await untrackedFiles();

    const created = await opencodeJson(base, 'POST', '/api/session', { title: String(task.title || item).slice(0, 80) });
    const sid = created?.data?.id;
    if (!sid) return { ok: false, error: 'could not create a session' };

    const sent = await opencodeJson(base, 'POST', `/api/session/${sid}/prompt`, {
      text: prompt,
      model: { providerID: OPENCODE_WORKER_PROVIDER, modelID: OPENCODE_WORKER_MODEL },
      agent: 'build',
    });
    if (!sent) return { ok: false, error: 'the prompt was not accepted' };

    let reply = await waitForAssistant(base, sid, 5 * 60 * 1000);
    if (reply?.error) {
      // The pinned model failed. Try once with the server's own choice before
      // giving up: a provider-side change should not silently stop the fleet
      // working.
      console.log(`   Worker failed on the pinned model; retrying with the server's default`);
      await opencodeJson(base, 'POST', `/api/session/${sid}/prompt`, {
        text: prompt,
        agent: 'build',
      });
      reply = await waitForAssistant(base, sid, 5 * 60 * 1000);
    }
    if (!reply) return { ok: false, error: 'the worker did not answer within five minutes' };
    if (reply.error) {
      return { ok: false, error: `worker failed: ${JSON.stringify(reply.error).slice(0, 200)}` };
    }
    const parts = reply.parts;
    const text = reply.text;

    // What the worker actually DID is in the tool calls, and that is the
    // part worth keeping: "wrote the file" is evidence in a way that a
    // paraphrase of it is not.
    const tools: string[] = [];
    const files: string[] = [];
    for (const c of parts) {
      if (!(c.type === 'tool' || c.tool || c.name)) continue;
      const name = c.name || c.tool || (c.state && c.state.title) || 'tool';
      const input = c.state?.input || c.input || c.arguments || c.args;
      const target = input && typeof input === 'object'
        ? (input.filePath || input.path || input.file || '')
        : '';
      tools.push(target ? `${name} (${String(target).slice(0, 120)})` : name);
      if (target && /\.[a-z0-9]{1,8}$/i.test(String(target)) && !String(target).includes(' ')) {
        files.push(String(target));
      }
      // A shell command that writes a file names the file. The worker often
      // writes through the shell rather than a write tool, and the command is
      // the record of what it touched.
      const command = input && typeof input === 'object' ? (input.command || '') : '';
      if (typeof command === 'string' && command) {
        for (const token of command.split(/[\s"'`;|&><]+/)) {
          const t = token.replace(/[,;]+$/, '');
          if (/\.[a-z0-9]{1,8}$/i.test(t) && !t.includes('://') && !/\s/.test(t) && t.length < 200) {
            files.push(t);
          }
        }
      }
    }

    // The deliverable: the first address in the reply, or - when there is
    // no address - the file the worker wrote.
    //
    // This box cannot push to GitHub (its credential is rejected), so a
    // commit URL is not available. A file the worker wrote IS checkable: it is
    // on this disk, and anyone can look at it. `file:<path>` is therefore a
    // legitimate deliverable, and the verifier checks that the path exists
    // rather than fetching a URL.
    let deliverable = (text.match(/https?:\/\/\S+/g) || [])[0]?.replace(/[.,;]+$/, '')
      || (files.length ? `file:${files[0]}` : null);

    if (!deliverable) {
      // The model did not say what it changed. Ask it, in the same session,
      // and keep only a path that can actually be opened - a path that does
      // not exist is the model describing an intention, not a deliverable.
      await opencodeJson(base, 'POST', `/api/session/${sid}/prompt`, {
        text: 'List the files you changed, one path per line, and nothing else. No commentary.',
        agent: 'build',
      });
      const follow = await waitForAssistant(base, sid, 120000);
      if (follow?.text) {
        const named = (follow.text.match(/[^\s"'`]+/g) || [])
          .filter((p) => /\.[a-z0-9]{1,8}$/i.test(p) && !/^https?:/i.test(p))
          .slice(0, 6);
        for (const p of named) {
          if (await fileExists(p)) {
            deliverable = `file:${p}`;
            break;
          }
        }
        if (deliverable) tools.push(`named by the worker: ${deliverable}`);
      }
    }

    if (!deliverable) {
      // Still nothing. Ask the TREE: a file that appeared while the worker
      // was running is a file the worker made, whatever it chose to say.
      const after = await untrackedFiles();
      const appeared = [...after].filter((p) => !before.has(p));
      if (appeared.length) {
        for (const p of appeared) {
          if (await fileExists(p)) {
            deliverable = `file:${p}`;
            break;
          }
        }
        if (deliverable) tools.push(`appeared in the working tree: ${deliverable}`);
      }
    }

    const summary = [
      text,
      tools.length ? `Tools used: ${[...new Set(tools)].join('; ')}` : '',
      deliverable ? `Deliverable: ${deliverable}` : '',
    ].filter(Boolean).join('\n').trim();
    if (!summary) return { ok: false, error: 'the worker replied with nothing' };
    return { ok: true, summary: summary.slice(0, 4000), deliverable: deliverable || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function executeChecklistItem(supabase: any, task: Task, item: string): Promise<{ success: boolean; summary?: string; error?: string; deliverable?: string }> {
  const itemLower = item.toLowerCase();

  // ── WORK THAT NEEDS HANDS ──
  //
  // The knowledge-search path can only describe. "Implement X", "fix Y", "open
  // a pull request" need an agent that can write files and run commands, and
  // the stack HAS one: the OpenCode server, which the fleet already proxies
  // for the operator's dashboard (relay/harness-proxy.mjs).
  //
  // It is reached through that proxy on purpose. The proxy injects the
  // server's own credential, so nothing here has to know a password, and the
  // path is the same one the dashboard's opencode button uses - one harness,
  // one way in.
  if (looksLikeImplementation(itemLower)) {
    const worked = await runOpenCodeWorker(task, item);
    if (worked.ok) {
      return { success: true, summary: worked.summary, deliverable: worked.deliverable };
    }
    // No falling through to the knowledge path for an implementation item.
    //
    // It used to, and that is how a step called "create the file" was
    // completed by a knowledge search that returned nothing - the hollow
    // completion this whole change exists to end. A step that needs an agent
    // with hands is not completed by an agent that can only describe.
    return {
      success: false,
      error: `opencode_worker_failed: ${worked.error || 'no answer'}`,
    };
  }

  try {
    // 1. Search for relevant tools using the item text
    console.log(`   🔍 Searching for tools relevant to: "${item}"...`);

    // Default tools that are always candidates
    const availableTools: any[] = [
      {
        name: 'search_knowledge',
        description: 'Search internal documentation, previous tasks, and knowledge base.',
        parameters: { query: 'string' }
      }
    ];

    try {
      const { data: searchData, error: searchError } = await supabase.functions.invoke('search-edge-functions', {
        body: { query: item, limit: 5 }
      });

      const matchedFunctions = searchData?.functions ?? searchData?.results;
      if (!searchError && Array.isArray(matchedFunctions)) {
        // Add unique tools from search
        matchedFunctions.forEach((t: any) => {
          if (!availableTools.find(at => at.name === t.name)) {
            availableTools.push(t);
          }
        });
      }
    } catch (err) {
      console.warn("   ⚠️ Tool search failed, using defaults:", err);
    }

    // 2. Ask AI to select a tool or perform a simulated action
    const prompt = `
Context: You are an autonomous agent executing a task.
Task: ${task.title}
Checklist Item: "${item}"

Available Tools:
${availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Decide the best course of action:
1. USE A TOOL: If a tool is relevant, return { "action": "tool", "tool_name": "name", "payload": { ... } }
   - For 'search_knowledge', payload should be { "query": "..." }
2. ANALYZE: If the item requires thinking/reasoning, return { "action": "analyze", "response": "Your analysis here..." }
3. PLAN: If the item requires planning, return { "action": "plan", "response": "Your plan here..." }
4. DOCUMENT: If the item requires writing, return { "action": "document", "response": "Your documentation here..." }

If you CHANGED something, your response must include the URL of what you changed - a file, a pull request, a deployed endpoint, a commit. If you did not change anything, say exactly that, and name the URL of whatever you inspected instead. A plan is not a change.

Return ONLY the JSON object.
`;

    const aiResponse = await callAI(prompt);
    // Honesty gate: progress is only ever marked for a parsed AI decision.
    // An unavailable provider or unparseable output records a failed attempt
    // and advances nothing — marking fallback text as completed work would
    // manufacture progress the agent never performed.
    if (aiResponse.startsWith("AI analysis unavailable")) {
      return { success: false, error: "ai_unavailable_no_progress_written" };
    }
    let decision;
    try {
      const cleanJson = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      try {
        decision = JSON.parse(cleanJson);
      } catch {
        // Free-tier models often wrap the object in prose: recover the
        // outermost {...} before giving up to the manual fallback.
        const start = cleanJson.indexOf('{');
        const end = cleanJson.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('no JSON object');
        decision = JSON.parse(cleanJson.slice(start, end + 1));
      }
    } catch (e) {
      console.error("   ❌ Failed to parse AI decision:", aiResponse);
      // Unparseable output is not work. Record the failure, write nothing.
      return { success: false, error: "unparseable_decision_no_progress_written" };
    }

    // 3. Execute the decision
    if (decision.action === 'tool') {
      console.log(`   🛠️ AI selected tool: ${decision.tool_name}`);

      // Handle search_knowledge specifically if mapped to a different function, 
      // but otherwise try to invoke the function name directly
      let functionName = decision.tool_name;
      let payload = decision.payload || {};

      if (functionName === 'search_knowledge') {
        // Map to extract-knowledge or similar? 
        // Actually ai-chat maps 'search_knowledge' -> invokeEdgeFunction... wait, let's look at ai-chat again.
        // It says: } else if (name === 'search_knowledge') { ... result = await invokeEdgeFunction('search_knowledge', ...
        // Wait, does 'search_knowledge' edge function exist? 
        // I listed dirs and saw 'extract-knowledge', 'knowledge-manager', 'system-knowledge-builder'.
        // I did NOT see 'search-knowledge'.
        // BUT ai-chat has: `else if (name === 'search_knowledge') { ... result = await handleSearchKnowledge(...) }` (Wait, I need to check exact code again).

        // Let's assume for now we use 'search-edge-functions' for tools and 'knowledge-manager' or 'extract-knowledge' for knowledge?
        // Actually, let's just map it to 'extract-knowledge' if that seems right, OR standard vector search.
        // NOTE: If the tool doesn't exist as an edge function, this will fail.
        // Let's try to map 'search_knowledge' to 'extract-knowledge' with action='search' ?

        // SAFE FALLBACK: If tool is 'search_knowledge', let's use a known existing function or just simulate.
        // Actually, let's look at the available functions again.
        // 'search-edge-functions' IS available.
        // 'extract-knowledge' IS available.
        // Let's assume 'extract-knowledge' is the one.
        if (functionName === 'search_knowledge') {
          // Map to knowledge-manager which handles search
          functionName = 'knowledge-manager';
          payload = {
            action: 'search_knowledge',
            data: {
              search_term: payload.query,
              limit: 5
            }
          };
        }
      }

      // Invoke the function
      try {
        const { data, error } = await supabase.functions.invoke(functionName, {
          body: payload
        });

        if (error) throw error;

        const output = typeof data === 'string' ? data : JSON.stringify(data).substring(0, 500);
        return { success: true, summary: `Executed ${functionName}: ${output}...` };

      } catch (err) {
        console.error(`   ❌ Tool execution failed:`, err);
        return { success: false, error: `Tool ${functionName} failed: ${err.message}` };
      }

    } else if (['analyze', 'plan', 'document'].includes(decision.action)) {
      return { success: true, summary: `${decision.action.toUpperCase()}: ${decision.response}` };
    }

    return { success: false, error: 'no_action_taken_no_progress_written' };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Does this URL actually point at something?
 *
 * Evidence is only evidence if it can be fetched. A model asked for a URL will
 * produce one: in a live test it produced
 * "https://example.com/pfp-booking-tables-state" for a task whose only work
 * had been a knowledge search that returned nothing - and that address does
 * not exist. So a URL is checked by asking for it, and the answer has to be a
 * success.
 *
 * A URL that answers 404 fails, and so does one that needs credentials the
 * fleet does not have (a private pull request). That is deliberate: the board
 * should only claim what can be checked, and a completion nobody can check is
 * a claim.
 */
async function verifyEvidenceUrl(url: string): Promise<{ ok: boolean; status?: number }> {
  const target = String(url || '').trim();
  if (!target) return { ok: false };

  // A file the worker wrote: checkable by looking, not by fetching.
  if (target.startsWith('file:')) {
    const rel = target.slice('file:'.length).replace(/^["']|["']$/g, '');
    try {
      const abs = rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)
        ? rel
        : `${Deno.cwd()}/${rel}`;
      const st = await Deno.stat(abs);
      return { ok: st.isFile, status: st.isFile ? 200 : 404 };
    } catch {
      return { ok: false, status: 404 };
    }
  }

  if (!/^https?:\/\//i.test(target)) return { ok: false };

  const tryFetch = async (method: string): Promise<number | null> => {
    try {
      const r = await fetch(target, {
        method,
        redirect: 'follow',
        headers: method === 'GET' ? { Range: 'bytes=0-2048' } : {},
        signal: AbortSignal.timeout(15000),
      });
      return r.status;
    } catch {
      return null;
    }
  };

  let status = await tryFetch('HEAD');
  if (status === null || status === 405 || status === 403 || status >= 500) {
    const viaGet = await tryFetch('GET');
    if (viaGet !== null) status = viaGet;
  }
  if (status === null) return { ok: false };
  return { ok: status >= 200 && status < 400, status };
}

/**
 * The URL of the thing that was actually changed.
 *
 * The work log is prose written by the agent, so the deliverable is looked for
 * in it: the first http(s) URL that is not this task's own record. A work log
 * with no such URL describes an intention rather than a change - and the
 * database guard agrees (app.artifact_is_self_referential refuses to count a
 * task pointing at itself).
 */
function findDeliverable(workLog: any[], taskId: string): string | null {
  const urls: string[] = [];
  const files: string[] = [];
  for (const entry of workLog || []) {
    const text = String(entry?.summary || '');
    urls.push(...(text.match(/https?:\/\/[^\s"'<>)\]]+/g) || []));
    files.push(...(text.match(/file:[^\s"'<>)\]]+/g) || []));
  }
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, '');
    if (!url) continue;
    // The task's own record is not a deliverable.
    if (url.includes(`/tasks/${taskId}`)) continue;
    return url;
  }
  // A file the worker wrote is checkable on this machine, which is what this
  // box can offer instead of a pushed commit URL.
  for (const raw of files) {
    const f = raw.replace(/[.,;:]+$/, '');
    if (f && f.length > 'file:'.length) return f;
  }
  return null;
}

async function generateChecklist(task: Task): Promise<string[]> {
  const prompt = `
Task: ${task.title}
Description: ${task.description}
Category: ${task.category}
Stage: ${task.stage}

This task is missing a checklist. Generate a specific, actionable 3-5 item checklist for an autonomous agent to complete this task. 
The items should be clear steps like "Research X", "Draft content for Y", "Deploy Z".
Return ONLY the checklist items as a JSON array of strings. No markdown, no explanations.
Example: ["Analyze competitors", "Draft marketing copy", "Review with user"]
`;

  try {
    const response = await callAI(prompt);
    // clean up response to ensure it's valid JSON
    const cleanResponse = response.replace(/```json/g, '').replace(/```/g, '').trim();
    const items = JSON.parse(cleanResponse);
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.error("Error generating checklist:", err);
    // Simple fallback logic if AI fails
    if (task.title.toLowerCase().includes("research")) {
      return ["Define research goals", "Gather data sources", "Summarize findings"];
    }
    return ["Analyze task requirements", "Create execution plan", "Execute plan", "Verify results"];
  }
}

async function chatCompletion(url: string, key: string, model: string, prompt: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API Error: ${response.status} - ${errorText.slice(0, 200)}`);
  }
  const result = await response.json();
  // OpenAI-compatible shape (OpenRouter, Ollama Cloud, OpenCode Zen). Gemini-style
  // candidates shape accepted too, in case a proxy translates upstream.
  // Empty content falls through to the next tier rather than poisoning the
  // decision parse downstream.
  const content = result.choices?.[0]?.message?.content
    || result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content || !String(content).trim()) throw new Error("empty completion from " + url);
  return content;
}

async function callAI(prompt: string): Promise<string> {
  // Tier 1: OpenRouter (OpenAI-compatible). Default is a free model verified
  // live against real decision prompts (laguna-s-2.1); OPENROUTER_MODEL pins
  // another catalog id. Rejected: openrouter/free (safety model, empty),
  // gemma-4-31b-it:free (429), nemotron-3-nano-omni (empties on long prompts).
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (openrouterKey) {
    const model = Deno.env.get("OPENROUTER_MODEL") || "poolside/laguna-s-2.1:free";
    try {
      return await chatCompletion("https://openrouter.ai/api/v1/chat/completions", openrouterKey, model, prompt);
    } catch (error) {
      console.error("OpenRouter Exception, trying Ollama Cloud fallback:", error);
    }
  } else {
    console.error("❌ WARNING: OPENROUTER_API_KEY not found. Falling back to Ollama Cloud.");
  }

  // Tier 2: Ollama Cloud (OpenAI-compatible).
  //
  // The model is operator config, and the default is the one Ollama actually
  // serves for free: minimax-m3.1-flash, measured 2026-10-20 at 200 in
  // 790-1403ms with native tool_calls on all three accounts. The old default
  // (gemma4:31b) is in the free plan but its weekly allowance is spent on
  // every account (429), and there is no "-free" slug on Ollama to fall back
  // to - minimax-m3.1-flash-free is a 404.
  const ollamaKey = Deno.env.get("OLLAMA_API_KEY") || Deno.env.get("OLLAMA_XMRT_API_KEY");
  if (ollamaKey) {
    const ollamaModel = Deno.env.get("OLLAMA_MODEL") || "minimax-m3.1-flash";
    try {
      return await chatCompletion("https://ollama.com/v1/chat/completions", ollamaKey, ollamaModel, prompt);
    } catch (error) {
      console.error("Ollama Cloud Exception, trying OpenCode Zen fallback:", error);
    }
  } else {
    console.error("❌ WARNING: OLLAMA_API_KEY not found. Falling back to OpenCode Zen.");
  }

  // Tier 3: OpenCode Zen (OpenAI-compatible, fleet free tier). Currently 403s
  // (FreeTierError: free tier only works from inside OpenCode) — kept so a
  // future key upgrade lights it up with no code change.
  const opencodeKey = Deno.env.get("OPENCODE_API_KEY");
  if (!opencodeKey) {
    return "AI analysis unavailable (Missing OPENROUTER, OLLAMA and OPENCODE keys)";
  }
  const base = (Deno.env.get("OPENCODE_BASE_URL") || "https://opencode.ai/zen/v1").replace(/\/$/, "");
  const model = (Deno.env.get("OPENCODE_MODELS") || "space-bunny-free").split(",")[0].trim();
  try {
    return await chatCompletion(`${base}/chat/completions`, opencodeKey, model, prompt);
  } catch (error) {
    console.error("OpenCode Zen Exception:", error);
    return "AI analysis unavailable (all providers failed)";
  }
}
