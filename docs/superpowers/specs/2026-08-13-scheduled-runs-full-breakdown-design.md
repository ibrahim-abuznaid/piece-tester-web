# Scheduled Runs — full run breakdown + drill-any-piece

**Date:** 2026-08-13
**Component:** `client/src/components/ScheduledRunsFeed.tsx` (Scheduled Runs feed)
**Server:** `server/src/db/queries.ts` (`getWaveDetail`)
**Status:** Approved, ready for implementation plan

## Problem

The Scheduled Runs feed shows, per selected wave (one schedule fire), a failures-first
drill: failing pieces expand into their failing targets, which expand into steps. Passing
pieces are folded away as "N passing piece hidden". Two things are wrong:

1. **Running runs are invisible and the counts mislead.** A piece is classified "passing"
   whenever `failed === 0` — *even while a run is still `running`*. So a piece like `linear`
   with 2 completed + 1 running runs is buried in the "passing" fold and labelled `2/3 ✓`,
   which reads like "2 of 3 passed, 1 failed" when the third is actually mid-run. There is no
   way to see *which run is going*.

2. **Only failing targets are drillable.** `getWaveDetail` enumerates only the failing runs
   per piece (`WavePiece.failing[]`). Passing and running targets are counted but never
   listed, so a piece cannot be expanded to inspect its actions/triggers and their steps the
   way the Test Logs page (`History.tsx`) lets you expand any run.

## Goal

For the selected wave, show **everything that ran** — passed, running, and failed — grouped
by piece, and let the user expand **any** piece to see each action/trigger and drill into its
steps, including the one currently running. Keep the failures-first emphasis, and keep the
payload light (the file's design property: cost scales with number of failures, not number of
runs).

## Design

### 1. Server — enumerate all runs per piece (`server/src/db/queries.ts`)

Rename `WavePiece.failing` → **`runs`** and populate it with **every** run in the wave, each
carrying a `status`. Category/error remain meaningful only for failed runs.

```ts
export interface WaveRun {
  run_id: number;
  target_action: string;
  target_type: string;     // 'action' | 'trigger'
  status: string;          // 'completed' | 'failed' | 'running' | …
  category: string | null; // failed runs only
  error: string | null;    // failed runs only (short one-line hint)
  duration_ms: number | null;
  started_at: string;
}

export interface WavePiece {
  piece_name: string;
  total: number;
  passed: number;
  failed: number;
  running: number;
  worst_category: string | null;
  runs: WaveRun[];         // ALL runs; ordered failed(by severity) → running → passed
}
```

**Query plan (preserves the "parse scales with failures" property):**

1. Per-piece counts — unchanged (`total/passed/failed/running` grouped by piece).
2. **All runs** metadata for the wave — `r.id, r.status, r.started_at, r.completed_at,
   p.piece_name, p.target_action, p.target_type` — **without `step_results`**. Cheap; scales
   with run count but no JSON parsing.
3. **Failed runs only** — `r.id, r.step_results` `WHERE status='failed'` — parsed through
   `analyzeFailedRun` to derive `category`/`error`. JSON parse cost still scales with failures.

Merge: build `runs[]` per piece from query 2; attach `category`/`error` from a
`run_id → {category, error}` map built from query 3. `worst_category` computed from the failed
runs (as today). Sort each piece's `runs`: failed first (by `categorySeverity`), then running,
then passed; alphabetical by `target_action` within a group. Piece ordering unchanged (most
failures first, then alphabetical). `step_results` are still **never** in this payload — they
load lazily per run via `getPlanRun` when a target is expanded.

Mirror the `WaveRun` / `WavePiece` type change in `client/src/lib/api.ts`.

### 2. Client — three lanes + drill-any-piece (`ScheduledRunsFeed.tsx`)

`WaveDetailView` splits pieces into three groups (was two):

- **Failing** — `failed > 0`. Red, auto-shown, as today.
- **⟳ In progress** — `failed === 0 && running > 0`. **New lane** with a spinner header,
  auto-shown, above the passing fold.
- **Passing** — `failed === 0 && running === 0`. Folded as today ("N passing piece hidden"),
  now expandable.

`PieceGroup` becomes lane-agnostic and renders **all** of `piece.runs` when expanded (not just
failing). Border/dot color keyed off the lane (red / blue / green).

`FailingTargetRow` generalizes to **`TargetRow`**, rendering one `WaveRun`:
- status icon: ✓ green (`completed`), ✗ red (`failed`), ⟳ spinner (`running`), clock (other);
- `trigger` badge when `target_type === 'trigger'`;
- for failed runs only: category badge + short error hint;
- expand → existing **`RunSteps`** (unchanged — lazy `getPlanRun`, **loads once on expand**;
  no auto-refresh).

Per-piece header label changes from `{passed}/{total} ✓` to a segmented count showing only the
nonzero parts: **`{passed} passed · {running} running · {failed} failed`**.

`expandedRun` state and the piece/run expand handlers are unchanged — `TargetRow` reuses the
same `expandedRun === run_id` toggle already threaded through `PieceGroup`.

### 3. Out of scope (explicitly)

- The wave summary line ("N of M covered tested", passed/failing/running) — unchanged.
- The left rail (`WaveRailItem`, `{passed}/{total} passed · {running} running`) — unchanged.
- Auto-refresh / live polling of an expanded running run's steps — **not** included; steps load
  once on expand (the wave detail itself still polls every 30s, updating counts).

## Testing

- **Server unit test** (`getWaveDetail`): seed one wave with one piece having a passed run, a
  running run, and a failed run. Assert: `runs.length === 3`; statuses correct; ordering is
  failed → running → passed; `category`/`error` populated only on the failed run; per-piece
  `passed/failed/running` counts correct. A second piece all-passing asserts it still appears
  with its runs enumerated.
- **Client**: behavior-verified in the running app (three lanes render; expanding the
  in-progress piece shows the running target; expanding it loads steps).

## Files touched

- `server/src/db/queries.ts` — `WaveRun`/`WavePiece` types, `getWaveDetail` queries + merge.
- `client/src/lib/api.ts` — mirror `WaveRun`/`WavePiece` types.
- `client/src/components/ScheduledRunsFeed.tsx` — three lanes, `TargetRow`, count labels.
- `docs/SCHEDULED-RUNS-UX.md` + component header comment — reflect all-runs enumeration.
- Server test file for `getWaveDetail`.
