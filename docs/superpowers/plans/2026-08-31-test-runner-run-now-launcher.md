# Test Runner "Run Now" Launcher + Legacy Engine Retirement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose `/test-runner` into a plan-based "Run Now" launcher, delete the legacy plan-less test engine everywhere, and collapse Test Logs to a single Plan Runs view (fixing its duration bug).

**Architecture:** A new server batch endpoint (`POST /test-plans/run-batch`) creates plan-run records up front (returning `run_id`s synchronously) and executes the plans in the background behind a small concurrency cap, reusing the existing `executePlan`. The rewritten Test Runner page groups approved plans by piece, disables broken/stale targets, fires the batch, and polls for live progress. The legacy `test_runs` engine and its two pages' worth of UI are removed; the tables stay for historical data.

**Tech Stack:** Node + Express + better-sqlite3 (server), React + react-query + Tailwind (client), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-08-31-test-runner-run-now-launcher-design.md`

**Branch & commit policy:** Work on a feature branch `feat/test-runner-run-now-launcher` (never `main`). Per repo convention, commit each task locally but **do NOT push or open a PR until the user has manually tested** the running app.

---

## File Structure

**Create:**
- `server/src/services/concurrency.ts` — generic `runWithConcurrency` pool (one responsibility: bounded parallelism).
- `server/src/services/concurrency.test.ts`
- `server/src/services/plan-batch.ts` — `runPlanBatch`: create run records + fan out execution under a cap.
- `server/src/services/plan-batch.test.ts`
- `client/src/lib/time.ts` — DB-timestamp normalization + run duration (fixes the UTC/local skew).
- `client/src/lib/time.test.ts`
- `client/src/lib/test-runner-selection.ts` — pure `buildPieceGroups` used by the launcher.
- `client/src/lib/test-runner-selection.test.ts`

**Modify:**
- `server/src/services/plan-executor.ts` — `executePlan` gains optional `existingRunId`.
- `server/src/routes/test-plans.ts` — add `POST /run-batch` (thin wrapper over `runPlanBatch`).
- `client/src/lib/api.ts` — add `runBatch`; remove 6 legacy fns.
- `client/src/pages/TestRunner.tsx` — full rewrite (plan launcher).
- `client/src/pages/History.tsx` — remove legacy tab; apply time fix.
- `server/src/services/test-engine.ts` — delete legacy engine bits; keep `createClient`/`sleep`/`runScheduledTests` (plan-only).
- `server/src/services/scheduler.ts` — no logic change (return value already discarded); verify only.
- `server/src/index.ts` — unregister `/api/tests` and `/api/history`.
- `server/src/db/queries.ts` — remove now-unused legacy helpers + `test_runs` reset.
- `CONTEXT.md` — refresh the "Test Runner" / "Test run" glossary entries.

**Delete:**
- `server/src/routes/tests.ts`
- `server/src/routes/history.ts`

**Keep untouched:** `test_runs` / `test_results` tables and schema (historical rows preserved, no UI).

---

## Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/test-runner-run-now-launcher
git status
```
Expected: on branch `feat/test-runner-run-now-launcher`, clean tree.

---

## Task 1: Bounded-concurrency pool helper

**Files:**
- Create: `server/src/services/concurrency.ts`
- Test: `server/src/services/concurrency.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/concurrency.test.ts
import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

describe('runWithConcurrency', () => {
  it('never exceeds the limit and processes every item', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];

    await runWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item);
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('resolves immediately for an empty list', async () => {
    let called = 0;
    await runWithConcurrency([], 3, async () => { called++; });
    expect(called).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/services/concurrency.test.ts`
Expected: FAIL — cannot find module `./concurrency.js` / `runWithConcurrency is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/concurrency.ts

/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 * Resolves when all items have been processed. Worker rejections propagate.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function drain(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => drain()));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/services/concurrency.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/concurrency.ts server/src/services/concurrency.test.ts
git commit -m "feat: add bounded-concurrency pool helper"
```

---

## Task 2: `executePlan` accepts an existing run id

Currently `executePlan` always calls `createPlanRun` internally (`plan-executor.ts:338`). The batch endpoint needs to create the run record first (to return `run_id` synchronously) and then have `executePlan` reuse it.

**Files:**
- Modify: `server/src/services/plan-executor.ts:324-339`
- Test: `server/src/services/plan-executor.existing-run.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/plan-executor.existing-run.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { createPlanRun, listPlanRuns } from '../db/queries.js';
import { executePlan } from './plan-executor.js';

function seedStalePlan(): number {
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Do it', description: '', actionName: 'x',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['slack', 'send_message', 'action', steps, 'approved', 1],
  ).lastId;
}

describe('executePlan — existingRunId', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('reuses a pre-created run instead of creating a new one', async () => {
    const planId = seedStalePlan();
    const pre = createPlanRun(planId, 'manual'); // status 'running'

    const run = await executePlan(planId, () => {}, 'manual', undefined, undefined, pre.id);

    expect(run.id).toBe(pre.id);              // same run, not a fresh one
    expect(run.status).toBe('blocked');       // stale gate still fires
    expect(listPlanRuns(planId)).toHaveLength(1); // no duplicate run row
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/services/plan-executor.existing-run.test.ts`
Expected: FAIL — `executePlan` ignores the 6th arg and creates a second run (length 2 / id mismatch).

- [ ] **Step 3: Implement — add the optional param and reuse**

In `server/src/services/plan-executor.ts`, change the signature (lines 324-330) to add `existingRunId`:

```ts
export async function executePlan(
  planId: number,
  onProgress: (progress: PlanProgress) => void,
  triggerType: string = 'manual',
  signal?: AbortSignal,
  wave?: WaveInfo,
  existingRunId?: number,
): Promise<TestPlanRunRow> {
```

Then change the run-creation line (currently line 338) from:

```ts
  // Create run (stamped with the schedule fire's wave, if any)
  const run = createPlanRun(planId, triggerType, wave);
  const runId = run.id;
```

to:

```ts
  // Reuse a caller-created run (batch launcher) when provided, else create one here.
  const run = existingRunId != null
    ? (getPlanRun(existingRunId) ?? createPlanRun(planId, triggerType, wave))
    : createPlanRun(planId, triggerType, wave);
  const runId = run.id;
```

(`getPlanRun` and `createPlanRun` are already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/services/plan-executor.existing-run.test.ts server/src/services/plan-executor.stale.test.ts`
Expected: PASS (existing stale tests still green — the default path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/plan-executor.ts server/src/services/plan-executor.existing-run.test.ts
git commit -m "feat: let executePlan reuse a pre-created run id"
```

---

## Task 3: Batch run service + endpoint + client helper

**Files:**
- Create: `server/src/services/plan-batch.ts`
- Test: `server/src/services/plan-batch.test.ts`
- Modify: `server/src/routes/test-plans.ts` (add route)
- Modify: `client/src/lib/api.ts` (add `runBatch`)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/plan-batch.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { getPlanRun } from '../db/queries.js';
import { runPlanBatch } from './plan-batch.js';

function seedStalePlan(action: string): number {
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Do it', description: '', actionName: 'x',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['slack', action, 'action', steps, 'approved', 1],
  ).lastId;
}

describe('runPlanBatch', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('creates one manual run per plan and returns run ids', async () => {
    const a = seedStalePlan('send_message');
    const b = seedStalePlan('update_message');

    const { pairs, done } = runPlanBatch([a, b, 99999], 'manual', 2); // 99999 = unknown → filtered

    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.plan_id).sort()).toEqual([a, b].sort());
    for (const p of pairs) {
      const run = getPlanRun(p.run_id)!;
      expect(run.trigger_type).toBe('manual');
    }

    await done; // stale plans short-circuit (no live AP) → blocked
    for (const p of pairs) {
      expect(getPlanRun(p.run_id)!.status).toBe('blocked');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/services/plan-batch.test.ts`
Expected: FAIL — cannot find module `./plan-batch.js`.

- [ ] **Step 3: Implement the service**

```ts
// server/src/services/plan-batch.ts
import { getTestPlan, createPlanRun, updatePlanRun } from '../db/queries.js';
import { executePlan } from './plan-executor.js';
import { runWithConcurrency } from './concurrency.js';

export interface BatchPair { plan_id: number; run_id: number; }

const DEFAULT_CONCURRENCY = 3;

/**
 * Create a run record for each valid plan up front (so callers get run ids
 * synchronously), then execute them in the background behind a concurrency cap.
 * Unknown plan ids are skipped. Returns the pairs plus a `done` promise that
 * resolves when all background runs finish (used by tests).
 */
export function runPlanBatch(
  planIds: number[],
  triggerType: string = 'manual',
  concurrency: number = DEFAULT_CONCURRENCY,
): { pairs: BatchPair[]; done: Promise<void> } {
  const pairs: BatchPair[] = [];
  for (const planId of planIds) {
    if (!getTestPlan(planId)) continue;
    const run = createPlanRun(planId, triggerType);
    pairs.push({ plan_id: planId, run_id: run.id });
  }

  const done = runWithConcurrency(pairs, concurrency, async ({ plan_id, run_id }) => {
    try {
      await executePlan(plan_id, () => {}, triggerType, undefined, undefined, run_id);
    } catch (err) {
      updatePlanRun(run_id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        step_results: JSON.stringify([{
          stepId: 'error', label: 'Run failed to start', status: 'failed',
          output: null, error: err instanceof Error ? err.message : String(err), duration_ms: 0,
        }]),
      });
    }
  });

  return { pairs, done };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/services/plan-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route (thin wrapper)**

In `server/src/routes/test-plans.ts`, add the import near the top (after line 3):

```ts
import { runPlanBatch } from '../services/plan-batch.js';
```

Add this route (place it just above the existing `router.post('/:id/run-background', ...)` so the static path isn't shadowed by `/:id`):

```ts
// ── Run many approved plans now (manual launcher) ──
router.post('/run-batch', (req, res) => {
  const planIds: number[] = Array.isArray(req.body?.plan_ids)
    ? req.body.plan_ids.filter((n: unknown) => Number.isInteger(n))
    : [];
  const triggerType = (req.body?.trigger_type as string) || 'manual';
  const { pairs } = runPlanBatch(planIds, triggerType);
  res.json(pairs);
});
```

- [ ] **Step 6: Add the client helper**

In `client/src/lib/api.ts`, add next to `runPlanBackground` (around line 1121):

```ts
  runBatch: (planIds: number[], triggerType: string = 'manual') =>
    request<{ plan_id: number; run_id: number }[]>('POST', '/test-plans/run-batch', {
      plan_ids: planIds,
      trigger_type: triggerType,
    }),
```

- [ ] **Step 7: Verify the suite still passes**

Run: `npx vitest run server/src/services/plan-batch.test.ts server/src/routes`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/plan-batch.ts server/src/services/plan-batch.test.ts server/src/routes/test-plans.ts client/src/lib/api.ts
git commit -m "feat: add /test-plans/run-batch endpoint and runBatch client helper"
```

---

## Task 4: Timestamp/duration helpers (fixes the Test Logs duration bug)

`started_at` is stored by SQLite `datetime('now')` as `"YYYY-MM-DD HH:MM:SS"` (UTC, no zone) — JS parses that as **local** time. `completed_at` is `new Date().toISOString()` (UTC with `Z`). The mismatch inflates durations by the local UTC offset (~19,800s in IST). Normalize DB timestamps to UTC before use.

**Files:**
- Create: `client/src/lib/time.ts`
- Test: `client/src/lib/time.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// client/src/lib/time.test.ts
import { describe, it, expect } from 'vitest';
import { parseDbTime, runDurationSeconds } from './time';

describe('parseDbTime', () => {
  it('treats a space-separated SQLite timestamp as UTC', () => {
    // Same instant, two encodings, must be equal:
    expect(parseDbTime('2026-08-31 12:00:00')).toBe(Date.parse('2026-08-31T12:00:00Z'));
  });
  it('passes through an ISO string with Z unchanged', () => {
    expect(parseDbTime('2026-08-31T12:00:05.000Z')).toBe(Date.parse('2026-08-31T12:00:05.000Z'));
  });
});

describe('runDurationSeconds', () => {
  it('computes a small positive duration across the two encodings (no TZ skew)', () => {
    // 5 seconds apart — must NOT be ~19,800s regardless of the machine timezone.
    const d = runDurationSeconds('2026-08-31 12:00:00', '2026-08-31T12:00:05.000Z');
    expect(d).toBe(5);
  });
  it('returns null when either side is missing', () => {
    expect(runDurationSeconds('2026-08-31 12:00:00', null)).toBeNull();
    expect(runDurationSeconds(null, '2026-08-31T12:00:05.000Z')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/time.test.ts`
Expected: FAIL — cannot find module `./time`.

- [ ] **Step 3: Implement**

```ts
// client/src/lib/time.ts

/**
 * Parse a timestamp coming from the DB. SQLite `datetime('now')` yields
 * "YYYY-MM-DD HH:MM:SS" (UTC, no zone), which JS would parse as LOCAL time;
 * `toISOString()` values already carry a 'T' and 'Z'. Normalize the former to
 * UTC so both encodings compare on the same clock. Returns ms since epoch.
 */
export function parseDbTime(s: string): number {
  const norm = s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z';
  return new Date(norm).getTime();
}

/** Whole-second duration between two DB timestamps, or null if either is absent. */
export function runDurationSeconds(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  return Math.round((parseDbTime(completedAt) - parseDbTime(startedAt)) / 1000);
}

/** Local-time string for a DB timestamp (normalized from UTC). */
export function formatDbTime(s: string): string {
  try { return new Date(parseDbTime(s)).toLocaleTimeString(); } catch { return s; }
}

/** Local date+time string for a DB timestamp (normalized from UTC). */
export function formatDbDateTime(s: string): string {
  try { return new Date(parseDbTime(s)).toLocaleString(); } catch { return s; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/lib/time.test.ts`
Expected: PASS (4 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/time.ts client/src/lib/time.test.ts
git commit -m "feat: add UTC-normalizing time helpers (fixes duration skew)"
```

---

## Task 5: Launcher selection model (pure helper)

**Files:**
- Create: `client/src/lib/test-runner-selection.ts`
- Test: `client/src/lib/test-runner-selection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// client/src/lib/test-runner-selection.test.ts
import { describe, it, expect } from 'vitest';
import { buildPieceGroups } from './test-runner-selection';
import type { CoverageRow, TestPlan } from './api';

function cov(piece: string, connected: boolean): CoverageRow {
  return {
    piece_name: piece, display_name: piece.toUpperCase(), logo_url: null,
    connected, covered: true, schedule_id: null, cadence: null, has_plans: true,
    plan_count: 1, planned_targets: 1, total_targets: 1, health: 'unknown',
    actions_failing: 0, last_run_at: null, last_run_id: null,
  };
}
function plan(id: number, piece: string, action: string, status: 'draft' | 'approved', needsRegen = 0): TestPlan {
  return {
    id, piece_name: piece, target_action: action, target_type: 'action',
    steps: [], status, agent_memory: '', automation_status: 'unknown',
    needs_regen: needsRegen, created_at: '', updated_at: '',
  };
}

describe('buildPieceGroups', () => {
  it('includes only approved plans, grouped by piece', () => {
    const groups = buildPieceGroups(
      [cov('slack', true)],
      [plan(1, 'slack', 'send', 'approved'), plan(2, 'slack', 'draft_action', 'draft')],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].targets.map((t) => t.planId)).toEqual([1]);
  });

  it('marks targets of an unconnected piece non-runnable', () => {
    const groups = buildPieceGroups([cov('slack', false)], [plan(1, 'slack', 'send', 'approved')]);
    expect(groups[0].runnable).toBe(false);
    expect(groups[0].targets[0].runnable).toBe(false);
    expect(groups[0].targets[0].reason).toMatch(/connection/i);
  });

  it('marks a stale plan non-runnable but keeps the piece runnable if a fresh target exists', () => {
    const groups = buildPieceGroups(
      [cov('slack', true)],
      [plan(1, 'slack', 'send', 'approved', 1), plan(2, 'slack', 'edit', 'approved', 0)],
    );
    const stale = groups[0].targets.find((t) => t.planId === 1)!;
    const fresh = groups[0].targets.find((t) => t.planId === 2)!;
    expect(stale.runnable).toBe(false);
    expect(stale.reason).toMatch(/stale/i);
    expect(fresh.runnable).toBe(true);
    expect(groups[0].runnable).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/test-runner-selection.test.ts`
Expected: FAIL — cannot find module `./test-runner-selection`.

- [ ] **Step 3: Implement**

```ts
// client/src/lib/test-runner-selection.ts
import type { CoverageRow, TestPlan } from './api';

export interface RunnableTarget {
  planId: number;
  targetAction: string;
  targetType: 'action' | 'trigger';
  runnable: boolean;
  reason?: string;
}
export interface PieceGroup {
  pieceName: string;
  displayName: string;
  logoUrl: string | null;
  connected: boolean;
  targets: RunnableTarget[];
  runnable: boolean;
}

/**
 * Group approved plans by piece and mark which targets can run now.
 * Non-runnable when the piece has no active connection, or the plan is stale
 * (needs_regen=1). Connected-but-broken-upstream is not detectable cheaply
 * here; such runs are gated server-side and recorded as `blocked`.
 */
export function buildPieceGroups(coverage: CoverageRow[], plans: TestPlan[]): PieceGroup[] {
  const covByPiece = new Map(coverage.map((c) => [c.piece_name, c]));
  const byPiece = new Map<string, TestPlan[]>();
  for (const p of plans) {
    if (p.status !== 'approved') continue;
    if (!byPiece.has(p.piece_name)) byPiece.set(p.piece_name, []);
    byPiece.get(p.piece_name)!.push(p);
  }

  const groups: PieceGroup[] = [];
  for (const [pieceName, piecePlans] of byPiece) {
    const c = covByPiece.get(pieceName);
    const connected = c?.connected ?? false;
    const targets: RunnableTarget[] = piecePlans
      .map((p) => {
        const stale = p.needs_regen === 1;
        const reason = !connected ? 'No active connection — connect first'
          : stale ? 'Plan is stale — regenerate first'
          : undefined;
        return {
          planId: p.id,
          targetAction: p.target_action,
          targetType: (p.target_type ?? 'action') as 'action' | 'trigger',
          runnable: connected && !stale,
          reason,
        };
      })
      .sort((a, b) => a.targetAction.localeCompare(b.targetAction));
    groups.push({
      pieceName,
      displayName: c?.display_name ?? pieceName,
      logoUrl: c?.logo_url ?? null,
      connected,
      targets,
      runnable: connected && targets.some((t) => t.runnable),
    });
  }
  return groups.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/lib/test-runner-selection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/test-runner-selection.ts client/src/lib/test-runner-selection.test.ts
git commit -m "feat: add plan-launcher selection model helper"
```

---

## Task 6: Rewrite the Test Runner page as a plan launcher

**Files:**
- Modify (full rewrite): `client/src/pages/TestRunner.tsx`

The selection/gating logic is already unit-tested (Task 5); this task is the UI wiring. Verify visually via the running app.

- [ ] **Step 1: Replace the file contents**

```tsx
// client/src/pages/TestRunner.tsx
import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { buildPieceGroups, type PieceGroup } from '../lib/test-runner-selection';
import { runDurationSeconds } from '../lib/time';
import {
  Play, Loader2, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle, XCircle, MinusCircle,
} from 'lucide-react';

interface RunMeta { piece: string; target: string; }

export default function TestRunner() {
  const { data: coverage } = useQuery({ queryKey: ['coverage'], queryFn: api.getCoverage });
  const { data: plans } = useQuery({ queryKey: ['testPlans'], queryFn: () => api.listTestPlans() });

  const groups = useMemo<PieceGroup[]>(
    () => (coverage && plans ? buildPieceGroups(coverage, plans) : []),
    [coverage, plans],
  );

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<{ plan_id: number; run_id: number }[]>([]);
  const [runData, setRunData] = useState<Record<number, any>>({});
  const metaRef = useRef<Record<number, RunMeta>>({});
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function runnablePlanIds(g: PieceGroup): number[] {
    return g.targets.filter((t) => t.runnable).map((t) => t.planId);
  }

  function togglePiece(g: PieceGroup) {
    const ids = runnablePlanIds(g);
    const next = new Set(selected);
    const allOn = ids.length > 0 && ids.every((id) => next.has(id));
    for (const id of ids) { if (allOn) next.delete(id); else next.add(id); }
    setSelected(next);
  }

  function toggleTarget(planId: number) {
    const next = new Set(selected);
    if (next.has(planId)) next.delete(planId); else next.add(planId);
    setSelected(next);
  }

  function toggleExpand(piece: string) {
    const next = new Set(expanded);
    if (next.has(piece)) next.delete(piece); else next.add(piece);
    setExpanded(next);
  }

  function selectAll() {
    const next = new Set<number>();
    for (const g of groups) for (const id of runnablePlanIds(g)) next.add(id);
    setSelected(next);
  }

  async function handleRun() {
    if (selected.size === 0) return;
    setRunning(true);
    setRunData({});
    // Remember piece/target for each plan so results can be labelled.
    metaRef.current = {};
    for (const g of groups) for (const t of g.targets) {
      if (selected.has(t.planId)) metaRef.current[t.planId] = { piece: g.displayName, target: t.targetAction };
    }
    try {
      const pairs = await api.runBatch([...selected], 'manual');
      setRuns(pairs);
      startPolling(pairs);
    } catch {
      setRunning(false);
    }
  }

  function startPolling(pairs: { plan_id: number; run_id: number }[]) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const updates: Record<number, any> = {};
      await Promise.all(pairs.map(async (p) => {
        try { updates[p.run_id] = await api.getPlanRun(p.run_id); } catch { /* keep polling */ }
      }));
      setRunData((prev) => ({ ...prev, ...updates }));
      const anyRunning = pairs.some((p) => (updates[p.run_id]?.status ?? 'running') === 'running');
      if (!anyRunning) { clearInterval(pollRef.current); setRunning(false); }
    }, 1500);
  }

  const totals = runs.reduce(
    (acc, p) => {
      const s = runData[p.run_id]?.status ?? 'running';
      acc.total++;
      if (s === 'completed') acc.passed++;
      else if (s === 'failed') acc.failed++;
      else if (s === 'blocked') acc.blocked++;
      else if (s === 'running') acc.running++;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, blocked: 0, running: 0 },
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Test Runner</h2>
          <p className="text-sm text-gray-500 mt-1">Run existing approved plans on demand.</p>
        </div>
        {runs.length > 0 && (
          <Link to="/history" className="text-xs text-primary-400 hover:text-primary-300">View in Test Logs →</Link>
        )}
      </div>

      {/* Piece selection */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-gray-400">Select pieces to run:</p>
          <button onClick={selectAll} className="text-xs text-primary-400 hover:text-primary-300">Select All</button>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-gray-500">
            No approved plans yet. Create them from a piece's <span className="text-gray-300">AI Test</span> or{' '}
            <Link to="/batch-setup" className="text-primary-400 hover:text-primary-300">Batch Setup</Link>.
          </p>
        ) : (
          <div className="space-y-1">
            {groups.map((g) => {
              const ids = runnablePlanIds(g);
              const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
              const someOn = ids.some((id) => selected.has(id));
              const isOpen = expanded.has(g.pieceName);
              return (
                <div key={g.pieceName} className="border border-gray-800 rounded">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button onClick={() => toggleExpand(g.pieceName)} className="text-gray-500 hover:text-gray-300">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <input
                      type="checkbox"
                      disabled={!g.runnable}
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = !allOn && someOn; }}
                      onChange={() => togglePiece(g)}
                    />
                    <span className={`text-sm ${g.runnable ? 'text-gray-200' : 'text-gray-500'}`}>{g.displayName}</span>
                    <span className="text-[10px] text-gray-600">{g.targets.length} target{g.targets.length !== 1 ? 's' : ''}</span>
                    {!g.connected && (
                      <span className="flex items-center gap-1 text-[10px] text-amber-400" title="No active connection — connect first">
                        <AlertTriangle size={11} /> no connection
                      </span>
                    )}
                  </div>
                  {isOpen && (
                    <div className="border-t border-gray-800/60 px-3 py-2 space-y-1">
                      {g.targets.map((t) => (
                        <label
                          key={t.planId}
                          className={`flex items-center gap-2 text-xs ${t.runnable ? 'text-gray-300 cursor-pointer' : 'text-gray-600 cursor-not-allowed'}`}
                          title={t.reason ?? ''}
                        >
                          <input
                            type="checkbox"
                            disabled={!t.runnable}
                            checked={selected.has(t.planId)}
                            onChange={() => toggleTarget(t.planId)}
                          />
                          <span>{t.targetAction}</span>
                          <span className="text-[10px] text-gray-600">{t.targetType}</span>
                          {!t.runnable && t.reason && (
                            <span className="flex items-center gap-1 text-amber-400/80"><AlertTriangle size={10} /> {t.reason}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <button
            onClick={handleRun}
            disabled={running || selected.size === 0}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-medium disabled:opacity-50"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Run Selected ({selected.size})
          </button>
        </div>
      </div>

      {/* Results */}
      {runs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex gap-4 mb-4 text-sm">
            <span className="text-gray-400">Total: {totals.total}</span>
            <span className="text-green-400">Passed: {totals.passed}</span>
            <span className="text-red-400">Failed: {totals.failed}</span>
            <span className="text-yellow-400">Blocked: {totals.blocked}</span>
            {totals.running > 0 && <span className="text-blue-400">Running: {totals.running}</span>}
          </div>
          <div className="space-y-2">
            {runs.map((p) => {
              const d = runData[p.run_id];
              const status = d?.status ?? 'running';
              const meta = metaRef.current[p.plan_id];
              const icon = status === 'completed' ? <CheckCircle size={14} className="text-green-400" />
                : status === 'failed' ? <XCircle size={14} className="text-red-400" />
                : status === 'blocked' ? <MinusCircle size={14} className="text-yellow-400" />
                : <Loader2 size={14} className="text-blue-400 animate-spin" />;
              const dur = d ? runDurationSeconds(d.started_at, d.completed_at) : null;
              return (
                <div key={p.run_id} className="flex items-center justify-between py-2 px-3 bg-gray-800 rounded text-sm">
                  <div className="flex items-center gap-3">
                    {icon}
                    <span className="text-gray-300">{meta?.piece}</span>
                    <span className="text-gray-500">{meta?.target}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {dur != null && <span>{dur}s</span>}
                    <span>#{p.run_id}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check the client build**

Run: `npm run build`
Expected: build succeeds (no TS errors referencing TestRunner).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/TestRunner.tsx
git commit -m "feat: repurpose Test Runner as a plan-based run-now launcher"
```

---

## Task 7: Collapse Test Logs to a single Plan Runs view + apply time fix

**Files:**
- Modify: `client/src/pages/History.tsx`

- [ ] **Step 1: Remove the tab machinery and legacy component**

In `client/src/pages/History.tsx`:

1. Delete the `type TabId = ...` line.
2. Replace the `History()` component body so it renders `PlanRunHistory` directly (no tab bar, no `tab` state):

```tsx
export default function History() {
  const [searchParams] = useSearchParams();
  const [pieceFilter, setPieceFilter] = useState(searchParams.get('piece') ?? '');

  useEffect(() => {
    const p = searchParams.get('piece');
    if (p) setPieceFilter(p);
  }, [searchParams]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Test Logs</h2>
          <p className="text-sm text-gray-500 mt-1">Every plan run — manual and scheduled.</p>
        </div>
        <div className="flex items-center gap-2">
          <Filter size={12} className="text-gray-500" />
          <input
            type="text"
            placeholder="Filter by piece..."
            value={pieceFilter}
            onChange={e => setPieceFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 w-48"
          />
        </div>
      </div>
      <PlanRunHistory pieceFilter={pieceFilter} />
    </div>
  );
}
```

3. Delete the entire `LegacyRunHistory` function (the section under `// Legacy Run History (old test_runs / test_results)`).
4. Remove now-unused imports: `Play`, `Archive`, `Info`, `TestResultBadge` (used only by legacy), and any icon only referenced by the deleted tab bar/legacy component. Keep icons still used by `PlanRunHistory`/`PlanRunCard`/`StepResultRow`. (Let the build flag stragglers.)

- [ ] **Step 2: Apply the duration/time fix in `PlanRunCard` and the helpers**

Add the import at the top:

```tsx
import { runDurationSeconds, formatDbTime, formatDbDateTime } from '../lib/time';
```

In `PlanRunCard`, replace the duration block (currently lines ~257-260):

```tsx
  const duration = runDurationSeconds(run.started_at, run.completed_at);
```

Replace the local `formatTime`/`formatDate` helper definitions and their uses with the shared ones:
- Replace `formatTime(run.started_at)` → `formatDbTime(run.started_at)`.
- In `groupByDate`, change `const d = new Date(run.started_at);` → `const d = new Date(parseDbTime(run.started_at));` and add `parseDbTime` to the import.
- Delete the now-unused local `formatDate`/`formatTime` functions. (If `formatDate` is still referenced anywhere kept, replace with `formatDbDateTime`.)

- [ ] **Step 3: Type-check the client build**

Run: `npm run build`
Expected: build succeeds; no references to `api.listHistory`/`getHistoryRun`/`deleteHistoryRun`/`deleteAllHistoryRuns` remain in History.tsx.

Verify: `grep -nE "listHistory|getHistoryRun|deleteHistoryRun|deleteAllHistoryRuns|LegacyRunHistory|TabId" client/src/pages/History.tsx` → no matches.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/History.tsx
git commit -m "refactor: single Plan Runs log in Test Logs + fix duration TZ skew"
```

---

## Task 8: Delete the legacy plan-less engine (server)

**Files:**
- Modify: `server/src/services/test-engine.ts`
- Modify: `server/src/services/scheduler.ts` (verify only)
- Delete: `server/src/routes/tests.ts`, `server/src/routes/history.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1: Trim `test-engine.ts`**

- Delete the exported `runTests` function (lines ~40-58).
- Delete the private `executeTestRun` function (lines ~149-240).
- Delete the private helpers that only `executeTestRun` used and now have **0 external refs**: `mapRunStatus`, `extractError`, `parseJson`. (Keep `createClient` — 32 external refs — and `sleep` — 7 external refs.)
- In `runScheduledTests`, delete the "Legacy test run" block and its connection gathering (lines ~70-106: everything from `const connections = listConnections();` through the `executeTestRun(...)` call and its surrounding `if (toTest.length > 0) { ... }`). Keep the "Test plan runs (modern approach)" block. Change the return type to `Promise<void>` and drop the `return runId;`. Update the function's doc comment to say it runs approved plans only.
- Remove now-unused imports from the top of the file: `listConnections`, `createTestRun`, `createTestResult`, `updateTestRun`, and the `PieceConnectionRow` type. (Keep `getSettings`, `listTestPlans`, `ScheduleTarget`, `WaveInfo` — still used.)

- [ ] **Step 2: Delete the legacy routes and unregister them**

```bash
git rm server/src/routes/tests.ts server/src/routes/history.ts
```

In `server/src/index.ts`, delete these lines:
- `import testsRoutes from './routes/tests.js';` (line 12)
- `import historyRoutes from './routes/history.js';` (line 13)
- `app.use('/api/tests', testsRoutes);` (line 46)
- `app.use('/api/history', historyRoutes);` (line 47)

- [ ] **Step 3: Remove now-unused legacy DB helpers**

In `server/src/db/queries.ts`, delete the now-unused legacy functions: `createTestRun`, `getTestRun`, `listTestRuns`, `updateTestRun`, `createTestResult`, `getTestResults`, and the legacy run-delete helpers (the `DELETE FROM test_runs ...` functions around lines 1500-1510).

In `reconcileOrphanedRuns` (lines ~587-596), remove the legacy `test_runs` reset so it only reconciles plan runs:

```ts
export function reconcileOrphanedRuns(): number {
  const plan = getDb().run(
    `UPDATE test_plan_runs SET status = 'interrupted', completed_at = datetime('now') WHERE status = 'running'`,
  );
  return plan.changes;
}
```

Leave the `test_runs` / `test_results` **table definitions in `schema.ts` untouched** (historical rows preserved).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS. If a test file fails to import a deleted symbol, that symbol was still referenced somewhere — fix the reference (there should be none, per the pre-check). Also run the client build:

Run: `npm run build`
Expected: build succeeds.

Sanity grep (expect no matches outside `schema.ts`):
`grep -rnE "runTests|executeTestRun|createTestRun|createTestResult|getTestResults|listTestRuns|getTestRun\b" server/src --include=*.ts | grep -v schema.ts`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy plan-less test engine and routes"
```

---

## Task 9: Remove legacy client API fns + refresh glossary

**Files:**
- Modify: `client/src/lib/api.ts`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Remove the six unused client API functions**

In `client/src/lib/api.ts`, delete these entries (now that no page references them):
`runTests` (line ~987), `getTestStatus` (line ~988), `listHistory` (line ~991), `getHistoryRun` (line ~992), `deleteHistoryRun` (line ~1131), `deleteAllHistoryRuns` (line ~1133).

Verify no references remain:
`grep -rnE "\b(runTests|getTestStatus|listHistory|getHistoryRun|deleteHistoryRun|deleteAllHistoryRuns)\b" client/src` → no matches.

- [ ] **Step 2: Update `CONTEXT.md` glossary**

Under **Execution**, update the entry for **Test run** and the Test Runner references to reflect the retirement:

Replace the **Test run** definition:

```
**Test run**:
_Retired._ Formerly a batch of auto-generated, plan-less action tests. The
plan-less engine has been removed; all testing now runs through test plans.
Old `test_runs` rows are retained for history only.
```

Update the **Test-step strategy** / any wording that implies Test Runner is plan-less if present, and ensure the "Run now" launcher is described where the app's surfaces are listed (the Test Runner page now runs existing approved plans on demand).

- [ ] **Step 3: Type-check the client build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api.ts CONTEXT.md
git commit -m "chore: drop legacy client API fns; refresh glossary"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS (all suites, including the 4 new test files).

- [ ] **Step 2: Build the client**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Smoke-test the running app (manual — the real gate before any push)**

Run the dev server (`npm run dev`) and confirm:
- `/test-runner` lists pieces with approved plans; unconnected pieces and stale targets are disabled with tooltips; expand/collapse and select-all work.
- "Run Selected (N)" fires; the results panel shows live per-run status and settles; "View in Test Logs →" navigates to `/history`.
- `/history` shows only the Plan Runs log (no tab bar); durations are realistic (seconds, not ~19,800s).
- A scheduled wave (or a manual run) produces **no** new `test_runs` rows: `sqlite3 data/app.db "SELECT COUNT(*) FROM test_runs;"` does not increase after a wave.

- [ ] **Step 4: Hand off to the user for testing**

Do not push or open a PR yet. Summarize what changed and ask the user to test per repo convention (commit-after-testing).

---

## Self-Review (author checklist — completed)

- **Spec coverage:** Launcher page (Task 6, helper Task 5) ✓; batch endpoint + concurrency + manual trigger (Tasks 1,3) ✓; executePlan reuse for sync run_ids (Task 2) ✓; broken/stale disabled selection (Task 5 helper + Task 6 UI) ✓; delete engine manual+scheduled (Task 8) ✓; Archived tab removed / single Plan Runs log (Task 7) ✓; duration bug bundled fix (Tasks 4,7) ✓; wave rollups already read `test_plan_runs` only — verified, no change needed (noted in Task 8/spec) ✓; tables retained (Task 8 keeps schema) ✓; tests for endpoint/scheduler-no-legacy/selection (Tasks 1,3,5; "no test_runs" checked in Task 10 smoke) ✓.
- **Placeholder scan:** none — every code step shows full code; every run step shows an exact command + expected result.
- **Type consistency:** `runWithConcurrency(items, limit, worker)`, `runPlanBatch(planIds, triggerType, concurrency) → { pairs, done }`, `BatchPair {plan_id, run_id}`, `executePlan(..., existingRunId?)`, `buildPieceGroups(coverage, plans) → PieceGroup[]`, `runDurationSeconds(started, completed)` — names/signatures match across tasks and the client/server call sites.
