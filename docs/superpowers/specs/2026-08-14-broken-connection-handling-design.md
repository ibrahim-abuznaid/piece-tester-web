# Broken imported-connection detection & handling

**Date:** 2026-08-14
**Server:** `server/src/services/connection-health.ts` (new), `server/src/services/plan-executor.ts`, `server/src/db/queries.ts`, `server/src/routes/connections.ts`
**Client:** `client/src/lib/api.ts`, `client/src/pages/Dashboard.tsx` (Health tab), `client/src/components/NeedsAttention.tsx`, `client/src/components/ScheduledRunsFeed.tsx`
**Status:** Approved (mechanism corrected 2026-08-14 — see "Execution-path correction"), ready for implementation plan

## Execution-path correction

The first draft placed the gate in `test-engine.ts` (the manual `test_runs`/`test_results`
path). That is the **wrong path**: the Health tab (`getPieceHealth`), Needs Attention
(`getAttentionItems`), and Scheduled Runs (`getWaveDetail`) all read from **`test_plan_runs`**
— the plan-executor path (`server/src/services/plan-executor.ts` → `executePlan`), whose run
statuses are `completed` | `failed` | `running`. Scheduled waves and manual plan runs both go
through `executePlan(planId, onProgress, triggerType, signal, wave)`. So the gate and the new
state must live there. The connection is resolved per-step by `resolveConnectionAuthInput`
(`ai-config-generator.ts:518`), which for a deleted connection throws
`"Imported connection not found in AP. Re-import it."` — and `classifyError`
(`plan-executor.ts:111`) maps that to `not_found` (severity 4), so **today a deleted
connection is recorded as a piece failure**. That is exactly the mis-signal we are fixing.

## Problem

An imported connection stores only a **pointer** to Activepieces:
`connection_value = { _imported: true, remote_id: "<AP id>" }` (`connections.ts` import
route). The real credential lives upstream in Activepieces. At test time
`test-engine.ts:176-193` calls `client.listConnections()`, matches `remote_id`, and if it is
gone throws a generic `"Imported connection not found in AP"`.

Two consequences:

1. **Lazy, at run time.** We only learn the connection is broken when a test blows up. For a
   scheduled wave this records a fake *failure* against the piece and pollutes the run log.
2. **No local health.** We cache no status/expiry for connections, so there is no way to see
   "this connection is dead" without running something.

The connection can go bad two ways, and we currently distinguish neither:
- **Deleted** — gone from Activepieces entirely (`remote_id` no longer in `listConnections()`).
- **Errored / reauth** — still present but Activepieces marks the `AppConnection.status` as
  `ERROR` (revoked or expired token).

## Goal

If an imported connection is broken (deleted **or** errored/reauth), **do not run the test**.
Instead record the run as `blocked` and surface the piece on the **Health tab** in a distinct
*"Connection needs fixing"* state — explicitly **not** counted as a piece pass/fail regression
— with two backlinks: **Fix in Activepieces** and **Re-import here**. The same gate runs for
both manual plan runs and scheduled waves.

Non-goals for v1 (see "Deferred to a follow-up" for the full list): no health-status cache
columns, no on-demand Validate button, no scheduled background reconciliation, and no
health-checking of manual (non-imported) connections.

## Design

The core representation: a new **run status `blocked`** on `test_plan_runs`. A run that never
executed a step because its connection is broken is neither `completed` nor `failed` — `blocked`
is the honest signal (consistent with the signal-trust oracle). `test_plan_runs.status` is a
plain `TEXT` column with no CHECK constraint, so the new value needs **no migration** — only the
readers (§4) must learn about it or they will silently drop/miscount it.

### 1. Health checker — the detection unit (`server/src/services/connection-health.ts`, new)

A small module. The classifier is pure (takes a fetched remote list) so it is unit-testable
with no live API. `AppConnection` (from `ap-client.ts`) has `id`, `externalId`, and `status`.

```ts
import type { AppConnection, ActivepiecesClient } from './ap-client.js';

export type RemoteStatus = 'live' | 'missing' | 'error';
export interface HealthResult { status: RemoteStatus; detail: string; }

// Pure classifier. Match rule mirrors resolveConnectionAuthInput:
//   rc.id === remoteId || rc.externalId === remoteId
export function classifyImported(remoteId: string, remoteList: AppConnection[]): HealthResult;
//   not found                  -> { status: 'missing', detail: 'Connection was deleted in Activepieces' }
//   found && status === 'ERROR' -> { status: 'error',  detail: 'Connection is in an error state in Activepieces — reauthorize it' }
//   found && active             -> { status: 'live',   detail: '' }

// Health of an imported connection given its raw connection_value JSON. Returns null when the
// value is not _imported (manual creds live locally — cannot be deleted upstream) or is
// unparseable. Otherwise fetches listConnections() once and classifies. A THROWN
// listConnections() (network/bad creds) PROPAGATES — never treated as 'missing' (see Error
// handling). Takes the raw value (not a pieceName) so it needs no queries.ts import — the
// caller (executePlan) fetches the active connection via getConnectionByPiece.
export async function checkImportedConnectionHealth(
  client: ActivepiecesClient,
  connectionValueJson: string,
): Promise<(HealthResult & { remoteId: string }) | null>;
```

### 2. Backlink builder — pure, unit-testable (`connection-health.ts`)

```ts
export interface ConnectionBacklinks { activepieces: string; reimport: string; }

// baseUrl is settings.base_url (e.g. "https://cloud.activepieces.com/api").
// Strip a trailing /api, append /projects/<projectId>/connections.
// reimport is always the local deep-link "/connections?piece=<pieceName>".
export function buildConnectionBacklinks(
  baseUrl: string, projectId: string, pieceName: string,
): ConnectionBacklinks;
// ("https://cloud.activepieces.com/api", "projX", "hubspot") ->
//   { activepieces: "https://cloud.activepieces.com/projects/projX/connections",
//     reimport:     "/connections?piece=hubspot" }
```

### 3. Pre-flight gate in `executePlan` (`server/src/services/plan-executor.ts`)

`executePlan` (line 296) already fetches `pieceMeta` and calls `createPlanRun(planId, triggerType, wave)`
before the step loop. Immediately after `createPlanRun` (and before the `try {` step loop), add
the gate:

```ts
// Pre-flight: if this piece's imported connection is deleted/errored upstream, do NOT run.
// Record the run as `blocked` (not failed — it never executed) so the Health board reads it
// as an environment problem, not a piece regression.
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

- `.catch(() => null)` means a failed `listConnections()` (network/creds) does NOT block — the
  plan proceeds and any real auth error is classified as today (see Error handling).
- Add `'plan_blocked'` to the `PlanProgress.type` union (line ~121). The scheduled-wave runner
  ignores progress type; the manual SSE stream simply reports it.
- No active connection, or `checkImportedConnectionHealth` returning `null` (manual / non-imported
  value), falls through to the normal path unchanged.

### 4. Teach the readers about `blocked` (`server/src/db/queries.ts`)

Three aggregations read `test_plan_runs.status` and must handle `blocked` explicitly, or it is
silently dropped/miscounted:

**`getPieceHealth` (line ~781).** Add a per-piece `actions_blocked` counter and a
`blocked_reason` + `backlinks`. In the row loop:
```ts
else if (row.last_status === 'blocked') {
  h.actions_blocked++;
  if (!h.blocked_reason) h.blocked_reason = extractFirstStepError(row.step_results); // the health.detail
}
```
Final piece status precedence becomes: `failing` (actions_failing > 0) → **`blocked`**
(actions_blocked > 0) → `healthy` (actions_passing > 0) → `unknown`. Attach `backlinks`
(built via `buildConnectionBacklinks` from `getSettings()` + piece_name) when status is
`blocked`. `PieceHealthRow` gains `actions_blocked: number`, `blocked_reason: string | null`,
`backlinks: ConnectionBacklinks | null`, and `status` gains `'blocked'`.

**`getAttentionItems` (line ~924).** Change the candidate WHERE from `r.status = 'failed'` to
`r.status IN ('failed', 'blocked')`. For a `blocked` row, skip `analyzeFailedRun` and instead:
`category = 'connection_broken'`, `bucket = 'reauth'`, `reason = <the blocked step error>`, and
attach `backlinks`. Fail-streak/flaky logic still applies (a `blocked` run counts as a
non-passing status for streak). `AttentionItem` gains `backlinks: ConnectionBacklinks | null`;
its `bucket` union already includes `reauth`.

**`getWaveDetail` (line ~1103).** Add `blocked` to the per-piece count query
(`SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked`), thread it onto `WavePiece`
(`blocked: number`) and the wave-level `agg`. In `statusRank`, rank `blocked` between failed and
running (e.g. `run.status === 'blocked' ? 60`). `WaveRun.status` already carries the raw string,
so a `blocked` run flows through; the frontend renders it (§6). `blocked` runs are NOT counted
in `failed`.

### 5. Signal-trust — environment problem, not a bug

Because `blocked` is its own status (never `failed`), the piece is not counted as failing in any
of the three aggregations. It surfaces in Needs Attention in the **`reauth`** lane with category
`connection_broken` — an actionable environment issue, not a piece regression — consistent with
the existing `reauth` / `likely_broken` / `watching` / `noise` triage.

### 6. Frontend surfacing + backlinks

- **`client/src/lib/api.ts`** — mirror the new fields: `PieceHealthRow.status` gains `'blocked'`
  plus `actions_blocked`, `blocked_reason`, `backlinks`; add a `ConnectionBacklinks` interface;
  `AttentionItem.backlinks`; `WavePiece.blocked`; wave-level `blocked`.
- **`client/src/pages/Dashboard.tsx` (Health tab)** — a `blocked` piece renders a distinct
  amber **"Connection needs fixing"** state (not the red failing dot), shows `blocked_reason`,
  and two links: **Fix in Activepieces** (`backlinks.activepieces`, `target="_blank"`) and
  **Re-import here** (`backlinks.reimport`, in-app route).
- **`client/src/components/NeedsAttention.tsx`** — the `reauth` lane already renders; for a
  `connection_broken` item show the two backlink buttons alongside the existing mute/retest.
- **`client/src/components/ScheduledRunsFeed.tsx`** — render a `blocked` run/piece with a
  neutral "Blocked" badge (not counted among failures) via the existing status rendering.

### Deferred to a follow-up (explicitly out of scope for v1)

These were in the first draft; pre-flight already guards every run, so they are enhancements,
not requirements. Called out so they can be pulled in later:

- **Health-status cache columns** on `piece_connections` (`remote_status`, `last_verified_at`).
  Not needed: the `blocked` run status + the blocked step's detail already drive every surface.
- **On-demand "Validate" button** + `POST /connections/validate` on the Connections page.
  Useful for checking idle pieces without a run, but not required by the stated goal.
- **Scheduled background reconciliation** job.
- **Health-checking manual (non-imported) connections** — they cannot be deleted upstream.

## Data flow

```
executePlan(planId, ..., triggerType) — manual OR scheduled
  ├─ getPieceMetadata + createPlanRun
  ├─ getConnectionByPiece → checkImportedConnectionHealth(client, value)  [connection-health.ts]
  │     ├─ null (no conn / manual value)      → run steps as today
  │     ├─ live                               → run steps as today
  │     └─ missing | error                    → updatePlanRun(status='blocked'); return early
  │                                               (0 steps executed)
  └─ readers of test_plan_runs:
        getPieceHealth   → piece.status='blocked' + reason + backlinks   (Health tab, amber)
        getAttentionItems→ reauth lane, category='connection_broken' + backlinks
        getWaveDetail    → blocked count, "Blocked" badge (not a failure)
```

## Error handling

- A thrown `listConnections()` (network / bad AP creds) is **not** a connection-deleted signal:
  `checkImportedConnectionHealth` re-throws, the `.catch(() => null)` at the gate lets the plan
  run normally, and any real auth failure classifies as today. Only a successful list with the
  `remoteId` absent means `missing`.
- Piece with no active connection, or a manual (non-`_imported`) connection value:
  `checkImportedConnectionHealth` returns `null` → behavior unchanged.

## Testing

- `connection-health.test.ts` (Vitest): `classifyImported` — absent `remoteId` → `missing`;
  present with `status: 'ERROR'` → `error`; present + active → `live`; matches by `externalId`
  as well as `id`.
- `buildConnectionBacklinks` unit test: `("https://cloud.activepieces.com/api", "projX",
  "hubspot")` → `activepieces: "https://cloud.activepieces.com/projects/projX/connections"`,
  `reimport: "/connections?piece=hubspot"`; also a `base_url` without a trailing `/api`.
- `plan-executor` gate test: a plan whose piece has a deleted imported connection yields a run
  with `status === 'blocked'` and **zero executed steps** (no `executeActionOnAP` call); a
  `live` connection runs normally; a thrown `listConnections()` does not block.
- `queries` test: a `blocked` latest run makes `getPieceHealth` report the piece `status:
  'blocked'` (not `failing`), and `getAttentionItems` emits a `reauth` / `connection_broken`
  item; `getWaveDetail` counts it under `blocked`, not `failed`.
