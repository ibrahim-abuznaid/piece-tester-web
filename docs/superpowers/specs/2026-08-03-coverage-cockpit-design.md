# Coverage Cockpit — rebuild the Schedules page

**Date:** 2026-08-03
**Status:** Approved design, implemented on `feat/schedules-coverage-cockpit`
**Topic:** Turn the schedule/plan page into a piece-centric coverage cockpit

---

## 1. Problem

The app is a pipeline for answering *"which Activepieces pieces are currently broken?"* To get a
piece under continuous testing today, it must clear three gates on three different pages:

1. **Connections** — add credentials.
2. **Batch Setup / Piece Detail** — AI-generate approved test plans per action.
3. **Schedules** — check the piece in a modal's `TargetPicker`.

The `TargetPicker` only shows pieces that have *already* cleared gates 1 and 2, so the Schedules page
assumes all the work is done and just lets you tick boxes. At the scale we care about (top pieces now,
more later), this is the wrong shape:

- **No coverage view** — the page lists cron rows, not pieces. You can't see, across the catalog,
  which pieces are under continuous testing and which aren't.
- **The setup gate is invisible** — a piece with no connection/plan simply doesn't appear.
- **Authoring friction** — a modal checkbox list doesn't scale to hundreds of pieces.

## 2. Goal

Rebuild the Schedules page into a **coverage cockpit**: one piece-centric list over the whole catalog
that shows, per piece, whether it's under continuous testing and what its single next step is — and lets
you enroll pieces onto a schedule in bulk ("create a schedule for the pieces, then edit it").

Keep it simple: the headline is **covered vs not covered**, not a granular multi-stage pipeline.

### Non-goals

- No auto-connect / in-app OAuth (connecting stays manual).
- No rewrite of the scheduler, test engine, or plan-generation engine.
- No changes to Test Logs, Reports, Health triage internals, or Connections CRUD.
- No curated "top 100" list (it becomes a saved filter later — §11).

## 3. Model

Two independent axes per piece:

- **Coverage** — on an **enabled** schedule? `Covered` / `Not covered`. Headline metric.
- **Readiness** — `not connected → connected → no plans → healthy / failing`.

Journey (each step is the row's surfaced "next action"):

```
Connect (manual)  →  Enroll (1 click, add to a schedule)  →  Generate plans (separate, AI)  →  runs → health
```

**Enroll = schedule only.** Enrolling adds the piece to a schedule; it does not auto-generate plans.
A piece that is covered but has no approved plans is a real, surfaced state ("covered · no plans yet");
the scheduler already skips such pieces safely.

## 4. Statuses are derived (no schema churn)

`getCoverage(catalog)` joins: catalog (`client.listPieces()`), active `piece_connections`, enabled
`schedules.targets`, approved `test_plans` counts, and `getPieceHealth()`.

## 5. Storage — one schedule per cadence (approved)

The `schedules` table and `scheduler.ts` engine are unchanged. Each distinct cadence (schedule_config +
timezone) maps to one schedule row; pieces are members via `{ piece_name }` wildcard targets.

- **Enroll** — find-or-create the cadence schedule, add wildcard targets, enable.
- **Change cadence** — remove from current schedule, add to the new cadence schedule.
- **Unenroll** — remove targets; a schedule left with **zero** targets is **deleted** (empty targets
  mean "all pieces" — emptying would silently cover everything).

## 6. Backend API (`/api/coverage`)

- `GET /api/coverage` → `CoverageRow[]`.
- `POST /api/coverage/enroll` `{ piece_names, cadence }`.
- `POST /api/coverage/unenroll` `{ piece_names }`.
- `POST /api/coverage/cadence` `{ piece_names, cadence }`.

`cadence = { cron_expression, schedule_config (JSON), timezone, label }` — the client builds cron/label.
Generate plans reuses `POST /api/batch-setup/start`; Connect routes to Piece Detail (no new endpoint).

## 7. Frontend

- `components/CoverageCockpit.tsx` — coverage bar, search + filter chips, bulk actions, piece rows.
- `components/CadenceEditor.tsx` — reusable cadence modal + config→cron helpers.
- `pages/Schedules.tsx` — tab 1 renders `<CoverageCockpit/>`; the Scheduled Runs tab
  (`ScheduledRunsFeed`) is unchanged. The old create/edit modal is left unreachable (later cleanup).
- `lib/api.ts` — `CoverageRow`/`CadencePayload` types + coverage methods.

## 8. Edge cases

- Covered but no plans → allowed, flagged, counted under "need plans"; scheduler skips it.
- Enroll a not-connected piece → allowed but flagged; "Connect" stays the next step.
- Legacy "all pieces" schedule (enabled, empty targets) → read as everything covered; never appended to
  or emptied by enroll/unenroll.

## 9. Testing

- Server: unit tests for `getCoverage` derivation + enroll/unenroll target math.
- Manual: run the app, verify each row state's "Next" action, bulk enroll writes the schedule, coverage
  bar counts match.

## 10. Affected files

New: `server/src/routes/coverage.ts`, `client/src/components/CoverageCockpit.tsx`,
`client/src/components/CadenceEditor.tsx`.
Changed: `server/src/db/queries.ts`, `server/src/index.ts`, `client/src/pages/Schedules.tsx`,
`client/src/lib/api.ts`. Unchanged/reused: `scheduler.ts`, `test-engine.ts`, `batch-setup.ts`,
`getPieceHealth()`.

## 11. Future

- **Top-100 focus** — a saved filter/tag so the coverage bar reads against a curated subset.
- **Triggers** — a triggers-specific readiness breakdown if needed.
