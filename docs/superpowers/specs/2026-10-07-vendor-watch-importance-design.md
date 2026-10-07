# Vendor Watch: importance filter (High / Medium / Low)

## Problem

The Vendor Changes inbox lists findings newest first. A deprecation in Google Sheets (14,000+ Cloud projects)
sits next to the same kind of finding in a piece nobody uses, and both look equally urgent. As the watch list grows
past the ~10-piece pilot, triage needs to start with the pieces that matter: the most used ones, and the ones
enterprise customers depend on.

## Goal

Every watched piece gets an **importance**: High, Medium, Low, or Unrated (no data yet). The Inbox, Filed and
Watchers tabs show it and can filter by it, and the Inbox sorts by it. The Generate-watchers picker shows it too,
so the next pilot pieces can be picked by importance.

## Signals

1. **Cloud usage.** The number of Cloud projects that use the piece, summed over **every published version**. The
   catalog's `projectUsage` counts projects per `name@version` row and the list endpoint only returns the latest
   version, so a piece the team bumps often looks unused (Slack shows 2 there; the real number is ~1,800). The sum is
   an upper bound, because a project on two versions counts twice. That's fine for tiering.
   - Versions: `GET cloud.activepieces.com/api/v1/pieces/registry?release=<CURRENT_VERSION>&edition=cloud` returns
     every `name@version` on Cloud in one call (13,169 rows on 2026-10-07). `CURRENT_VERSION` comes from
     `GET /api/v1/flags`.
   - Usage per version: `GET /api/v1/pieces/<name>?version=<v>` → `projectUsage`.
2. **Enterprise list.** Cloud can't see enterprise usage, because enterprise customers mostly self-host. NetSuite shows
   6 Cloud projects, SQL Server 0 and Business Central 0. So enterprise importance is a **hand-kept list** in the
   Vendor Watch config, and a piece on it is always High. The list lives only in the DB. This repo is public, so no
   customer-derived list is committed.

## Tier rule

| Condition (first match wins) | Importance |
|---|---|
| Piece is on the Enterprise list | High |
| No usage fetched yet | Unrated |
| Cloud projects ≥ `importance_high_min` (default **300**) | High |
| Cloud projects ≥ `importance_medium_min` (default **50**) | Medium |
| Otherwise (including pieces not on Cloud: 0) | Low |

The defaults come from the 2026-09-19 all-versions usage table (766 pieces): about 52 High, 79 Medium and 635 Low.
Stripe (491) and HubSpot (492) land in High. Salesforce (93) lands in Medium unless it is put on the Enterprise list,
and that is the job of the list. Both thresholds can be changed in Config.

The rule lives in **one place**, an SQL `CASE` built by `importanceSelect()` in `vendor-watch-queries.ts`. Every list
(findings, plans, the usage map) and the ticket draft read importance through it.

## Data

- New table `piece_usage(piece_name PK, projects, versions, versions_failed, fetched_at)`. Each refresh replaces one
  row per piece. A piece missing from the Cloud registry is stored as 0 projects / 0 versions (Low, "not on Cloud").
- New `vendor_watch_config` columns: `importance_high_min` (300), `importance_medium_min` (50) and `enterprise_pieces`
  (JSON string array, `[]`). These are guarded `ALTER TABLE`s, because pilot DBs already have the table.

## Refresh

- `piece-usage.ts` holds `refreshPieceUsage(scope)`. It makes one registry call, then fetches every version of every
  piece in scope, 8 at a time, with a 20 s timeout per request. Failed versions are counted in `versions_failed`
  and left out of the sum. A piece whose versions **all** failed keeps its old row. If the registry call fails, the
  refresh fails and no rows change.
- **Single-flight.** Only one refresh runs at a time. Progress (`scope`, `done`, `total`, `error`, timestamps) is kept
  in memory for the Config card.
- **Scopes.** `watched` (pieces with a watch plan, usually a few hundred requests) and `catalog` (every Cloud piece,
  ~13k requests, 5–10 min). `catalog` runs only by hand, from Config.
- **Lazy freshness.** `GET /plans` and `GET /findings` call `ensureWatchedUsage()`. It starts a background `watched`
  refresh for pieces with no row or a row older than 7 days, and does not retry a piece within 1 hour of a failed
  attempt. This covers first deploy, newly generated watchers and weekly freshness with no new cron. When nothing is
  stale it costs one query.

## API (`/api/vendor-watch`)

- `GET /findings?status=&piece=&importance=high,medium,low,unrated` → `{ findings, counts }`. Each row gains
  `importance`, `enterprise`, `usage_projects` and `usage_fetched_at`. `counts` holds per-tier totals for the same
  status/piece, ignoring the importance filter, for the chips. The Inbox (`status=new`) sorts by importance, then
  severity, then newest. Filed keeps newest first. The filter runs in SQL, before the existing 500-row cap.
- `GET /plans`: rows gain the same four fields and are ordered by importance, then piece name.
- `GET /usage` → `{ pieces: [{ piece_name, projects, importance, enterprise }], refresh }` for the Generate picker.
- `POST /usage/refresh { scope: 'watched' | 'catalog' }` → 202, or 409 while a refresh runs.
- `PUT /config` accepts `importance_high_min`, `importance_medium_min` (whole numbers, high > medium ≥ 1) and
  `enterprise_pieces` (array of piece names, max 200).

## UI

- **Badge** (`ImportanceBadge`): signal-bar icon plus label, in a different palette from severity, so "how bad is the
  change" and "how much does the piece matter" never look alike. High is violet with 3 bars, Medium is sky with 2 bars,
  Low is gray with 1 bar, and Unrated is a dim dash. Enterprise pieces add a small building icon. The tooltip gives the
  numbers, e.g. "High · 491 Cloud projects (all versions) · Enterprise list · usage from 2026-10-07".
- **Filter** (`ImportanceFilter`): toggle chips `High n · Medium n · Low n · Unrated n` (Unrated shows only when it is
  above 0). Several can be on at once (for example High + Medium to hide the Low noise), and none on means all. The
  filter lives in the URL (`?importance=high,medium`), so a filtered inbox can be linked, and it is shared by Inbox,
  Filed and Watchers.
- **Inbox / Filed:** a new Importance column after Piece, plus the filter row.
- **Watchers:** the Importance column, the filter, and ordering by importance.
- **Generate watchers picker:** a badge per piece where usage is known, sorted by Cloud projects (most used first),
  with the same chips. Because "pilot the 10 most important pieces" is the next rollout step.
- **Config:** a new Importance section with the two thresholds, the Enterprise list (chips with ×, plus an input with
  catalog type-ahead), the usage status ("N pieces rated · oldest from …") and two buttons: Refresh watched pieces /
  Refresh whole catalog. Each button shows progress.

## Ticket text

Filed tickets get one extra line: `**Importance:** High (491 Cloud projects · Enterprise list)`. Priority still comes
from severity. Mapping importance onto priority is a follow-up, to decide once real tickets exist.

## Out of scope / follow-ups

- Seeding the Enterprise list from Pylon (tickets per piece from enterprise accounts). The Pylon API isn't wired into
  the tester.
- Self-hosted usage telemetry: there is no source for it.
- Using importance in the auto-file rule or Linear priority.

## Testing

- `importance` tier rule via the query layer: enterprise wins over usage, Unrated without a row, threshold edges,
  config changes re-tier without a refresh.
- `listFindings` filter, counts, inbox sort order, and the 500-row cap applied after the filter.
- `refreshPieceUsage` with an injected fetch: sums over versions, a piece missing from the registry becomes 0, partial
  failures are counted, an all-failed piece keeps its old row, a registry failure changes nothing, single-flight
  returns 409-equivalent.
- `ensureWatchedUsage`: only stale/missing pieces, 1 h back-off after failure.
- `parseConfigPatch`: thresholds and enterprise list validation.
- Ticket draft: the importance line.
- No live network in tests.
