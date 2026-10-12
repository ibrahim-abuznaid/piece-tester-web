# Health and Needs Attention stall the server

**Date:** 2026-10-12
**Branch:** `fix/slow-board-queries` (off `main`)
**Status:** Design — implemented on the branch, pending user test

## Problem

The server runs SQLite through better-sqlite3, which is synchronous, so every
query runs on the Node event loop. The Health board and Needs Attention queries
each took 50 to 60 seconds on the live database, and nothing else was served
while they ran — not even `/api/health`. Two pages poll those endpoints every
30 seconds, so one open tab kept the single-core droplet saturated.

Root causes, verified in the code:

1. `test_plan_runs` and `test_plans` have no indexes beyond the UNIQUE
   autoindex on plans. Both board queries find the latest run per plan with a
   correlated subquery on `plan_id`; without an index SQLite scans the whole
   run table once per plan. Plans with no scheduled run (every piece set up
   but not yet fired) force a full scan each. Reproduced on a synthetic
   database at live scale (2,500 plans, 7,000 runs, 50 MB of step results):
   17 s per query on a laptop core.
2. The Health query selects the full `step_results` blob for every plan only
   to read a first-step error from the failed and blocked ones.
3. Step outputs are stored uncapped; nine runs exceed 1 MB and one holds a
   4 MB base64 image. The run history page pulls 100 full runs every 10 s.
4. Dashboard and Health board each poll health every 30 s; Health board also
   polls attention and reported every 30 s.

## Changes

### 1. Indexes (schema migration)

Added at the end of `initTables`, after every `test_plan_runs` column
migration, as idempotent `CREATE INDEX IF NOT EXISTS`:

```
idx_test_plan_runs_plan_id   ON test_plan_runs(plan_id)
idx_test_plan_runs_wave_id   ON test_plan_runs(wave_id)
idx_test_plan_runs_status    ON test_plan_runs(status)
idx_ai_usage_logs_created_at ON ai_usage_logs(created_at)
```

`plan_id` alone is enough for "latest run per plan": SQLite appends the rowid
(`id`) to every index entry, so `ORDER BY id DESC LIMIT 1` within a plan walks
the index backwards and stops at the first match. `test_plans(piece_name)` is
already the leading column of the UNIQUE autoindex, so no new index there.
Creating the indexes on the live database is a one-off read of the run table
at boot, well under a second.

### 2. Health query reads step results only where it uses them

`getPieceHealth` selects `step_results` through
`CASE WHEN r.status IN ('failed','blocked') THEN r.step_results END`, so
completed runs — the large majority — never load their blob. The parsing
helpers accept `null`. `getAttentionItems` already filters to failed and
blocked rows, so it is unchanged. No new column, no backfill.

### 3. Cap stored step output

New module `server/src/services/step-results-storage.ts`:

- `serializeStepResults(steps)` is the single path that turns in-memory step
  results into the stored JSON. Any string longer than 8 KB is cut to 8 KB
  with a `…[truncated, N chars]` suffix (this covers base64 blobs). Any step
  whose serialized `output` still exceeds 64 KB is stored as
  `{ truncated: true, bytes, preview }` where `preview` is the first 64 KB.
- In-memory step results are untouched: input mapping between steps and
  output assertions keep the full values.
- Runs stored before the cap are left as they are. A backfill that trims them
  was considered and dropped: it would be the only irreversible step in this
  change, and the nine oversized runs no longer reach any board query.

Every `step_results` write in `plan-executor.ts` and `plan-batch.ts` goes
through `serializeStepResults`.

### 4. Lighter polling and run history

- Health, attention and reported polls on Dashboard and HealthBoard move from
  30 s to 60 s.
- `GET /test-plans/runs/all` returns `step_statuses: string[]` per run instead
  of `step_results`. The run-history row draws its step dots and counts from
  that; expanding a row fetches the run through the existing
  `GET /test-plans/runs/:id`, the same lazy pattern the Scheduled Runs feed
  uses. `GET /test-plans/:id/runs` (per-plan list) is unchanged.

## Not in scope

- Moving the AI agent layer to a worker process (recommendation 5). It is an
  architecture change; the four fixes above remove the stall on their own.
- A stored `first_error` column. The CASE select gives the same payoff with
  no schema or write-path change.
- The listener-leak warning in the error log.

## Testing

Vitest:

- the four indexes exist after `getDb()`;
- `serializeStepResults`: long strings truncated, oversized output replaced
  with a preview, small results and errors untouched;
- `listAllPlanRuns` returns `step_statuses` and no `step_results`;
- existing Health and Attention suites still pass (error text, category,
  blocked reason, backlinks).

Benchmark on the synthetic database (`scratchpad/bench.mts`, numbers in the
final report): Health and Attention before and after the indexes, and with
and without the step-results column.

Manual: open Dashboard, Health, Needs Attention, Test Logs; `/api/health`
must answer in milliseconds while a board loads; expand a run in Test Logs
and see its steps load.
