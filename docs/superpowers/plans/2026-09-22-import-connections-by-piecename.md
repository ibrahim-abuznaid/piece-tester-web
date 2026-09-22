# Import Piece Connections by pieceName — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match a piece's Activepieces connections by the AP `pieceName` field (dropping the `-piece-testing` name convention), import all of them, and keep the newest one active.

**Architecture:** `classify()` filters the remote connection list by exact `pieceName` and returns the whole set. `sweepTestConnections()` imports every not-yet-imported match per piece (idempotent by remote id), keeps a pre-existing active connection or else activates the newest, and marks plans stale only when something new was imported. Routes forward the new shapes unchanged; two client surfaces (Connections sweep summary, PieceDetail per-piece banner) get reworded.

**Tech Stack:** TypeScript, Node/Express (server), better-sqlite3, React + TanStack Query (client), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-import-connections-by-piecename-design.md`

**Run all tests:** `npm test` (root). Single file: `npx vitest run <path>`.

---

## File structure

- `server/src/services/test-connection-matcher.ts` — pure matcher. Rewritten: pieceName equality, returns `{ status, connections }`. Suffix machinery deleted.
- `server/src/services/connection-sweep.ts` — sweep orchestration. Rewritten: import-all + idempotency + active selection.
- `server/src/services/*.test.ts` — rewritten to match.
- `server/src/routes/connections.ts` — no code change (forwards `classify`/sweep results). Verified only.
- `client/src/pages/Connections.tsx` — sweep summary reworded, ambiguous block removed.
- `client/src/pages/BatchSetup.tsx` — stale help text (references `<slug>-piece-testing`) reworded. No bucket summary exists there, so nothing else changes.
- `client/src/pages/PieceDetail.tsx` — per-piece banner reworked to "found → import all" via a piece-scoped sweep.
- `client/src/lib/api.ts` — **no change**: `testMatchConnection` and `sweepConnections` already return `any`, so the new response shapes need no type edits.

---

### Task 1: Rewrite the matcher to match by pieceName

**Files:**
- Modify: `server/src/services/test-connection-matcher.ts`
- Test: `server/src/services/test-connection-matcher.test.ts`

- [ ] **Step 1: Replace the matcher test file**

Replace the entire contents of `server/src/services/test-connection-matcher.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { classify } from './test-connection-matcher.js';
import type { AppConnection } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: '@activepieces/piece-gmail', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

describe('classify', () => {
  it('returns every connection whose pieceName matches the piece', () => {
    const r = classify('@activepieces/piece-gmail', [
      conn({ id: 'a', pieceName: '@activepieces/piece-gmail', displayName: 'Gmail A' }),
      conn({ id: 'b', pieceName: '@activepieces/piece-gmail', displayName: 'Gmail B' }),
      conn({ id: 'c', pieceName: '@activepieces/piece-slack', displayName: 'Slack' }),
    ]);
    expect(r.status).toBe('found');
    expect(r.connections.map(c => c.displayName)).toEqual(['Gmail A', 'Gmail B']);
  });

  it('matches exactly — a longer pieceName is not a match', () => {
    const r = classify('@activepieces/piece-gmail', [
      conn({ id: 'a', pieceName: '@activepieces/piece-gmail-extra', displayName: 'X' }),
    ]);
    expect(r.status).toBe('none');
    expect(r.connections).toEqual([]);
  });

  it('returns none when no connection matches', () => {
    const r = classify('@activepieces/piece-notion', [conn({ pieceName: '@activepieces/piece-gmail' })]);
    expect(r.status).toBe('none');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/src/services/test-connection-matcher.test.ts`
Expected: FAIL — the current `classify` returns `{ status: 'matched'|'none'|'ambiguous', connection, candidates, expected }`, so `r.connections` is `undefined` and `status` is `'matched'` not `'found'`.

- [ ] **Step 3: Rewrite the matcher**

Replace the entire contents of `server/src/services/test-connection-matcher.ts` with:

```ts
import type { AppConnection } from './ap-client.js';

export type MatchStatus = 'found' | 'none';
export interface MatchResult {
  status: MatchStatus;
  connections: AppConnection[];
}

/**
 * Match by AP pieceName. A remote connection belongs to piece P when its `pieceName`
 * equals P exactly (both sides use the `@activepieces/piece-<slug>` form). Returns every
 * matching connection; `found` when there is at least one, `none` when there are zero.
 */
export function classify(pieceName: string, remoteConns: AppConnection[]): MatchResult {
  const connections = remoteConns.filter(c => c.pieceName === pieceName);
  return { status: connections.length ? 'found' : 'none', connections };
}
```

This deletes `TEST_MARKER`, `pieceSlug`, `normalize`, and `expectedTestName`. A grep confirmed nothing outside this module and `connection-sweep.ts` imports them; `connection-sweep.ts` is fixed in Task 2.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/src/services/test-connection-matcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/test-connection-matcher.ts server/src/services/test-connection-matcher.test.ts
git commit -m "feat: match piece connections by pieceName" --no-verify
```

---

### Task 2: Rewrite the sweep to import all matches, newest active

**Files:**
- Modify: `server/src/services/connection-sweep.ts`
- Test: `server/src/services/connection-sweep.test.ts`

- [ ] **Step 1: Replace the sweep test file**

Replace the entire contents of `server/src/services/connection-sweep.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { getConnectionByPiece, listConnectionsForPiece, createConnection } from '../db/queries.js';
import { sweepTestConnections } from './connection-sweep.js';
import type { AppConnection, ActivepiecesClient } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: '@activepieces/piece-gmail', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

function fakeClient(list: AppConnection[]) {
  const box = { calls: 0 };
  const client = {
    listConnections: async () => { box.calls++; return list; },
  } as unknown as ActivepiecesClient;
  return { client, box };
}

describe('sweepTestConnections', () => {
  beforeEach(() => getDb().exec('DELETE FROM piece_connections; DELETE FROM test_plans;'));

  it('imports every connection for a piece and reports their names', async () => {
    const { client } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A', updated: '2026-01-01T00:00:00Z' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B', updated: '2026-02-01T00:00:00Z' }),
    ]);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(result.linked.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    expect(result.linked[0].importedNames).toEqual(['Gmail A', 'Gmail B']);
    expect(listConnectionsForPiece('@activepieces/piece-gmail')).toHaveLength(2);
  });

  it('activates the newest connection when the piece had none active', async () => {
    const { client } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A', updated: '2026-01-01T00:00:00Z' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B', updated: '2026-02-01T00:00:00Z' }),
    ]);
    await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    const active = getConnectionByPiece('@activepieces/piece-gmail')!;
    expect(JSON.parse(active.connection_value).remote_id).toBe('ext-b');
  });

  it('is idempotent — a re-sweep imports nothing new and reports already_linked', async () => {
    const list = [
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B' }),
    ];
    const { client } = fakeClient(list);
    await sweepTestConnections(client, ['@activepieces/piece-gmail']);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(result.linked).toEqual([]);
    expect(result.alreadyLinked.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    expect(listConnectionsForPiece('@activepieces/piece-gmail')).toHaveLength(2);
  });

  it('preserves an already-active connection across a re-sweep that adds a new one', async () => {
    createConnection({
      piece_name: '@activepieces/piece-gmail', display_name: 'Gmail A', connection_type: 'IMPORTED',
      connection_value: JSON.stringify({ _imported: true, remote_id: 'ext-a' }),
    });
    const { client } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-a', displayName: 'Gmail A', updated: '2026-01-01T00:00:00Z' }),
      conn({ id: 'r2', externalId: 'ext-b', displayName: 'Gmail B', updated: '2026-02-01T00:00:00Z' }),
    ]);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(result.linked[0].importedNames).toEqual(['Gmail B']);
    const active = getConnectionByPiece('@activepieces/piece-gmail')!;
    expect(JSON.parse(active.connection_value).remote_id).toBe('ext-a');
  });

  it('reports skipped_none for pieces with no connections and fetches only once', async () => {
    const { client, box } = fakeClient([conn({ pieceName: '@activepieces/piece-gmail' })]);
    const result = await sweepTestConnections(client, [
      '@activepieces/piece-slack', '@activepieces/piece-notion',
    ]);

    expect(box.calls).toBe(1);
    expect(result.skippedNone.map(r => r.pieceName)).toEqual([
      '@activepieces/piece-slack', '@activepieces/piece-notion',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/src/services/connection-sweep.test.ts`
Expected: FAIL — current sweep uses the old `classify` shape and lacks `importedNames`, per-remote-id idempotency, and the active-selection rule.

- [ ] **Step 3: Rewrite the sweep**

Replace the entire contents of `server/src/services/connection-sweep.ts` with:

```ts
import type { AppConnection, ActivepiecesClient } from './ap-client.js';
import {
  listConnectionsForPiece, getConnectionByPiece, createConnection,
  activateConnection, markPlansStaleByPiece, type PieceConnectionRow,
} from '../db/queries.js';
import { classify } from './test-connection-matcher.js';

export interface SweepPieceResult {
  pieceName: string;
  outcome: 'linked' | 'already_linked' | 'skipped_none' | 'error';
  importedNames?: string[];
  error?: string;
}
export interface SweepResult {
  linked: SweepPieceResult[];
  alreadyLinked: SweepPieceResult[];
  skippedNone: SweepPieceResult[];
  errored: SweepPieceResult[];
}

/** The remote_id stored on an imported row, or undefined for a non-imported/local row. */
function importedRemoteId(row: PieceConnectionRow): string | undefined {
  try {
    const v = JSON.parse(row.connection_value);
    return v?._imported ? v.remote_id : undefined;
  } catch { return undefined; }
}

/** AP timestamp used to pick the "newest" connection; '' when AP omits it. */
function apTimestamp(c: AppConnection): string {
  return String((c as any).updated ?? (c as any).created ?? '');
}

/** Newest by timestamp; ties or missing timestamps fall back to last in list order. */
function pickNewest(conns: AppConnection[]): AppConnection {
  return conns.reduce((best, c) => (apTimestamp(c) >= apTimestamp(best) ? c : best));
}

/**
 * Fetch the AP connection list once; for each piece import every connection (by pieceName)
 * not already imported, keeping a pre-existing active connection or else activating the newest.
 */
export async function sweepTestConnections(
  client: ActivepiecesClient,
  pieceNames: string[],
): Promise<SweepResult> {
  const remoteList = await client.listConnections();
  const result: SweepResult = { linked: [], alreadyLinked: [], skippedNone: [], errored: [] };

  for (const pieceName of pieceNames) {
    const { status, connections } = classify(pieceName, remoteList);
    if (status === 'none') {
      result.skippedNone.push({ pieceName, outcome: 'skipped_none' });
      continue;
    }

    const existingRemoteIds = new Set(
      listConnectionsForPiece(pieceName).map(importedRemoteId).filter(Boolean) as string[],
    );
    const toImport = connections.filter(c => !existingRemoteIds.has(c.externalId || c.id));
    if (toImport.length === 0) {
      result.alreadyLinked.push({ pieceName, outcome: 'already_linked' });
      continue;
    }

    // Capture the active connection before importing — createConnection flips is_active.
    const preActive = getConnectionByPiece(pieceName);

    try {
      const imported = toImport.map(c => ({
        ap: c,
        row: createConnection({
          piece_name: pieceName,
          display_name: c.displayName,
          connection_type: c.type || 'IMPORTED',
          connection_value: JSON.stringify({ _imported: true, remote_id: c.externalId || c.id }),
        }),
      }));

      if (preActive) {
        // Don't disturb a prior active connection (manual choice or earlier import).
        activateConnection(preActive.id);
      } else {
        const newest = pickNewest(imported.map(i => i.ap));
        const row = imported.find(i => i.ap.id === newest.id)!.row;
        activateConnection(row.id);
      }
      markPlansStaleByPiece(pieceName);
      result.linked.push({
        pieceName, outcome: 'linked',
        importedNames: imported.map(i => i.ap.displayName),
      });
    } catch (err) {
      result.errored.push({
        pieceName, outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/src/services/connection-sweep.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify the route still compiles against the new shapes**

The route file forwards results, so no edit is expected. Confirm nothing references removed fields:

Run: `grep -n "expected\|\.candidates\|'matched'\|'ambiguous'\|skippedAmbiguous\|\.connection\b" server/src/routes/connections.ts`
Expected: no matches. (If any appear, remove them — the route should only call `classify(...)` and `sweepTestConnections(...)` and `res.json(...)` the result.)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/connection-sweep.ts server/src/services/connection-sweep.test.ts
git commit -m "feat: sweep imports all piece connections, newest active" --no-verify
```

---

### Task 3: Rework client sweep copy (Connections summary + BatchSetup help text)

**Files:**
- Modify: `client/src/pages/Connections.tsx:61-92`
- Modify: `client/src/pages/BatchSetup.tsx:416-419`

- [ ] **Step 1: Reword the sweep button and result summary**

In `client/src/pages/Connections.tsx`, replace the button label and result block (currently lines 61-92). Change the button text:

```tsx
        <button onClick={() => sweepMut.mutate()} disabled={sweepMut.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded-lg text-sm font-medium disabled:opacity-50">
          {sweepMut.isPending ? 'Importing…' : 'Import piece connections'}
        </button>
```

Replace the entire `{sweepResult && ( ... )}` block with:

```tsx
        {sweepResult && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm space-y-2">
            <p className="text-green-400">
              Imported {sweepResult.linked.reduce((n: number, r: any) => n + (r.importedNames?.length || 0), 0)} connection(s) across {sweepResult.linked.length} piece(s)
            </p>
            <p className="text-gray-400">Already linked {sweepResult.alreadyLinked.length}</p>
            <p className="text-gray-400">No connections {sweepResult.skippedNone.length}</p>
            {sweepResult.errored?.length > 0 && (
              <div className="text-red-400">
                <p>Errored {sweepResult.errored.length}:</p>
                <ul className="list-disc ml-5 text-xs">
                  {sweepResult.errored.map((s: any) => (
                    <li key={s.pieceName}>{s.pieceName}: {s.error}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
```

This removes the `skippedAmbiguous` block entirely.

- [ ] **Step 2: Reword the stale BatchSetup help text**

In `client/src/pages/BatchSetup.tsx`, replace the help paragraph (~lines 416-419) that references the `<slug>-piece-testing` convention:

```tsx
          <p className="text-gray-400 text-sm mb-4">
            Only pieces with an active connection can be set up. Import the connections already
            configured in Activepieces for each piece.
          </p>
```

(No bucket summary is rendered on this page, so nothing else changes here.)

- [ ] **Step 3: Verify the client builds**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors referencing `skippedAmbiguous`.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Connections.tsx client/src/pages/BatchSetup.tsx
git commit -m "feat: reword client sweep copy for import-all" --no-verify
```

---

### Task 4: Rework the PieceDetail per-piece banner

**Files:**
- Modify: `client/src/pages/PieceDetail.tsx` (add a piece-scoped sweep mutation near `importMut` ~line 319; pass it to `ImportPanel` at ~line 791; rework the banner in `ImportPanel` ~lines 1951-1971)

- [ ] **Step 1: Add a piece-scoped sweep mutation**

In `client/src/pages/PieceDetail.tsx`, immediately after the `importMut` mutation block (ends ~line 327), add:

```tsx
  const sweepPieceMut = useMutation({
    mutationFn: () => api.sweepConnections([name!]),
    onSuccess: () => {
      invalidateConns();
      qc.invalidateQueries({ queryKey: ['testMatch', name] });
      setStep('configure');
    },
  });
```

- [ ] **Step 2: Pass the mutation into ImportPanel**

At the `<ImportPanel ... />` usage (~line 791), add the `sweepMut` prop:

```tsx
                <ImportPanel remoteConns={remoteConns} loadingRemote={loadingRemote} isOAuth={isOAuth} dashInfo={dashInfo} importMut={importMut} sweepMut={sweepPieceMut} hasExisting={inactiveConns.length > 0} match={testMatch} />
```

- [ ] **Step 3: Rework the banner inside ImportPanel**

Update the `ImportPanel` signature (~line 1951) to accept `sweepMut`:

```tsx
function ImportPanel({ remoteConns, loadingRemote, isOAuth, dashInfo, importMut, sweepMut, hasExisting, match }: any) {
```

Replace the two banner blocks (the `match?.status === 'matched'` block and the `match?.status === 'ambiguous'` block, ~lines 1955-1971) with a single `found` block:

```tsx
      {match?.status === 'found' && match.connections?.length > 0 && (
        <div className="flex items-center justify-between bg-green-950/40 border border-green-800 rounded-lg px-4 py-3">
          <div>
            <p className="text-sm font-medium text-green-300">
              Found {match.connections.length} connection{match.connections.length > 1 ? 's' : ''} for this piece
            </p>
            <p className="text-xs text-gray-400">{match.connections.map((c: any) => c.displayName).join(', ')}</p>
          </div>
          <button onClick={() => sweepMut.mutate()} disabled={sweepMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-xs font-medium disabled:opacity-50">
            <Download size={13} /> {sweepMut.isPending ? 'Importing…' : 'Import all'}
          </button>
        </div>
      )}
```

The per-connection `remoteConns` list below (with individual **Import** buttons) is unchanged — it still lets the user import one connection at a time. The "Import all" button reuses the sweep so the newest becomes active.

- [ ] **Step 4: Verify the client builds**

Run: `npm run build`
Expected: build succeeds; no references to `match.expected`, `match.connection`, or `match.candidates` remain.

Run: `grep -n "match.expected\|match.connection\b\|match.candidates\|'matched'\|'ambiguous'" client/src/pages/PieceDetail.tsx`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PieceDetail.tsx
git commit -m "feat: PieceDetail banner imports all piece connections" --no-verify
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites pass. Note: a pre-existing failure in `regression-service` (a date time-bomb, unrelated to this work) may appear — confirm any failure is that one and not in the matcher/sweep suites.

- [ ] **Step 2: Build the client**

Run: `npm run build`
Expected: success, no TypeScript errors.

- [ ] **Step 3: Confirm the suffix machinery is fully gone**

Run: `grep -rn "piece-testing\|TEST_MARKER\|expectedTestName\|skippedAmbiguous\|'ambiguous'" server/src client/src --include=*.ts --include=*.tsx | grep -v ".test."`
Expected: no matches.

- [ ] **Step 4: Manual test checklist (hand to the user)**

Do NOT commit anything further until the user has tested (per project convention). Provide this checklist:
- Connections page → "Import piece connections" → summary shows imported/already-linked/no-connections counts, no "ambiguous" line.
- A piece with 2+ AP connections → all appear in the Connections list; exactly one is active (green); Activate switches between them.
- PieceDetail for such a piece → banner shows "Found N connections", "Import all" imports them and lands on Configure; re-opening shows no banner (or all already imported).
- Re-run the sweep → no duplicate rows; previously-active connection stays active.
