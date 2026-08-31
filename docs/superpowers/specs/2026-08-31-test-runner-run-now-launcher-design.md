# Design: Repurpose Test Runner as a plan-based "Run Now" launcher, retire the legacy engine

**Date:** 2026-08-31
**Status:** Approved (pending spec review)

## Problem

The app has a v1 → v2 split, and two pages straddle it:

- **`/test-runner` ("Test Runner")** runs the *original, plan-less* path: pick connected
  pieces → auto-generate action tests → `POST /tests/run` → write `test_runs`/`test_results`.
  This data is siloed: excluded from Reports, AI Analysis, Health, and Coverage. The page is
  linked from nowhere but the sidebar. The same legacy engine *also* fires on every scheduled
  wave (`test-engine.ts:81-106`), producing results nobody analyzes.
- **`/history` ("Test Logs")** has two tabs: **Plan Runs** (the canonical chronological log of
  plan runs — useful) and **Archived Runs (v1)** (the legacy `test_runs` — a fading relic).

The whole app has moved to plan-based testing (plans → Reports/Health/Coverage/Needs-Attention).
The legacy engine is dead weight that still burns Activepieces calls on every wave and clutters
two pages.

## Goals

1. Repurpose Test Runner into a **plan-based "Run Now" launcher**: pick pieces → run their
   existing *approved* plans on demand, with live progress. Results flow to Test Logs / Reports /
   Health automatically (they're ordinary plan runs).
2. **Delete the legacy plan-less engine everywhere** — manual page *and* scheduled waves — so
   `createTestRun`/`executeTestRun`/`runTests` can be removed.
3. **Simplify Test Logs** to a single Plan Runs log (remove the Archived Runs v1 tab).

## Non-goals

- **Navigation-survival for the launcher.** Plan runs are short (unlike Batch Setup's long AI
  generation jobs). If the user navigates away, runs still complete server-side and appear in
  Test Logs. No nav-surviving job store. (YAGNI.)
- **Consolidating Test Logs (chronological) with Schedules→Runs (wave-grouped).** These genuinely
  overlap, but de-fragmenting them is a separate project.
- **Purging historical `test_runs`/`test_results` rows.** Tables and old rows stay untouched; we
  just remove all UI/read access to them.

## Decisions (locked with user)

| Question | Decision |
| --- | --- |
| Legacy plan-less path | Repurpose the page as a plan launcher; keep a manual "run now" but via plans |
| Scheduled legacy runs | Stop everywhere — delete the engine |
| Selection model | Piece-level, with expand-to-deselect individual targets |
| Archived Runs (v1) tab | Remove entirely; leave old DB rows untouched |
| Execution mechanism | New server batch endpoint (`POST /test-plans/run-batch`) |
| Concurrency | Server-side cap ~3-4 parallel plans, queue the rest |
| Broken/stale plans | Disable their selection, with an explanatory tooltip |

## Architecture

### Component A — Test Runner page (`client/src/pages/TestRunner.tsx`, full rewrite)

Route stays `/test-runner`; nav label stays "Test Runner".

**Source data**
- `listTestPlans()` → filter `status === 'approved'`, group by `piece_name`.
- `listPieces()` for display names.
- Per-piece connection health + per-plan `needs_regen` (stale) signals, to decide which targets
  are runnable. Reuse whatever the Coverage rows / connections list already expose (the exact
  field names are confirmed in the implementation plan; both signals already exist for the
  Coverage Cockpit and the stale-plan feature).

**Selection UI**
- One row per piece with a checkbox + "N targets" + "Select All".
- Chevron expands a piece to list its targets; each target has its own checkbox so users can
  deselect specific ones. Piece checkbox = select/deselect all its (runnable) targets.
- **Runnable gating:** a target whose piece connection is broken, or whose plan is stale
  (`needs_regen`), renders **disabled** with a tooltip ("Connection needs fixing" /
  "Plan is stale — regenerate first"). Disabled targets can't be selected; a piece with only
  disabled targets is itself disabled. Links to the relevant fix surface (Connections / Coverage).

**Run**
- "Run Selected (N)" → collect the chosen `plan_id`s → `api.runBatch(planIds, 'manual')`.
- Response is `[{ plan_id, run_id }]`; the page tracks those run_ids.

**Live results**
- Aggregate strip: Total / Passed / Failed / Running.
- Per-piece result rows reusing the Test Logs step mini-dots (`completed`/`failed`/`running`/
  `waiting`/`skipped` colors), polling `getPlanRun(run_id)` (or a batch-status read) on an
  interval until all runs settle.
- On completion: a "View in Test Logs →" link (deep-links `/history`).
- Empty state (no approved plans anywhere): explain and link to Batch Setup / a piece's AI Test.

### Component B — Server batch run endpoint

`POST /test-plans/run-batch` in `server/src/routes/test-plans.ts`:

- Body: `{ plan_ids: number[], trigger_type?: string }` (default `'manual'`).
- For each plan: create its run record **synchronously up front**, collect `run_id` (this fixes
  the existing race in `run-background`, which reads "latest run" right after an async fire —
  `test-plans.ts:182-184`).
- Execute the plans async through `executePlan`, with a **concurrency cap (~3-4)** — a small
  in-process queue/pool; excess plans wait for a slot.
- Respond immediately with `[{ plan_id, run_id }]`.
- Client helper: `api.runBatch(planIds, triggerType='manual')`.

### Component C — Delete the legacy engine

Remove (server):
- `services/test-engine.ts`: `runTests()`, `executeTestRun()`, and the legacy test-run block +
  connection gathering inside `runScheduledTests()` (lines ~70-106). `runScheduledTests` keeps
  only the plan-run block; its return value (previously the legacy runId) is unused by its caller
  (`scheduler.ts:51` discards it) — simplify signature to `Promise<void>`.
- `routes/tests.ts`: whole file (`POST /tests/run`, `GET /tests/status/:id`); unregister it.
- `routes/history.ts`: the legacy `/history` read + delete routes (only the removed Archived tab
  used them); unregister it.
- `db/queries.ts`: now-unused helpers — `createTestRun`, `getTestRun`, `listTestRuns`,
  `updateTestRun`, `createTestResult`, `getTestResults`, the legacy delete-run helpers, and the
  startup "interrupted" reset that targets `test_runs` (`queries.ts:593`).

Keep:
- `test_runs` / `test_results` **tables and schema** (old rows preserved; no UI).

Remove (client `lib/api.ts`): `runTests`, `getTestStatus`, `listHistory`, `getHistoryRun`,
`deleteHistoryRun`, `deleteAllHistoryRuns`. Add `runBatch`.

### Component D — Scheduler

Waves now run **plans only**. Verify wave rollups (`getScheduledWaves` and
`ScheduledRunsFeed`) aggregate from `plan_runs`, not legacy `test_runs` (legacy rows carry
`wave_id`/`schedule_id`, so a rollup that counted them would change). Adjust the rollup query if
needed so wave counts reflect only plan runs.

### Component E — Test Logs (`client/src/pages/History.tsx`)

- Remove the tab bar, `LegacyRunHistory`, the v1 explainer, and the `tab` state. Page becomes the
  single **Plan Runs** log (`PlanRunHistory`). Keep the piece filter, date grouping, clear-logs,
  and per-run delete.
- Update the subtitle to drop the manual/scheduled tab framing if needed.
- **Bundled fix:** the duration mis-parse showing ~19,800s durations (UTC-vs-local
  `started_at`/`completed_at` parsing, `PlanRunCard` duration calc ~line 258). Fix while in-file.

## Data flow

```
Test Runner page
  listTestPlans()+listPieces()+health/stale signals ─▶ grouped, gated selection
  Run Selected ─▶ POST /test-plans/run-batch {plan_ids, 'manual'}
                    └▶ create run records (sync) ─▶ [{plan_id, run_id}]
                    └▶ executePlan × N (concurrency ≤ 3-4)
  poll getPlanRun(run_id) ─▶ live aggregate + per-piece progress
                    └▶ runs land in plan_runs ─▶ Test Logs / Reports / Health

Scheduler wave ─▶ runScheduledTests(targets) ─▶ plan runs only (no test_runs)
```

## Error handling

- **Broken connection / stale plan:** disabled in selection (can't be run from here); the user is
  pointed to the fix surface. (Even if one slipped through, `executePlan` already gates and
  records a `blocked` result.)
- **Batch endpoint partial failure:** a plan that fails to start still returns its `run_id` with a
  failed/errored run; the page shows it as failed rather than dropping it.
- **Navigating away mid-run:** runs continue server-side; the page simply stops polling. Test Logs
  reflects final state.
- **No approved plans:** empty state with links; "Run Selected" disabled.

## Testing

- **`POST /test-plans/run-batch`** (vitest): returns one `run_id` per plan; stamps `trigger_type`
  `'manual'`; respects the concurrency cap (never more than N in flight); handles an empty/invalid
  plan_id list.
- **Scheduler** (vitest): firing a wave creates **no** `test_runs` row and does create plan runs.
- **Launcher logic** (vitest/component): approved-plan grouping by piece; selection → plan_id
  mapping; broken/stale targets are non-selectable.
- **Regression:** Test Logs renders with only the Plan Runs view; the removed legacy routes 404;
  no dangling imports of deleted symbols (typecheck/build clean).

## Rollout / migration

- No DB migration. Tables retained; only code paths and UI removed.
- Single branch; per-feature commits (page rewrite, batch endpoint, engine deletion, scheduler,
  Test Logs). Do not commit feature code until the user has tested (repo convention).
