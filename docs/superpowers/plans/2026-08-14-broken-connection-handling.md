# Broken imported-connection handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a piece's imported connection is deleted or errored upstream in Activepieces, don't run its test — record the run as `blocked`, show the piece on the Health tab as "Connection needs fixing" (not a failure), with **Fix in Activepieces** and **Re-import here** backlinks.

**Architecture:** A pure detection module (`connection-health.ts`) classifies an imported connection against the upstream `listConnections()` result. `executePlan` calls it before running any step; if broken it writes a new `blocked` run status and returns early. The three readers of `test_plan_runs` (`getPieceHealth`, `getAttentionItems`, `getWaveDetail`) learn about `blocked` so it is surfaced as an environment issue, never counted as a piece failure. The frontend renders the new state with backlinks.

**Tech Stack:** TypeScript, Express (server), better-sqlite3 via a `DatabaseAdapter`, Vitest (`npm test` from repo root; `DB_PATH=./data/test.db`), React + TanStack Query (client).

**Spec:** `docs/superpowers/specs/2026-08-14-broken-connection-handling-design.md`

**Key facts (verified in code):**
- Health tab / Needs Attention / Scheduled Runs read `test_plan_runs` (statuses `completed`/`failed`/`running`), NOT `test_results`. `status` is plain `TEXT` — the new `blocked` value needs no migration.
- `AppConnection` (`server/src/services/ap-client.ts:75`) = `{ id, pieceName, displayName, projectId, externalId, type, status, ... }`.
- `executePlan` (`server/src/services/plan-executor.ts:296`): `const client = createClient()` (310), `createPlanRun(...)` (313), `getResumeEmitter` (315), `cleanupEmitter` (143), `PlanProgress.type` union (121), `StepResult` type (~line 39).
- `updatePlanRun(id, { status, completed_at, step_results, ... })` (`queries.ts:1545`) accepts `status: string`.
- `getConnectionByPiece(pieceName)` (`queries.ts:116`) returns the active `PieceConnectionRow` (its `connection_value` is JSON; imported = `{ _imported: true, remote_id }`).
- `getSettings()` (`queries.ts:25`) → `{ base_url, project_id, ... }`; default `base_url = 'https://cloud.activepieces.com/api'`.
- No import cycle: `connection-health.ts` imports only from `ap-client.js`; `queries.ts` and `plan-executor.ts` import from `connection-health.js` (one-directional).

---

## Task 1: Pure detection + backlink builders

**Files:**
- Create: `server/src/services/connection-health.ts`
- Test: `server/src/services/connection-health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/connection-health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyImported, buildConnectionBacklinks } from './connection-health.js';
import type { AppConnection } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: 'p', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

describe('classifyImported', () => {
  it('missing when remoteId is absent from the list', () => {
    expect(classifyImported('gone', [conn({ id: 'id1', externalId: 'ext1' })]).status).toBe('missing');
  });
  it('error when upstream status is ERROR', () => {
    expect(classifyImported('id1', [conn({ id: 'id1', status: 'ERROR' })]).status).toBe('error');
  });
  it('live when present and active', () => {
    expect(classifyImported('id1', [conn({ id: 'id1', status: 'ACTIVE' })]).status).toBe('live');
  });
  it('matches by externalId too', () => {
    expect(classifyImported('ext1', [conn({ id: 'id1', externalId: 'ext1' })]).status).toBe('live');
  });
});

describe('buildConnectionBacklinks', () => {
  it('strips a trailing /api and builds both links', () => {
    const b = buildConnectionBacklinks('https://cloud.activepieces.com/api', 'projX', 'hubspot');
    expect(b.activepieces).toBe('https://cloud.activepieces.com/projects/projX/connections');
    expect(b.reimport).toBe('/connections?piece=hubspot');
  });
  it('works when baseUrl has no /api suffix', () => {
    const b = buildConnectionBacklinks('https://ap.example.com', 'p1', 'slack');
    expect(b.activepieces).toBe('https://ap.example.com/projects/p1/connections');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- connection-health` (from repo root)
Expected: FAIL — `Failed to resolve import "./connection-health.js"` / functions not defined.

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/services/connection-health.ts`:

```ts
import type { AppConnection } from './ap-client.js';

export type RemoteStatus = 'live' | 'missing' | 'error';
export interface HealthResult { status: RemoteStatus; detail: string; }
export interface ConnectionBacklinks { activepieces: string; reimport: string; }

/**
 * Classify an imported connection against the upstream connection list. Pure.
 * Match rule mirrors resolveConnectionAuthInput: rc.id === remoteId || rc.externalId === remoteId.
 */
export function classifyImported(remoteId: string, remoteList: AppConnection[]): HealthResult {
  const remote = remoteList.find(rc => rc.id === remoteId || rc.externalId === remoteId);
  if (!remote) return { status: 'missing', detail: 'Connection was deleted in Activepieces' };
  if (String(remote.status).toUpperCase() === 'ERROR') {
    return { status: 'error', detail: 'Connection is in an error state in Activepieces — reauthorize it' };
  }
  return { status: 'live', detail: '' };
}

/**
 * Build the two "fix it" backlinks for a broken connection. Pure.
 * baseUrl is settings.base_url (e.g. "https://cloud.activepieces.com/api").
 */
export function buildConnectionBacklinks(baseUrl: string, projectId: string, pieceName: string): ConnectionBacklinks {
  const dashboard = baseUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
  return {
    activepieces: `${dashboard}/projects/${projectId}/connections`,
    reimport: `/connections?piece=${encodeURIComponent(pieceName)}`,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- connection-health`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/connection-health.ts server/src/services/connection-health.test.ts
git commit -m "feat(connections): classifyImported + backlink builder"
```

---

## Task 2: `checkImportedConnectionHealth` (injectable, no DB)

**Files:**
- Modify: `server/src/services/connection-health.ts`
- Test: `server/src/services/connection-health.test.ts`

- [ ] **Step 1: Add the failing test** (append to `connection-health.test.ts`)

```ts
import { checkImportedConnectionHealth } from './connection-health.js';
import type { ActivepiecesClient } from './ap-client.js';

function fakeClient(list: AppConnection[]): ActivepiecesClient {
  return { listConnections: async () => list } as unknown as ActivepiecesClient;
}

describe('checkImportedConnectionHealth', () => {
  it('returns null for a manual (non-imported) connection', async () => {
    const r = await checkImportedConnectionHealth(fakeClient([]), JSON.stringify({ secret_text: 'x' }));
    expect(r).toBeNull();
  });
  it('returns null for unparseable connection_value', async () => {
    expect(await checkImportedConnectionHealth(fakeClient([]), 'not json')).toBeNull();
  });
  it('returns missing (with remoteId) for a deleted imported connection', async () => {
    const r = await checkImportedConnectionHealth(fakeClient([]), JSON.stringify({ _imported: true, remote_id: 'gone' }));
    expect(r?.status).toBe('missing');
    expect(r?.remoteId).toBe('gone');
  });
  it('returns live when the imported connection still exists', async () => {
    const list = [conn({ id: 'id1', status: 'ACTIVE' })];
    const r = await checkImportedConnectionHealth(fakeClient(list), JSON.stringify({ _imported: true, remote_id: 'id1' }));
    expect(r?.status).toBe('live');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- connection-health`
Expected: FAIL — `checkImportedConnectionHealth is not a function`.

- [ ] **Step 3: Implement** (append to `connection-health.ts`; add `ActivepiecesClient` to the existing type import)

Change the import line at the top of `connection-health.ts` to:
```ts
import type { AppConnection, ActivepiecesClient } from './ap-client.js';
```

Append:
```ts
/**
 * Health of an imported connection given its raw `connection_value` JSON.
 * Returns null when the connection is NOT imported (manual creds live locally and cannot be
 * deleted upstream) or the value is unparseable. Otherwise fetches the upstream list once and
 * classifies. A thrown listConnections() (network / bad creds) PROPAGATES — callers decide;
 * we never treat a fetch failure as 'missing'.
 */
export async function checkImportedConnectionHealth(
  client: ActivepiecesClient,
  connectionValueJson: string,
): Promise<(HealthResult & { remoteId: string }) | null> {
  let parsed: { _imported?: boolean; remote_id?: unknown } | null = null;
  try { parsed = JSON.parse(connectionValueJson); } catch { return null; }
  if (!parsed || !parsed._imported || !parsed.remote_id) return null;
  const remoteId = String(parsed.remote_id);
  const remoteList = await client.listConnections();
  return { remoteId, ...classifyImported(remoteId, remoteList) };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- connection-health`
Expected: PASS (10 assertions total).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/connection-health.ts server/src/services/connection-health.test.ts
git commit -m "feat(connections): checkImportedConnectionHealth"
```

---

## Task 3: Pre-flight gate in `executePlan`

**Files:**
- Modify: `server/src/services/plan-executor.ts` (imports ~6-16; `PlanProgress.type` ~121; gate after line ~315)

No unit test (gate is thin glue calling the Task-2 helper; `createClient()` is internal to `executePlan`). Covered by Task 2 (decision) + Tasks 4-6 (readers) + manual UI verification. Verify with a typecheck.

- [ ] **Step 1: Extend the queries import** — change the `from '../db/queries.js'` import block to include `getConnectionByPiece`:

```ts
import {
  createPlanRun, getPlanRun, updatePlanRun,
  getTestPlan, getConnectionByPiece, type TestPlanRunRow, type WaveInfo,
} from '../db/queries.js';
```

- [ ] **Step 2: Add the connection-health import** (below the `createClient` import from `./test-engine.js`):

```ts
import { checkImportedConnectionHealth } from './connection-health.js';
```

- [ ] **Step 3: Add `'plan_blocked'` to the progress union** (`PlanProgress.type`, ~line 121):

```ts
  type: 'step_start' | 'step_complete' | 'step_failed' | 'paused_for_human' | 'paused_for_approval' | 'plan_complete' | 'plan_failed' | 'plan_blocked' | 'error';
```

- [ ] **Step 4: Insert the gate** — immediately AFTER `const emitter = getResumeEmitter(runId);` (line ~315) and BEFORE `const stepResults = new Map<...>()`:

```ts
  // Pre-flight: if this piece's imported connection is deleted/errored upstream, do NOT run.
  // Record the run as `blocked` (it never executed a step) so the Health board reads it as an
  // environment problem, not a piece regression. A thrown listConnections() (network/creds)
  // does NOT block — the .catch lets the plan proceed and any real auth error classifies as today.
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

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit` (or the repo's typecheck script if present)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/plan-executor.ts
git commit -m "feat(connections): block plan runs whose imported connection is broken"
```

---

## Task 4: `getPieceHealth` — surface `blocked`

**Files:**
- Modify: `server/src/db/queries.ts` (`PieceHealthRow` ~756; add `firstStepMessage`; `getPieceHealth` ~781; add `buildConnectionBacklinks` import)
- Test: `server/src/db/queries.health.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/src/db/queries.health.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getPieceHealth } from './queries.js';

function seedPlan(piece: string, action: string): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES (?,?,?,?)`,
    [piece, action, 'action', 'approved'],
  ).lastId;
}
function seedScheduledRun(planId: number, status: string, stepResults = '[]'): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'scheduled', stepResults, '2026-08-14 10:00:00'],
  ).lastId;
}

describe('getPieceHealth — blocked connection', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('reports a blocked connection as status "blocked", not "failing"', () => {
    const plan = seedPlan('hubspot', 'create_contact');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'connection', status: 'skipped', error: 'Connection was deleted in Activepieces' },
    ]));

    const hub = getPieceHealth().find(r => r.piece_name === 'hubspot')!;
    expect(hub.status).toBe('blocked');
    expect(hub.actions_failing).toBe(0);
    expect(hub.actions_blocked).toBe(1);
    expect(hub.blocked_reason).toContain('deleted');
    expect(hub.backlinks?.reimport).toBe('/connections?piece=hubspot');
    expect(hub.backlinks?.activepieces).toContain('/connections');
  });

  it('a passing run is still healthy (regression guard)', () => {
    const plan = seedPlan('slack', 'send_message');
    seedScheduledRun(plan, 'completed');
    expect(getPieceHealth().find(r => r.piece_name === 'slack')!.status).toBe('healthy');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- queries.health`
Expected: FAIL — `hub.status` is `'unknown'` (blocked branch missing) and `actions_blocked` is `undefined`.

- [ ] **Step 3: Add the import** — near the top of `queries.ts`, add:

```ts
import { buildConnectionBacklinks, type ConnectionBacklinks } from '../services/connection-health.js';
```

- [ ] **Step 4: Extend `PieceHealthRow`** (`queries.ts` ~756) to:

```ts
export interface PieceHealthRow {
  piece_name: string;
  status: 'failing' | 'blocked' | 'healthy' | 'unknown';
  actions_total: number;
  actions_passing: number;
  actions_failing: number;
  actions_blocked: number;
  last_run_at: string | null;
  failing_actions: { action: string; error: string | null; category: string; plan_id: number; run_id: number }[];
  blocked_reason: string | null;
  backlinks: ConnectionBacklinks | null;
  recent: string[]; // last ~12 run statuses, oldest→newest, for a sparkline
}
```

- [ ] **Step 5: Add the `firstStepMessage` helper** — directly below the existing `extractFirstStepError` function:

```ts
/** First step's error message regardless of status — used for blocked runs (sole step is 'skipped'). */
function firstStepMessage(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    return Array.isArray(steps) && steps[0]?.error ? String(steps[0].error) : null;
  } catch { return null; }
}
```

- [ ] **Step 6: Update `getPieceHealth`** — three edits inside the function:

(a) In the per-piece init object (where `failing_actions: []` is set), add the new fields:
```ts
        actions_total: 0, actions_passing: 0, actions_failing: 0, actions_blocked: 0,
        last_run_at: null, failing_actions: [], blocked_reason: null, backlinks: null,
        recent: recentByPiece.get(row.piece_name) ?? [],
```

(b) In the status branch (after the `else if (row.last_status === 'failed') { ... }` block), add:
```ts
    else if (row.last_status === 'blocked') {
      h.actions_blocked++;
      if (!h.blocked_reason) h.blocked_reason = firstStepMessage(row.step_results);
    }
```

(c) Replace the final status-assignment + sort block:
```ts
  const result = [...byPiece.values()];
  for (const h of result) {
    h.status = h.actions_failing > 0 ? 'failing'
      : h.actions_blocked > 0 ? 'blocked'
      : h.actions_passing > 0 ? 'healthy' : 'unknown';
  }
```
with:
```ts
  const result = [...byPiece.values()];
  const settings = getSettings();
  for (const h of result) {
    h.status = h.actions_failing > 0 ? 'failing'
      : h.actions_blocked > 0 ? 'blocked'
      : h.actions_passing > 0 ? 'healthy' : 'unknown';
    if (h.status === 'blocked') {
      h.backlinks = buildConnectionBacklinks(settings.base_url, settings.project_id, h.piece_name);
    }
  }
  // Order: failing first, then blocked, then everything else — most-failing first within a rank.
  const rank = (h: PieceHealthRow) => (h.status === 'failing' ? 0 : h.status === 'blocked' ? 1 : 2);
```
Then change the existing `result.sort(...)` line to:
```ts
  result.sort((a, b) =>
    (rank(a) - rank(b)) ||
    (b.actions_failing - a.actions_failing) ||
    a.piece_name.localeCompare(b.piece_name));
  return result;
```
(Delete the original single-line `result.sort((a, b) => (b.actions_failing - a.actions_failing) || a.piece_name.localeCompare(b.piece_name));` so it is not duplicated.)

- [ ] **Step 7: Run the test, verify it passes**

Run: `npm test -- queries.health`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.health.test.ts
git commit -m "feat(health): report blocked connections as their own status with backlinks"
```

---

## Task 5: `getAttentionItems` — a `reauth` item for blocked connections

**Files:**
- Modify: `server/src/db/queries.ts` (`AttentionItem` ~886; `getAttentionItems` ~924)
- Test: `server/src/db/queries.attention.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/src/db/queries.attention.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getAttentionItems } from './queries.js';

function seedPlan(piece: string, action: string): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES (?,?,?,?)`,
    [piece, action, 'action', 'approved'],
  ).lastId;
}
function seedScheduledRun(planId: number, status: string, stepResults = '[]'): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'scheduled', stepResults, '2026-08-14 10:00:00'],
  ).lastId;
}

describe('getAttentionItems — blocked connection', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('emits a reauth / connection_broken item with backlinks', () => {
    const plan = seedPlan('hubspot', 'create_contact');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'connection', status: 'skipped', error: 'Connection was deleted in Activepieces' },
    ]));

    const item = getAttentionItems().find(i => i.piece_name === 'hubspot')!;
    expect(item.bucket).toBe('reauth');
    expect(item.category).toBe('connection_broken');
    expect(item.error).toContain('deleted');
    expect(item.backlinks?.reimport).toBe('/connections?piece=hubspot');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- queries.attention`
Expected: FAIL — blocked runs are excluded by `WHERE r.status = 'failed'`, so `item` is `undefined`.

- [ ] **Step 3: Extend `AttentionItem`** (`queries.ts` ~886) — add one field before the closing brace:

```ts
  mute_id: number | null;
  backlinks: ConnectionBacklinks | null;  // present for connection_broken items
}
```

- [ ] **Step 4: Update the candidate query** — in `getAttentionItems`, add `r.status` to the SELECT and widen the WHERE. Change the `latest` query's SELECT/WHERE:

```ts
    SELECT p.id AS plan_id, p.piece_name, p.target_action,
           r.id AS run_id, r.status AS last_status, r.started_at AS last_run_at, r.step_results
    FROM test_plans p
    JOIN test_plan_runs r ON r.id = (
      SELECT r2.id FROM test_plan_runs r2
      WHERE r2.plan_id = p.id AND r2.trigger_type = 'scheduled'
      ORDER BY r2.id DESC LIMIT 1
    )
    WHERE r.status IN ('failed', 'blocked')
```
Also update the row type of that `db.all<...>` to include `last_status: string`.

- [ ] **Step 5: Branch on blocked inside the loop** — replace the block that computes `category/error`, `bucket`, `reason` for each row with a blocked-aware version. Find:

```ts
    const { category, error } = analyzeFailedRun(row.step_results);

    let bucket: AttentionItem['bucket'];
    if (category === 'auth') bucket = 'reauth';
    else if (category === 'transient' || category === 'rate_limit') bucket = 'noise';
    else bucket = streak >= 2 ? 'likely_broken' : 'watching';

    let reason: string;
    if (bucket === 'reauth') reason = 'connection auth failed — needs re-auth';
    else if (bucket === 'noise') reason = `${category} — likely environment/flake`;
    else if (bucket === 'likely_broken') reason = `failed ${streak}× in a row · ${category}`;
    else reason = flaky ? `flaky — recently passed and failed · ${category}` : `first failure · ${category}`;
```
Replace with:
```ts
    const isBlocked = row.last_status === 'blocked';
    const { category, error } = isBlocked
      ? { category: 'connection_broken', error: firstStepMessage(row.step_results) }
      : analyzeFailedRun(row.step_results);

    let bucket: AttentionItem['bucket'];
    if (isBlocked || category === 'auth') bucket = 'reauth';
    else if (category === 'transient' || category === 'rate_limit') bucket = 'noise';
    else bucket = streak >= 2 ? 'likely_broken' : 'watching';

    let reason: string;
    if (isBlocked) reason = error || 'connection deleted/errored in Activepieces — fix it';
    else if (bucket === 'reauth') reason = 'connection auth failed — needs re-auth';
    else if (bucket === 'noise') reason = `${category} — likely environment/flake`;
    else if (bucket === 'likely_broken') reason = `failed ${streak}× in a row · ${category}`;
    else reason = flaky ? `flaky — recently passed and failed · ${category}` : `first failure · ${category}`;

    const backlinks = isBlocked
      ? buildConnectionBacklinks(getSettings().base_url, getSettings().project_id, row.piece_name)
      : null;
```

- [ ] **Step 6: Add `backlinks` to the pushed item** — in the `items.push({ ... })` object, add:

```ts
      muted: mute !== null, mute_id: mute?.id ?? null,
      backlinks,
```

- [ ] **Step 7: Run the test, verify it passes**

Run: `npm test -- queries.attention`
Expected: PASS.

- [ ] **Step 8: Run the full server suite (regression guard)**

Run: `npm test`
Expected: all pass (wave + health + attention + connection-health).

- [ ] **Step 9: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.attention.test.ts
git commit -m "feat(attention): route blocked connections to the reauth lane with backlinks"
```

---

## Task 6: `getWaveDetail` — count `blocked` separately

**Files:**
- Modify: `server/src/db/queries.ts` (`WavePiece` ~1051; `WaveDetail` ~1061; `getWaveDetail` ~1103)
- Test: extend `server/src/db/queries.wave.test.ts`

- [ ] **Step 1: Add the failing test** (append a case to `queries.wave.test.ts`, reusing its `seedPlan`/`seedRun` helpers)

```ts
  it('counts blocked runs separately from failed', () => {
    const plan = seedPlan('hubspot', 'create_contact');
    seedRun(plan, 'wave-b', 'blocked', {
      stepResults: JSON.stringify([{ stepId: 'connection', status: 'skipped', error: 'deleted' }]),
    });
    const detail = getWaveDetail('wave-b')!;
    expect(detail.blocked).toBe(1);
    expect(detail.failed).toBe(0);
    const hub = detail.pieces.find(p => p.piece_name === 'hubspot')!;
    expect(hub.blocked).toBe(1);
    expect(hub.runs[0].status).toBe('blocked');
  });
```
> Uses the file's existing `seedPlan(piece, action)` and `seedRun(planId, waveId, status, opts)` helpers.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- queries.wave`
Expected: FAIL — `detail.blocked` is `undefined`.

- [ ] **Step 3: Extend the types** — `WavePiece` (~1051) add `blocked: number;` after `running: number;`; `WaveDetail` (~1061) add `blocked: number;` after `running: number;`.

- [ ] **Step 4: Update the count query** in `getWaveDetail` — add a blocked column to `pieceCounts`:

```ts
  const pieceCounts = db.all<{ piece_name: string; total: number; passed: number; failed: number; running: number; blocked: number }>(`
    SELECT p.piece_name AS piece_name,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS passed,
           SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM test_plan_runs r
    JOIN test_plans p ON p.id = r.plan_id
    WHERE r.wave_id = ?
    GROUP BY p.piece_name
  `, [waveId]);
```

- [ ] **Step 5: Thread `blocked` through the piece map + ranking + agg.**

(a) In the `byPiece.set(...)` init object, add `blocked: c.blocked,`.

(b) In the `statusRank` function, add a blocked rank between failed and running:
```ts
  const statusRank = (run: WaveRun): number =>
    run.status === 'failed' ? 100 + categorySeverity(run.category)
    : run.status === 'blocked' ? 60
    : run.status === 'running' ? 50
    : 10;
```

(c) In the `agg` reducer, add blocked:
```ts
  const agg = pieces.reduce((s, p) => ({
    total: s.total + p.total, passed: s.passed + p.passed, failed: s.failed + p.failed,
    running: s.running + p.running, blocked: s.blocked + p.blocked,
  }), { total: 0, passed: 0, failed: 0, running: 0, blocked: 0 });
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `npm test -- queries.wave`
Expected: PASS (existing wave cases + the new one).

- [ ] **Step 7: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.wave.test.ts
git commit -m "feat(waves): count blocked runs separately from failures"
```

---

## Task 7: Mirror the new types on the client

**Files:**
- Modify: `client/src/lib/api.ts` (`AttentionItem` ~369; `PieceHealthRow` ~387; `WavePiece` ~449; `WaveDetail` ~460)

No unit test (type-only). Verify with the client typecheck / build.

- [ ] **Step 1: Add a `ConnectionBacklinks` interface** near the other interfaces (e.g. above `AttentionItem`):

```ts
export interface ConnectionBacklinks {
  activepieces: string;  // external URL to the Activepieces connections page
  reimport: string;      // in-app route, e.g. "/connections?piece=hubspot"
}
```

- [ ] **Step 2: Extend `AttentionItem`** — add before its closing brace:

```ts
  mute_id: number | null;
  backlinks: ConnectionBacklinks | null;
}
```

- [ ] **Step 3: Extend `PieceHealthRow`** to match the server:

```ts
export interface PieceHealthRow {
  piece_name: string;
  status: 'failing' | 'blocked' | 'healthy' | 'unknown';
  actions_total: number;
  actions_passing: number;
  actions_failing: number;
  actions_blocked: number;
  last_run_at: string | null;
  failing_actions: { action: string; error: string | null; category: string; plan_id: number; run_id: number }[];
  blocked_reason: string | null;
  backlinks: ConnectionBacklinks | null;
  recent: string[];
}
```

- [ ] **Step 4: Extend `WavePiece` and `WaveDetail`** — add `blocked: number;` after `running: number;` in each.

- [ ] **Step 5: Typecheck**

Run: `cd client && npx tsc --noEmit` (or the repo build).
Expected: no errors (the render sites are updated in Tasks 8-10; adding fields alone should not break existing code).

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "feat(client): mirror blocked-connection types"
```

---

## Task 8: Health tab — render the "Connection needs fixing" state

**Files:**
- Modify: `client/src/pages/Dashboard.tsx` (`HealthRow`, ~line 152)

Manual verification (no unit test for React presentational rows).

- [ ] **Step 1: Update the status dot + border** in `HealthRow`. Replace:

```ts
  const dot = row.status === 'failing' ? 'bg-red-500'
    : row.status === 'healthy' ? 'bg-green-500'
    : 'bg-gray-600';
  const border = row.status === 'failing' ? 'border-red-500/20' : 'border-gray-800';
```
with:
```ts
  const dot = row.status === 'failing' ? 'bg-red-500'
    : row.status === 'blocked' ? 'bg-amber-500'
    : row.status === 'healthy' ? 'bg-green-500'
    : 'bg-gray-600';
  const border = row.status === 'failing' ? 'border-red-500/20'
    : row.status === 'blocked' ? 'border-amber-500/20'
    : 'border-gray-800';
```

- [ ] **Step 2: Render the blocked hint + backlinks** in the middle "hint" span. Locate the `<span className="flex-1 min-w-0 text-xs truncate" title={failHint}>` block and add a `row.status === 'blocked'` branch as the FIRST condition inside it:

```tsx
        <span className="flex-1 min-w-0 text-xs truncate" title={row.blocked_reason ?? failHint}>
          {row.status === 'blocked' ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
                Connection needs fixing
              </span>
              {row.blocked_reason && <span className="text-amber-400/60">{row.blocked_reason}</span>}
              {row.backlinks && (
                <>
                  <a href={row.backlinks.activepieces} target="_blank" rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-primary-400 hover:underline">Fix in Activepieces ↗</a>
                  <Link to={row.backlinks.reimport} onClick={e => e.stopPropagation()}
                    className="text-primary-400 hover:underline">Re-import here</Link>
                </>
              )}
            </span>
          ) : firstFail ? (
            <span className="text-red-400/90">✗ {firstFail.action}{extraFails > 0 ? ` +${extraFails}` : ''}
              {firstFail.error ? <span className="text-red-400/50"> — {firstFail.error}</span> : null}
            </span>
          ) : recovered ? (
            <span className="text-[10px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5"
              title="Currently passing, but failed recently — see the sparkline">
              recovered
            </span>
          ) : null}
        </span>
```

- [ ] **Step 3: Ensure `Link` is imported.** At the top of `Dashboard.tsx` confirm `Link` is in the `react-router-dom` import (it is used elsewhere in the file — e.g. the "Schedules"/"Reports" links). If not, add it: `import { Link, useNavigate } from 'react-router-dom';`

- [ ] **Step 4: Manual verification**

Follow the memory note **UI check via headless browser** to launch the app. Seed a blocked run (or temporarily point a connection's `remote_id` at a non-existent id and let a scheduled plan run). On the Health tab, confirm: the piece shows an amber dot + "Connection needs fixing", the reason text, and both links (Activepieces opens a new tab; "Re-import here" navigates to `/connections?piece=<name>`). Confirm it is NOT shown with the red failing style and is NOT counted in "Failing now".

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Dashboard.tsx
git commit -m "feat(health-ui): amber 'Connection needs fixing' row with fix backlinks"
```

---

## Task 9: Needs Attention — backlink buttons for connection_broken

**Files:**
- Modify: `client/src/components/NeedsAttention.tsx` (`AttentionRow`, ~line 117)

Manual verification.

- [ ] **Step 1: Render backlink buttons** in `AttentionRow`, inside the action-button cluster (the `<div className="flex items-center gap-1 shrink-0">` that holds Retest/Runs/Mute). Add, as the FIRST children of that div:

```tsx
          {item.backlinks && (
            <>
              <a href={item.backlinks.activepieces} target="_blank" rel="noreferrer"
                title="Recreate/repair this connection in Activepieces"
                className="px-2 py-1 rounded text-[11px] text-gray-500 hover:text-amber-400 hover:bg-amber-500/10">
                Fix in AP ↗
              </a>
              <button onClick={() => navigate(item.backlinks!.reimport)}
                title="Re-import this connection here"
                className="px-2 py-1 rounded text-[11px] text-gray-500 hover:text-primary-400 hover:bg-primary-500/10">
                Re-import
              </button>
            </>
          )}
```
(`navigate` is already in scope via `useNavigate()`.)

- [ ] **Step 2: Manual verification**

With a blocked run present (from Task 8), open the Dashboard → Needs Attention. Confirm the item appears in the **reauth** lane (amber key icon), the reason reads "connection deleted/errored…", and the two buttons work. Confirm the ErrorPlaybook (expand chevron) still renders without crashing for `category === 'connection_broken'` (it falls to its default guidance — acceptable).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/NeedsAttention.tsx
git commit -m "feat(attention-ui): fix-in-AP / re-import buttons for broken connections"
```

---

## Task 10: Scheduled Runs — render `blocked` as its own lane/badge

**Files:**
- Modify: `client/src/components/ScheduledRunsFeed.tsx` (`CATEGORY_STYLE` ~41; piece filters ~197; summary line ~215; `LANE_STYLE` ~284; `PieceCounts` ~291; `PieceGroup` lane union ~309)

Manual verification. `PieceGroup.lane` is a strict union `'failing' | 'running' | 'passing'` driving `LANE_STYLE[lane]`; add a proper `'blocked'` lane rather than reusing `'failing'` (which would paint it red).

- [ ] **Step 1: Add a `connection_broken` category style** to `CATEGORY_STYLE` (~41) so a blocked run's badge reads amber if ever categorized. Add after the `auth:` line:

```ts
  auth: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  connection_broken: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
```

- [ ] **Step 2: Add a `blocked` lane style** — in `LANE_STYLE` (~284) add:

```ts
const LANE_STYLE = {
  failing: { border: 'border-red-500/20', dot: 'bg-red-500' },
  blocked: { border: 'border-amber-500/20', dot: 'bg-amber-500' },
  running: { border: 'border-blue-500/20', dot: 'bg-blue-500' },
  passing: { border: 'border-gray-800', dot: 'bg-green-500' },
} as const;
```

- [ ] **Step 3: Widen the `PieceGroup` lane union** (~309):

```ts
  lane: 'failing' | 'blocked' | 'running' | 'passing';
```

- [ ] **Step 4: Show blocked in `PieceCounts`** (~291) — add an amber segment. Replace the function body's `const { passed, running, failed } = piece;` and the empty check with a blocked-aware version:

```tsx
function PieceCounts({ piece }: { piece: WavePiece }) {
  const { passed, running, failed, blocked } = piece;
  const empty = passed === 0 && running === 0 && failed === 0 && blocked === 0;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      {(passed > 0 || empty) && <span className="text-gray-400">{passed} passed</span>}
      {running > 0 && (
        <span className="text-blue-400">{passed > 0 ? '· ' : ''}{running} running</span>
      )}
      {blocked > 0 && (
        <span className="text-amber-400">{passed > 0 || running > 0 ? '· ' : ''}{blocked} blocked</span>
      )}
      {failed > 0 && (
        <span className="text-red-400 font-medium">{passed > 0 || running > 0 || blocked > 0 ? '· ' : ''}{failed} failed</span>
      )}
    </span>
  );
}
```

- [ ] **Step 5: Surface blocked pieces as a distinct group.** After the `failingPieces` / `runningPieces` / `passingPieces` definitions (~line 197), add `blockedPieces` and exclude blocked from the running/passing lanes:

```ts
  const failingPieces = detail.pieces.filter(p => p.failed > 0);
  const blockedPieces = detail.pieces.filter(p => p.failed === 0 && p.blocked > 0);
  const runningPieces = detail.pieces.filter(p => p.failed === 0 && p.blocked === 0 && p.running > 0);
  const passingPieces = detail.pieces.filter(p => p.failed === 0 && p.blocked === 0 && p.running === 0);
```

- [ ] **Step 6: Render the blocked group** — add after the "Failures first" section and before "In progress":

```tsx
      {blockedPieces.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 px-1 pt-1 text-xs text-amber-300">
            Connection needs fixing — not run
          </div>
          {blockedPieces.map(p => (
            <PieceGroup key={p.piece_name} piece={p} lane="blocked" open={expandedPieces.has(p.piece_name)}
              onToggle={() => onTogglePiece(p.piece_name)} expandedRun={expandedRun} onToggleRun={onToggleRun} />
          ))}
        </div>
      )}
```

- [ ] **Step 7: Add a blocked count to the summary line** (~line 215, next to passed/failing/running):

```tsx
          {detail.blocked > 0 && <span className="text-amber-400">{detail.blocked} blocked</span>}
```

- [ ] **Step 8: Manual verification**

With a blocked run in a wave, open Scheduled Runs, select that wave. Confirm the piece appears under "Connection needs fixing — not run" with an amber dot, the run row shows status `blocked`, the summary shows "N blocked", and it is NOT added to the "checks failing" count.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/ScheduledRunsFeed.tsx
git commit -m "feat(waves-ui): show blocked (connection) runs in their own lane"
```

---

## Final verification

- [ ] **Full server test suite:** `npm test` from repo root — all green (connection-health, queries.health, queries.attention, queries.wave).
- [ ] **Server + client typecheck/build:** the repo's build command — no errors.
- [ ] **End-to-end manual:** import a connection, delete it upstream in Activepieces, run/schedule its plan. Confirm: the plan run is `blocked` (0 steps executed); the Health tab shows amber "Connection needs fixing" with both backlinks; Needs Attention shows it in the reauth lane; Scheduled Runs shows it as blocked, not failed; the piece is not counted as "Failing now".

## Notes on commits

The user commits one-by-one after testing (see the per-task commit steps as suggested boundaries). Do not push; do not merge. The feature branch `feat/broken-connection-handling` was proposed but not created — create it before the first commit if desired.
