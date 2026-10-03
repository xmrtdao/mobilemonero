# The 73 restored cron jobs, reviewed

Generated from `relay-data/cron-jobs.json` (81 jobs) against `cron.job` and the live
`xmrt_suite` schema. Matching is by **name**: the JSON and the table have independent
`id` spaces, so an id match invents pairs that do not exist.

## Why the JSON is not simply "restored"

`loadJobsFromPg()` reads `cron.job` first and only falls back to the JSON when that
table is **empty**. The table is not empty, so the JSON is never consulted and all 73
jobs have been invisible to the scheduler. Staging them into the table is what makes
them real - but only the ones the table can actually represent.

| bucket | count | what it means |
|---|---|---|
| A | 21 | Pure SQL. Every referenced routine and table exists in `xmrt_suite`. Staged, `enabled=false`. |
| B | 48 | Invoke Supabase edge functions. **The table cannot represent these** - see below. |
| C | 4 | No `command`, `sql`, `fn` or `body` anywhere in either workspace. |

## Bucket B: the blocker

The edge functions are all deployed and reachable - they answer on the local Supabase.
Two independent facts stop them being staged anyway:

1. `cron.job` has columns `id, name, schedule, command, enabled, created_at`. There is no
   `fn` and no `body`. The runtime normalises `fn`+`body` only in the **JSON fallback**
   branch of `loadJobsFromPg()`; the `cron.job` branch never sets them. An edge job
   inserted here has its type inferred from the `command` text by regex, and anything that
   does not match is handed to `cmd.exe` as a shell command.
2. Reconstructing them as SQL cannot work either. `net.http_post`, `extensions.http` and
   every other outbound-HTTP entry point are **absent** - `pg_net` is not installed. The
   `net` schema exists holding only the orphaned `_http_response` types, and the two
   `prune_net_http_response` helpers still run while having nothing to prune.

So they need a decision, not a restore: either add `fn`/`body` columns to `cron.job` and
teach the DB branch of the loader to use them, or give each function a thin node wrapper
and stage that as a shell command, which is the pattern the 14 existing rows already use.

## Bucket C (4)

- `fleet-chat-heartbeat` - the target exists, but `cron.job` **already runs it** as
  `fleet-chat-productivity-agent`. A duplicate. Nothing to restore.
- `fleet-chat-followup`, `fleet-chat-task-creator` - no job row, but the engine
  implements both (`runFleetChatFollowUp()`, `runFleetChatTaskCreator()`). These are
  **built and not wired**, not missing.
- `XMRT-DAO-SeasonalScraper` - "Nightly contact scrape for PFP campaign". Absent from the
  old workspace too, so there is nothing to recover. Its sibling `31harbor-nightly-scraper`
  is already in the table pointing at `DevGruGold/relay/scripts/nightly-scraper.mjs`, which
  does not exist. Same for `31harbor-{morning,midday,afternoon}-send` -> `daily-sender.mjs`.

## Also found

`cron.job_id_seq` was at 3 while `max(id)` was 14, so the first insert that relied on the
default failed with a primary-key collision. Any code path that omits `id` was broken.
Repaired with `setval` to `max(id)`.

`pg_cron` is **not installed** in this database. `cron.job` is a configuration table and
`relay/cron-engine-v2.mjs` is the scheduler that reads it. Nothing in the table would run
on its own, with or without `pg_cron`.

## Redundancy inside bucket B

48 jobs invoke only **36 functions**, and several functions are scheduled more than once.
Grouping by function rather than by job name is the only way to see this - the job names
read like separate features when they are not.

**Same function, same action, different cadence - keep one:**

| function | jobs | schedules | keeper |
|---|---|---|---|
| `suite-task-automation-engine` | 3 | `3,13,23,...` / `18,48` / `4,19,34,...` | `suite-task-automation-engine` |
| `summarize-conversation` | 2 | `8,23,38,53` / `*/5` | `summarize-conversation-fast` |
| `opportunity-scanner` | 2 | `0 *` / `*/10` | `opportunity-scanner-fast` |
| `workflow-template-manager` | 2 | monthly / weekly | both, they are genuinely different periods |

The four `KEEPER` markers already recorded in the `desc` field agree with this, which is a
useful cross-check: somebody had already made this call in prose and it was never applied.

**Same function, different actions - these are real, not duplicates.** Collapsing them would
silently drop work:

- `task-orchestrator` x4 - `auto_assign_tasks`, `rebalance_workload`, `identify_blockers`, `performance_report`
- `ecosystem-monitor` x3 - `self_evaluate`, none, `{"generate_tasks":true}`
- `task-auto-advance` x3 - none, `run_all`, none (the two `none` jobs are the redundant pair)

One genuine oddity: `ecosystem-monitor-evaluate` and `ecosystem-monitor-tasks` both fire at
`0 11 * * *`, so they collide exactly, while `-evaluate` is also documented as the 6-hourly
self-evaluation. Its schedule does not match its description.
