# Stale test-plan guard on connection change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a piece's active connection changes, mark its approved plans stale, block (not fail) runs of stale plans, and give a one-click Regenerate on the piece page.

**Architecture:** Add one flag column (`needs_regen`) to `test_plans`. Set it from the connection-change routes; clear it when a plan is regenerated/approved. Add a second pre-flight gate in `plan-executor.ts`'s `executePlan` that records a stale plan's run as `blocked` (reusing PR #14's `blocked` status) with a `stepId: 'stale'` marker. That marker also drives a server-only backlinks guard so blocked stale rows show the plan's message but not the wrong "Fix in AP" buttons. The client surfaces a warning banner + Regenerate button on the piece page.

**Tech Stack:** TypeScript, Express, SQLite (better-sqlite3 via a `DatabaseAdapter`), React + react-query (client), Vitest (server tests). Test runner: `npm test` (= `vitest run`). Run one file: `npx vitest run <path>`.

**Spec:** `docs/superpowers/specs/2026-08-17-stale-plan-on-connection-change-design.md`

---

## File Structure

**Modify (server):**
- `server/src/db/schema.ts` — add `needs_regen` migration (Task 1)
- `server/src/db/queries.ts` — `TestPlanRow` type, `markPlansStaleByPiece`, clear-on-write, `firstStepId` helper + backlinks guard (Tasks 1, 2, 3, 6)
- `server/src/services/plan-executor.ts` — reorder top + stale gate (Task 4)
- `server/src/routes/connections.ts` — call `markPlansStaleByPiece` (Task 5)

**Modify (client):**
- `client/src/lib/api.ts` — `TestPlan.needs_regen` (Task 7)
- `client/src/pages/PieceDetail.tsx` — banner, badge, regenerate loop (Tasks 8, 9)

**Create (tests):**
- `server/src/db/queries.stale.test.ts` — markStale, clear, backlinks guard (Tasks 2, 3, 6)
- `server/src/services/plan-executor.stale.test.ts` — the executePlan gate (Task 4)

---

## Task 1: Add the `needs_regen` column + type

**Files:**
- Modify: `server/src/db/schema.ts:332-336`
- Modify: `server/src/db/queries.ts:405-416` (`TestPlanRow`)
- Test: `server/src/db/queries.stale.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/src/db/queries.stale.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getTestPlan } from './queries.js';

function seedPlan(piece: string, action: string, status = 'approved'): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status)
     VALUES (?,?,?,?,?)`,
    [piece, action, 'action', '[]', status],
  ).lastId;
}

describe('test_plans.needs_regen column', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('defaults needs_regen to 0 on a new plan', () => {
    const id = seedPlan('slack', 'send_message');
    expect(getTestPlan(id)!.needs_regen).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: FAIL — `needs_regen` is `undefined` (property missing on the row / not on the type).

- [ ] **Step 3: Add the migration (AFTER the target_type rebuild)**

Ordering matters: the `target_type` migration (`schema.ts:341-369`) **recreates** the `test_plans` table by copying named columns into `test_plans_new`. A `needs_regen` column added *before* that block would be dropped by the rebuild. So place the new migration **after** the `target_type` block closes (`db.exec(\`PRAGMA foreign_keys = ON;\`);` at line 368, then the `}` at 369). Add, right after line 369, a fresh `table_info` read so it sees the post-rebuild schema:

```ts
  // Migration: add needs_regen flag to test_plans if missing.
  // 1 = the active connection changed after this plan was approved; regenerate before running.
  // MUST run after the target_type rebuild above, which recreates the table.
  const planCols2 = db.pragma(`table_info(test_plans)`) as { name: string }[];
  if (planCols2.length > 0 && !planCols2.some(c => c.name === 'needs_regen')) {
    db.exec(`ALTER TABLE test_plans ADD COLUMN needs_regen INTEGER NOT NULL DEFAULT 0`);
  }
```

Also add the column to the `CREATE TABLE IF NOT EXISTS test_plans` body (schema.ts:181-192) so fresh DBs have it — add the line after `agent_memory TEXT DEFAULT '',` (line 188):

```sql
      needs_regen INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 4: Add the field to the type**

In `server/src/db/queries.ts`, add to `TestPlanRow` (after `automation_status: string;`, line 413):

```ts
  needs_regen: number; // 0 | 1 — 1 = connection changed since approval; regenerate before running
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.ts server/src/db/queries.ts server/src/db/queries.stale.test.ts
git commit -m "feat(plans): add needs_regen column to test_plans"
```

---

## Task 2: `markPlansStaleByPiece` query

**Files:**
- Modify: `server/src/db/queries.ts` (add after `deleteTestPlansByPiece`, line 540)
- Test: `server/src/db/queries.stale.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/db/queries.stale.test.ts`:

```ts
import { markPlansStaleByPiece } from './queries.js';

describe('markPlansStaleByPiece', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('flags only approved plans of the named piece', () => {
    const approved = seedPlan('slack', 'send_message', 'approved');
    const draft = seedPlan('slack', 'find_channel', 'draft');
    const other = seedPlan('github', 'create_issue', 'approved');

    const changed = markPlansStaleByPiece('slack');

    expect(changed).toBe(1);
    expect(getTestPlan(approved)!.needs_regen).toBe(1);
    expect(getTestPlan(draft)!.needs_regen).toBe(0);   // drafts untouched
    expect(getTestPlan(other)!.needs_regen).toBe(0);   // other pieces untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: FAIL — `markPlansStaleByPiece is not a function` (not exported).

- [ ] **Step 3: Implement the query**

In `server/src/db/queries.ts`, add after `deleteTestPlansByPiece` (after line 540):

```ts
/**
 * Mark all APPROVED plans for a piece as stale (connection changed → resource IDs may be wrong).
 * Draft plans are left alone. Returns the number of rows changed.
 */
export function markPlansStaleByPiece(pieceName: string): number {
  return getDb().run(
    `UPDATE test_plans SET needs_regen = 1, updated_at = datetime('now')
       WHERE piece_name = ? AND status = 'approved'`,
    [pieceName],
  ).changes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.stale.test.ts
git commit -m "feat(plans): markPlansStaleByPiece flags approved plans"
```

---

## Task 3: Clear the flag on regenerate / approve

**Files:**
- Modify: `server/src/db/queries.ts:447-450` (`createTestPlan` update branch) and `:511-520` (`updateTestPlan`)
- Test: `server/src/db/queries.stale.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/db/queries.stale.test.ts`:

```ts
import { createTestPlan, updateTestPlan } from './queries.js';

describe('needs_regen clears on rewrite/approve', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('createTestPlan (regenerate) clears the flag on the reused row', () => {
    const id = seedPlan('slack', 'send_message', 'approved');
    markPlansStaleByPiece('slack');
    expect(getTestPlan(id)!.needs_regen).toBe(1);

    // Regeneration reuses the same (piece, action, type) row via createTestPlan's update branch.
    createTestPlan({ piece_name: 'slack', target_action: 'send_message', steps: '[]', status: 'draft' });
    expect(getTestPlan(id)!.needs_regen).toBe(0);
  });

  it('updateTestPlan clears the flag when steps are rewritten', () => {
    const id = seedPlan('slack', 'send_message', 'approved');
    markPlansStaleByPiece('slack');
    updateTestPlan(id, { steps: '[]' });
    expect(getTestPlan(id)!.needs_regen).toBe(0);
  });

  it('updateTestPlan does NOT clear the flag on a status-only update', () => {
    const id = seedPlan('slack', 'send_message', 'approved');
    markPlansStaleByPiece('slack');
    updateTestPlan(id, { status: 'approved' });
    expect(getTestPlan(id)!.needs_regen).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: FAIL — both new cases still read `needs_regen` as `1`.

- [ ] **Step 3: Add `needs_regen = 0` to both UPDATE statements**

In `createTestPlan`'s update branch (`server/src/db/queries.ts:447-450`), change the UPDATE to:

```ts
      db.run(`
        UPDATE test_plans SET steps = ?, status = ?, agent_memory = ?, automation_status = ?, needs_regen = 0, updated_at = datetime('now')
        WHERE id = ?
      `, [p.steps, p.status || 'draft', p.agent_memory || '', automationStatus, existing.id]);
```

In `updateTestPlan` (`server/src/db/queries.ts:511-520`), change the UPDATE to:

```ts
  const current = getTestPlan(id);
  if (!current) return undefined;
  const stepsJson = updates.steps ?? current.steps;
  const automationStatus = computeAutomationStatus(stepsJson);
  // Clear stale ONLY when the plan's steps are rewritten (a real regeneration). A status-only or
  // memory-only update must not un-stale a plan whose content still targets the old account.
  const needsRegen = updates.steps !== undefined ? 0 : current.needs_regen;
  getDb().run(`
    UPDATE test_plans SET steps = ?, status = ?, agent_memory = ?, automation_status = ?, needs_regen = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [
    stepsJson,
    updates.status ?? current.status,
    updates.agent_memory ?? current.agent_memory,
    automationStatus,
    needsRegen,
    id,
  ]);
  return getTestPlan(id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.stale.test.ts
git commit -m "feat(plans): clear needs_regen when a plan is rewritten or re-approved"
```

---

## Task 4: The stale gate in `executePlan` (with reorder)

**Files:**
- Modify: `server/src/services/plan-executor.ts:304-340`
- Test: `server/src/services/plan-executor.stale.test.ts` (new)

**Why reorder:** Today `getPieceMetadata()` (line 312, a network call) runs before the gates. Moving it below both gates means a `blocked` run (broken connection OR stale plan) does **zero** ActivePieces calls — faster, and unit-testable without mocking AP. Precedence: broken-connection gate first (regenerating needs a live connection), stale gate second.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/plan-executor.stale.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { executePlan } from './plan-executor.js';

function seedStepPlan(needsRegen: number): number {
  // One real step so the `steps.length === 0` guard passes; no active connection is seeded,
  // so the broken-connection gate is skipped and getPieceMetadata is never reached.
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Do it', description: '', actionName: 'x',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['slack', 'send_message', 'action', steps, 'approved', needsRegen],
  ).lastId;
}

describe('executePlan — stale plan gate', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('blocks a stale plan without executing steps', async () => {
    const planId = seedStepPlan(1);
    const run = await executePlan(planId, () => {});
    expect(run.status).toBe('blocked');
    const steps = JSON.parse(run.step_results);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepId).toBe('stale');
    expect(steps[0].status).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/services/plan-executor.stale.test.ts`
Expected: FAIL — the run is not `blocked` (executePlan tries to fetch piece metadata / run the step).

- [ ] **Step 3: Reorder the top of `executePlan` and add the gate**

In `server/src/services/plan-executor.ts`, the current top is (lines 304-340):

```ts
  const plan = getTestPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const steps: TestPlanStep[] = JSON.parse(plan.steps);
  if (steps.length === 0) throw new Error('Plan has no steps');

  // Get piece metadata
  const client = createClient();
  const pieceMeta: PieceMetadataFull = await client.getPieceMetadata(plan.piece_name);

  // Create run (stamped with the schedule fire's wave, if any)
  const run = createPlanRun(planId, triggerType, wave);
  const runId = run.id;
  const emitter = getResumeEmitter(runId);

  // Pre-flight: if this piece's imported connection is deleted/errored upstream, do NOT run.
  // ...
  const activeConn = getConnectionByPiece(plan.piece_name);
  const health = activeConn
    ? await checkImportedConnectionHealth(client, activeConn.connection_value).catch(() => null)
    : null;
  if (health && health.status !== 'live') {
    const blockedStep: StepResult = {
      stepId: 'connection', label: 'Connection check', status: 'skipped',
      output: null, error: health.detail, duration_ms: 0,
    };
    updatePlanRun(runId, {
      status: 'blocked',
      completed_at: new Date().toISOString(),
      step_results: JSON.stringify([blockedStep]),
    });
    onProgress({ type: 'plan_blocked', runId, message: health.detail, stepResults: [blockedStep] });
    cleanupEmitter(runId);
    return getPlanRun(runId)!;
  }
```

Replace that whole span with (note: `getPieceMetadata` moved to the bottom, stale gate added):

```ts
  const plan = getTestPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const steps: TestPlanStep[] = JSON.parse(plan.steps);
  if (steps.length === 0) throw new Error('Plan has no steps');

  const client = createClient();

  // Create run (stamped with the schedule fire's wave, if any)
  const run = createPlanRun(planId, triggerType, wave);
  const runId = run.id;
  const emitter = getResumeEmitter(runId);

  // Gate 1 — broken connection: if this piece's imported connection is deleted/errored upstream,
  // do NOT run. Record `blocked` so the Health board reads it as an environment problem, not a
  // piece regression. A thrown listConnections() (network/creds) does NOT block — the .catch lets
  // the plan proceed and any real auth error classifies as today.
  const activeConn = getConnectionByPiece(plan.piece_name);
  const health = activeConn
    ? await checkImportedConnectionHealth(client, activeConn.connection_value).catch(() => null)
    : null;
  if (health && health.status !== 'live') {
    const blockedStep: StepResult = {
      stepId: 'connection', label: 'Connection check', status: 'skipped',
      output: null, error: health.detail, duration_ms: 0,
    };
    updatePlanRun(runId, {
      status: 'blocked',
      completed_at: new Date().toISOString(),
      step_results: JSON.stringify([blockedStep]),
    });
    onProgress({ type: 'plan_blocked', runId, message: health.detail, stepResults: [blockedStep] });
    cleanupEmitter(runId);
    return getPlanRun(runId)!;
  }

  // Gate 2 — stale plan: the active connection changed after this plan was approved, so its
  // frozen account-scoped inputs (e.g. Linear teamId/issueId) may point at the wrong account.
  // Block (never fail) until the user regenerates. The `stepId: 'stale'` marker distinguishes
  // this from Gate 1 for the Health/Attention backlinks guard (see queries.ts).
  if (plan.needs_regen === 1) {
    const staleStep: StepResult = {
      stepId: 'stale', label: 'Plan needs regenerating', status: 'skipped',
      output: null,
      error: 'Connection changed after this plan was approved — regenerate the plan.',
      duration_ms: 0,
    };
    updatePlanRun(runId, {
      status: 'blocked',
      completed_at: new Date().toISOString(),
      step_results: JSON.stringify([staleStep]),
    });
    onProgress({ type: 'plan_blocked', runId, message: staleStep.error!, stepResults: [staleStep] });
    cleanupEmitter(runId);
    return getPlanRun(runId)!;
  }

  // Piece metadata is only needed to actually run steps — fetch after the gates so a blocked
  // run makes zero ActivePieces calls.
  const pieceMeta: PieceMetadataFull = await client.getPieceMetadata(plan.piece_name);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/services/plan-executor.stale.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/plan-executor.ts server/src/services/plan-executor.stale.test.ts
git commit -m "feat(plans): block a stale plan's run instead of failing it"
```

---

## Task 5: Mark plans stale from the connection-change routes

**Files:**
- Modify: `server/src/routes/connections.ts` (import route :57-76, activate :79-84, create :96-113, update :116-131, delete :191-195)

No unit test: these are thin HTTP glue over `markPlansStaleByPiece` (already tested in Task 2) and there is no route-test harness in this repo. Verified by typecheck + the manual check below.

- [ ] **Step 1: Mark stale in the import route**

In `server/src/routes/connections.ts`, in `POST /import`, after `const conn = db.createConnection({...});` (line 71) and before `res.status(201)...` (line 72), add:

```ts
    db.markPlansStaleByPiece(conn.piece_name);
```

- [ ] **Step 2: Mark stale in the activate route**

In `POST /:id/activate` (lines 79-84), after the `if (!conn) return ...` guard (line 82), add:

```ts
  db.markPlansStaleByPiece(conn.piece_name);
```

- [ ] **Step 3: Mark stale in the create route**

In `POST /` (lines 96-113), after `const conn = db.createConnection({...});` (line 108) and before `res.status(201)...`, add:

```ts
    db.markPlansStaleByPiece(conn.piece_name);
```

- [ ] **Step 4: Mark stale in the update route (only when the active connection's value changes)**

In `PUT /:id` (lines 116-131), replace the tail (from `const conn = db.updateConnection(id, updates);` to the end of the handler) with:

```ts
  const conn = db.updateConnection(id, updates);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  // Only a credential change on the ACTIVE connection can invalidate approved plans.
  if (updates.connection_value !== undefined && conn.is_active) {
    db.markPlansStaleByPiece(conn.piece_name);
  }
  res.json({ ...conn, connection_value: '***' });
```

- [ ] **Step 5: Mark stale in the delete route (only when the active connection is removed)**

In `DELETE /:id` (lines 191-195), replace the handler body with:

```ts
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const conn = db.getConnection(id);              // capture piece + active state before delete
  const ok = db.deleteConnection(id);
  if (!ok) return res.status(404).json({ error: 'Connection not found' });
  // Deleting the ACTIVE connection promotes another (or leaves none) — either way the piece's
  // active connection changed, so its approved plans are stale.
  if (conn && conn.is_active) db.markPlansStaleByPiece(conn.piece_name);
  res.json({ success: true });
});
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev` (starts server + client). In another shell, with an approved plan for a piece that has a connection, activate a different connection for it and confirm the plan is flagged:

```bash
# Replace <id> with an inactive connection id for the piece, from GET /api/connections.
curl -s -X POST http://localhost:3001/api/connections/<id>/activate >/dev/null
sqlite3 data/piece-tester.db "SELECT target_action, needs_regen FROM test_plans WHERE piece_name='<piece>';"
```

Expected: the piece's `approved` plans show `needs_regen = 1`.
(If the server runs on a different port, use the one printed by `npm run dev`.)

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/connections.ts
git commit -m "feat(connections): mark a piece's plans stale when its active connection changes"
```

---

## Task 6: Backlinks guard — don't show "Fix in AP" for a stale block

**Files:**
- Modify: `server/src/db/queries.ts` (add `firstStepId` near `firstStepMessage` :786; guard in `getPieceHealth` :826-868 and `getAttentionItems` :1015-1017)
- Test: `server/src/db/queries.stale.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/db/queries.stale.test.ts`:

```ts
import { getPieceHealth, getAttentionItems } from './queries.js';

function seedScheduledRun(planId: number, status: string, stepResults: string): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'scheduled', stepResults, '2026-08-17 10:00:00'],
  ).lastId;
}

describe('blocked backlinks guard (stale vs connection)', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('a STALE block gets no connection backlinks', () => {
    const plan = seedPlan('linear', 'update_issue', 'approved');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'stale', status: 'skipped', error: 'Connection changed — regenerate the plan.' },
    ]));

    const row = getPieceHealth().find(r => r.piece_name === 'linear')!;
    expect(row.status).toBe('blocked');
    expect(row.backlinks).toBeNull();
    expect(row.blocked_reason).toContain('regenerate');

    const att = getAttentionItems().find(i => i.piece_name === 'linear')!;
    expect(att.backlinks).toBeNull();
  });

  it('a CONNECTION block still gets backlinks (regression guard)', () => {
    const plan = seedPlan('hubspot', 'create_contact', 'approved');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'connection', status: 'skipped', error: 'Connection was deleted in Activepieces' },
    ]));

    const row = getPieceHealth().find(r => r.piece_name === 'hubspot')!;
    expect(row.backlinks?.reimport).toBe('/connections?piece=hubspot');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: FAIL — the STALE case's `backlinks` is set (currently every blocked piece gets backlinks).

- [ ] **Step 3: Add the `firstStepId` helper**

In `server/src/db/queries.ts`, add right after `firstStepMessage` (after line 791):

```ts
/** First step's stepId — distinguishes a 'connection' block (PR #14) from a 'stale' block. */
function firstStepId(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    return Array.isArray(steps) && steps[0]?.stepId ? String(steps[0].stepId) : null;
  } catch { return null; }
}
```

- [ ] **Step 4: Guard backlinks in `getPieceHealth`**

Track, per piece, whether any blocked run is a *connection* block. In the blocked branch (`queries.ts:852-855`), replace:

```ts
    else if (row.last_status === 'blocked') {
      h.actions_blocked++;
      if (!h.blocked_reason) h.blocked_reason = firstStepMessage(row.step_results);
    }
```

with:

```ts
    else if (row.last_status === 'blocked') {
      h.actions_blocked++;
      if (!h.blocked_reason) h.blocked_reason = firstStepMessage(row.step_results);
      if (firstStepId(row.step_results) === 'connection') connectionBlocked.add(row.piece_name);
    }
```

Declare the set just before the `for (const row of latest)` loop (before line 826):

```ts
  const connectionBlocked = new Set<string>(); // pieces whose block is a broken connection (not stale)
```

Then in the finalizing loop, change the backlinks assignment (`queries.ts:865-867`):

```ts
    if (h.status === 'blocked' && connectionBlocked.has(h.piece_name)) {
      h.backlinks = buildConnectionBacklinks(settings.base_url, settings.project_id, h.piece_name);
    }
```

- [ ] **Step 5: Guard backlinks in `getAttentionItems`**

In `server/src/db/queries.ts`, replace the backlinks line (`:1015-1017`):

```ts
    const backlinks = isBlocked
      ? buildConnectionBacklinks(getSettings().base_url, getSettings().project_id, row.piece_name)
      : null;
```

with:

```ts
    // A stale-plan block is not a connection problem — no Fix-in-AP / Re-import backlinks.
    const isStaleBlock = isBlocked && firstStepId(row.step_results) === 'stale';
    const backlinks = (isBlocked && !isStaleBlock)
      ? buildConnectionBacklinks(getSettings().base_url, getSettings().project_id, row.piece_name)
      : null;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run server/src/db/queries.stale.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the existing health test (regression guard)**

Run: `npx vitest run server/src/db/queries.health.test.ts`
Expected: PASS — the connection-block case still attaches backlinks.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.stale.test.ts
git commit -m "feat(health): withhold connection backlinks from a stale-plan block"
```

---

## Task 7: Expose `needs_regen` to the client

**Files:**
- Modify: `client/src/lib/api.ts:280-292` (`TestPlan`)

The `test-plans` / `listTestPlans` responses are the DB rows (`SELECT *`), so the field flows through automatically once the type includes it.

- [ ] **Step 1: Add the field to the client type**

In `client/src/lib/api.ts`, add to `interface TestPlan` (after `automation_status: ...;`, line 289):

```ts
  /** 1 = the active connection changed after approval; regenerate before running. */
  needs_regen?: number;
```

- [ ] **Step 2: Verify the client compiles**

Run: `npm run build:client`
Expected: build succeeds (no TypeScript error on the new field).

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "feat(client): expose plan needs_regen flag"
```

---

## Task 8: Piece-page UI — stale banner, badge, and one-click regenerate

**Files:**
- Modify: `client/src/pages/PieceDetail.tsx`

One task (one commit) because the banner button references the regenerate function — they must land together to compile. No client test harness exists in this repo, so this is verified by running the app. Reuses the existing per-action generator `api.streamAiPlanV2(pieceName, actionName, callbacks)` (`client/src/lib/api.ts:630`); each successful regeneration re-approves the plan server-side, clearing `needs_regen` (Task 3), after which we reload plans to refresh the banner/badges.

- [ ] **Step 1: Add the derived list, state, and functions**

In `client/src/pages/PieceDetail.tsx`, near the other `useState` hooks / derived values (e.g. after `activeAiJobs` is defined, ~line 147), add:

```tsx
  const [regenerating, setRegenerating] = useState(false);

  const staleActions = Object.entries(actionPlans)
    .filter(([, p]) => p.needs_regen === 1)
    .map(([action]) => action);

  async function reloadPlans() {
    if (!name) return;
    try {
      const plans = await api.listTestPlans(name);
      const planMap: Record<string, TestPlan> = {};
      const triggerMap: Record<string, TestPlan> = {};
      for (const p of plans) {
        if (p.target_type === 'trigger') triggerMap[p.target_action] = p;
        else planMap[p.target_action] = p;
      }
      setActionPlans(planMap);
      setTriggerPlans(triggerMap);
    } catch { /* keep current */ }
  }

  async function regenerateStalePlans() {
    if (!name || regenerating) return;
    setRegenerating(true);
    try {
      for (const action of staleActions) {
        await new Promise<void>((resolve) => {
          api.streamAiPlanV2(name, action, {
            onLog: () => {},
            onResult: () => {},
            onError: () => {},        // skip a failed regen; the plan stays stale and blocked
            onDone: () => resolve(),
          });
        });
        await reloadPlans();          // refresh flags as each action completes
      }
    } finally {
      setRegenerating(false);
    }
  }
```

Also ensure `AlertTriangle` is imported from `lucide-react` (add it to the existing `lucide-react` import line at the top of the file if not already present). `PlanStreamCallbacks` in this codebase uses `onLog`, `onResult`, `onError`, `onDone`, and an optional `onPlanProgress?` (see `streamAiPlanV2`, `api.ts:649-655`), so the four-field object above satisfies it.

- [ ] **Step 2: Add the banner above the action list**

Immediately above the action list (find the "STEP 2 / Configure" section header around line 851; place this as the first child of that section), add:

```tsx
  {staleActions.length > 0 && (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
      <AlertTriangle size={16} className="flex-shrink-0 text-amber-400" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-amber-300">Connection changed — {staleActions.length} plan(s) need regenerating</p>
        <p className="mt-0.5 text-xs text-amber-300/70">These plans were approved against the previous connection and will be blocked (not run) until regenerated.</p>
      </div>
      <button
        onClick={regenerateStalePlans}
        disabled={regenerating}
        className="ml-auto whitespace-nowrap rounded bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
      >
        {regenerating ? 'Regenerating…' : 'Regenerate plans'}
      </button>
    </div>
  )}
```

- [ ] **Step 3: Add a "Stale" badge on each affected action**

At the plan-status badge (`PieceDetail.tsx:1072-1082`), add — immediately before the existing "Plan Ready / Draft" badge span — a stale badge:

```tsx
  {actionPlans[actionName]?.needs_regen === 1 && (
    <span className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400">
      <AlertTriangle size={10} /> Stale
    </span>
  )}
```

- [ ] **Step 4: Build the client**

Run: `npm run build:client`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 5: Verify in the app**

Run: `npm run dev`. Open a piece that has an approved plan, switch its active connection, reload the piece page. Expected: the amber banner shows a count and each affected action shows a "Stale" badge. Click **Regenerate plans** → button shows "Regenerating…", plans regenerate one by one, badges clear as each finishes, and the banner disappears when all are done.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PieceDetail.tsx
git commit -m "feat(piece-detail): warn + one-click regenerate for stale plans"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the whole server test suite**

Run: `npm test`
Expected: all tests PASS (the pre-existing suite + the new `queries.stale.test.ts` and `plan-executor.stale.test.ts`).

- [ ] **Step 2: Build the client**

Run: `npm run build:client`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Manual smoke (the Linear scenario)**

Run: `npm run dev`. Reproduce the original bug and confirm it's fixed:
1. A piece with several approved plans + a schedule.
2. Switch its active connection.
3. Trigger the schedule (or run the plans).

Expected: every stale plan comes back **blocked** with "Plan needs regenerating…", the piece page shows the banner + "Regenerate plans", and no run is reported as a red piece failure. After clicking Regenerate, the plans run normally again.

---

## Self-Review Notes

- **Spec coverage:** §1 data → Task 1; §2 set flag → Tasks 2, 5; §3 clear flag → Task 3; §4 gate → Task 4; §5 backlinks guard → Task 6; §6 UI → Tasks 7-8. Testing section → Tasks 2, 3, 4, 6 (server) + manual (routes/client, no harness).
- **Ordering choice:** Task 4 places the stale gate *after* the broken-connection gate (broken connection wins, since regenerating needs a live connection) — matches the spec's co-occurrence edge case.
- **Naming consistency:** `markPlansStaleByPiece`, `needs_regen`, `firstStepId`, `staleActions`, `regenerateStalePlans`, `regenerating` used identically across tasks.
- **Out of scope (per spec Non-goals):** no account-diffing; no bulk-regenerate server endpoint; the "no active connection at all" local-delete gap is untouched; no dedicated Regenerate button on Health/Needs-Attention rows.
