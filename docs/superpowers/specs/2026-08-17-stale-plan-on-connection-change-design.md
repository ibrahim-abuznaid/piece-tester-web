# Stale test-plan guard on connection change

**Date:** 2026-08-17
**Server:** `server/src/db/schema.ts`, `server/src/db/queries.ts`, `server/src/routes/connections.ts`, `server/src/services/plan-executor.ts`
**Client:** `client/src/lib/api.ts`, `client/src/pages/PieceDetail.tsx`, and the blocked-run remediation surfaces (`client/src/pages/Dashboard.tsx` Health tab, `client/src/components/NeedsAttention.tsx`)
**Status:** Approved, ready for implementation plan
**Relates to:** builds on `feat/broken-connection-handling` (PR #14) — reuses the `blocked` run status and all of its surfacing. See `docs/superpowers/specs/2026-08-14-broken-connection-handling-design.md`.

## Problem

A test plan's `steps` JSON freezes **account-scoped resource IDs** at generation time — e.g.
Linear `teamId` / `projectId` / `issueId` / `stateId`, Slack `channel_id`. Only the **auth** is
dynamic: it is resolved fresh on every run by `resolveConnectionAuthInput`
(`ai-config-generator.ts:518-559`), which reads the currently-active connection for the piece and
emits `{{connections.<externalId>}}`. The plan itself stores **no** connection reference
(`ai-config-generator.ts:547` strips any raw `auth`).

Consequence: when a user **changes the active connection** for a piece to one backed by a
**different account/workspace**, auth keeps working, but the plan's frozen IDs no longer exist in
the new account. Every step that references one fails with a "not found"/validation error.

**Observed (prod, Linear):** the user swapped the Linear connection, left the approved plans as-is,
and ran the schedule. The one action whose plan they regenerated **passed** (auth is dynamic; its
inputs were rebuilt against the new workspace). Every non-regenerated action **failed** and showed
as a red piece regression.

This is a distinct failure mode from PR #14:

| | PR #14 (done) | This spec |
|---|---|---|
| Trigger | Connection deleted/errored **in AP** | Connection **swapped/changed** in our platform |
| What's wrong | Auth invalid | Auth valid, **plan stale** |
| Pre-flight health check | Fails → catches it | **Passes** (connection is live) → misses it |
| Symptom today | Fixed → `blocked` | **Still a fake piece "failure"** |
| Remediation | Fix in AP / Re-import | **Regenerate plan** |

PR #14's `checkImportedConnectionHealth` gate cannot catch this: the new connection is *live*, so
health passes, the plan runs, and stale-ID failures classify as ordinary piece failures.

## Goal

When a piece's active connection changes, **mark that piece's approved plans stale**, **warn** in
the piece UI with a one-click **Regenerate plans** action, and make runs of a stale plan come back
as **`blocked`** ("Plan needs regenerating") — amber, **not** a red `failed` piece regression —
until the plan is regenerated.

Keep it simple (per the "testing pieces" motto): **no account-diffing.** Any change to the active
connection marks the piece's plans stale. We accept over-flagging (e.g. a same-account token
refresh needlessly marks plans stale) as the cost of not guessing.

## Design

### 1. Data — one flag

Add `needs_regen INTEGER NOT NULL DEFAULT 0` to `test_plans` (`schema.ts:181-192`), via an
idempotent `ALTER TABLE` guard in `initTables` alongside the existing column migrations:

```ts
const planCols = db.pragma('table_info(test_plans)') as { name: string }[];
if (planCols.length && !planCols.some(c => c.name === 'needs_regen')) {
  db.exec(`ALTER TABLE test_plans ADD COLUMN needs_regen INTEGER NOT NULL DEFAULT 0`);
}
```

`needs_regen = 1` means "the active connection changed after this plan was approved; regenerate."

### 2. Set the flag — mark stale when the active connection changes

New query in `queries.ts`:

```ts
/** Mark all approved plans for a piece as stale (connection changed). Returns rows changed. */
export function markPlansStaleByPiece(pieceName: string): number {
  return getDb().run(
    `UPDATE test_plans SET needs_regen = 1, updated_at = datetime('now')
       WHERE piece_name = ? AND status = 'approved'`,
    [pieceName],
  ).changes;
}
```

Call it from every `connections.ts` route where the **active** connection for a piece changes.
Each handler already knows the affected `piece_name` (from the row or request):

- `POST /connections/:id/activate` (`connections.ts:79-84`) — switch to a different connection.
- `POST /connections` (`:96-113`) and `POST /connections/import` (`:57-76`) — a new connection is
  created and becomes active (`createConnection` deactivates others, `queries.ts:125-146`).
- `PUT /connections/:id` (`:116-131`) — when the update changes `connection_value` **and** the row
  is active (`is_active = 1`).
- `DELETE /connections/:id` (`:191-195`) — only when the delete **auto-promotes** another
  connection to active (`deleteConnection`, `queries.ts:195-211`). Deleting an inactive connection
  changes nothing → no marking.

Marking only `status = 'approved'` plans is deliberate: `draft` plans aren't scheduled and are
about to be edited anyway.

### 3. Clear the flag — on regenerate / re-approve

Regeneration reuses the same plan row via `createTestPlan`'s update branch (`queries.ts:445-459`),
and approval goes through `updateTestPlan` (`queries.ts:502-522`). Add `needs_regen = 0` to both
UPDATE statements so writing fresh steps or re-approving a plan clears its own flag. No separate
"clear" call is needed — the existing regenerate flow (`streamAiPlan` →
`runPlanJobInBackground` → auto-approve on passing auto-test, `pieces.ts:187-232`) clears it.

### 4. Guard the run — block, don't fail (reuse PR #14's `blocked`)

Add a second pre-flight gate in `executePlan` (`plan-executor.ts`), immediately **after** the
existing connection-health `blocked` gate (`:319-340`):

```ts
if (plan.needs_regen === 1) {
  const staleStep: StepResult = {
    stepId: 'stale', label: 'Plan needs regenerating', status: 'skipped',
    output: null, error: 'Connection changed after this plan was approved — regenerate the plan.',
    duration_ms: 0,
  };
  updatePlanRun(runId, {
    status: 'blocked',
    blocked_reason: 'stale_plan',            // see §5
    completed_at: new Date().toISOString(),
    step_results: JSON.stringify([staleStep]),
  });
  onProgress({ type: 'plan_blocked', runId, message: staleStep.error!, stepResults: [staleStep] });
  cleanupEmitter(runId);
  return getPlanRun(runId)!;
}
```

Because the gate lives in `executePlan`, it covers **both** scheduled waves and manual runs
uniformly, and it reuses the `plan_blocked` event + `blocked` status that Health, Needs-Attention,
the wave rail, and PieceDetail already render (PR #14; PieceDetail specifically via `a35b593`).
`getTestPlan` (`queries.ts`) must return the new `needs_regen` column so the gate can read it.

**Decision — manual runs are also blocked.** A manual run of a stale plan returns `blocked` too
(one code path). The PieceDetail UI shows the Regenerate action right there, so this is not a dead
end. If we later want manual runs to bypass the gate for debugging, that is a one-line
`triggerType !== 'manual'` guard — deferred, not in v1.

### 5. Distinguish the blocked reason (remediation refinement)

PR #14 carries the block reason only as a free-text `error` string, and its surfaces hard-code the
**Fix in AP / Re-import** remediation. Our block has a different fix (**Regenerate**), so we add a
discriminator so the UI shows the right action:

- Add `blocked_reason TEXT` to `test_plan_runs` (idempotent `ALTER TABLE`; nullable, no migration
  pain — statuses are plain TEXT). Values: `'broken_connection'` (PR #14) | `'stale_plan'` (this).
- This work also adds `blocked_reason = 'broken_connection'` to PR #14's **existing** gate
  (`plan-executor.ts:327-337`); the new stale gate sets `'stale_plan'`.
- The blocked-run readers (`getPieceHealth`, `getAttentionItems`, `getWaveDetail`) surface
  `blocked_reason` so the client can branch remediation:
  - `broken_connection` → **Fix in AP** / **Re-import** (unchanged).
  - `stale_plan` → **Regenerate plan**.

If threading `blocked_reason` through all three readers proves heavy, the fallback for v1 is to
branch on the `stepId` already stored in `step_results[0]` (`'connection'` vs `'stale'`) — no new
column. Prefer the explicit column; the fallback keeps the feature shippable if the column is
contentious.

### 6. UI — warn + regenerate (`PieceDetail.tsx`)

Plans are already loaded into `actionPlans` / `triggerPlans` (`PieceDetail.tsx:149-180`); the API
response gains `needs_regen`. Add:

- **Banner** (amber) when any of the piece's plans have `needs_regen === 1`: "Connection changed —
  test plans need regenerating," with a **Regenerate plans** button.
- **"Stale" badge** on each affected action next to the existing plan-status badge
  (`:1072-1082`).
- The **Regenerate plans** button reuses the existing per-action flow (`api.streamAiPlan`,
  `client/src/lib/api.ts:947-948`) in a **client-side loop over the stale actions only**,
  sequentially. No new bulk server endpoint. Each regeneration clears that plan's flag on
  completion (§3), so the badge/banner clear incrementally.
- Plans that require human input during generation pause as they do today; the loop handles the
  automatable ones and leaves the rest for manual attention.

The Health tab and Needs-Attention already render `blocked` runs; they only need the
`blocked_reason` branch from §5 to swap **Fix in AP / Re-import** → **Regenerate** for stale
plans.

## Edge cases

- **Same-account swap / token refresh.** Over-flags (marks stale though nothing broke). Accepted
  per the no-account-diffing decision; regenerating is cheap-ish and always safe.
- **Local delete of the active connection with no replacement.** Out of scope here — that is the
  separate "no active connection" gap (pre-flight only blocks when `activeConn` exists,
  `plan-executor.ts:323`). Not addressed in this spec.
- **Draft plans.** Never marked (not scheduled; about to be edited).
- **Regeneration that fails auto-test.** Plan stays `draft` and un-approved; `needs_regen` on the
  old approved row is already cleared by the rewrite (§3), but the plan is no longer `approved`, so
  the scheduler skips it (`test-engine.ts:110`) — it won't run stale and won't run broken.
- **Concurrent change during a wave.** A connection changed mid-wave marks plans stale; runs
  already in flight for that piece complete under the pre-change state. Acceptable — next fire is
  correctly blocked.
- **PR #14 co-occurrence.** If a connection is *both* changed and broken, the broken-connection
  gate runs first (`:319-340`) and wins (`broken_connection`); the user fixes the connection, and
  the stale flag still blocks until they regenerate. Correct ordering.

## Non-goals (v1)

- No account-identity detection (no "did the workspace actually change?" check).
- No bulk regenerate **server** endpoint — client loop over the existing per-action flow.
- No handling of the "connection deleted locally, no replacement" gap (separate follow-up).
- No auto-regeneration — the user always confirms via the Regenerate button.

## Testing

- **`markPlansStaleByPiece`**: only `approved` plans of the named piece flip to `needs_regen = 1`;
  drafts and other pieces untouched.
- **Flag clears** on `createTestPlan` update branch and on `updateTestPlan` approve.
- **`executePlan` gate**: `needs_regen = 1` → run `blocked`, `blocked_reason = 'stale_plan'`, zero
  steps executed, `plan_blocked` emitted; `needs_regen = 0` → runs normally. Covers manual and
  scheduled `triggerType`.
- **Connection routes** each call `markPlansStaleByPiece` for the right `piece_name` (activate /
  create / import / active-value update / delete-with-promotion) and **not** for a no-op
  (inactive-connection delete, non-value PUT).
- **Reader branch**: a `stale_plan` blocked run surfaces the Regenerate remediation, a
  `broken_connection` one surfaces Fix-in-AP / Re-import.
