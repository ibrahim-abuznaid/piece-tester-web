# Bug Trend page — Pieces Team bugs over time, from Linear

**Date:** 2026-09-24
**Server:** `server/src/db/schema.ts`, `server/src/routes/settings-view.ts`, `server/src/routes/settings.ts`, `server/src/index.ts`, new `server/src/services/bug-trend/*`, new `server/src/routes/bug-trend.ts`
**Client:** `client/src/App.tsx`, `client/src/components/Layout.tsx`, `client/src/lib/api.ts`, `client/src/pages/Settings.tsx`, new `client/src/pages/BugTrend.tsx`, new `client/src/components/bug-trend/*`
**Status:** Approved, ready for implementation plan
**Relates to:** the "Report to Pieces" transport (`server/src/services/report-transport.ts`), which files `piece-tester` issues into Linear through a webhook. This spec adds the first *read* path from Linear.

## Problem

The team lead wants one picture to send managers that answers "are Pieces Team bugs going down?"
Today that answer lives only in Linear filters. The Piece Tester has no Linear read access: it can
file an issue through the Activepieces webhook flow, but it never reads one back
(`piece_reports.status` stays `reported` forever).

Two facts shape the design:

- **Bugs close fast.** The team fixes most bugs in 1–5 days, so "open bugs right now" sits near
  zero almost every day. The number that can visibly move is **bugs opened per week**.
- **Linear labels differ by team.** The `GIT` team has a type group (`🐛 bug` / `🌟 feature` /
  `✨ polishing`) and a `🛟 support` intake label. The `PIE` team has **no** bug label, only
  `source/*`, `area/*` and `piece-tester`. PIE also carries a batch of auto-created junk tickets,
  all canceled.

## Goal

A **Bug Trend** page in the Piece Tester with two charts and three headline numbers, built live
from Linear, that the lead can download as one PNG and paste into a message to managers.

- Chart 1: **bugs opened per week**, stacked by source, with a 4-week rolling average line.
- Chart 2: **open bugs at the end of each day**.
- KPI tiles: open now · opened in the last 28 days vs the 28 before · median days to fix.

Non-goals are listed under [Out of scope](#out-of-scope).

## Design

### 1. What counts as a bug

A **tracked bug** is a Linear issue that matches either query, whose state type is not
`canceled`, and that is not in the trash:

| Team | Filter | Assignee |
|---|---|---|
| `GIT` | label `🐛 bug` | current assignee is on the **roster** |
| `PIE` | label `piece-tester` | any |

- **Canceled and duplicate issues are excluded entirely** (Linear gives duplicates a
  `canceled`-type state). This drops the PIE junk tickets and "not a bug" closures.
- **Deleted (trashed) issues are excluded too** (`trashed` is true). Deleting an issue in Linear
  moves it to the trash, which archives it, so `includeArchived: true` would otherwise keep
  returning it until Linear purges it. It is the same kind of junk as a canceled issue.
- **PIE `🏢 customer` tickets are not counted.** PIE has no bug label, so those tickets mix
  features and bugs and would inflate the count.
- **Source** is assigned by the first rule that matches:
  1. has label `piece-tester` → **Caught by the tester** (`tester`)
  2. has label `🛟 support` → **Reported by support** (`support`)
  3. otherwise → **Found internally** (`internal`)
- **Fixed** means `completedAt` is set. Days to fix = `(completedAt − createdAt) / 1 day`.
- Label names and team keys live in one constants block in `bug-trend.ts` (`LINEAR_LABELS`,
  `LINEAR_TEAMS`), which `linear-client.ts` imports.

### 2. Server: fetching from Linear

New module `server/src/services/bug-trend/`:

**`linear-client.ts`** talks to `https://api.linear.app/graphql` with axios (the server's existing
HTTP client). Personal API keys go in the header as `Authorization: <key>` with **no** `Bearer`
prefix.

- `fetchTrackedBugs(apiKey, rosterIds)` runs two paginated queries (GIT, PIE), 100 per page,
  following `pageInfo.endCursor` until `hasNextPage` is false, with **`includeArchived: true`**
  (Linear auto-archives closed issues after a team-set period; without this flag old fixed bugs
  silently vanish from the history).
- Fields: `identifier title url createdAt completedAt trashed state { type } team { key }
  assignee { id name } labels { nodes { name } }`. No date filter: the total is a few dozen issues.
  `trashed` is selected only to drop deleted issues (§1).
- `fetchViewer(apiKey)` runs `viewer { id name }`, used to validate a key on save.
- `fetchActiveUsers(apiKey)` returns `{ id, name, displayName }` for active workspace users.
- Errors: an HTTP 401/403 becomes `LinearError('Linear rejected the API key')`; a 200 response
  with a GraphQL `errors` array becomes `LinearError(<first error message>)`; network errors keep
  their message. Callers never see the key in any error text.

**`bug-trend.ts`** holds the pure functions and their types. It does all the math; the client only
formats. `classifySource(labelNames): BugSource` applies the source rules from §1;
`linear-client.ts` calls it while normalizing each Linear issue into a `TrackedBug` (and drops
`canceled`-type and trashed issues there).

```ts
type BugSource = 'support' | 'internal' | 'tester';

interface TrackedBug {            // normalized from Linear, canceled and trashed already dropped
  identifier: string; title: string; url: string;
  team: 'GIT' | 'PIE'; source: BugSource;
  assigneeName: string | null;
  createdAt: string; completedAt: string | null;   // ISO
}

interface BugTrendWeek {
  weekStart: string;              // YYYY-MM-DD, a Monday, UTC
  support: number; internal: number; tester: number; total: number;
  rolling4: number | null;        // mean of `total` over this week + the 3 before
  inProgress: boolean;            // the current, unfinished week
}

interface BugTrendDay { date: string; open: number; openIds: string[] }   // end of day, UTC

interface BugTrendKpis {
  openNow: number;
  openedLast28: number; openedPrev28: number;
  medianDaysToFix: number | null; fixedCount: number;
}

interface BugTrend {
  from: string; asOf: string; markerDate: string;
  weeks: BugTrendWeek[]; days: BugTrendDay[]; kpis: BugTrendKpis;
  issues: TrackedBug[];           // the bugs behind the charts and KPIs: createdAt >= the first
                                  // bar's Monday, still open, or completedAt in [from, now]
}

function buildBugTrend(bugs: TrackedBug[], opts: { from: string; now: Date; markerDate: string }): BugTrend;
```

Rules `buildBugTrend` implements:

- **Weeks** start Monday 00:00 **UTC**. Bars cover every week from the Monday on or before `from`
  through the current week, zero-filled. A bug created before that first Monday is not in any bar.
- **`rolling4`** uses the three weeks before each bar even when they fall before `from` (the full
  issue history is available), so the line starts at the first bar. It is `null` for the
  in-progress week, so a half-finished week never drags the average down.
- **Days** run from `from` through today. `open` counts bugs with `createdAt` before the end of
  that UTC day and `completedAt` null or after it. Today's point is computed at `now`, so it
  equals `kpis.openNow`. A bug opened and fixed on the same day never shows on this line; it does
  show in the weekly bars.
- **KPI windows are relative to `now`, not `from`:** `openedLast28` counts `createdAt` in
  (now − 28 d, now]; `openedPrev28` counts (now − 56 d, now − 28 d].
- **`medianDaysToFix`** is over bugs whose `completedAt` falls in [from, now], one decimal place,
  `null` when none. `fixedCount` is that sample size.
- `markerDate` is passed through unchanged. It is a constant, `TESTER_AT_SCALE_DATE = '2026-08-01'`
  (the month plan runs jumped from hundreds to thousands), not a setting.

**`bug-trend-cache.ts`** holds the raw `TrackedBug[]` fetch result in memory, not the built trend
(building is cheap and depends on `from`). It takes the fetcher and a clock as arguments so it can
be tested without Express.

- TTL **15 minutes**. `refresh: true` bypasses it.
- `invalidate()` is called whenever the Linear key or the roster is saved or removed.
- If a fetch fails and a cached copy exists, return the cached copy plus a warning:
  `Couldn't reach Linear (<message>). Showing data from <HH:MM UTC>.`

### 3. Server: routes

New router `server/src/routes/bug-trend.ts`, mounted at `/api/bug-trend` **after** the
`app.use('/api', requireAuth)` line in `index.ts`, like every other data route.

`GET /api/bug-trend?from=YYYY-MM-DD&refresh=1`

| Situation | Response |
|---|---|
| No Linear key saved | `200 { state: 'needs-setup', missing: 'key' }` |
| Key saved, roster empty | `200 { state: 'needs-setup', missing: 'roster' }` |
| Fetch OK (or served from cache) | `200 { state: 'ok', fetchedAt, warnings: string[], trend: BugTrend }` |
| Fetch failed, no cache | `502 { error: <LinearError message> }` |
| `from` missing | defaults to `2026-06-01` |
| `from` malformed or in the future | `400 { error }` |

`from` is checked against the request time, but the trend is built as of `fetchedAt`. When the
cached data was fetched before UTC midnight and `from` is today, the trend starts on the fetch day
instead (`trend.from` is that day), so `days` is never empty.

`warnings` also carries a data-sanity note when a whole query comes back empty, e.g.
`No GIT issues matched label "🐛 bug" for the roster. Check the label name and the roster.`
This is the only guard against a label being renamed in Linear.

### 4. Settings: the Linear key and the roster

**Storage.** Two columns on the single-row `settings` table, added with the same idempotent
`ALTER TABLE` guard `initTables` already uses:

- `linear_api_key TEXT NOT NULL DEFAULT ''`
- `bug_trend_roster TEXT NOT NULL DEFAULT '[]'`: JSON `[{ id, name }]`, matched by Linear user ID

`settings-view.ts` adds `linear_api_key` to `SettingsForView` and masks it with `maskLong`, the
same way as `anthropic_api_key`. The raw key never reaches the browser. The roster is not secret
and passes through as parsed JSON.

**Endpoints** on the existing settings router, following `save-anthropic-key` /
`remove-anthropic-key`:

- `POST /api/settings/save-linear-key { api_key }`: trims, calls `fetchViewer`, and rejects a bad
  key with `400 { error: <LinearError message> }` without saving. On success it saves the key,
  invalidates the cache and, **if the roster is empty**, seeds it (below). Response:
  `{ success, viewer: name, seeded: string[], notFound: string[] }`.
- `POST /api/settings/remove-linear-key`: clears the key, invalidates the cache. The roster is kept.
- `GET /api/settings/linear-users`: `fetchActiveUsers` via the saved key; `409` if no key.
- `PUT /api/settings` accepts `bug_trend_roster` (validated as an array of `{ id: string, name:
  string }`) and invalidates the cache.

**One-time seed.** When a key is saved and the roster is `[]`, the server matches these display
names case-insensitively against active users' `name` and `displayName`: "Ibrahim Abu Znaid",
"Kishan Parmar", "Sanket Nannaware", "Odai Thalji", "Talal Jaber". Matches are saved by **ID**;
misses are reported back in `notFound`. Names are used only for this seed. After it, the saved
IDs are the truth, and a user can edit the list freely.

**Settings UI.** A new **"Linear — Bug Trend"** card in `Settings.tsx`, next to the existing
Linear report webhook card:

- Masked key field with Save / Remove, same interaction as the Anthropic key card, plus one line of
  help: *Create a personal API key in Linear → Settings → Account → Security & access. Give it
  Read access only, limited to the GIT and PIE teams, if Linear offers those options.*
- Once a key is saved: a searchable checklist of active Linear users (from `linear-users`), with
  roster members checked and listed first, and a Save roster button.

### 5. The Bug Trend page

**Navigation.** New sidebar entry **Bug Trend** (lucide `TrendingDown` icon) directly after
Reports in `Layout.tsx`; route `/bug-trend` in `App.tsx`; page `client/src/pages/BugTrend.tsx`.
Chart parts live in `client/src/components/bug-trend/` (`KpiRow`, `OpenedPerWeekChart`,
`OpenBugsChart`, `BugTable`) so the page file stays small. Data comes through a new
`api.getBugTrend({ from, refresh })` in `client/src/lib/api.ts`, called with React Query.

**Layout.** Controls sit *outside* the exported card, so the PNG holds only the picture:

```
Bug Trend                          From [2026-06-01]   Updated 20:31 UTC ↻   [Download PNG]
┌─ export card (fixed 960 px wide) ──────────────────────────────────────────────┐
│ Pieces Team bugs                                                               │
│ GIT 🐛 bug assigned to the team + tester-filed PIE · Jun 1 – Sep 24, 2026       │
│ ┌ Open now ┐  ┌ Opened, last 28 days ┐  ┌ Median days to fix ┐                  │
│ │    1     │  │  6   ↓ 45% vs 11     │  │  2.1   (27 fixed)  │                  │
│ └──────────┘  └──────────────────────┘  └────────────────────┘                  │
│ Bugs opened per week       ■ Reported by support ■ Found internally            │
│                            ■ Caught by the tester  ─ 4-week average            │
│ [stacked columns · average line · dashed "Tester at scale" marker]              │
│ Open bugs at end of day                                                        │
│ [step line · same marker]                                                      │
│ footnote: what's counted and what isn't                                        │
└────────────────────────────────────────────────────────────────────────────────┘
▸ Show the 33 bugs                     (table, not in the PNG)
```

**Chart 1: Bugs opened per week** (`recharts` `ComposedChart`, height 240):

- Stacked `Bar`s in a fixed order, bottom to top: support, internal, tester. A source that is zero
  in every week is dropped from the chart and the legend.
- X-axis ticks show each week's Monday as `Aug 4`.
- The **in-progress week** is drawn at 40% opacity; its tooltip says "this week so far".
- `Line` for `rolling4`, 2 px, neutral ink, no dots, same y-axis (both are bug counts; no second
  axis).
- `ReferenceLine` at the week containing `markerDate`, dashed, muted, labeled "Tester at scale".
- Tooltip: the week's date range, a count per source, the total and the 4-week average.

**Chart 2: Open bugs at end of day** (`LineChart`, height 160):

- One `Line`, `type="stepAfter"`, 2 px, neutral ink. A single series, so no legend: the title
  names it.
- The same dashed marker at `markerDate`.
- Tooltip: the date, the open count and the open issue IDs.

**Colors.** The app is dark, with `bg-gray-900` (`#111827`) cards. Series colors follow the
dataviz reference palette's dark steps, validated against `#111827` with the palette validator
(lightness, chroma, CVD separation, normal-vision floor and contrast all pass; worst adjacent pair
aqua/orange ΔE 9.4 deutan):

| Role | Hex |
|---|---|
| Reported by support | `#3987e5` |
| Found internally | `#d95926` |
| Caught by the tester | `#199e70` |
| 4-week average line, open-bugs line | `#d1d5db` (neutral: "all bugs, any source") |
| Grid / axis ticks / tooltip | `#1f2937` / `#6b7280` / `TOOLTIP_STYLE` from `Reports.tsx` |

Stacked segments are separated by a 2 px gap in the card color; only the top segment gets
4 px rounded corners. Text (titles, tick labels, legend labels, KPI values) uses the text colors,
never a series color.

**KPI tiles.** Plain text, no sparkline:

- **Open now**: `kpis.openNow`.
- **Opened, last 28 days**: `openedLast28`, then an arrow icon + percent vs `openedPrev28`
  (`↓ 45% vs 11`). Down is shown in the good color, up in the critical color, always with the
  arrow and the word "vs", so direction is never color alone. When `openedPrev28` is 0 the delta
  reads "— vs 0".
- **Median days to fix**: `medianDaysToFix` with `(N fixed)`; "—" when there are none.

**Footnote** (inside the card, so it travels with the PNG): *Counts GIT bugs whose current
assignee is on the Pieces team, plus bugs the Piece Tester filed on PIE. Support routes some piece
bugs to other engineers, so routing changes move these numbers. Canceled and duplicate issues are
left out. Weeks start Monday (UTC). Lighter bar = this week so far.*

**Download PNG.** New client dependency **`html-to-image`**. It captures the whole card (title,
KPI tiles, both charts, footnote); plain SVG-to-canvas would capture one chart at a time.

- `toPng(cardRef.current, { pixelRatio: 2, backgroundColor: '#111827', style: { margin: '0' } })`,
  saved as `pieces-team-bugs-YYYY-MM-DD.png` (the `asOf` date). The fixed 960 px card width means
  every export is 1920 px wide. `margin: '0'` is required: html-to-image copies the card's computed
  `mx-auto` margin onto the clone, which on wide screens shifts the capture right and cuts off the
  card's right edge.
- All chart series set `isAnimationActive={false}` so a capture never catches a half-drawn chart.
- The button shows a spinner while capturing and an inline error if `toPng` throws.

**Bug table.** Collapsed by default under the card, not part of the PNG. It is the table view
behind the charts and the place to answer "which bugs were those?". Columns: ID (links to Linear),
title, source, assignee, opened, fixed, days to fix. Newest first.

**Empty, error and stale states:**

| Situation | Page shows |
|---|---|
| `needs-setup`, missing key | Card: "Connect Linear to see the bug trend" + **Open Settings** link |
| `needs-setup`, missing roster | Card: "Pick the team members to count" + **Open Settings** link |
| `502` | Red banner with the Linear error + **Retry** (a `refresh=1` call) |
| `warnings` non-empty | Amber note above the card per warning; the card still renders |
| No bugs in the window | Charts render zero-filled; KPI tiles show 0 / "—" |

The card subtitle's "as of" date comes from `fetchedAt`, so a PNG taken from stale cached data
still carries the right date.

## Testing

Tests first for the pure logic (`superpowers:test-driven-development`). Vitest, like the rest of
the repo.

**`server/src/services/bug-trend/bug-trend.test.ts`**, covering `classifySource` and
`buildBugTrend`:

- Source precedence: `piece-tester` + `🛟 support` on one issue → `tester`; `🛟 support` alone →
  `support`; neither → `internal`.
- A bug created Sunday 23:59 UTC and one created Monday 00:00 UTC land in different weeks.
- Weeks are zero-filled from the Monday on or before `from`; bugs before it are not in any bar.
- The current week has `inProgress: true` and `rolling4: null`; `rolling4` for the first bar uses
  weeks before `from`.
- Daily `open`: a bug open across `from` counts from day one; opened and fixed the same day → never
  open; the last day equals `kpis.openNow`.
- KPI windows at the 28- and 56-day edges; median with an even count, an odd count and none.
- `issues` includes a bug created before `from` that is still open, one created before `from` and
  fixed inside the window, and a first-bar bug created before a non-Monday `from`.

**`linear-client.test.ts`** with a mocked axios: follows `endCursor` across pages; sends
`includeArchived: true`; sends the key without `Bearer`; drops `canceled`-type and trashed issues;
maps 401, GraphQL `errors` and network failures to `LinearError`, and no error message contains
the key.

**`bug-trend-cache.test.ts`** with a fake clock and a stub fetcher: a hit inside 15 minutes, a
miss after; `refresh` bypasses; `invalidate()` forces a fetch; a failure with a cached copy returns
the copy plus the stale warning; a failure without one throws.

**`settings-view.test.ts`** (extend the existing test): `linear_api_key` comes back masked, never
raw; `bug_trend_roster` comes back parsed.

**Seed matching:** a small pure `matchRosterSeed(users, names)` with tests for case-insensitive
match on `name` or `displayName`, and a miss reported in `notFound`.

**Manual check before merge:**

1. Run locally with a real Linear key; confirm the seeded roster in Settings.
2. Pick two weeks and compare the per-source counts with the same filter in Linear's UI.
3. Download the PNG, open it, and look for label collisions, clipped text and a missing legend.
4. Remove the key and confirm the setup card; save a bad key and confirm the error.

## Rollout

- Branch `feat/bug-trend` from `origin/main`, one PR to `main`. CI (typecheck + tests) gates the
  deploy to the droplet on merge.
- After deploy, the lead creates the Linear key and saves it in the live app's Settings, then
  confirms the roster. The key lives only in the droplet's SQLite settings row. This repo is
  public, so no key, token or user ID goes into any committed file.
- `html-to-image` is the only new dependency.

## Out of scope

- Auto-posting the chart anywhere, or a public share link. Sharing is the PNG.
- Assignee history. The count uses the *current* assignee; tracking who owned a bug at the time
  needs a nightly sync table (rejected approach B).
- A light-mode export. The PNG matches the app's dark theme.
- A configurable marker date, more markers, or annotations.
- `🌟 feature` / `✨ polishing` issues, and PIE issues without `piece-tester`.
- Syncing `piece_reports.status` back from Linear.

## Risks

- **The trend depends on routing, not only on quality.** Only bugs assigned to the roster count.
  When support routes more piece bugs to the team (for example after a new hire), the "opened"
  bars rise even if piece quality is flat. The footnote says this; the lead should say it too when
  sharing.
- **The tester marker invites a before/after reading that the data may not support.** Routing to
  the team changed around the same time the tester scaled up. The marker is context only (it
  explains when "Caught by the tester" bars begin), not a causal claim, and the KPI tile compares
  rolling 28-day windows rather than before/after the marker for this reason.
- **A renamed label silently drops bugs.** The all-empty warning catches a full rename; a partial
  relabel would not be caught.
- **Read-only key scoping** depends on what Linear's key settings offer. A normal personal key
  works if they don't.
