# Import piece connections by pieceName

**Date:** 2026-09-22
**Status:** Design approved, pending spec review
**Supersedes:** `docs/superpowers/specs/2026-09-07-auto-link-test-connections-design.md`

## Summary

The auto-link feature currently matches an Activepieces (AP) connection to a piece
by a display-name convention — the connection whose normalized name equals or ends
with `<slug>-piece-testing` — and links exactly one connection per piece.

This redesign drops the naming convention entirely. A piece's connections are now
**every** AP connection whose `pieceName` field equals the piece's name. The sweep
imports **all** of them, keeps the newest one active, and leaves the rest imported
but inactive. The `-piece-testing` suffix, and the `ambiguous` (>1 match) skip case,
are removed.

## Motivation

The suffix convention required every testable connection in the AP project to be
named `<slug>-piece-testing`, and silently skipped a piece when it had zero or more
than one such connection. In practice the tester's AP project just has connections
per piece; requiring the marker name was friction and the "ambiguous → skip" rule
hid usable connections. Matching on the `pieceName` AP already stores is direct and
needs no naming discipline.

## Decisions (locked with the user 2026-09-22)

1. **Match key:** AP `pieceName` field, exact equality (`c.pieceName === pieceName`).
   Both sides use the `@activepieces/piece-<slug>` form. No display-name logic.
2. **Multiplicity:** import **all** matching connections for the piece.
3. **Active selection:** keep the **newest** connection active; import the rest as
   inactive. Precise rule below.
4. **Scope:** backend only — the Connections page already lists all connections
   (active green / inactive dimmed) and has an **Activate** button that switches the
   active one, so no new UI is needed.

## Non-goals

- **Not** running a piece's tests once per connection ("test each connection"). Runs
  still resolve a single active connection per piece via `getConnectionByPiece`.
- **No** schema change. `piece_connections` already holds multiple rows per piece
  with one `is_active = 1`; `activateConnection` already deactivates siblings.
- No new connection-switching UI (the Activate button already exists).

## Architecture

### 1. Matcher — `server/src/services/test-connection-matcher.ts`

Replace suffix matching with pieceName matching.

```
export type MatchStatus = 'found' | 'none';
export interface MatchResult {
  status: MatchStatus;
  connections: AppConnection[];   // all AP conns for this piece (empty when none)
}

export function classify(pieceName: string, remoteConns: AppConnection[]): MatchResult {
  const connections = remoteConns.filter(c => c.pieceName === pieceName);
  return { status: connections.length ? 'found' : 'none', connections };
}
```

Delete `TEST_MARKER`, `expectedTestName`, and the `ambiguous` status. Delete
`normalize` and `pieceSlug` unless a pre-delete grep shows another consumer (current
grep shows none outside this module and its test).

### 2. Sweep — `server/src/services/connection-sweep.ts`

Import every matching connection per piece, idempotently.

- Fetch the AP connection list once (unchanged).
- For each piece, `classify` to get its connections.
- **Dedup per remote connection.** A match is "already imported" when a
  `piece_connections` row for the piece already carries that remote id
  (`connection_value._imported` with `remote_id === (externalId || id)`). Import only
  matches not already present. Re-running never duplicates and never disturbs
  existing rows.
- Import a new match via the existing `createConnection(...)` with
  `{ _imported: true, remote_id: externalId || id }`.
- **Active selection:**
  - If the piece has **no** active connection → after importing, activate the AP
    connection with the most recent timestamp (AP `updated`/`created` if present on
    the connection object; otherwise the last one in AP's list order).
  - If the piece **already has** an active connection (prior import or manual choice)
    → leave it active; import the rest as inactive. A re-sweep never yanks the active
    connection out from under an in-flight setup.
  - Note: `createConnection` activates the row it inserts and deactivates siblings, so
    achieving "keep existing active" means either importing new matches as inactive,
    or re-activating the prior active row after the inserts. Implementation picks
    whichever is cleanest with the existing queries (e.g. import all, then call
    `activateConnection` on the chosen id).
- `markPlansStaleByPiece(pieceName)` fires **once per piece**, only when ≥1 new
  connection was imported for it.

**Result buckets:**

```
interface SweepPieceResult {
  pieceName: string;
  outcome: 'linked' | 'already_linked' | 'skipped_none' | 'error';
  importedNames?: string[];   // display names of newly imported connections
  error?: string;
}
interface SweepResult {
  linked: SweepPieceResult[];        // ≥1 new connection imported
  alreadyLinked: SweepPieceResult[]; // all matches already present
  skippedNone: SweepPieceResult[];   // piece has 0 AP connections
  errored: SweepPieceResult[];
}
```

The `skippedAmbiguous` bucket and the `expected` field are removed throughout.

### 3. Routes — `server/src/routes/connections.ts`

- `GET /remote/:pieceName/test-match` → still returns `classify(...)`, now the new
  `{ status, connections }` shape. (`GET /remote/:pieceName` already filters by
  `pieceName` and is unchanged.)
- `POST /sweep` → unchanged trigger; returns the new `SweepResult`.
- No change to `POST /import`, `POST /:id/activate`.

### 4. Client

- `PieceDetail.tsx` banner (`api.testMatchConnection` → `ImportPanel match={testMatch}`):
  when `status === 'found'` and some connections are not yet imported, show
  "Found N connection(s) for this piece — import". After import they appear in the
  piece's connection list, newest active. No banner when all are already imported or
  `status === 'none'`.
- `Connections.tsx` sweep summary and `BatchSetup.tsx` sweep button: update the
  summary text to "Imported X connections across Y pieces; Z pieces had none;
  N already linked" plus the errored list. Remove the ambiguous/skipped line.
- `client/src/lib/api.ts`: response types updated to the new shapes; no new methods.

## Data flow

1. User triggers sweep (Connections button, BatchSetup catalog button) or opens a
   piece (per-piece banner).
2. Server fetches AP connections once, filters by `pieceName` per piece.
3. New matches are imported into `piece_connections`; newest active per the rule.
4. Plans for a piece are marked stale iff a new connection was imported for it.
5. Imported connections render in the existing Connections list; Activate switches
   which one runs.

## Error handling

- AP list fetch failure → route returns `500` with `ActivepiecesClient.formatError`
  (unchanged).
- A match that fails to persist → `errored` bucket carrying the message (kept from
  today, so a link failure is never misreported as "none").

## Testing

- `test-connection-matcher.test.ts` — rewrite around pieceName matching: `found`
  with N connections, `none` with zero, exact-match only (no cross-piece false
  positives, e.g. `piece-gmail` vs `piece-gmail-extra`). Drop suffix/ambiguous cases.
- `connection-sweep.test.ts` — rewrite: import-all for a multi-connection piece;
  per-remote-id idempotency (re-sweep adds nothing, disturbs nothing); active
  selection (no active → newest active; existing active → preserved); `skipped_none`;
  `errored` on persist failure.

## Risk / assumption

Matching by `pieceName` imports **every** connection a piece has in the AP project —
including any production or non-test connection that happens to exist there. This is
assumed acceptable because it is the dedicated tester's AP project (all connections
there are fair game). Dropping the `-piece-testing` marker removes the only signal
that a connection is "meant for testing"; if that project is ever shared with
non-test connections, this would over-import.

## Affected files

- `server/src/services/test-connection-matcher.ts` (+ test) — rewrite
- `server/src/services/connection-sweep.ts` (+ test) — rewrite
- `server/src/routes/connections.ts` — response shape (drop `expected`, new buckets)
- `client/src/lib/api.ts` — response types
- `client/src/pages/PieceDetail.tsx` — banner wording/logic
- `client/src/pages/Connections.tsx` — sweep summary
- `client/src/pages/BatchSetup.tsx` — sweep summary
