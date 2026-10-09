# Batch setup: tracked first run right after plan generation

**Date:** 2026-10-09
**Branch:** `feat/batch-first-run` (off `main`)
**Status:** Design — implemented on the branch, pending user test

## Problem

A setup run generates plans, auto-tests them (`trigger_type = 'auto_test'`), then
creates one monthly, day-staggered schedule per piece. Nothing tracked runs until
that cron fires — up to 28 days later. The Health board and the Needs-Attention
inbox only count `scheduled` (and finished `retest`) runs, so a freshly set-up
piece sits at **unknown** until its first schedule fire.

## Goal

Right after a setup run finishes generating plans, fire **one tracked run** for
its pieces so Health shows a real status immediately. The scheduled cadence
continues from there unchanged.

## Language (additions to CONTEXT.md)

**First run**: the one-off wave a setup run fires for its pieces as soon as plan
generation ends, so Health has a result before the schedule's first fire. It is a
wave with no schedule.

## Behaviour

1. When a setup run finishes (not cancelled), after its schedules are created,
   the server fires one wave covering **every approved plan of every piece in the
   batch** — the same set each piece's schedule would run on its first fire.
   Plans with empty or invalid steps are skipped, as the scheduler does.
2. Runs are stamped `trigger_type = 'scheduled'`, `wave_id = 'setup<runId>-<ts>'`,
   `schedule_id = NULL`. Health, Needs Attention, Scheduled Runs, Reports and
   regression stats pick them up with no query changes.
3. The first run executes **in the background after the batch is marked done**,
   so the wizard's Done step appears at once and the batch releases its pieces.
   Plans run sequentially through the existing `runScheduledTests`, exactly like
   a cron fire (including the alert engine, when enabled).
4. A checkbox in the schedule panel, **"Run every approved plan once right after
   setup"**, defaults on and is independent of the schedule toggle. Stored as
   `firstRunEnabled` in `setup_runs.config`.
5. The Done step shows a **First run** card that polls while the run is in
   flight: `Running · 12 of 40 done · 3 failed · 1 blocked`, then
   `Complete · 36 passed · 3 failed · 1 blocked`, with links to Health and to the
   wave in Scheduled Runs (`/schedules?tab=logs&wave=<id>`).
6. Setup run history (list + detail) shows the first run's outcome. The Scheduled
   Runs feed labels the wave `Setup run #<id> — first run`.
7. If nothing is approved, no first run is recorded and the card says so.

## Ordering: schedule first, then run

The schedule rows are created before the first run so the pieces are already
enrolled when the wave starts. Creating them first changes nothing the user sees:
a monthly fire landing during the first run is a coincidence with no side effect
beyond a second data point.

## Persistence

`setup_runs` gains three nullable/defaulted columns (additive migration, same
pattern as `setup_run_items.interruptions`):

```
first_run_wave_id      TEXT      -- NULL = no first run recorded
first_run_total        INTEGER NOT NULL DEFAULT 0   -- plans the wave set out to run
first_run_completed_at TEXT      -- set when the wave finishes (or is closed at boot)
```

Progress comes from the existing wave aggregate (`total/passed/failed/running/
blocked` over `test_plan_runs WHERE wave_id = ?`); the stored total gives the
denominator before every run row exists.

## Server

- `services/setup-first-run.ts` (new)
  - `firstRunPlans(pieceNames)` — approved plans with non-empty step arrays.
  - `startFirstRun(setupRunId, pieceNames, deps)` — returns `null` when nothing
    to run; otherwise stamps `first_run_wave_id` + `first_run_total`, calls
    `runScheduledTests([{piece_name}...], { wave_id })` fire-and-forget, and
    sets `first_run_completed_at` when it settles (resolve **or** reject).
    `deps.run` defaults to `runScheduledTests` so tests inject a fake.
- `routes/batch-setup.ts`
  - `/start` accepts `schedule.firstRun` (default `true`) → `config.firstRunEnabled`.
  - Finalization computes the eligible piece list once, creates schedules,
    finalizes the setup run, completes the batch queue, **then** starts the first
    run (skipped when cancelled, when disabled, or when the run already has a
    `first_run_wave_id` — a resumed batch must not fire twice).
  - `batch_done` carries `firstRun: { waveId, total } | null`.
  - `GET /runs/:id` returns `{ run, items, first_run: WaveSummary | null }`.
- `db/queries.ts`
  - `startSetupFirstRun`, `completeSetupFirstRun`, `closeOrphanedFirstRuns`
    (boot: any first run without `completed_at` is closed, next to
    `reconcileOrphanedRuns`, since its runs were just marked `interrupted`).
  - `getWaveSummary(waveId)`.
  - `getScheduledWaves` / `getWaveDetail` label a setup wave via
    `LEFT JOIN setup_runs sr ON sr.first_run_wave_id = r.wave_id`.
- `services/plan-jobs.ts` — `getBatchStatus` includes `setupRunId` so a
  re-opened batch can show its first-run card.

## Client

- `lib/api.ts` — `ScheduleConfigInput.firstRun?`, first-run fields on
  `SetupRunSummary`, `first_run` on the detail response, `firstRun` on
  `batch_done`, `setupRunId` on `BatchStatus`.
- `components/ScheduleStep.tsx` — the first-run checkbox, outside the
  cadence block so it is available with scheduling off.
- `pages/BatchSetup.tsx` — collapsed summary reads
  `Schedule after setup: Monthly · first run now`; Done step renders
  `<FirstRunCard>` (polls the setup run detail every 5 s until
  `first_run_completed_at` is set); the Setup Run detail modal shows the same
  summary line.
- `components/SetupRunHistory.tsx` — row shows `first run 36/40 ok` when present.
- `pages/Schedules.tsx` + `components/ScheduledRunsFeed.tsx` — honour a
  `?wave=<id>` deep link (select that wave once, like `?run=`).

## Error handling

- Runner throws → logged, `first_run_completed_at` still set; the card shows
  whatever runs exist.
- Server restart mid-run → runs become `interrupted` (existing reconcile), the
  first run is closed at boot, and the schedule covers the rest. No re-fire.
- Cancelled batch → no first run.
- Pieces already on a schedule are still included: their schedule row is left
  alone (existing rule) but their plans run now, so the piece's Health is
  coherent.

## Testing

- `services/setup-first-run.test.ts` (DB-backed, fake runner):
  runs only approved, non-empty plans of the given pieces; passes one target per
  piece and the wave id; stamps wave id + total; marks completed on resolve and
  on reject; returns `null` and stamps nothing with no approved plans.
- `db/queries.first-run.test.ts`: `getWaveSummary` aggregates one wave;
  `getScheduledWaves` labels a setup wave; `closeOrphanedFirstRuns` closes only
  open first runs.
- Existing suite stays green; server + client typecheck; client build.

## Out of scope

- Re-firing an interrupted first run.
- Running the first run with concurrency (sequential like cron keeps AP load
  predictable while other batches may still be generating).
- Any change to how Health classifies runs.
