# Coverage "generating" badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live "N generating" badge on each Coverage-page piece row while that piece has AI plan generation running.

**Architecture:** A new in-memory aggregation in the plan-jobs store returns active-job counts per piece; a small read-only endpoint on the coverage router exposes it; the Coverage page polls it every 3s and renders a purple pill per row when the count > 0.

**Tech Stack:** Express (server), better-sqlite3 (unrelated here — this feature is in-memory only), React + @tanstack/react-query + Tailwind (client), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-08-27-coverage-generating-badge-design.md`

---

### Task 1: Server — aggregate active job counts per piece

**Files:**
- Modify: `server/src/services/plan-jobs.ts` (add exported function near `getActiveJobsForPiece`, ~line 57–75)
- Test: `server/src/services/plan-jobs.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/services/plan-jobs.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createJob, completeJob, getActiveJobCountsByPiece } from './plan-jobs.js';

afterEach(() => { vi.useRealTimers(); });

describe('getActiveJobCountsByPiece', () => {
  it('counts running jobs per piece', () => {
    createJob('@ap/piece-alpha', 'v2:a1');
    createJob('@ap/piece-alpha', 'v2:a2');
    createJob('@ap/piece-beta', 'v2:b1');

    const counts = getActiveJobCountsByPiece();
    expect(counts['@ap/piece-alpha']).toBe(2);
    expect(counts['@ap/piece-beta']).toBe(1);
  });

  it('does not count completed jobs', () => {
    vi.useFakeTimers(); // completeJob schedules a 2-min cleanup timer; don't let it keep the process alive
    const job = createJob('@ap/piece-gamma', 'v2:g1');
    expect(getActiveJobCountsByPiece()['@ap/piece-gamma']).toBe(1);

    completeJob(job, 'done');
    expect(getActiveJobCountsByPiece()['@ap/piece-gamma'] ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/src/services/plan-jobs.test.ts`
Expected: FAIL — `getActiveJobCountsByPiece` is not exported (import error / "is not a function").

- [ ] **Step 3: Add the implementation**

In `server/src/services/plan-jobs.ts`, add this exported function directly after `getActiveJobsForPiece` (after its closing `}` around line 75):

```ts
/** Count of active (running/pending) plan jobs per piece, for the Coverage "generating" badge. */
export function getActiveJobCountsByPiece(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, job] of activeJobs) {
    if (job.status === 'running') {
      counts[job.pieceName] = (counts[job.pieceName] ?? 0) + 1;
    }
  }
  if (activeBatchQueue && activeBatchQueue.status === 'running') {
    for (const item of activeBatchQueue.items) {
      if (item.status === 'running' || item.status === 'pending') {
        counts[item.pieceName] = (counts[item.pieceName] ?? 0) + 1;
      }
    }
  }
  return counts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/src/services/plan-jobs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/plan-jobs.ts server/src/services/plan-jobs.test.ts
git commit -m "feat(server): active plan-job counts per piece"
```

---

### Task 2: Server — expose `GET /coverage/active-jobs`

**Files:**
- Modify: `server/src/routes/coverage.ts` (add import at top; add route before `export default router;`)

- [ ] **Step 1: Add the import**

At the top of `server/src/routes/coverage.ts`, after the existing imports (after line 5), add:

```ts
import { getActiveJobCountsByPiece } from '../services/plan-jobs.js';
```

- [ ] **Step 2: Add the route**

In `server/src/routes/coverage.ts`, immediately before `export default router;` (line 62), add:

```ts
// Live per-piece active AI-plan-job counts, for the Coverage "generating" badge.
router.get('/active-jobs', (_req, res) => {
  res.json(getActiveJobCountsByPiece());
});
```

- [ ] **Step 3: Verify the server starts and the route responds**

The dev server (`npm run dev`) hot-reloads. With it running, hit the endpoint (send the session cookie if session auth is on):

Run: `curl -s -H "Cookie: $(cat .devcookie 2>/dev/null)" http://localhost:3001/api/coverage/active-jobs`
Expected: a JSON object — `{}` when nothing is generating, e.g. `{"@activepieces/piece-mistral-ai":3}` while a Setup All runs. (A `401` just means auth is required — that's fine; the client query sends credentials. The point is the route exists and returns JSON, not HTML/404.)

> Note: confirm the API base/port from `client/src/lib/api.ts` (`BASE`) if `3001` differs.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/coverage.ts
git commit -m "feat(server): GET /coverage/active-jobs endpoint"
```

---

### Task 3: Client — API helper

**Files:**
- Modify: `client/src/lib/api.ts` (add next to `getCoverage`, ~line 1001)

- [ ] **Step 1: Add the helper**

In `client/src/lib/api.ts`, directly after the `getCoverage` line (`getCoverage: () => request<CoverageRow[]>('GET', '/coverage'),`), add:

```ts
  getActiveJobCounts: () =>
    request<Record<string, number>>('GET', '/coverage/active-jobs'),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "feat(client): getActiveJobCounts api helper"
```

---

### Task 4: Client — poll + render the badge

**Files:**
- Modify: `client/src/components/CoverageCockpit.tsx` (add query ~line 31; pass prop ~line 250–268; add `generating` prop to `Row` ~line 301–314; render pill in the Piece cell ~line 337)

- [ ] **Step 1: Add the polling query**

In `client/src/components/CoverageCockpit.tsx`, directly after the existing `coverage` query (after line 31, the closing `});`), add:

```ts
  const { data: activeJobs = {} } = useQuery({
    queryKey: ['coverageActiveJobs'],
    queryFn: api.getActiveJobCounts,
    refetchInterval: 3000,
  });
```

- [ ] **Step 2: Pass the count into each Row**

In the `visible.map(r => ( <Row ... /> ))` block, add a `generating` prop to the `<Row>` (e.g. right after `key={r.piece_name}` / `r={r}`):

```tsx
                  generating={activeJobs[r.piece_name] ?? 0}
```

- [ ] **Step 3: Accept the prop in `Row`**

Update the `Row` function's destructured params and its prop types. Change the signature header (lines ~301–314) to include `generating`:

```tsx
function Row({
  r, checked, onToggle, onConnect, onEnroll, onGenPlans, onOpenPlans, onOpenRuns, onEdit, busy, generating,
}: {
  r: CoverageRow;
  checked: boolean;
  onToggle: () => void;
  onConnect: () => void;
  onEnroll: () => void;
  onGenPlans: () => void;
  onOpenPlans: () => void;
  onOpenRuns: () => void;
  onEdit: () => void;
  busy: boolean;
  generating: number;
}) {
```

- [ ] **Step 4: Render the pill in the Piece cell**

In `Row`, inside the Piece `<div className="min-w-0">`, directly after the shortName line
(`<div className="text-[11px] text-gray-600 truncate">{shortName(r.piece_name)}</div>`), add:

```tsx
          {generating > 0 && (
            <Pill className="mt-0.5 bg-purple-500/20 text-purple-300">
              <Loader2 size={9} className="animate-spin" /> {generating} generating
            </Pill>
          )}
```

(`Loader2` and `Pill` are already imported/defined in this file.)

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit -p client/tsconfig.json && npm run build:client`
Expected: tsc exit 0; build prints `✓ built`.

- [ ] **Step 6: Manual verification in the browser**

With `npm run dev` running: open Coverage (`/schedules`), then in another tab start "Setup All with AI" on a piece. Within ~3s the Coverage row for that piece shows `⟳ N generating`; it disappears when generation finishes. (Optionally start a second piece and confirm both rows show their own counts.)

- [ ] **Step 7: Commit**

```bash
git add client/src/components/CoverageCockpit.tsx
git commit -m "feat(client): live \"generating\" badge on Coverage rows"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all files pass, including `server/src/services/plan-jobs.test.ts`.

- [ ] **Step 2: Confirm branch state**

Run: `git log --oneline -5`
Expected: the four feature commits on top of `main`, plus the spec commit.

---

## Notes for the implementer

- This feature is in-memory only on the server (the job store is a module-level `Map`); it does not touch the database.
- Piece identity is the full `piece_name` (e.g. `@activepieces/piece-mistral-ai`) in both the `/coverage` rows and the counts map — they line up directly, no normalization needed.
- The badge counts any active plan generation (Setup All *or* a single AI Test) — this is intentional per the spec.
- Keep commits per-task as shown.
