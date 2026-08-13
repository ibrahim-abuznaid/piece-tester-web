# Scheduled Runs — full run breakdown + drill-any-piece — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Scheduled Runs feed, show every run of the selected wave (passed / running / failed) grouped by piece, and let the user expand any piece to see each action/trigger and drill into its steps — including the one currently running — instead of hiding running pieces in the "passing" fold behind a misleading `2/3 ✓`.

**Architecture:** Server `getWaveDetail` currently enumerates only failing runs per piece (`WavePiece.failing[]`). We rename that to `runs[]` and populate it with **all** runs (each carrying a `status`), keeping `step_results` out of the payload (three queries: per-piece counts, all-run metadata, and `step_results` only for failed runs so JSON-parse cost still scales with failures). The client mirrors the type and splits pieces into three lanes — Failing / In-progress / Passing — with a lane-agnostic `PieceGroup` that lists all targets via a generalized `TargetRow`, reusing the existing lazy `RunSteps` loader (loads once on expand).

**Tech Stack:** TypeScript, Express, better-sqlite3 (server); React + @tanstack/react-query + Tailwind + lucide-react (client); Vitest for the server unit test.

**Spec:** `docs/superpowers/specs/2026-08-13-scheduled-runs-full-breakdown-design.md`

---

## Preflight: branch

- [ ] **Create a feature branch off `main`** (do not work on `main`):

```bash
cd /home/sanket/workspace/piece-tester-web
git checkout main && git pull --ff-only
git checkout -b feat/scheduled-runs-full-breakdown
```

## File structure

| File | Responsibility | Change |
|---|---|---|
| `vitest.config.ts` (repo root) | Test runner config; points tests at an isolated `DB_PATH` | **Create** |
| `package.json` | Add `test` script | Modify |
| `server/src/db/queries.ts` | `WaveRun`/`WavePiece` types + `getWaveDetail` enumerating all runs | Modify (`~1040-1172`) |
| `server/src/db/queries.wave.test.ts` | Unit test for `getWaveDetail` | **Create** |
| `client/src/lib/api.ts` | Mirror `WaveRun`/`WavePiece` types | Modify (`~436-456`) |
| `client/src/components/ScheduledRunsFeed.tsx` | Three lanes, lane-agnostic `PieceGroup`, `TargetRow`, count labels | Modify |
| `docs/SCHEDULED-RUNS-UX.md` | Reflect all-runs enumeration | Modify (`52`, `55`) |

---

## Task 0: Test infrastructure (Vitest)

No test runner is wired up yet (Vitest is installed but there is no config or `test` script). This task adds both so later tasks can run `npm test`.

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `vitest.config.ts` at the repo root**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/src/**/*.test.ts'],
    passWithNoTests: true,
    // better-sqlite3 is a native addon — run tests in forked processes, not worker
    // threads, to avoid native-module-in-worker issues.
    pool: 'forks',
    // Isolate tests from the real dev DB (schema.ts reads DB_PATH at import time).
    // data/*.db is already gitignored.
    env: {
      DB_PATH: './data/test.db',
    },
  },
});
```

- [ ] **Step 2: Add the `test` script to `package.json`**

In the `"scripts"` block, add a `test` entry (leave the existing scripts intact):

```json
    "start": "tsx server/src/index.ts",
    "build": "npm run build:client",
    "test": "vitest run"
```

(Insert `"test": "vitest run"` after the `"build"` line — remember to add the trailing comma to the `"build"` line.)

- [ ] **Step 3: Verify the runner starts green with no tests yet**

Run: `npm test`
Expected: exits 0 with a message like `No test files found ... passWithNoTests`. (PASS.)

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "test: wire up vitest with an isolated test DB"
```

---

## Task 1: Server — `getWaveDetail` enumerates all runs (TDD)

Rename `WaveFailingRun` → `WaveRun` (add `status`) and `WavePiece.failing` → `runs`, and change `getWaveDetail` to list every run in the wave. `category`/`error` stay populated only for failed runs; `step_results` never enters the payload.

**Files:**
- Create: `server/src/db/queries.wave.test.ts`
- Modify: `server/src/db/queries.ts` (interfaces `~1040-1072`, `getWaveDetail` `~1101-1172`)

- [ ] **Step 1: Write the failing test**

Create `server/src/db/queries.wave.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getWaveDetail } from './queries.js';

// Insert a test_plan and return its id.
function seedPlan(piece: string, action: string, type: 'action' | 'trigger' = 'action'): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES (?, ?, ?, 'approved')`,
    [piece, action, type],
  ).lastId;
}

// Insert a scheduled test_plan_run in a wave with an explicit status/step_results/timings.
function seedRun(
  planId: number,
  waveId: string,
  status: string,
  opts: { stepResults?: string; startedAt?: string; completedAt?: string } = {},
): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at, completed_at, wave_id, schedule_id)
     VALUES (?, ?, 'scheduled', ?, ?, ?, ?, NULL)`,
    [planId, status, opts.stepResults ?? '[]', opts.startedAt ?? '2026-08-13 10:00:00', opts.completedAt ?? null, waveId],
  ).lastId;
}

describe('getWaveDetail', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM schedules;');
  });

  it('enumerates every run per piece with correct status and ordering', () => {
    const create = seedPlan('linear', 'create_issue');
    const get = seedPlan('linear', 'get_issue');
    const trig = seedPlan('linear', 'new_issue', 'trigger');
    const charge = seedPlan('stripe', 'charge');
    const wave = 'wave-1';

    const passRun = seedRun(create, wave, 'completed', {
      startedAt: '2026-08-13 10:00:00', completedAt: '2026-08-13 10:00:02',
    });
    seedRun(get, wave, 'completed');
    seedRun(trig, wave, 'running');
    seedRun(charge, wave, 'failed', {
      stepResults: JSON.stringify([{ stepId: 's1', status: 'failed', error: 'boom', errorCategory: 'piece_error' }]),
    });

    const detail = getWaveDetail(wave);
    expect(detail).not.toBeNull();
    expect(detail!.total).toBe(4);
    expect(detail!.passed).toBe(2);
    expect(detail!.failed).toBe(1);
    expect(detail!.running).toBe(1);

    // Failing piece (stripe) sorts first; its one run carries category + error.
    const stripe = detail!.pieces[0];
    expect(stripe.piece_name).toBe('stripe');
    expect(stripe.runs).toHaveLength(1);
    expect(stripe.runs[0].status).toBe('failed');
    expect(stripe.runs[0].category).toBe('piece_error');
    expect(stripe.runs[0].error).toBe('boom');
    expect(stripe.worst_category).toBe('piece_error');

    // linear enumerates all 3 runs; running sorts ahead of completed; completed carry no category.
    const linear = detail!.pieces.find(p => p.piece_name === 'linear')!;
    expect(linear.runs).toHaveLength(3);
    expect(linear.passed).toBe(2);
    expect(linear.running).toBe(1);
    expect(linear.runs[0].status).toBe('running');
    expect(linear.runs[0].target_type).toBe('trigger');
    const completed = linear.runs.filter(r => r.status === 'completed');
    expect(completed).toHaveLength(2);
    expect(completed.every(r => r.category === null)).toBe(true);
    // Duration computed from naive-UTC timestamps (2s).
    expect(linear.runs.find(r => r.run_id === passRun)!.duration_ms).toBe(2000);
  });

  it('returns null for an unknown wave', () => {
    expect(getWaveDetail('does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/src/db/queries.wave.test.ts`
Expected: FAIL — the assertions reference `piece.runs` / `run.status`, which don't exist yet (`runs` is `undefined`, so `stripe.runs` throws / is undefined).

- [ ] **Step 3: Replace the `WaveFailingRun`/`WavePiece` interfaces**

In `server/src/db/queries.ts`, replace the `WaveFailingRun` and `WavePiece` interface block (currently around lines 1040–1058):

```ts
export interface WaveRun {
  run_id: number;
  target_action: string;
  target_type: string;    // 'action' | 'trigger'
  status: string;         // 'completed' | 'failed' | 'running' | …
  category: string | null; // failed runs only (errorCategory | 'assert_failed' | 'unknown')
  error: string | null;    // failed runs only — short one-line hint
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
  runs: WaveRun[];   // ALL runs enumerated; ordered failed(by severity) → running → passed
}
```

Leave the `WaveDetail` interface (below it) unchanged — it references `WavePiece`, which still exists.

- [ ] **Step 4: Rewrite `getWaveDetail` to enumerate all runs**

In `server/src/db/queries.ts`, replace the whole `getWaveDetail` function body (currently around lines 1101–1172) with:

```ts
/**
 * Per-piece rollup for one wave. Three queries: cheap per-piece counts, ALL runs' lightweight
 * metadata (no step_results), and step_results ONLY for the failing runs (so JSON-parse cost
 * scales with failures, not total runs). step_results still load lazily per run on expand.
 */
export function getWaveDetail(waveId: string): WaveDetail | null {
  const db = getDb();

  const pieceCounts = db.all<{ piece_name: string; total: number; passed: number; failed: number; running: number }>(`
    SELECT p.piece_name AS piece_name,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS running
    FROM test_plan_runs r
    JOIN test_plans p ON p.id = r.plan_id
    WHERE r.wave_id = ?
    GROUP BY p.piece_name
  `, [waveId]);
  if (pieceCounts.length === 0) return null;

  // Every run in the wave — metadata only, NO step_results (keeps the payload light).
  const allRuns = db.all<{ id: number; status: string; started_at: string; completed_at: string | null; piece_name: string; target_action: string; target_type: string }>(`
    SELECT r.id, r.status, r.started_at, r.completed_at,
           p.piece_name, p.target_action, p.target_type
    FROM test_plan_runs r
    JOIN test_plans p ON p.id = r.plan_id
    WHERE r.wave_id = ?
  `, [waveId]);

  // step_results ONLY for failed runs → derive category/error (parse cost ∝ failures).
  const failingRows = db.all<{ id: number; step_results: string }>(`
    SELECT r.id, r.step_results
    FROM test_plan_runs r
    WHERE r.wave_id = ? AND r.status = 'failed'
  `, [waveId]);
  const failMeta = new Map<number, { category: string; error: string | null }>();
  for (const r of failingRows) failMeta.set(r.id, analyzeFailedRun(r.step_results));

  const meta = db.get<{ schedule_id: number | null; started_at: string; label: string | null }>(`
    SELECT r.schedule_id AS schedule_id, MIN(r.started_at) AS started_at, s.label AS label
    FROM test_plan_runs r
    LEFT JOIN schedules s ON s.id = r.schedule_id
    WHERE r.wave_id = ?
  `, [waveId]);

  const byPiece = new Map<string, WavePiece>();
  for (const c of pieceCounts) {
    byPiece.set(c.piece_name, {
      piece_name: c.piece_name, total: c.total, passed: c.passed, failed: c.failed, running: c.running,
      worst_category: null, runs: [],
    });
  }
  for (const r of allRuns) {
    const wp = byPiece.get(r.piece_name);
    if (!wp) continue;
    const fm = r.status === 'failed' ? (failMeta.get(r.id) ?? { category: 'unknown', error: null }) : null;
    wp.runs.push({
      run_id: r.id, target_action: r.target_action, target_type: r.target_type, status: r.status,
      category: fm?.category ?? null, error: fm?.error ?? null,
      duration_ms: runDurationMs(r.started_at, r.completed_at), started_at: r.started_at,
    });
  }

  // Within a piece: failed first (by category severity), then running, then everything else.
  const statusRank = (run: WaveRun): number =>
    run.status === 'failed' ? 100 + categorySeverity(run.category)
    : run.status === 'running' ? 50
    : 10;

  const pieces = [...byPiece.values()];
  for (const wp of pieces) {
    wp.worst_category = wp.runs
      .filter(r => r.status === 'failed')
      .reduce<string | null>((w, f) => (categorySeverity(f.category) > categorySeverity(w) ? f.category : w), null);
    wp.runs.sort((a, b) => statusRank(b) - statusRank(a) || a.target_action.localeCompare(b.target_action));
  }
  // Failing pieces first (most failures first), then alphabetical.
  pieces.sort((a, b) => (b.failed - a.failed) || a.piece_name.localeCompare(b.piece_name));

  const agg = pieces.reduce((s, p) => ({
    total: s.total + p.total, passed: s.passed + p.passed, failed: s.failed + p.failed, running: s.running + p.running,
  }), { total: 0, passed: 0, failed: 0, running: 0 });

  return {
    wave_id: waveId,
    schedule_id: meta?.schedule_id ?? null,
    schedule_label: meta?.label || null,
    started_at: meta?.started_at ?? '',
    ...agg,
    pieces,
    ...getCoverageCounts(),
  };
}
```

Note: `categorySeverity(cat: string | null)` and `runDurationMs` already exist above this function and accept these argument types unchanged — no edits needed to them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/src/db/queries.wave.test.ts`
Expected: PASS (both `it` blocks green).

- [ ] **Step 6: Verify no other server code referenced the old `failing` field**

Run: `grep -rn "\.failing\b\|WaveFailingRun" server/src`
Expected: no matches (the only consumer was the client, changed in Task 3). If a match appears, it is a leftover to fix before committing.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.wave.test.ts
git commit -m "feat(waves): enumerate all runs per piece in getWaveDetail"
```

---

## Task 2: Client — mirror the `WaveRun`/`WavePiece` types

The client keeps its own copy of these types in `api.ts`. Update it to match the server's new shape.

**Files:**
- Modify: `client/src/lib/api.ts` (`~436-456`)

- [ ] **Step 1: Replace the `WaveFailingRun`/`WavePiece` interfaces**

In `client/src/lib/api.ts`, replace the `WaveFailingRun` and `WavePiece` interface block (currently around lines 436–456) with:

```ts
/** One run (target) within a wave — enough to list/drill without loading step_results. */
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

/** Per-piece rollup within a wave — all runs enumerated; step_results still load lazily. */
export interface WavePiece {
  piece_name: string;
  total: number;
  passed: number;
  failed: number;
  running: number;
  worst_category: string | null;
  runs: WaveRun[];
}
```

Leave the `WaveDetail` interface below it unchanged.

- [ ] **Step 2: Verify the type compiles (it will be consumed in Task 3)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "api\.ts|ScheduledRunsFeed" | head`
Expected: errors only in `ScheduledRunsFeed.tsx` (it still imports `WaveFailingRun` and uses `piece.failing`) — those are fixed in Task 3. No errors originating in `api.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "feat(waves): mirror WaveRun/WavePiece types on the client"
```

---

## Task 3: Client — three lanes + drill-any-piece

Rework `ScheduledRunsFeed.tsx`: split pieces into Failing / In-progress / Passing lanes, make `PieceGroup` lane-agnostic and render **all** runs, and generalize `FailingTargetRow` into a status-aware `TargetRow`. `RunSteps`/`StepRow` are unchanged (still load once on expand).

**Files:**
- Modify: `client/src/components/ScheduledRunsFeed.tsx`

- [ ] **Step 1: Update the import to use `WaveRun`**

Replace the import (lines 4–6):

```tsx
import {
  api, type WaveSummary, type WaveDetail, type WavePiece, type WaveRun, type StepResult,
} from '../lib/api';
```

- [ ] **Step 2: Replace `WaveDetailView` with the three-lane version**

Replace the entire `WaveDetailView` function (currently lines ~178–266) with:

```tsx
function WaveDetailView({
  waveId, expandedPieces, onTogglePiece, expandedRun, onToggleRun,
}: {
  waveId: string;
  expandedPieces: Set<string>;
  onTogglePiece: (name: string) => void;
  expandedRun: number | null;
  onToggleRun: (id: number) => void;
}) {
  const { data: detail, isLoading } = useQuery<WaveDetail>({
    queryKey: ['wave-detail', waveId],
    queryFn: () => api.getWaveDetail(waveId),
    refetchInterval: 30_000,
  });
  const [showPassing, setShowPassing] = useState(false);

  if (isLoading || !detail) return <p className="text-sm text-gray-400">Loading run…</p>;

  const failingPieces = detail.pieces.filter(p => p.failed > 0);
  const runningPieces = detail.pieces.filter(p => p.failed === 0 && p.running > 0);
  const passingPieces = detail.pieces.filter(p => p.failed === 0 && p.running === 0);

  return (
    <div className="space-y-3">
      {/* Summary line */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-200">{formatDateTime(detail.started_at)}</span>
          {detail.schedule_label && (
            <span className="flex items-center gap-1 text-[10px] text-purple-300 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">
              <CalendarClock size={9} /> {detail.schedule_label}
            </span>
          )}
          <span className="text-xs text-gray-500">
            · {detail.pieces.length}{detail.covered_total > 0 ? ` of ${detail.covered_total} covered` : ' pieces'} tested
          </span>
        </div>
        <div className="flex items-center gap-4 mt-1.5 text-sm">
          <span className="text-green-400">{detail.passed} passed</span>
          <span className={detail.failed > 0 ? 'text-red-400 font-medium' : 'text-gray-500'}>
            {detail.failed} {detail.failed === 1 ? 'check' : 'checks'} failing
          </span>
          {detail.running > 0 && <span className="text-blue-400">{detail.running} running</span>}
        </div>
        {detail.covered_untested > 0 && (
          <p className="text-xs text-amber-300/80 mt-1.5">
            {detail.covered_untested} covered but untested (no plans) —{' '}
            <Link to="/schedules" className="text-primary-400 hover:underline">fix in Coverage</Link>
          </p>
        )}
      </div>

      {/* Failures first */}
      {failingPieces.length > 0 && (
        <div className="space-y-1.5">
          {failingPieces.map(p => (
            <PieceGroup key={p.piece_name} piece={p} lane="failing" open={expandedPieces.has(p.piece_name)}
              onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
          ))}
        </div>
      )}

      {/* In progress */}
      {runningPieces.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 px-1 pt-1 text-xs text-blue-300">
            <Loader2 size={12} className="animate-spin" />
            <span>In progress</span>
          </div>
          {runningPieces.map(p => (
            <PieceGroup key={p.piece_name} piece={p} lane="running" open={expandedPieces.has(p.piece_name)}
              onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
          ))}
        </div>
      )}

      {/* All-clear only when nothing is failing AND nothing is still running */}
      {failingPieces.length === 0 && runningPieces.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400 flex items-center gap-2">
          <CheckCircle size={15} className="text-green-400" /> Every check in this run passed. 🎉
        </div>
      )}

      {/* Passing pieces folded away — now expandable to their targets → steps */}
      {passingPieces.length > 0 && (
        <div>
          <button onClick={() => setShowPassing(v => !v)}
            className="w-full flex items-center gap-2 px-1 py-1.5 text-left text-xs text-gray-500 hover:text-gray-300">
            {showPassing ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{passingPieces.length} passing piece{passingPieces.length === 1 ? '' : 's'} hidden</span>
          </button>
          {showPassing && (
            <div className="space-y-1.5 pb-1">
              {passingPieces.map(p => (
                <PieceGroup key={p.piece_name} piece={p} lane="passing" open={expandedPieces.has(p.piece_name)}
                  onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Replace `PieceGroup` with the lane-agnostic version + add `PieceCounts`/`LANE_STYLE`**

Replace the entire `PieceGroup` function (currently lines ~268–296) with:

```tsx
const LANE_STYLE = {
  failing: { border: 'border-red-500/20', dot: 'bg-red-500' },
  running: { border: 'border-blue-500/20', dot: 'bg-blue-500' },
  passing: { border: 'border-gray-800', dot: 'bg-green-500' },
} as const;

function PieceCounts({ piece }: { piece: WavePiece }) {
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-gray-400">{piece.passed} passed</span>
      {piece.running > 0 && <span className="text-blue-400">· {piece.running} running</span>}
      {piece.failed > 0 && (
        <span className="text-red-400 font-medium">· {piece.failed} failed</span>
      )}
    </span>
  );
}

function PieceGroup({ piece, lane, open, onToggle, expandedRun, onToggleRun }: {
  piece: WavePiece;
  lane: 'failing' | 'running' | 'passing';
  open: boolean;
  onToggle: () => void;
  expandedRun: number | null;
  onToggleRun: (id: number) => void;
}) {
  const s = LANE_STYLE[lane];
  return (
    <div className={`border ${s.border} rounded-lg bg-gray-900 overflow-hidden`}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/40 transition-colors">
        {open ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
        {lane === 'running'
          ? <Loader2 size={13} className="text-blue-400 animate-spin shrink-0" />
          : <span className={`w-2 h-2 rounded-full ${s.dot} shrink-0`} />}
        <span className="text-sm font-medium text-gray-200 truncate">{clean(piece.piece_name)}</span>
        <div className="ml-auto flex items-center gap-2">
          <PieceCounts piece={piece} />
          {lane === 'failing' && <CategoryBadge category={piece.worst_category} />}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-800/50 px-2 py-2 space-y-1.5 bg-gray-950/30">
          {piece.runs.map(r => (
            <TargetRow key={r.run_id} r={r} expanded={expandedRun === r.run_id}
              onToggle={() => onToggleRun(r.run_id)} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace `FailingTargetRow` with the status-aware `TargetRow`**

Replace the entire `FailingTargetRow` function (currently lines ~298–316) with:

```tsx
function TargetRow({ r, expanded, onToggle }: { r: WaveRun; expanded: boolean; onToggle: () => void }) {
  const dur = fmtDur(r.duration_ms);
  const icon = r.status === 'completed' ? <CheckCircle size={13} className="text-green-400 shrink-0" />
    : r.status === 'failed' ? <XCircle size={13} className="text-red-400 shrink-0" />
    : r.status === 'running' ? <Loader2 size={13} className="text-blue-400 animate-spin shrink-0" />
    : <Clock size={13} className="text-gray-500 shrink-0" />;
  return (
    <div id={`wave-run-${r.run_id}`} className="border border-gray-800 rounded-lg bg-gray-900 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors">
        {expanded ? <ChevronDown size={13} className="text-gray-500 shrink-0" /> : <ChevronRight size={13} className="text-gray-500 shrink-0" />}
        {icon}
        <span className="text-sm text-gray-200">{r.target_action}</span>
        {r.target_type === 'trigger' && (
          <span className="flex items-center gap-0.5 text-[10px] text-purple-300"><Zap size={9} /> trigger</span>
        )}
        {r.status === 'failed' && <CategoryBadge category={r.category} />}
        {r.status === 'failed' && r.error && (
          <span className="text-[11px] text-red-400/70 truncate min-w-0 flex-1">— {r.error}</span>
        )}
        <span className="text-[10px] text-gray-500 shrink-0 ml-auto">#{r.run_id}{dur ? ` · ${dur}` : ''}</span>
      </button>
      {expanded && <RunSteps runId={r.run_id} />}
    </div>
  );
}
```

Leave `RunSteps`, `StepRow`, and `safeParse` (below it) unchanged.

- [ ] **Step 5: Typecheck the client**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exits 0 (no errors). In particular, no remaining references to `WaveFailingRun` or `piece.failing`.

- [ ] **Step 6: Build the client to confirm it bundles**

Run: `npm run build:client`
Expected: Vite build completes with no TypeScript/bundle errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/ScheduledRunsFeed.tsx
git commit -m "feat(waves): three lanes + drill any piece in Scheduled Runs"
```

---

## Task 4: Docs — reflect all-runs enumeration

**Files:**
- Modify: `docs/SCHEDULED-RUNS-UX.md` (lines 52, 55)
- Modify: `client/src/components/ScheduledRunsFeed.tsx` (header comment, lines ~12-18)

- [ ] **Step 1: Update the `GET /reports/waves/:id` description (line 52)**

Replace:

```md
  - `GET /reports/waves/:id` — per-piece rollup; enumerates only FAILING runs, counts passing.
```

with:

```md
  - `GET /reports/waves/:id` — per-piece rollup; enumerates ALL runs (status-tagged), with
    category/error attached only to failing runs. No `step_results` in the payload.
```

- [ ] **Step 2: Update the payload-scaling note (line 55)**

Replace:

```md
- Payload scales with #failures, not #runs (verified: a 1-failure wave ≈ 600 bytes).
```

with:

```md
- Run metadata (no `step_results`) scales with #runs; JSON-parse of `step_results` still scales
  with #failures; a single run's steps still load lazily via `GET /test-plans/runs/:id` on expand.
```

- [ ] **Step 3: Update the component header comment**

In `client/src/components/ScheduledRunsFeed.tsx`, replace the second paragraph of the top doc comment:

```tsx
 * Left: a rail of runs (one per schedule fire). Right: the selected run's summary + a
 * failures-first Piece → Target drill. step_results are NEVER in the list — a run's steps load
 * lazily (getPlanRun) only when you expand it. Scales with #failures, not #runs.
```

with:

```tsx
 * Left: a rail of runs (one per schedule fire). Right: the selected run's summary split into
 * Failing / In-progress / Passing lanes. Every piece expands to ALL its targets (action/trigger);
 * step_results are NEVER in the list — a run's steps load lazily (getPlanRun) only when you expand
 * a target. Run metadata scales with #runs; step_results parse cost scales with #failures.
```

- [ ] **Step 4: Commit**

```bash
git add docs/SCHEDULED-RUNS-UX.md client/src/components/ScheduledRunsFeed.tsx
git commit -m "docs(waves): reflect all-runs enumeration + three lanes"
```

---

## Task 5: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: `queries.wave.test.ts` passes (2 tests), no failures.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exits 0.

- [ ] **Step 3: Manual UI check (do not commit anything from this step)**

Start the app (`npm run dev`) and open the Scheduled Runs feed. On a wave that has a piece with a still-running run (like the `linear` example):
- The piece appears under an **In progress** lane (not buried in "passing hidden"), labelled e.g. `2 passed · 1 running`.
- Expanding the piece lists **all** its targets (actions + triggers) with per-status icons.
- Expanding the running target shows its steps (loads once).
- A fully-passing wave still shows "Every check in this run passed 🎉" and folds passing pieces, which are now themselves expandable.

Reference the memory note `ui-check-headless-browser` for driving the app headless in this WSL box if needed.

- [ ] **Step 4: Hand off for user testing**

Per the project's standing preference (`commit-after-testing`), the code commits from Tasks 1–4 stay local on the `feat/scheduled-runs-full-breakdown` branch. Do **not** push or open a PR until the user has tested the change in the running app and confirms it.

---

## Self-review notes (author)

- **Spec coverage:** all-runs enumeration (Task 1), client type mirror (Task 2), three lanes + drill-any-piece + count label (Task 3), doc + header comment (Task 4), server test + manual UI check (Tasks 1 & 5). Perf property (no `step_results` in payload; parse ∝ failures) preserved in Task 1's three-query design. Out-of-scope items (summary line, left rail, live-step auto-refresh) left untouched.
- **Type consistency:** `WaveRun` (fields `run_id, target_action, target_type, status, category, error, duration_ms, started_at`) and `WavePiece.runs` are identical in server (`queries.ts`) and client (`api.ts`); `PieceGroup` lane prop is `'failing' | 'running' | 'passing'` everywhere; `TargetRow` consumes `WaveRun`.
- **No placeholders:** every code and command step is concrete.
