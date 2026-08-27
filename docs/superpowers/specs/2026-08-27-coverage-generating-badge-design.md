# Coverage "generating" badge — design

**Date:** 2026-08-27
**Status:** Approved (pending spec review)

## Problem

When "Set up All with AI" runs on a piece, there's no cross-piece view of what's
generating right now. You have to open each piece to see if it's busy. The goal is
a lightweight, at-a-glance indicator on the Coverage page showing which pieces
currently have AI plan generation in progress.

## Scope

- **Live only.** The badge shows only while a piece has active AI plan generation,
  and disappears when idle. No history / last-result.
- **Any AI plan generation counts.** The server can't cheaply distinguish a
  "Set up All" batch from a single "AI Test" (both are individual v2 plan jobs), so
  the badge counts any active plan jobs on the piece. It reads as "this piece is busy
  generating plans."
- Per-piece badge on the existing Coverage rows. No new sidebar page.

### Out of scope (YAGNI)

- Top-of-page summary banner.
- Click-to-jump on the badge itself (the row already opens the piece detail).
- Distinguishing Set up All vs single AI Test.
- History / last-run outcome.

## Architecture

Three small pieces, each independently testable:

### 1. Job-store aggregation (`server/src/services/plan-jobs.ts`)

New function:

```ts
getActiveJobCountsByPiece(): Record<string, number>
```

Walks the in-memory `activeJobs` map counting jobs with status `running` per
`pieceName`, plus any `running`/`pending` items in the active v1 batch queue
(mirrors the inclusion logic already in `getActiveJobsForPiece`). Returns a map of
`pieceName → count`. Pieces with zero active jobs are omitted.

- Depends on: the existing `activeJobs` map and `activeBatchQueue` (already in this
  module).
- Pure read over in-memory state; no DB, no I/O.

### 2. Endpoint (`server/src/routes/coverage.ts`)

```
GET /coverage/active-jobs  →  Record<string, number>
```

Returns `getActiveJobCountsByPiece()`. Placed on the coverage router (not the pieces
router) to avoid shadowing the existing `GET /:name` piece-metadata route, and
because it feeds the Coverage page. Read-only, no params.

### 3. Client badge (`client/src/components/CoverageCockpit.tsx`, `client/src/lib/api.ts`)

- `api.getActiveJobCounts(): Promise<Record<string, number>>` → `GET /coverage/active-jobs`.
- New React Query in `CoverageCockpit`:
  ```ts
  useQuery({
    queryKey: ['coverageActiveJobs'],
    queryFn: api.getActiveJobCounts,
    refetchInterval: 3000,
  })
  ```
  Polls every 3s while the Coverage page is mounted (React Query stops on unmount).
  Fails quiet: on error the map is empty and no badges render — Coverage is unaffected.
- Pass the counts map into each `Row`. When `counts[r.piece_name] > 0`, render a small
  purple pill next to the piece name: a spinning icon + `"{n} generating"`. Hidden
  when the count is 0 or absent. Purple/`Loader2` to match the Setup All theme.

## Data flow

```
activeJobs map (server memory)
  └─ getActiveJobCountsByPiece()
       └─ GET /coverage/active-jobs
            └─ api.getActiveJobCounts()  [polled every 3s]
                 └─ CoverageCockpit query → Row badge (count > 0)
```

Keying: both `/coverage` rows and the counts map use the exact `piece_name`
(full package name, e.g. `@activepieces/piece-x`), so lookups line up directly.

## Error handling

- Endpoint always returns a JSON object (possibly empty). No error states to surface.
- Client query failure → empty map → no badges. Never blocks or errors the Coverage
  list, which is a separate query.

## Testing

- **Server unit test** (`server/src/services/plan-jobs.*.test.ts`): seed jobs via
  `createJob` for two pieces, assert `getActiveJobCountsByPiece()` returns the right
  per-piece counts; assert a completed job (status `done`) is not counted.
- No new client test: the badge is pure conditional rendering off the count.

## Files touched

- `server/src/services/plan-jobs.ts` — add `getActiveJobCountsByPiece()`
- `server/src/routes/coverage.ts` — add `GET /active-jobs`
- `client/src/lib/api.ts` — add `getActiveJobCounts()`
- `client/src/components/CoverageCockpit.tsx` — poll + per-row badge
- one server test file — aggregation unit test
