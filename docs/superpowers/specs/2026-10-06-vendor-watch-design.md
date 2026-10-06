# Vendor Watch — watch vendor APIs and file Linear tickets when they break us

**Date:** 2026-10-06
**Server:** `server/src/db/schema.ts`, `server/src/index.ts`, `server/src/agents/v2/{agent-runner,types,cost-tracker,tool-registry}.ts`, `server/src/agents/v2/tools/index.ts`, `server/src/services/bug-trend/linear-client.ts`, new `server/src/services/vendor-watch/*`, new `server/src/db/vendor-watch-queries.ts`, new `server/src/agents/v2/{workers,prompts}/watch-planner.ts`, new `server/src/agents/v2/tools/{probe-source,set-watch-plan}.ts`, new `server/src/routes/vendor-watch.ts`
**Client:** `client/src/App.tsx`, `client/src/components/Layout.tsx`, `client/src/lib/api.ts`, `client/src/pages/PieceDetail.tsx`, new `client/src/pages/VendorWatch.tsx`, new `client/src/components/vendor-watch/*`
**Status:** Draft — written after the brainstorm; sections 2–4 were not walked through one by one, so review them closest
**Relates to:** test plans (the generator mirrors "Generate plan"), the Bug Trend Linear client (reused for writes), the `piece-build` skill's manual "vendor alive" step (this automates it)

## Problem

Pieces break because the vendor changed, not because we did. A vendor sunsets an API version,
removes an endpoint, changes auth, or shuts down, and the first we hear of it is a customer ticket.
The clearest case: the Zagomail fix (PIE-497) was approved before anyone noticed the vendor had
shut down months earlier. The `piece-build` skill now says "dig the vendor first", but that only
runs when someone is already fixing the piece.

The Piece Tester runs pieces against live vendors on a schedule, but it only sees breakage *after*
it happens, and only for targets that have a test plan and a working connection. It knows nothing
about the vendor: no website, API base URL, changelog or OpenAPI link is stored anywhere.

## Goal

A **Vendor Watch** feature in the Piece Tester that works like test plans:

1. **Generate watcher** for a piece (one, or a batch). An agent reads the piece source, records
   which endpoints the piece calls, finds the vendor's changelog / deprecation page / OpenAPI spec,
   verifies the tester can actually read each one, and saves a **watch plan**.
2. **Watch runs** check every plan's sources on a daily schedule, diff them against the last
   snapshot, and turn real changes into **findings**.
3. **Breakage first.** A finding that will break a piece we ship (vendor dead; or a breaking change,
   deprecation or auth change that hits an endpoint the piece uses, at high/critical severity,
   with verified evidence) is **filed in Linear automatically**. Everything else (new features,
   changes that don't touch us, anything uncertain) waits in a **Vendor Changes inbox** where a
   person files or dismisses it.

Success = we learn about a deprecation or breaking change from a PIE ticket before a customer
reports it through support.

## Out of scope

- Status pages and outages. An outage is transient; it is not an API change. The liveness check
  only asks "does the vendor still exist".
- Live probing of endpoints with real connections (e.g. reading `Sunset`/`Deprecation` headers).
  Actions run inside the Activepieces engine; the tester sees step output, not raw HTTP headers.
- Syncing Linear state back (closing findings when the issue is Done). Same v1 limit as
  `piece_reports`.
- Auto-fixing pieces or opening PRs.
- Filing into the `GIT` board. Watch tickets go to `PIE` only.
- Creating Linear labels from the app.
- Moving "Report to Pieces" off its webhook onto the direct Linear path built here (possible later).

## Terms

Added to `CONTEXT.md` under a new **Vendor watch** heading:

| Term | Meaning |
|---|---|
| **Watch plan** | One per piece. The piece's endpoint inventory plus the sources to watch. Counterpart of a test plan. |
| **Endpoint inventory** | The API calls a piece makes: per target, method + path (or `sdk:<method>` for SDK-based pieces). |
| **Source** | One URL a watch plan checks. Kind: `liveness`, `feed`, `openapi`, `html`. |
| **Snapshot** | The normalized content of a source from its last successful check. |
| **Watch run** | One check of one watch plan's sources. Trigger: `baseline`, `scheduled`, `manual`. |
| **Watch cycle** | All watch runs fired by one firing of the vendor-watch cron (or "Run all now"). |
| **Finding** | A conclusion from a watch run: kind, severity, which targets it hits, evidence. |
| **Vendor Changes inbox** | Findings with status `new`, waiting for a person to file or dismiss. |
| **Baseline** | The first check of a source. It records the snapshot and reports only *still-open* deprecations already published; baseline findings are never auto-filed. |

## Design

### 1. Data model

New tables in `schema.ts` (`CREATE TABLE IF NOT EXISTS`, same style as `alerts`). All queries live in
a new `server/src/db/vendor-watch-queries.ts` rather than `queries.ts` (already 2,100+ lines);
it imports `getDb()` the same way.

```sql
CREATE TABLE IF NOT EXISTS vendor_watch_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,            -- the daily cron; manual runs work regardless
  cron_expression TEXT NOT NULL DEFAULT '0 4 * * *',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  auto_file_enabled INTEGER NOT NULL DEFAULT 0,  -- off until the pilot proves the signal
  linear_team_key TEXT NOT NULL DEFAULT 'PIE',
  linear_label TEXT NOT NULL DEFAULT 'vendor-watch',
  classifier_model TEXT NOT NULL DEFAULT '',     -- '' = settings.ai_model
  dead_after_failures INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO vendor_watch_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS watch_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_name TEXT NOT NULL UNIQUE,
  piece_version TEXT NOT NULL DEFAULT '',        -- version the inventory was read from
  piece_display_name TEXT NOT NULL DEFAULT '',   -- for ticket titles, so filing needs no catalog call
  vendor_name TEXT NOT NULL DEFAULT '',
  api_base_urls TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  api_version TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL DEFAULT '',
  endpoint_inventory TEXT NOT NULL DEFAULT '[]', -- JSON EndpointRef[]
  status TEXT NOT NULL DEFAULT 'generating',     -- generating | active | paused | stale | failed
  generation_note TEXT NOT NULL DEFAULT '',      -- agent note, or the failure reason
  generation_cost_usd REAL NOT NULL DEFAULT 0,
  generated_at TEXT,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watch_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES watch_plans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                            -- liveness | feed | openapi | html
  url TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_ok_at TEXT,
  last_changed_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(plan_id, url)
);

CREATE TABLE IF NOT EXISTS watch_snapshots (       -- latest snapshot only, one row per source
  source_id INTEGER PRIMARY KEY REFERENCES watch_sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,                         -- normalized; JSON for feed/openapi/html blocks
  fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES watch_plans(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,                    -- baseline | scheduled | manual
  cycle_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',        -- running | completed | failed
  sources_checked INTEGER NOT NULL DEFAULT 0,
  sources_changed INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  findings_created INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS vendor_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES watch_plans(id) ON DELETE CASCADE,
  piece_name TEXT NOT NULL,
  source_id INTEGER REFERENCES watch_sources(id) ON DELETE SET NULL,
  run_id INTEGER REFERENCES watch_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,          -- vendor_dead | breaking | deprecation | auth_change | new_feature | other
  severity TEXT NOT NULL,      -- critical | high | medium | low
  affects_piece INTEGER NOT NULL DEFAULT 0,
  affected_targets TEXT NOT NULL DEFAULT '[]',   -- JSON string[]; ['*'] = the whole piece
  effective_date TEXT,                           -- YYYY-MM-DD or NULL
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  suggested_action TEXT NOT NULL DEFAULT '',
  evidence_url TEXT NOT NULL DEFAULT '',
  evidence_excerpt TEXT NOT NULL DEFAULT '',
  evidence_verified INTEGER NOT NULL DEFAULT 0,  -- excerpt found verbatim in the fetched text
  is_baseline INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',            -- new | filed | dismissed
  filed_by TEXT,                                 -- auto | manual
  linear_issue_id TEXT,
  linear_identifier TEXT,
  linear_url TEXT,
  file_error TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(piece_name, signature)
);
```

`EndpointRef` = `{ target: string; target_kind: 'action' | 'trigger'; method: string; path: string; note?: string }`.
`path` keeps path templates (`/v3/customers/{id}`); SDK-based pieces use `method: 'SDK'` and `path: 'sdk:<package>#<method>'`.

**Boot reconcile** (next to `reconcileOrphanedRuns` in `startBackgroundWork`): `watch_runs` still
`running` → `failed` ("interrupted by restart"); `watch_plans` still `generating` → `failed` if the
plan was never generated, else `stale` (its previous inventory and sources keep running).

### 2. Generate watcher (the watch-planner agent)

A new worker `agents/v2/workers/watch-planner.ts` on the existing `runAgentLoop` and `CostTracker`
(operation `vendor_watch_generate`), model `settings.ai_model`, `maxIterations: 30`.

**Tools:** the existing `fetch_piece_source`, `fetch_action_source`, `fetch_trigger_source`,
`list_actions`, `list_triggers`; two new local tools `probe_source` and `set_watch_plan` (terminal);
and Anthropic's server-side `web_search` tool (`web_search_20250305`, `max_uses: 10`). No MCP
tools: the agent never runs actions.

**Steps the prompt asks for:**

1. **Inventory.** Read the source. Record API base URL(s), API version, auth type, and for every
   action and trigger the method + path it calls. Custom API Call actions record only the base URL.
2. **Discover.** Search for the vendor's official changelog, API deprecation / sunset / versioning
   policy page, OpenAPI spec, and the official SDK or spec repo's GitHub releases. Prefer
   machine-readable sources: changelog RSS/Atom, `https://github.com/<org>/<repo>/releases.atom`,
   raw OpenAPI JSON/YAML. Use HTML pages only when there is no feed.
3. **Verify.** Call `probe_source` on every candidate. Keep only sources it reports readable.

**`probe_source`** (`{ url, expected_kind }`) fetches through `safe-fetch` (§3) and returns
`{ ok, status, final_url, content_type, detected_kind, text_chars, sample, problem }`.
`detected_kind` is `feed` (XML with `<rss` or `<feed`), `openapi` (JSON/YAML with a top-level
`openapi` or `swagger` key), `html` (≥ 500 chars of text after normalization) or `unreadable`
(e.g. a JavaScript-only docs shell). Each probe is recorded in `ToolContext.probedSources`.

**`set_watch_plan`** input: `vendor_name, api_base_urls[], api_version, auth_type,
endpoint_inventory[], sources[{ kind, url, label }], note`. Before it is accepted,
`validateWatchPlan` (pure) checks:

- 1–8 sources; none of kind `liveness` (the system adds that one)
- every source URL was probed in this session with `ok: true` and a `detected_kind` equal to its `kind`
- at least one `api_base_urls` entry, and every entry is http(s) (the liveness source needs one)
- inventory targets that are not real actions/triggers of the piece are dropped (reported back as a warning, not an error)

A failed validation goes back to the agent as a tool error so it can fix and call again. This needs
one runner change: a terminal tool may define `validateTerminal(input, ctx) → string | null`; a
non-null result is returned as an `is_error` tool result and the loop continues.

**Saving.** The plan row is created up front with status `generating` (so the UI can show
progress and a restart can mark it `failed`). On success: inventory and metadata are stored,
`piece_version` is set from `getPieceMetadata`, sources are replaced, a `liveness` source is added
for the host of `api_base_urls[0]`, status → `active`, and a **baseline run** starts right away.
On failure (no terminal call, validation never passed, error): a first generation → `failed`; a
regeneration → `stale`, so the previous inventory and sources keep running. Either way the reason
goes in `generation_note`.

**Regenerate** keeps the plan id and findings, replaces inventory and sources, and drops the
snapshots of removed sources. A source whose URL is unchanged keeps its snapshot, so no new
baseline is needed.

**Batch.** `POST /plans/generate-batch` submits each piece through `submitPieceUnit` from
`batch-scheduler.ts` (batch id `vw-<timestamp>`), so watcher generation shares the global AI
concurrency cap with test-plan batches.

**Runner changes** (`agent-runner.ts`, all opt-in so existing workers are untouched):

- `AgentRunnerConfig.serverTools?: unknown[]` is appended to the tool list
- `AgentRunnerConfig.disableMcp?: boolean` skips MCP setup
- `stop_reason === 'pause_turn'`: keep the assistant turn and call again, instead of treating "no `tool_use` blocks" as done
- the cache breakpoint is only placed when the last message is a user turn
- `AgentRunnerConfig.client?` lets tests inject a fake Anthropic client
- `AgentRole` gains `'watch_planner'`

**Cost tracking.** `CostTracker`/`calculateCost` add `$0.01 × usage.server_tool_use.web_search_requests`.

**Stale plans.** At the start of each watch cycle, one `listPieces()` call compares catalog
versions with `piece_version`. A newer version marks the plan `stale`. Stale plans keep running
(their sources are still valid) and the UI offers **Regenerate**. Inventory is never regenerated
automatically.

### 3. Watch runs

**Fetching: `safe-fetch.ts`.** All network reads (probe, runs, liveness) go through one guarded fetch:

- `http`/`https` only
- the host is resolved with `dns.lookup(all)` and refused if any address is loopback, private
  (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, which includes the droplet's
  metadata service, and fe80::/10), CGNAT (100.64/10) or unspecified
- redirects are followed by hand (max 5), and every hop is checked again
- 20 s timeout, 5 MB body cap, `User-Agent: piece-tester-vendor-watch/1`
- DNS lookup is injectable for tests

The URLs come from an AI reading web pages, so this guard is required, not optional.

**Per source kind:**

| Kind | Normalize | Changed when | Findings from |
|---|---|---|---|
| `liveness` | `dns.lookup(host)` + GET `https://host/` (status ignored; any HTTP response = alive) | n/a | Deterministic: `vendor_dead` |
| `feed` | Parse RSS 2.0 / Atom (`fast-xml-parser`) → entries `{ id (guid/id/link), title, date, text }` | an entry id not in the snapshot | Classifier over the new entries |
| `openapi` | Parse JSON/YAML (`yaml`) → map `"METHOD /path"` → `{ deprecated, params[{ name, in, required }] }` | map hash differs | Deterministic diff (below) |
| `html` | `node-html-parser`: drop script/style/nav/header/footer/aside, take text of headings, paragraphs, list items, table rows → blocks; drop blocks < 30 chars | a block hash not in the snapshot | Classifier over the added blocks |

New dependencies: `fast-xml-parser`, `yaml`, `node-html-parser` (all pure JS).

**Run algorithm** (`runner.ts`, `runWatchPlan(planId, trigger, deps)`; network, classifier and
filer are injected for tests):

1. Insert a `watch_runs` row.
2. For each enabled source, one at a time:
   - **Fetch fails:** `last_error`, `sources_failed += 1`, and `consecutive_failures += 1`, with one
     exception for `liveness` below.
     - For `liveness`, only "host gone" failures increment `consecutive_failures`: DNS-not-found,
       connection-refused or a TLS error. Timeouts are an outage and only set `last_error`. Any HTTP
       response, 4xx/5xx included, counts as alive.
     - When `consecutive_failures` reaches `dead_after_failures` (default 3, so 3 days), create a
       `vendor_dead` finding (critical, `['*']`). On the source's very first check (baseline), one
       "host gone" failure is enough. That one is a baseline finding, so it lands in the inbox; this
       is how generating a watcher for a Zagomail-style piece shows the problem at once.
     - Other kinds: the source shows as failing in the UI (red dot + last error) from the first failure. No finding.
   - **Fetch succeeds:** reset `consecutive_failures`, then normalize → hash.
   - **No snapshot:** run the **baseline** (below), then store the snapshot.
   - **Same hash:** set `last_ok_at` only.
   - **Hash differs:** diff → produce findings → store the new snapshot, `last_changed_at`, `sources_changed += 1`.
3. Insert each finding with `INSERT OR IGNORE` on `(piece_name, signature)`. Only rows actually
   inserted continue to filing (§4).
4. Close the run with counts and cost; set `watch_plans.last_run_at`.

**OpenAPI diff** (deterministic; operations matched to the inventory by `endpoint-match.ts`, which
normalizes method case, trailing slashes and any `{param}` name to `{}`):

| Change | Used by the piece | Finding |
|---|---|---|
| operation removed | yes | `breaking`, high |
| operation newly `deprecated: true` | yes | `deprecation`, high |
| new required parameter on an operation | yes | `breaking`, high |
| any of the above | no | `other`, low (inbox) |
| operations added | — | one `new_feature`, low, listing up to 20 |

`effective_date` is null; the spec rarely carries one. On **baseline**, every already-deprecated
operation the piece uses becomes a `deprecation` finding (medium).

**Classifier** (`classifier.ts`, feed and html). There is one Claude call per changed source, with
model `config.classifier_model || settings.ai_model` and `CostTracker` operation
`vendor_watch_classify`. The output is forced through a tool (`tool_choice: report_findings`), so
the result is structured.

- **Input:**
  - piece name and display name, vendor, `api_version`, `auth_type`
  - the inventory
  - source label, URL and kind
  - mode (`change` | `baseline`) and today's date
  - the new text (new feed entries, or added html blocks), capped at 15,000 chars with a note when cut
- **Output:** `findings[]`, each with:
  - `kind`, `severity`, `affects_piece`
  - `affected_targets[]`: target names from the inventory, or `['*']` for an auth-wide or
    piece-wide change
  - `effective_date` (YYYY-MM-DD or null)
  - `title` (≤ 90 chars), `summary` (≤ 600), `suggested_action`
  - `evidence_excerpt`: a verbatim quote ≤ 300 chars
  - An empty list is the normal answer for marketing posts, typos and unrelated changes.
- **Severity rubric (in the prompt):**
  - **critical:** the vendor is gone, or something the piece uses stops working within 30 days or already has.
  - **high:** something the piece uses is removed or breaks on a stated date more than 30 days out, or is already deprecated.
  - **medium:** a deprecation with no date, or a change to a used endpoint that may change its output.
  - **low:** a new feature, or a change the piece doesn't use.
- **Baseline mode:** the prompt adds "report only deprecations, sunsets and breaking changes that
  are still upcoming or took effect in the last 90 days". The text is the 20 newest feed entries,
  or the first 15,000 chars of the page.

**Post-validation** (pure, `validateClassifierFindings`):

- `evidence_verified = 1` only if the whitespace- and case-normalized excerpt is a substring of
  the normalized input text
- `affected_targets` are filtered to inventory targets (or `*`); `affects_piece` becomes
  `affected_targets.length > 0`
- unknown `kind`/`severity` values drop the finding
- dates that fail to parse become null

**Signature** (`findings.ts`):

- `vendor_dead`: `vendor_dead|<host>`
- openapi findings: `<kind>|<METHOD /path>`
- classifier findings: `sha1(kind | sorted targets | effective_date | first 120 chars of the normalized excerpt)`

### 4. Findings → Linear

**Auto-file rule** (`shouldAutoFile`, pure). All of these must hold:

- `config.auto_file_enabled` is on and the finding is **not** baseline
- **and** either:
  - `kind = vendor_dead`, or
  - `kind ∈ { breaking, deprecation, auth_change }` **and** `affects_piece` **and**
    `severity ∈ { critical, high }` **and** (`evidence_verified` **or** the source is `openapi`)

Everything else stays `new` in the inbox.

**Merge into an existing ticket.** Before creating anything, `findMergeTarget` looks for a
`filed` finding for the same piece, of the same kind, created in the last 60 days, whose targets
overlap. `*` overlaps any non-empty target list, and an empty list overlaps nothing. If one exists, the new finding is posted as a **comment** on that issue
and copies its Linear ids. This catches the same deprecation showing up in a second source with
different wording.

**Filing path: direct Linear GraphQL, not the report webhook.**

- The webhook flow behind "Report to Pieces" lives on a canary project we can't inspect from
  here, and the live `piece_reports` table is empty, so that path has never filed a ticket in
  production.
- The tester already stores a Linear API key (`settings.linear_api_key`, used by Bug Trend) and a
  GraphQL client with key redaction.
- `linear-client.ts` exports `linearQuery`, and a new `linear-filer.ts` adds:
  - `resolveLinearTargets(teamKey, labelName)`: the team id; the state of type `triage` (else
    `backlog`); the label id found by exact name among team labels, then workspace labels.
    Cached for 1 h.
  - `createIssue({ teamId, stateId, labelIds, title, description, priority })` → `issueCreate`
  - `addComment(issueId, body)` → `commentCreate`
- Priority: critical → 1 (Urgent), high → 2, medium → 3, low → 4.
- **Label: `vendor-watch` only.** *Not* `piece-tester`: Bug Trend counts every PIE issue labeled
  `piece-tester` as a bug the tester found, and watch tickets would inflate that chart.
- **The label must already exist.** If it is missing, filing fails with "Label 'vendor-watch' not
  found in PIE — create it in Linear", and the finding stays `new` with `file_error` set. The app
  never creates labels.
- The issue's creator is whoever owns the stored API key.

**Ticket text** (`ticket-draft.ts`, shared by auto-file and the inbox "File" modal). Title:
`<Piece display name>: <finding title>` (≤ 120 chars). Body:

```
**Vendor change found by Piece Tester vendor watch**

**Piece:** <display name> (`<piece_name>` <version>)
**What changed:** <summary>
**Effective date:** <YYYY-MM-DD (in N days)> | not stated
**Affects:** `<target>` (<METHOD path>), … | the whole piece
**Suggested action:** <suggested_action>

> <evidence_excerpt>

Source: [<label>](<evidence_url>) · seen <date>
Finding #<id> · <kind> · <severity> · <auto-filed | filed by hand>
```

Only public vendor information goes into a ticket; there is no customer data on this path.

**Inbox actions:**

- **File:** opens an editable draft (title, body, priority), the same interaction as
  `ReportToPiecesModal`, then calls create or comment per `findMergeTarget`. Status → `filed`,
  `filed_by = manual`.
- **Dismiss:** status → `dismissed`. Because of the unique signature, a dismissed finding never
  comes back.

### 5. Schedule

`services/vendor-watch/cron.ts` provides `initVendorWatch()` / `reloadVendorWatch()`, the same
shape as `scheduler.ts`:

- one `node-cron` task from `vendor_watch_config`, registered only when `enabled = 1` and the
  expression passes `cron.validate`
- it runs `runWatchCycle()`
- called from `startBackgroundWork`, and again after `PUT /config`

`runWatchCycle()`:

- guards against overlap with a module-level flag
- does the stale check (§2)
- runs every `active`/`stale` plan through `runWithConcurrency(plans, 3, …)`, all under one `cycle_id`

**"Run all now"** calls the same function. Manual runs of one plan work whether or not the cron is
enabled.

### 6. API (`/api/vendor-watch`, behind `requireAuth`)

| Method | Path | Does |
|---|---|---|
| GET / PUT | `/config` | read / update config (validates cron and timezone, reloads the cron) |
| POST | `/config/test-linear` | resolve team/state/label with the stored key; read-only |
| GET | `/plans` | list plans with source health counts, last run, open finding count |
| GET | `/plans/:id` | plan + sources (no snapshot content) + last 20 runs |
| GET | `/plans/by-piece/:pieceName` | the plan for a piece plus its `open_findings` count, or `null` |
| POST | `/plans/generate` | `{ piece_name }` → 202 `{ plan_id }` |
| POST | `/plans/generate-batch` | `{ piece_names[] }` → 202 `{ plan_ids[] }` |
| POST | `/plans/:id/run` | manual run, background → 202 `{ run_id }` |
| PATCH | `/plans/:id` | `{ status: 'active' \| 'paused' }` |
| DELETE | `/plans/:id` | delete plan (cascade) |
| PATCH | `/sources/:id` | `{ enabled }` |
| POST | `/run-cycle` | run all now → 202 |
| GET | `/findings` | `?status=new\|filed\|dismissed&piece=` |
| GET | `/findings/:id/draft` | `{ title, description, priority, mode: create\|comment, existing }` |
| POST | `/findings/:id/file` | `{ title, description, priority }` → filed finding |
| POST | `/findings/:id/dismiss` | → dismissed finding |

### 7. UI

- **Nav:** "Vendor Watch" (lucide `Radar`) → `/vendor-watch`, lazy-loaded like Bug Trend.
- **`VendorWatch.tsx`, four tabs:**
  - **Inbox:** `new` findings, newest first. Columns: piece, kind badge, severity, title,
    effective date, affects, source link. Actions: File…, Dismiss. A `file_error` shows in red on
    the row.
  - **Filed:** `filed` findings with the Linear identifier linked, and whether each was auto or manual.
  - **Watchers:**
    - table of plans: piece, status, sources (ok / failing), last run, open findings
    - row actions: Run now, Pause/Resume, Regenerate, Delete
    - an expanded row shows the inventory, the sources with their health and last error, and the last runs
    - **Generate watchers** opens a piece multi-select (from `api.listPieces`) and calls `generate-batch`
    - **Run all now**
    - while any plan is `generating`, the tab polls every 3 s
  - **Config:** the config fields plus **Test Linear**. This lives here, not in `Settings.tsx`
    (already 884 lines). It reuses the stored Linear and Anthropic keys and says so.
- **`PieceDetail.tsx`:** a small header chip. With no plan, it shows **Generate watcher**. With a
  plan, it shows its status and open-finding count and links to `/vendor-watch?piece=<name>`.

### 8. Error handling

| Failure | Behaviour |
|---|---|
| Anthropic key missing | generate/classify refuse with the existing "Anthropic API key not configured" message |
| `web_search` not enabled for the org | generation fails; `generation_note` carries the API error |
| Linear key missing / label missing / API error | finding stays `new`, `file_error` set, visible in the inbox; next cycle does **not** retry automatically (avoid ticket storms); File… retries by hand |
| Source unreadable (SPA, 403, too large), or a feed/page that suddenly parses to zero entries/blocks | counted as a fetch failure and the snapshot is left alone (so a temporarily broken feed doesn't replay its whole history as "new" when it comes back); never a finding unless it is the liveness source |
| Classifier returns malformed output | the source's snapshot is **not** advanced, so the change is retried next cycle; run `error` notes it |
| Server restart mid-run / mid-generation | boot reconcile marks them `failed` |
| Overlapping cycle | second call returns immediately ("cycle already running") |

### 9. Testing

All new tests use vitest, colocated `*.test.ts`, with no live network. Fixtures are small inline
strings in the tests: RSS 2.0, Atom, OpenAPI JSON and YAML, and an HTML changelog before and after.

- `safe-fetch`: refuses private, link-local, loopback and metadata IPs (injected lookup); re-checks redirects; caps body size
- `normalize` / `diff`: feed new entries (RSS + Atom), html added blocks (ignores reordering and short blocks), the openapi diff table above
- `endpoint-match`: template and method normalization
- `validateClassifierFindings`: verified and unverified evidence; target filtering; bad kinds dropped
- `findings`: signature stability; the `shouldAutoFile` matrix; `findMergeTarget` overlap rules
- `ticket-draft`: title cap, body sections, "not stated" date, whole-piece affects
- `linear-filer` (injected `linearQuery`): resolves triage state and label; missing label error; create vs comment
- `validateWatchPlan`: every rule in §2
- `runner` (real test DB, injected deps):
  - a baseline stores the snapshot and creates only baseline findings
  - an unchanged source does nothing
  - a changed feed creates a finding and auto-files when the rule passes and auto-file is on
  - when auto-file is off, the finding stays in the inbox
  - a classifier failure keeps the old snapshot
  - three DNS failures create `vendor_dead`; three timeouts do not
- `vendor-watch-queries`: round-trips, unique signature, cascade delete, boot reconcile
- `cron`: registers only when enabled and valid
- `agent-runner` (injected fake client): `pause_turn` continues; a terminal tool whose validation fails returns `is_error` and the loop goes on; a passing validation terminates

CI already runs `tsc --noEmit` and `npm test` on every PR.

### 10. Rollout

1. **Before merge:** Ibrahim creates the `vendor-watch` label on the PIE team, and confirms web
   search is enabled for the Anthropic org whose key the tester uses.
2. Merge; the existing deploy workflow ships it. Cron and auto-file both start **off**.
3. **Pilot (1 week):** generate watchers for ~10 high-usage pieces, chosen for vendors with good
   changelogs (e.g. Slack, Stripe, HubSpot, Notion, Gmail, Google Sheets, Airtable, Shopify,
   Telegram, OpenAI). Run them by hand, read every finding, and tune the prompt and rubric.
4. Turn on the daily cron. After a clean week, turn on auto-file.
5. Widen by generating watchers for the remaining pieces with ≥ 20 usage, in batches.

**Cost estimate:**

- Generation is roughly $0.20–0.60 per piece (Sonnet, about 15 turns, up to 10 searches at $0.01 each).
- Daily runs only pay for Claude when a source changed. With ~300 sources and ~10% changing on a
  given day, that is ~30 classifier calls, about $0.50/day.
- Each baseline costs one call per feed/html source.

## Risks

- **Noisy HTML pages.** Rotating banners and "last updated" lines can count as a change every
  day. Blocks under 30 chars are dropped, and the classifier returns `[]` for noise, but a noisy
  source still costs one call a day. Follow-up if it bites: per-source change rate in the UI.
- **GitHub rate limit.** `fetch_piece_source` uses the unauthenticated GitHub contents API
  (60/h). Batches above ~40 pieces an hour can hit it. Watch for it in the pilot; add a token later
  if needed.
- **SDK-based pieces** (e.g. Slack via `@slack/web-api`). The inventory holds SDK method names,
  not HTTP paths, so OpenAPI matching won't hit. Feed and html classification still works because
  the prompt sees the method names.
- **AI misreads a changelog.** Auto-filing needs verified evidence (or an OpenAPI source), a used
  target, and high/critical severity. Baselines never auto-file, and the pilot runs with
  auto-file off.
