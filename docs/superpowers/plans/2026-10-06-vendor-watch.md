# Vendor Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vendor Watch feature to the Piece Tester. It generates a per-piece watch plan (endpoint inventory + verified vendor sources), checks those sources daily, and files breaking vendor changes in Linear. Everything else lands in a Vendor Changes inbox.

**Architecture:**
- **Server:** new `server/src/services/vendor-watch/*` modules, each with one job: guarded fetch, normalize/diff per source kind, OpenAPI diff, classifier, findings rules, ticket text, Linear filer, filing, runner, cron. Plus a new watch-planner agent worker on the existing `agents/v2` runner, which gets small opt-in changes (server tools, `pause_turn`, terminal validation). Data lives in six new SQLite tables with queries in `server/src/db/vendor-watch-queries.ts`, exposed under `/api/vendor-watch`.
- **Client:** a lazy `VendorWatch` page (Inbox, Filed, Watchers, Config) and a chip on PieceDetail.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Express 4, better-sqlite3 via `DatabaseAdapter`, node-cron, `@anthropic-ai/sdk` 0.74 (server tool `web_search_20250305`), Linear GraphQL via the existing `linearQuery`, React 18 + React Query 5 + Tailwind, vitest 2. New deps: `fast-xml-parser`, `yaml`, `node-html-parser`.

**Spec:** `docs/superpowers/specs/2026-10-06-vendor-watch-design.md`. Read it before starting any task.

## Global Constraints

- Node 20 is the CI/runtime floor (droplet + `.github/workflows/deploy.yml`). Only use APIs available in Node 20, such as global `fetch`, `Response`, and `AbortSignal.timeout`.
- ESM everywhere: relative imports end in `.js` (server) and have no suffix (client), matching the surrounding files.
- Tests: vitest, colocated `*.test.ts`, **no live network** in any test. Network and AI are always injected.
- The repo is **public**: no API keys, webhook URLs, customer names or customer data in code, tests or docs.
- Linear tickets carry the label from `vendor_watch_config.linear_label` (default `vendor-watch`) and **never** `piece-tester`, because Bug Trend counts `piece-tester` issues as tester bugs.
- `vendor_watch_config.enabled` and `auto_file_enabled` both default to **0**.
- The app never creates Linear labels, and never retries a failed auto-file on its own.
- Every network read of a vendor URL goes through `safeFetch` (or `checkLiveness`, which uses it).
- `Settings.tsx` is not modified. Vendor Watch config lives on the Vendor Watch page.
- Comment density: match the surrounding files (short JSDoc on exported functions, no narration).
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run the whole suite with `npm test`, and typecheck with `npx tsc --noEmit -p tsconfig.json` (this covers server and client).

## Review Focus

- **Single-entry and id-less feeds.** `fast-xml-parser` returns an object, not an array, when a feed has one item. Items with no `guid`/`id`/`link` must still get a stable id, or every run re-reports them. Pinned in Task 3.
- **OpenAPI parameters via `$ref` and path-level `parameters`.** Real specs (Stripe, GitHub) declare params by reference and at the path level. A required parameter added only through a `$ref` must still be caught, and renaming a path parameter (`{id}` → `{customer_id}`) must **not** be reported as breaking. Pinned in Task 4.
- **Effective dates in the past.** Changelogs often announce a removal after it happened. The ticket text must say "N days ago", not "in -N days". Pinned in Task 5.
- **Oversized pages.** A multi-year HTML changelog can be megabytes. The classifier must see at most 15,000 chars, and evidence must be checked against exactly the text it saw. Pinned in Task 6.
- **The same plan run twice at once.** "Run now" clicked while the daily cycle is running the same plan must not run it twice or race on snapshots. Pinned in Task 8.

## File Map

**Create (server):**

| File | Responsibility |
|---|---|
| `server/src/services/vendor-watch/types.ts` | Shared string unions, `EndpointRef`, `FindingDraft`, `ProbeResult` |
| `server/src/db/vendor-watch-queries.ts` | All SQL for the six tables |
| `server/src/db/vendor-watch-test-utils.ts` | `resetVendorWatch()` + sample builders for tests |
| `server/src/services/vendor-watch/safe-fetch.ts` | SSRF-guarded fetch with size/time caps |
| `server/src/services/vendor-watch/liveness.ts` | "Does the vendor host still exist" |
| `server/src/services/vendor-watch/normalize.ts` | Feed + HTML parsing, snapshots, added-text rendering |
| `server/src/services/vendor-watch/openapi.ts` | Spec parsing, operation map, structural diff |
| `server/src/services/vendor-watch/endpoint-match.ts` | Match spec operations to inventory targets |
| `server/src/services/vendor-watch/openapi-findings.ts` | Deterministic findings from an OpenAPI diff/baseline |
| `server/src/services/vendor-watch/findings.ts` | Classifier-output validation, signatures, auto-file rule, vendor-dead finding |
| `server/src/services/vendor-watch/ticket-draft.ts` | Linear title/body/priority for a finding |
| `server/src/services/vendor-watch/classifier.ts` | One Claude call per changed source |
| `server/src/services/vendor-watch/linear-filer.ts` | Resolve team/state/label; create issue; add comment |
| `server/src/services/vendor-watch/filing.ts` | Preview + file a finding (create or comment) |
| `server/src/services/vendor-watch/runner.ts` | `startWatchRun`: check every source of one plan |
| `server/src/services/vendor-watch/cron.ts` | Daily cycle + cron registration |
| `server/src/services/vendor-watch/config.ts` | Validate a config patch from the API |
| `server/src/services/vendor-watch/generate.ts` | Generate/regenerate watch plans (single + batch) |
| `server/src/agents/v2/tools/probe-source.ts` | `probe_source` tool + `probeSource`/`detectKind` |
| `server/src/agents/v2/tools/set-watch-plan.ts` | `set_watch_plan` terminal tool + `validateWatchPlan` |
| `server/src/agents/v2/prompts/watch-planner.ts` | System + user prompt |
| `server/src/agents/v2/workers/watch-planner.ts` | `runWatchPlannerWorker` |
| `server/src/routes/vendor-watch.ts` | `/api/vendor-watch` router |

**Create (client):** `client/src/lib/vendorWatch.ts` (+ test), `client/src/pages/VendorWatch.tsx`, and in `client/src/components/vendor-watch/`: `FindingsTable.tsx`, `FileFindingModal.tsx`, `WatchersTab.tsx`, `PlanDetail.tsx`, `GenerateWatchersModal.tsx`, `VendorWatchConfigCard.tsx`, `VendorWatchChip.tsx`.

**Modify:**
- `server/src/db/schema.ts` (tables)
- `server/src/index.ts` (route + boot)
- `server/src/agents/v2/{types,agent-runner,tool-registry,cost-tracker}.ts`, `server/src/agents/v2/tools/index.ts`
- `server/src/services/bug-trend/linear-client.ts` (export `linearQuery`)
- `client/src/{App.tsx,components/Layout.tsx,lib/api.ts,pages/PieceDetail.tsx}`
- `CONTEXT.md`
- `package.json`, `package-lock.json`

---

### Task 1: Data model, queries and glossary

**Files:**
- Create: `server/src/services/vendor-watch/types.ts`
- Create: `server/src/db/vendor-watch-queries.ts`
- Create: `server/src/db/vendor-watch-test-utils.ts`
- Modify: `server/src/db/schema.ts` (end of `initTables`, after the `alerts` block)
- Modify: `CONTEXT.md` (append a section)
- Test: `server/src/db/vendor-watch-queries.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `server/src/db/schema.ts` (`run` returns `{ changes, lastId }`, `transaction(fn)` returns `fn()`).
- Produces (later tasks use these exact names):
  - types: `SourceKind`, `PlanStatus`, `RunTrigger`, `FindingKind`, `Severity`, `FindingStatus`, `FINDING_KINDS`, `SEVERITIES`, `EndpointRef`, `FindingDraft`, `ProbeResult`
  - row types: `WatchConfigRow`, `WatchConfigPatch`, `WatchPlanRow`, `WatchPlanListRow`, `WatchSourceRow`, `WatchSnapshotRow`, `WatchRunRow`, `VendorFindingRow`, `PlanResult`, `SourceInput`, `RunCounts`
  - config: `getWatchConfig()`, `updateWatchConfig(patch)`
  - plans: `getPlan(id)`, `getPlanByPiece(name)`, `listPlans()`, `listRunnablePlans()`, `beginPlanGeneration(name)`, `completePlanGeneration(id, r)`, `failPlanGeneration(id, note, cost?)`, `setPlanStatus(id, 'active'|'paused')`, `markStalePlans(Map)`, `touchPlanRun(id)`, `deletePlan(id)`
  - sources: `listSources(planId)`, `getSource(id)`, `replaceSources(planId, SourceInput[])`, `setSourceEnabled(id, bool)`, `recordSourceOk(id, changed)`, `recordSourceFailure(id, error, count?) → number`
  - snapshots: `getSnapshot(sourceId)`, `saveSnapshot(sourceId, hash, content)`
  - runs: `createRun(planId, trigger, cycleId?)`, `getRun(id)`, `finishRun(id, status, counts, error?)`, `listRuns(planId, limit?)`
  - findings: `insertFinding({plan_id, piece_name, source_id, run_id, draft}) → row | null`, `getFinding(id)`, `listFindings({status?, piece?})`, `countOpenFindings(piece)`, `markFindingFiled(id, {...})`, `setFindingFileError(id, msg)`, `dismissFinding(id)`, `targetsOverlap(a, b)`, `parseTargets(json)`, `findMergeTarget(piece, kind, targets, excludeId)`
  - boot: `reconcileVendorWatch() → { runs, plans }`
  - test utils: `resetVendorWatch()`, `samplePlanResult(over?)`, `sampleDraft(over?)`

- [ ] **Step 1: Create the shared types**

`server/src/services/vendor-watch/types.ts`:

```ts
export type SourceKind = 'liveness' | 'feed' | 'openapi' | 'html';
export type PlanStatus = 'generating' | 'active' | 'paused' | 'stale' | 'failed';
export type RunTrigger = 'baseline' | 'scheduled' | 'manual';
export type FindingKind = 'vendor_dead' | 'breaking' | 'deprecation' | 'auth_change' | 'new_feature' | 'other';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type FindingStatus = 'new' | 'filed' | 'dismissed';

export const FINDING_KINDS: readonly FindingKind[] = ['vendor_dead', 'breaking', 'deprecation', 'auth_change', 'new_feature', 'other'];
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/** One API call a piece makes. SDK-based pieces use method 'SDK' and path 'sdk:<package>#<method>'. */
export interface EndpointRef {
  target: string;
  target_kind: 'action' | 'trigger';
  method: string;
  path: string;
  note?: string;
}

/** A finding as produced by a differ or the classifier, before it is stored. */
export interface FindingDraft {
  kind: FindingKind;
  severity: Severity;
  /** Inventory target names, or ['*'] for the whole piece. Empty = touches nothing the piece uses. */
  affected_targets: string[];
  /** YYYY-MM-DD */
  effective_date: string | null;
  title: string;
  summary: string;
  suggested_action: string;
  evidence_url: string;
  evidence_excerpt: string;
  evidence_verified: boolean;
  is_baseline: boolean;
  signature: string;
}

/** What probe_source reports for one candidate URL. */
export interface ProbeResult {
  url: string;
  ok: boolean;
  status: number | null;
  final_url: string;
  content_type: string;
  detected_kind: 'feed' | 'openapi' | 'html' | 'unreadable';
  text_chars: number;
  sample: string;
  problem: string;
}
```

- [ ] **Step 2: Add the tables to `initTables`**

In `server/src/db/schema.ts`, at the very end of `function initTables(db: DatabaseAdapter): void { … }`, after the `CREATE TABLE IF NOT EXISTS alerts (…)` `db.exec`, add:

```ts
  // Vendor watch (docs/superpowers/specs/2026-10-06-vendor-watch-design.md)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_watch_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      cron_expression TEXT NOT NULL DEFAULT '0 4 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      auto_file_enabled INTEGER NOT NULL DEFAULT 0,
      linear_team_key TEXT NOT NULL DEFAULT 'PIE',
      linear_label TEXT NOT NULL DEFAULT 'vendor-watch',
      classifier_model TEXT NOT NULL DEFAULT '',
      dead_after_failures INTEGER NOT NULL DEFAULT 3,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO vendor_watch_config (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS watch_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_name TEXT NOT NULL UNIQUE,
      piece_version TEXT NOT NULL DEFAULT '',
      piece_display_name TEXT NOT NULL DEFAULT '',
      vendor_name TEXT NOT NULL DEFAULT '',
      api_base_urls TEXT NOT NULL DEFAULT '[]',
      api_version TEXT NOT NULL DEFAULT '',
      auth_type TEXT NOT NULL DEFAULT '',
      endpoint_inventory TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'generating',
      generation_note TEXT NOT NULL DEFAULT '',
      generation_cost_usd REAL NOT NULL DEFAULT 0,
      generated_at TEXT,
      last_run_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watch_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES watch_plans(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS watch_snapshots (
      source_id INTEGER PRIMARY KEY REFERENCES watch_sources(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES watch_plans(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL,
      cycle_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
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
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      affects_piece INTEGER NOT NULL DEFAULT 0,
      affected_targets TEXT NOT NULL DEFAULT '[]',
      effective_date TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      suggested_action TEXT NOT NULL DEFAULT '',
      evidence_url TEXT NOT NULL DEFAULT '',
      evidence_excerpt TEXT NOT NULL DEFAULT '',
      evidence_verified INTEGER NOT NULL DEFAULT 0,
      is_baseline INTEGER NOT NULL DEFAULT 0,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      filed_by TEXT,
      linear_issue_id TEXT,
      linear_identifier TEXT,
      linear_url TEXT,
      file_error TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(piece_name, signature)
    );
  `);
```

- [ ] **Step 3: Write the test utilities**

`server/src/db/vendor-watch-test-utils.ts`:

```ts
import { getDb } from './schema.js';
import type { FindingDraft } from '../services/vendor-watch/types.js';
import type { PlanResult } from './vendor-watch-queries.js';

/** Wipe every vendor-watch table and put the config row back to its defaults. Tests only. */
export function resetVendorWatch(): void {
  getDb().exec(`
    DELETE FROM vendor_findings;
    DELETE FROM watch_runs;
    DELETE FROM watch_snapshots;
    DELETE FROM watch_sources;
    DELETE FROM watch_plans;
    UPDATE vendor_watch_config SET enabled = 0, cron_expression = '0 4 * * *', timezone = 'UTC',
      auto_file_enabled = 0, linear_team_key = 'PIE', linear_label = 'vendor-watch',
      classifier_model = '', dead_after_failures = 3 WHERE id = 1;
  `);
}

export function samplePlanResult(over: Partial<PlanResult> = {}): PlanResult {
  return {
    piece_version: '0.5.0',
    piece_display_name: 'Acme',
    vendor_name: 'Acme',
    api_base_urls: ['https://api.acme.dev/v1'],
    api_version: 'v1',
    auth_type: 'API key',
    endpoint_inventory: [
      { target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' },
      { target: 'new_order', target_kind: 'trigger', method: 'GET', path: '/v1/orders' },
    ],
    generation_note: 'ok',
    generation_cost_usd: 0.42,
    ...over,
  };
}

export function sampleDraft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    kind: 'deprecation',
    severity: 'high',
    affected_targets: ['send_message'],
    effective_date: '2027-01-31',
    title: 'Messages v1 is deprecated',
    summary: 'POST /v1/messages will be removed.',
    suggested_action: 'Move to /v2/messages.',
    evidence_url: 'https://acme.dev/changelog',
    evidence_excerpt: 'POST /v1/messages will be removed on 2027-01-31',
    evidence_verified: true,
    is_baseline: false,
    signature: 'sig-1',
    ...over,
  };
}
```

- [ ] **Step 4: Write the failing tests**

`server/src/db/vendor-watch-queries.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  getWatchConfig, updateWatchConfig, beginPlanGeneration, completePlanGeneration, failPlanGeneration,
  getPlan, listPlans, listRunnablePlans, setPlanStatus, markStalePlans, deletePlan,
  replaceSources, listSources, recordSourceOk, recordSourceFailure, getSnapshot, saveSnapshot,
  createRun, finishRun, getRun, insertFinding, listFindings, countOpenFindings, markFindingFiled,
  dismissFinding, findMergeTarget, targetsOverlap, reconcileVendorWatch,
} from './vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult, sampleDraft } from './vendor-watch-test-utils.js';

function activePlan(name = '@activepieces/piece-acme') {
  const p = beginPlanGeneration(name);
  return completePlanGeneration(p.id, samplePlanResult());
}

describe('vendor watch config', () => {
  beforeEach(resetVendorWatch);

  it('starts with safe defaults', () => {
    const c = getWatchConfig();
    expect(c).toMatchObject({ enabled: 0, auto_file_enabled: 0, linear_team_key: 'PIE', linear_label: 'vendor-watch', dead_after_failures: 3, cron_expression: '0 4 * * *', timezone: 'UTC' });
  });

  it('patches only the given fields', () => {
    updateWatchConfig({ enabled: 1, linear_label: 'vw' });
    const c = getWatchConfig();
    expect(c.enabled).toBe(1);
    expect(c.linear_label).toBe('vw');
    expect(c.linear_team_key).toBe('PIE');
  });
});

describe('watch plans', () => {
  beforeEach(resetVendorWatch);

  it('goes generating → active with the plan result stored', () => {
    const p = beginPlanGeneration('@activepieces/piece-acme');
    expect(p.status).toBe('generating');
    const done = completePlanGeneration(p.id, samplePlanResult());
    expect(done.status).toBe('active');
    expect(done.piece_display_name).toBe('Acme');
    expect(JSON.parse(done.endpoint_inventory)).toHaveLength(2);
    expect(JSON.parse(done.api_base_urls)).toEqual(['https://api.acme.dev/v1']);
    expect(done.generated_at).not.toBeNull();
    expect(listRunnablePlans().map(r => r.id)).toEqual([p.id]);
  });

  it('keeps the plan id when regenerating', () => {
    const a = activePlan();
    const again = beginPlanGeneration(a.piece_name);
    expect(again.id).toBe(a.id);
    expect(again.status).toBe('generating');
  });

  it('marks a first failed generation failed, and a failed regeneration stale', () => {
    const first = beginPlanGeneration('@activepieces/piece-new');
    expect(failPlanGeneration(first.id, 'no sources', 0.1).status).toBe('failed');
    const a = activePlan();
    beginPlanGeneration(a.piece_name);
    const failed = failPlanGeneration(a.id, 'rate limited', 0.2);
    expect(failed.status).toBe('stale');
    expect(failed.generation_note).toBe('rate limited');
  });

  it('lists plans with source and open-finding counts', () => {
    const a = activePlan();
    const [s1] = replaceSources(a.id, [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' }, { kind: 'liveness', url: 'https://api.acme.dev/v1', label: 'host' }]);
    recordSourceFailure(s1.id, 'HTTP 500');
    insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: s1.id, run_id: null, draft: sampleDraft() });
    const [row] = listPlans();
    expect(row).toMatchObject({ sources_total: 2, sources_failing: 1, open_findings: 1 });
  });

  it('marks only active plans whose catalog version moved', () => {
    const a = activePlan('@activepieces/piece-a');
    const b = activePlan('@activepieces/piece-b');
    const c = activePlan('@activepieces/piece-c');
    setPlanStatus(c.id, 'paused');
    const n = markStalePlans(new Map([[a.piece_name, '0.6.0'], [b.piece_name, '0.5.0'], [c.piece_name, '0.9.0']]));
    expect(n).toBe(1);
    expect(getPlan(a.id)!.status).toBe('stale');
    expect(getPlan(b.id)!.status).toBe('active');
    expect(getPlan(c.id)!.status).toBe('paused');
  });

  it('deletes a plan with its sources, snapshots, runs and findings', () => {
    const a = activePlan();
    const [s] = replaceSources(a.id, [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' }]);
    saveSnapshot(s.id, 'h', '[]');
    const run = createRun(a.id, 'manual');
    insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: s.id, run_id: run.id, draft: sampleDraft() });
    expect(deletePlan(a.id)).toBe(true);
    const db = getDb();
    for (const t of ['watch_sources', 'watch_snapshots', 'watch_runs', 'vendor_findings']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
    }
  });
});

describe('watch sources and snapshots', () => {
  beforeEach(resetVendorWatch);

  it('keeps the row and snapshot of an unchanged source and drops removed ones', () => {
    const a = activePlan();
    const [keep, drop] = replaceSources(a.id, [
      { kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' },
      { kind: 'html', url: 'https://acme.dev/changelog', label: 'page' },
    ]);
    saveSnapshot(keep.id, 'h1', '["a"]');
    saveSnapshot(drop.id, 'h2', '["b"]');
    const after = replaceSources(a.id, [
      { kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS feed' },
      { kind: 'openapi', url: 'https://acme.dev/openapi.json', label: 'spec' },
    ]);
    expect(after.map(s => s.url)).toEqual(['https://acme.dev/rss', 'https://acme.dev/openapi.json']);
    expect(after[0].id).toBe(keep.id);
    expect(after[0].label).toBe('RSS feed');
    expect(getSnapshot(keep.id)?.content_hash).toBe('h1');
    expect(getSnapshot(drop.id)).toBeUndefined();
  });

  it('re-creates a source whose kind changed', () => {
    const a = activePlan();
    const [s] = replaceSources(a.id, [{ kind: 'html', url: 'https://acme.dev/x', label: 'x' }]);
    saveSnapshot(s.id, 'h', '[]');
    const [t] = replaceSources(a.id, [{ kind: 'feed', url: 'https://acme.dev/x', label: 'x' }]);
    expect(t.kind).toBe('feed');
    expect(getSnapshot(t.id)).toBeUndefined();
  });

  it('counts failures only when asked, and resets on success', () => {
    const a = activePlan();
    const [s] = replaceSources(a.id, [{ kind: 'liveness', url: 'https://api.acme.dev', label: 'host' }]);
    expect(recordSourceFailure(s.id, 'dns_not_found')).toBe(1);
    expect(recordSourceFailure(s.id, 'timeout', false)).toBe(1);
    expect(recordSourceFailure(s.id, 'dns_not_found')).toBe(2);
    recordSourceOk(s.id, true);
    const [after] = listSources(a.id);
    expect(after.consecutive_failures).toBe(0);
    expect(after.last_error).toBe('');
    expect(after.last_changed_at).not.toBeNull();
  });
});

describe('watch runs', () => {
  beforeEach(resetVendorWatch);

  it('round-trips a run', () => {
    const a = activePlan();
    const r = createRun(a.id, 'scheduled', 'vw-1');
    expect(r.status).toBe('running');
    finishRun(r.id, 'completed', { sources_checked: 3, sources_changed: 1, sources_failed: 0, findings_created: 2, cost_usd: 0.01 }, '');
    expect(getRun(r.id)).toMatchObject({ status: 'completed', sources_checked: 3, findings_created: 2, cycle_id: 'vw-1' });
  });
});

describe('vendor findings', () => {
  beforeEach(resetVendorWatch);

  it('ignores a second finding with the same signature for the same piece', () => {
    const a = activePlan('@activepieces/piece-a');
    const b = activePlan('@activepieces/piece-b');
    expect(insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft() })).not.toBeNull();
    expect(insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft() })).toBeNull();
    expect(insertFinding({ plan_id: b.id, piece_name: b.piece_name, source_id: null, run_id: null, draft: sampleDraft() })).not.toBeNull();
  });

  it('stores affects_piece from the targets', () => {
    const a = activePlan();
    const f = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ affected_targets: [], signature: 's2' }) })!;
    expect(f.affects_piece).toBe(0);
    expect(f.status).toBe('new');
  });

  it('dismisses only new findings and filters lists', () => {
    const a = activePlan();
    const f1 = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'x1' }) })!;
    const f2 = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'x2' }) })!;
    markFindingFiled(f2.id, { filed_by: 'auto', linear_issue_id: 'i', linear_identifier: 'PIE-1', linear_url: 'https://linear.app/x' });
    expect(dismissFinding(f2.id)!.status).toBe('filed');
    expect(dismissFinding(f1.id)!.status).toBe('dismissed');
    expect(listFindings({ status: 'filed' }).map(f => f.id)).toEqual([f2.id]);
    expect(countOpenFindings(a.piece_name)).toBe(0);
  });

  it('finds a filed finding of the same kind with overlapping targets to merge into', () => {
    const a = activePlan();
    const filed = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'f1' }) })!;
    markFindingFiled(filed.id, { filed_by: 'auto', linear_issue_id: 'iss', linear_identifier: 'PIE-9', linear_url: 'https://linear.app/pie-9' });
    const fresh = insertFinding({ plan_id: a.id, piece_name: a.piece_name, source_id: null, run_id: null, draft: sampleDraft({ signature: 'f2' }) })!;
    expect(findMergeTarget(a.piece_name, 'deprecation', ['send_message'], fresh.id)?.id).toBe(filed.id);
    expect(findMergeTarget(a.piece_name, 'deprecation', ['*'], fresh.id)?.id).toBe(filed.id);
    expect(findMergeTarget(a.piece_name, 'breaking', ['send_message'], fresh.id)).toBeNull();
    expect(findMergeTarget(a.piece_name, 'deprecation', ['new_order'], fresh.id)).toBeNull();
    expect(findMergeTarget(a.piece_name, 'deprecation', [], fresh.id)).toBeNull();
  });

  it('targetsOverlap: * overlaps any non-empty list, empty overlaps nothing', () => {
    expect(targetsOverlap(['*'], ['a'])).toBe(true);
    expect(targetsOverlap(['a'], ['*'])).toBe(true);
    expect(targetsOverlap(['a', 'b'], ['b'])).toBe(true);
    expect(targetsOverlap(['a'], ['b'])).toBe(false);
    expect(targetsOverlap([], ['*'])).toBe(false);
  });
});

describe('reconcileVendorWatch', () => {
  beforeEach(resetVendorWatch);

  it('closes interrupted runs and generations', () => {
    const a = activePlan('@activepieces/piece-a');
    createRun(a.id, 'scheduled');
    beginPlanGeneration(a.piece_name);
    const fresh = beginPlanGeneration('@activepieces/piece-fresh');
    expect(reconcileVendorWatch()).toEqual({ runs: 1, plans: 2 });
    expect(getPlan(a.id)!.status).toBe('stale');
    expect(getPlan(fresh.id)!.status).toBe('failed');
    expect(getPlan(fresh.id)!.generation_note).toBe('interrupted by restart');
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run server/src/db/vendor-watch-queries.test.ts`
Expected: FAIL. The test file cannot import `./vendor-watch-queries.js` because the file does not exist yet.

- [ ] **Step 6: Write the queries**

`server/src/db/vendor-watch-queries.ts`:

```ts
import { getDb } from './schema.js';
import type {
  EndpointRef, FindingDraft, FindingKind, FindingStatus, PlanStatus, RunTrigger, Severity, SourceKind,
} from '../services/vendor-watch/types.js';

export interface WatchConfigRow {
  id: number;
  enabled: number;
  cron_expression: string;
  timezone: string;
  auto_file_enabled: number;
  linear_team_key: string;
  linear_label: string;
  classifier_model: string;
  dead_after_failures: number;
  updated_at: string;
}

export interface WatchPlanRow {
  id: number;
  piece_name: string;
  piece_version: string;
  piece_display_name: string;
  vendor_name: string;
  api_base_urls: string;       // JSON string[]
  api_version: string;
  auth_type: string;
  endpoint_inventory: string;  // JSON EndpointRef[]
  status: PlanStatus;
  generation_note: string;
  generation_cost_usd: number;
  generated_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface WatchPlanListRow extends WatchPlanRow {
  sources_total: number;
  sources_failing: number;
  open_findings: number;
}

export interface WatchSourceRow {
  id: number;
  plan_id: number;
  kind: SourceKind;
  url: string;
  label: string;
  enabled: number;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_changed_at: string | null;
  consecutive_failures: number;
  last_error: string;
}

export interface WatchSnapshotRow {
  source_id: number;
  content_hash: string;
  content: string;
  fetched_at: string;
}

export interface WatchRunRow {
  id: number;
  plan_id: number;
  trigger_type: RunTrigger;
  cycle_id: string | null;
  status: 'running' | 'completed' | 'failed';
  sources_checked: number;
  sources_changed: number;
  sources_failed: number;
  findings_created: number;
  cost_usd: number;
  error: string;
  started_at: string;
  finished_at: string | null;
}

export interface VendorFindingRow {
  id: number;
  plan_id: number;
  piece_name: string;
  source_id: number | null;
  run_id: number | null;
  kind: FindingKind;
  severity: Severity;
  affects_piece: number;
  affected_targets: string;    // JSON string[]
  effective_date: string | null;
  title: string;
  summary: string;
  suggested_action: string;
  evidence_url: string;
  evidence_excerpt: string;
  evidence_verified: number;
  is_baseline: number;
  signature: string;
  status: FindingStatus;
  filed_by: 'auto' | 'manual' | null;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_url: string | null;
  file_error: string;
  created_at: string;
  updated_at: string;
}

// ── Config ──

const CONFIG_FIELDS = [
  'enabled', 'cron_expression', 'timezone', 'auto_file_enabled',
  'linear_team_key', 'linear_label', 'classifier_model', 'dead_after_failures',
] as const;

export type WatchConfigPatch = Partial<Pick<WatchConfigRow, (typeof CONFIG_FIELDS)[number]>>;

export function getWatchConfig(): WatchConfigRow {
  return getDb().get<WatchConfigRow>('SELECT * FROM vendor_watch_config WHERE id = 1')!;
}

export function updateWatchConfig(patch: WatchConfigPatch): WatchConfigRow {
  const keys = CONFIG_FIELDS.filter(k => patch[k] !== undefined);
  if (keys.length > 0) {
    getDb().run(
      `UPDATE vendor_watch_config SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
      keys.map(k => patch[k]),
    );
  }
  return getWatchConfig();
}

// ── Plans ──

export interface PlanResult {
  piece_version: string;
  piece_display_name: string;
  vendor_name: string;
  api_base_urls: string[];
  api_version: string;
  auth_type: string;
  endpoint_inventory: EndpointRef[];
  generation_note: string;
  generation_cost_usd: number;
}

export function getPlan(id: number): WatchPlanRow | undefined {
  return getDb().get<WatchPlanRow>('SELECT * FROM watch_plans WHERE id = ?', [id]);
}

export function getPlanByPiece(pieceName: string): WatchPlanRow | undefined {
  return getDb().get<WatchPlanRow>('SELECT * FROM watch_plans WHERE piece_name = ?', [pieceName]);
}

export function listPlans(): WatchPlanListRow[] {
  return getDb().all<WatchPlanListRow>(`
    SELECT p.*,
      (SELECT COUNT(*) FROM watch_sources s WHERE s.plan_id = p.id) AS sources_total,
      (SELECT COUNT(*) FROM watch_sources s WHERE s.plan_id = p.id AND s.consecutive_failures > 0) AS sources_failing,
      (SELECT COUNT(*) FROM vendor_findings f WHERE f.plan_id = p.id AND f.status = 'new') AS open_findings
    FROM watch_plans p
    ORDER BY p.piece_name
  `);
}

export function listRunnablePlans(): WatchPlanRow[] {
  return getDb().all<WatchPlanRow>(`SELECT * FROM watch_plans WHERE status IN ('active', 'stale') ORDER BY id`);
}

/** Create the plan row for a generation, or flip an existing plan to generating. Keeps the plan id. */
export function beginPlanGeneration(pieceName: string): WatchPlanRow {
  getDb().run(
    `INSERT INTO watch_plans (piece_name, status) VALUES (?, 'generating')
     ON CONFLICT(piece_name) DO UPDATE SET status = 'generating', generation_note = ''`,
    [pieceName],
  );
  return getPlanByPiece(pieceName)!;
}

export function completePlanGeneration(planId: number, r: PlanResult): WatchPlanRow {
  getDb().run(
    `UPDATE watch_plans SET piece_version = ?, piece_display_name = ?, vendor_name = ?, api_base_urls = ?,
       api_version = ?, auth_type = ?, endpoint_inventory = ?, generation_note = ?, generation_cost_usd = ?,
       status = 'active', generated_at = datetime('now')
     WHERE id = ?`,
    [
      r.piece_version, r.piece_display_name, r.vendor_name, JSON.stringify(r.api_base_urls), r.api_version,
      r.auth_type, JSON.stringify(r.endpoint_inventory), r.generation_note, r.generation_cost_usd, planId,
    ],
  );
  return getPlan(planId)!;
}

/** A first generation that fails → failed. A failed regeneration → stale, so the old plan keeps running. */
export function failPlanGeneration(planId: number, note: string, costUsd = 0): WatchPlanRow {
  getDb().run(
    `UPDATE watch_plans SET status = CASE WHEN generated_at IS NULL THEN 'failed' ELSE 'stale' END,
       generation_note = ?, generation_cost_usd = ?
     WHERE id = ?`,
    [note.slice(0, 2000), costUsd, planId],
  );
  return getPlan(planId)!;
}

export function setPlanStatus(planId: number, status: 'active' | 'paused'): WatchPlanRow | undefined {
  getDb().run('UPDATE watch_plans SET status = ? WHERE id = ?', [status, planId]);
  return getPlan(planId);
}

/** Mark active plans whose catalog version moved past the version their inventory was read from. */
export function markStalePlans(catalogVersions: Map<string, string>): number {
  let marked = 0;
  for (const p of getDb().all<WatchPlanRow>(`SELECT * FROM watch_plans WHERE status = 'active'`)) {
    const latest = catalogVersions.get(p.piece_name);
    if (latest && p.piece_version && latest !== p.piece_version) {
      getDb().run(`UPDATE watch_plans SET status = 'stale' WHERE id = ?`, [p.id]);
      marked++;
    }
  }
  return marked;
}

export function touchPlanRun(planId: number): void {
  getDb().run(`UPDATE watch_plans SET last_run_at = datetime('now') WHERE id = ?`, [planId]);
}

export function deletePlan(planId: number): boolean {
  return getDb().run('DELETE FROM watch_plans WHERE id = ?', [planId]).changes > 0;
}

// ── Sources ──

export interface SourceInput {
  kind: SourceKind;
  url: string;
  label: string;
}

export function listSources(planId: number): WatchSourceRow[] {
  return getDb().all<WatchSourceRow>('SELECT * FROM watch_sources WHERE plan_id = ? ORDER BY id', [planId]);
}

export function getSource(id: number): WatchSourceRow | undefined {
  return getDb().get<WatchSourceRow>('SELECT * FROM watch_sources WHERE id = ?', [id]);
}

/** Replace a plan's sources. A source whose kind and URL are unchanged keeps its row and snapshot. */
export function replaceSources(planId: number, sources: SourceInput[]): WatchSourceRow[] {
  const db = getDb();
  return db.transaction(() => {
    const wanted = new Map(sources.map(s => [`${s.kind} ${s.url}`, s]));
    for (const old of listSources(planId)) {
      if (!wanted.has(`${old.kind} ${old.url}`)) db.run('DELETE FROM watch_sources WHERE id = ?', [old.id]);
    }
    for (const s of wanted.values()) {
      db.run(
        `INSERT INTO watch_sources (plan_id, kind, url, label) VALUES (?, ?, ?, ?)
         ON CONFLICT(plan_id, url) DO UPDATE SET label = excluded.label`,
        [planId, s.kind, s.url, s.label],
      );
    }
    return listSources(planId);
  });
}

export function setSourceEnabled(id: number, enabled: boolean): WatchSourceRow | undefined {
  getDb().run('UPDATE watch_sources SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  return getSource(id);
}

export function recordSourceOk(id: number, changed: boolean): void {
  getDb().run(
    `UPDATE watch_sources SET consecutive_failures = 0, last_error = '', last_checked_at = datetime('now'),
       last_ok_at = datetime('now'), last_changed_at = CASE WHEN ? THEN datetime('now') ELSE last_changed_at END
     WHERE id = ?`,
    [changed ? 1 : 0, id],
  );
}

/** Record a failed check. `count = false` notes the error without adding to consecutive_failures. Returns the count. */
export function recordSourceFailure(id: number, error: string, count = true): number {
  getDb().run(
    `UPDATE watch_sources SET consecutive_failures = consecutive_failures + ?, last_error = ?,
       last_checked_at = datetime('now')
     WHERE id = ?`,
    [count ? 1 : 0, error.slice(0, 500), id],
  );
  return getSource(id)?.consecutive_failures ?? 0;
}

// ── Snapshots ──

export function getSnapshot(sourceId: number): WatchSnapshotRow | undefined {
  return getDb().get<WatchSnapshotRow>('SELECT * FROM watch_snapshots WHERE source_id = ?', [sourceId]);
}

export function saveSnapshot(sourceId: number, contentHash: string, content: string): void {
  getDb().run(
    `INSERT INTO watch_snapshots (source_id, content_hash, content, fetched_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(source_id) DO UPDATE SET content_hash = excluded.content_hash, content = excluded.content,
       fetched_at = excluded.fetched_at`,
    [sourceId, contentHash, content],
  );
}

// ── Runs ──

export interface RunCounts {
  sources_checked: number;
  sources_changed: number;
  sources_failed: number;
  findings_created: number;
  cost_usd: number;
}

export function createRun(planId: number, trigger: RunTrigger, cycleId: string | null = null): WatchRunRow {
  const res = getDb().run(
    'INSERT INTO watch_runs (plan_id, trigger_type, cycle_id) VALUES (?, ?, ?)',
    [planId, trigger, cycleId],
  );
  return getRun(res.lastId)!;
}

export function getRun(id: number): WatchRunRow | undefined {
  return getDb().get<WatchRunRow>('SELECT * FROM watch_runs WHERE id = ?', [id]);
}

export function finishRun(id: number, status: 'completed' | 'failed', counts: RunCounts, error = ''): WatchRunRow {
  getDb().run(
    `UPDATE watch_runs SET status = ?, sources_checked = ?, sources_changed = ?, sources_failed = ?,
       findings_created = ?, cost_usd = ?, error = ?, finished_at = datetime('now')
     WHERE id = ?`,
    [
      status, counts.sources_checked, counts.sources_changed, counts.sources_failed,
      counts.findings_created, counts.cost_usd, error.slice(0, 2000), id,
    ],
  );
  return getRun(id)!;
}

export function listRuns(planId: number, limit = 20): WatchRunRow[] {
  return getDb().all<WatchRunRow>('SELECT * FROM watch_runs WHERE plan_id = ? ORDER BY id DESC LIMIT ?', [planId, limit]);
}

// ── Findings ──

/** Insert a finding unless its (piece, signature) already exists. Returns null when it was a duplicate. */
export function insertFinding(p: {
  plan_id: number; piece_name: string; source_id: number | null; run_id: number | null; draft: FindingDraft;
}): VendorFindingRow | null {
  const d = p.draft;
  const res = getDb().run(
    `INSERT OR IGNORE INTO vendor_findings (plan_id, piece_name, source_id, run_id, kind, severity, affects_piece,
       affected_targets, effective_date, title, summary, suggested_action, evidence_url, evidence_excerpt,
       evidence_verified, is_baseline, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.plan_id, p.piece_name, p.source_id, p.run_id, d.kind, d.severity, d.affected_targets.length > 0 ? 1 : 0,
      JSON.stringify(d.affected_targets), d.effective_date, d.title, d.summary, d.suggested_action, d.evidence_url,
      d.evidence_excerpt, d.evidence_verified ? 1 : 0, d.is_baseline ? 1 : 0, d.signature,
    ],
  );
  return res.changes > 0 ? getFinding(res.lastId)! : null;
}

export function getFinding(id: number): VendorFindingRow | undefined {
  return getDb().get<VendorFindingRow>('SELECT * FROM vendor_findings WHERE id = ?', [id]);
}

export function listFindings(f: { status?: FindingStatus; piece?: string } = {}): VendorFindingRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status) { where.push('status = ?'); params.push(f.status); }
  if (f.piece) { where.push('piece_name = ?'); params.push(f.piece); }
  return getDb().all<VendorFindingRow>(
    `SELECT * FROM vendor_findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`,
    params,
  );
}

export function countOpenFindings(pieceName: string): number {
  return getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM vendor_findings WHERE piece_name = ? AND status = 'new'`, [pieceName],
  )!.n;
}

export function markFindingFiled(id: number, p: {
  filed_by: 'auto' | 'manual'; linear_issue_id: string; linear_identifier: string; linear_url: string;
}): VendorFindingRow {
  getDb().run(
    `UPDATE vendor_findings SET status = 'filed', filed_by = ?, linear_issue_id = ?, linear_identifier = ?,
       linear_url = ?, file_error = '', updated_at = datetime('now')
     WHERE id = ?`,
    [p.filed_by, p.linear_issue_id, p.linear_identifier, p.linear_url, id],
  );
  return getFinding(id)!;
}

export function setFindingFileError(id: number, message: string): void {
  getDb().run(
    `UPDATE vendor_findings SET file_error = ?, updated_at = datetime('now') WHERE id = ?`,
    [message.slice(0, 500), id],
  );
}

export function dismissFinding(id: number): VendorFindingRow | undefined {
  getDb().run(
    `UPDATE vendor_findings SET status = 'dismissed', updated_at = datetime('now') WHERE id = ? AND status = 'new'`,
    [id],
  );
  return getFinding(id);
}

export function parseTargets(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** `*` overlaps any non-empty list; an empty list overlaps nothing. */
export function targetsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes('*') || b.includes('*')) return true;
  return a.some(t => b.includes(t));
}

/** A filed finding from the last 60 days this one should be added to as a comment, instead of a new ticket. */
export function findMergeTarget(pieceName: string, kind: FindingKind, targets: string[], excludeId: number): VendorFindingRow | null {
  const rows = getDb().all<VendorFindingRow>(
    `SELECT * FROM vendor_findings
     WHERE piece_name = ? AND kind = ? AND status = 'filed' AND COALESCE(linear_issue_id, '') != ''
       AND id != ? AND created_at >= datetime('now', '-60 days')
     ORDER BY id DESC`,
    [pieceName, kind, excludeId],
  );
  return rows.find(r => targetsOverlap(parseTargets(r.affected_targets), targets)) ?? null;
}

// ── Boot ──

/** Close runs and generations a restart interrupted. A regeneration falls back to stale, a first one to failed. */
export function reconcileVendorWatch(): { runs: number; plans: number } {
  const runs = getDb().run(
    `UPDATE watch_runs SET status = 'failed', error = 'interrupted by restart', finished_at = datetime('now')
     WHERE status = 'running'`,
  ).changes;
  const plans = getDb().run(
    `UPDATE watch_plans SET status = CASE WHEN generated_at IS NULL THEN 'failed' ELSE 'stale' END,
       generation_note = 'interrupted by restart'
     WHERE status = 'generating'`,
  ).changes;
  return { runs, plans };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run server/src/db/vendor-watch-queries.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 8: Add the glossary terms**

Append to the end of `CONTEXT.md`:

```markdown

### Vendor watch

**Watch plan**:
One per piece: the piece's endpoint inventory plus the sources to watch. The vendor-side counterpart of a test plan.
_Avoid_: watcher config, monitor

**Endpoint inventory**:
The API calls a piece makes, per target: method + path, or `sdk:<package>#<method>` for SDK-based pieces.

**Source**:
One URL a watch plan checks. Kind: `liveness`, `feed`, `openapi` or `html`.

**Snapshot**:
The normalized content of a source from its last successful check. Only the latest is kept.

**Watch run**:
One check of one watch plan's sources. Trigger: `baseline`, `scheduled` or `manual`.

**Watch cycle**:
All watch runs fired by one firing of the vendor-watch cron (or "Run all now").
_Avoid_: wave (that's test plan runs), sweep (that's the flow reaper)

**Finding**:
What a watch run concluded about one vendor change: kind, severity, the targets it hits, evidence.

**Baseline**:
The first check of a source. It records the snapshot and reports only still-open deprecations; baseline findings are never auto-filed.

**Vendor Changes inbox**:
Findings with status `new`, waiting for a person to file or dismiss.
```

- [ ] **Step 9: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add server/src/services/vendor-watch/types.ts server/src/db/schema.ts server/src/db/vendor-watch-queries.ts server/src/db/vendor-watch-test-utils.ts server/src/db/vendor-watch-queries.test.ts CONTEXT.md
git commit -m "feat(vendor-watch): add tables, queries and glossary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Guarded fetch and liveness

**Files:**
- Create: `server/src/services/vendor-watch/safe-fetch.ts`
- Create: `server/src/services/vendor-watch/liveness.ts`
- Test: `server/src/services/vendor-watch/safe-fetch.test.ts`
- Test: `server/src/services/vendor-watch/liveness.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `safeFetch(url: string, opts?: SafeFetchOptions): Promise<SafeFetchResult>`
  - `SafeFetchOptions = { lookup?, fetchImpl?, timeoutMs?, maxBytes?, maxRedirects? }`
  - `SafeFetchResult = { status, finalUrl, contentType, body }`
  - `class SafeFetchError { code: SafeFetchErrorCode }`
  - `isBlockedAddress(addr): boolean`
  - `type LookupFn`
  - `checkLiveness(baseUrl: string, opts?: SafeFetchOptions): Promise<LivenessResult>`
  - `LivenessResult = { alive: boolean; failure?: SafeFetchErrorCode; detail: string }`
  - `countsTowardDead(failure?): boolean`
  - `hostOf(url): string`

- [ ] **Step 1: Write the failing safe-fetch tests**

`server/src/services/vendor-watch/safe-fetch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { safeFetch, isBlockedAddress, type LookupFn } from './safe-fetch.js';

const publicLookup: LookupFn = async (host) =>
  host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
const asFetch = (fn: (url: string, init?: any) => Promise<Response>) => fn as unknown as typeof fetch;

describe('isBlockedAddress', () => {
  it.each([
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '93.184.216.34', '2606:4700::1111'])('allows %s', (a) =>
    expect(isBlockedAddress(a)).toBe(false));
});

describe('safeFetch', () => {
  it('returns status, final URL, content type and body', async () => {
    const f = asFetch(async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const r = await safeFetch('https://acme.dev/x', { lookup: publicLookup, fetchImpl: f });
    expect(r).toEqual({ status: 200, finalUrl: 'https://acme.dev/x', contentType: 'text/plain', body: 'hello' });
  });

  it('refuses a host that resolves to the metadata address without fetching', async () => {
    const f = vi.fn();
    const lookup: LookupFn = async () => [{ address: '169.254.169.254', family: 4 }];
    await expect(safeFetch('http://metadata.example/', { lookup, fetchImpl: asFetch(f) })).rejects.toMatchObject({ code: 'blocked_address' });
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a literal private IP', async () => {
    await expect(safeFetch('http://192.168.0.10/', { lookup: publicLookup, fetchImpl: asFetch(vi.fn()) })).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('refuses non-http protocols', async () => {
    await expect(safeFetch('file:///etc/passwd', { lookup: publicLookup })).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('re-checks every redirect hop', async () => {
    const f = asFetch(async (url) =>
      url.startsWith('https://acme.dev')
        ? new Response(null, { status: 302, headers: { location: 'http://internal.example/admin' } })
        : new Response('secret'));
    await expect(safeFetch('https://acme.dev/start', { lookup: publicLookup, fetchImpl: f })).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('follows a public redirect and reports the final URL', async () => {
    const f = asFetch(async (url) =>
      url === 'https://acme.dev/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('moved', { status: 200 }));
    const r = await safeFetch('https://acme.dev/old', { lookup: publicLookup, fetchImpl: f });
    expect(r.finalUrl).toBe('https://acme.dev/new');
    expect(r.body).toBe('moved');
  });

  it('stops after too many redirects', async () => {
    const f = asFetch(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    await expect(safeFetch('https://acme.dev/loop', { lookup: publicLookup, fetchImpl: f, maxRedirects: 2 })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('caps the body size', async () => {
    const f = asFetch(async () => new Response('x'.repeat(2000)));
    await expect(safeFetch('https://acme.dev/big', { lookup: publicLookup, fetchImpl: f, maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('maps DNS not-found', async () => {
    const lookup: LookupFn = async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); };
    await expect(safeFetch('https://gone.example/', { lookup, fetchImpl: asFetch(vi.fn()) })).rejects.toMatchObject({ code: 'dns_not_found' });
  });

  it('maps connection refused, TLS and timeout errors', async () => {
    const refused = asFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    await expect(safeFetch('https://acme.dev/', { lookup: publicLookup, fetchImpl: refused })).rejects.toMatchObject({ code: 'connection_refused' });
    const tls = asFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); });
    await expect(safeFetch('https://acme.dev/', { lookup: publicLookup, fetchImpl: tls })).rejects.toMatchObject({ code: 'tls' });
    const slow = asFetch(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    await expect(safeFetch('https://acme.dev/', { lookup: publicLookup, fetchImpl: slow })).rejects.toMatchObject({ code: 'timeout' });
  });
});
```

- [ ] **Step 2: Write the failing liveness tests**

`server/src/services/vendor-watch/liveness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkLiveness, countsTowardDead, hostOf } from './liveness.js';
import type { LookupFn } from './safe-fetch.js';

const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const asFetch = (fn: () => Promise<Response>) => fn as unknown as typeof fetch;

describe('checkLiveness', () => {
  it('treats any HTTP response, even 404, as alive and fetches the origin root', async () => {
    let asked = '';
    const f = ((url: string) => { asked = url; return Promise.resolve(new Response('nope', { status: 404 })); }) as unknown as typeof fetch;
    const r = await checkLiveness('https://api.acme.dev/v1/things', { lookup, fetchImpl: f });
    expect(r).toEqual({ alive: true, detail: 'HTTP 404' });
    expect(asked).toBe('https://api.acme.dev/');
  });

  it('reports DNS not-found as a dead-type failure', async () => {
    const gone: LookupFn = async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };
    const r = await checkLiveness('https://api.gone.example', { lookup: gone, fetchImpl: asFetch(async () => new Response('')) });
    expect(r.alive).toBe(false);
    expect(r.failure).toBe('dns_not_found');
    expect(countsTowardDead(r.failure)).toBe(true);
  });

  it('reports a timeout as a failure that does not count toward dead', async () => {
    const slow = asFetch(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    const r = await checkLiveness('https://api.acme.dev', { lookup, fetchImpl: slow });
    expect(r.alive).toBe(false);
    expect(countsTowardDead(r.failure)).toBe(false);
  });

  it('rejects a non-URL', async () => {
    const r = await checkLiveness('not a url');
    expect(r).toMatchObject({ alive: false, failure: 'bad_url' });
  });

  it('hostOf returns the hostname, or the input when it is not a URL', () => {
    expect(hostOf('https://api.acme.dev/v1')).toBe('api.acme.dev');
    expect(hostOf('weird')).toBe('weird');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/safe-fetch.test.ts server/src/services/vendor-watch/liveness.test.ts`
Expected: FAIL. Neither module exists yet.

- [ ] **Step 4: Implement `safe-fetch.ts`**

`server/src/services/vendor-watch/safe-fetch.ts`:

```ts
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

export interface SafeFetchOptions {
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

export type SafeFetchErrorCode =
  | 'bad_url' | 'blocked_address' | 'dns_not_found' | 'connection_refused' | 'tls'
  | 'timeout' | 'too_large' | 'too_many_redirects' | 'network';

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const USER_AGENT = 'piece-tester-vendor-watch/1';
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, unspecified, multicast and reserved ranges. */
export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  const v6 = address.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) {
    const rest = v6.slice(7);
    return net.isIPv4(rest) ? isBlockedAddress(rest) : true;
  }
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

async function assertPublicHost(url: URL, lookup: LookupFn): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new SafeFetchError('blocked_address', `Refusing to fetch ${host}: not a public address`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch (err: any) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') throw new SafeFetchError('dns_not_found', `DNS: ${host} not found`);
    throw new SafeFetchError('network', `DNS lookup failed for ${host}: ${err?.code || err?.message}`);
  }
  if (addrs.length === 0) throw new SafeFetchError('dns_not_found', `DNS: ${host} has no addresses`);
  const bad = addrs.find(a => isBlockedAddress(a.address));
  if (bad) throw new SafeFetchError('blocked_address', `Refusing to fetch ${host}: resolves to ${bad.address}`);
}

function classifyNetworkError(err: any): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new SafeFetchError('timeout', 'Timed out');
  const code: string = err?.cause?.code || err?.code || '';
  if (code === 'ECONNREFUSED') return new SafeFetchError('connection_refused', 'Connection refused');
  if (code === 'ENOTFOUND') return new SafeFetchError('dns_not_found', 'DNS: host not found');
  if (/CERT|SSL|TLS/i.test(code) || /certificate|ssl|tls/i.test(String(err?.cause?.message || ''))) {
    return new SafeFetchError('tls', `TLS error: ${code || err?.cause?.message}`);
  }
  return new SafeFetchError('network', `Network error: ${code || err?.message || 'unknown'}`);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new SafeFetchError('too_large', `Body is ${declared} bytes (cap ${maxBytes})`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SafeFetchError('too_large', `Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch a vendor URL that came from an AI or a web page. Only public http(s) hosts, every redirect
 * hop re-checked, time and size capped. Any HTTP status is returned; callers decide what is a failure.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const lookup = opts.lookup ?? defaultLookup;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('bad_url', `Not a URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SafeFetchError('bad_url', `Only http(s) URLs are allowed: ${url.href}`);
    }
    await assertPublicHost(url, lookup);
    let res: Response;
    try {
      res = await fetchImpl(url.href, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
    } catch (err) {
      throw classifyNetworkError(err);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    let body: string;
    try {
      body = await readCapped(res, maxBytes);
    } catch (err) {
      throw classifyNetworkError(err);
    }
    return { status: res.status, finalUrl: url.href, contentType: res.headers.get('content-type') || '', body };
  }
  throw new SafeFetchError('too_many_redirects', `More than ${maxRedirects} redirects`);
}
```

- [ ] **Step 5: Implement `liveness.ts`**

`server/src/services/vendor-watch/liveness.ts`:

```ts
import { safeFetch, SafeFetchError, type SafeFetchErrorCode, type SafeFetchOptions } from './safe-fetch.js';

export interface LivenessResult {
  alive: boolean;
  failure?: SafeFetchErrorCode;
  detail: string;
}

/** Failures that mean "the host is gone", not "the host is having a bad day". */
const DEAD_FAILURES: ReadonlySet<SafeFetchErrorCode> = new Set(['dns_not_found', 'connection_refused', 'tls']);

export function countsTowardDead(failure: SafeFetchErrorCode | undefined): boolean {
  return !!failure && DEAD_FAILURES.has(failure);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Does the vendor's API host still exist? Any HTTP response, 4xx and 5xx included, counts as alive. */
export async function checkLiveness(baseUrl: string, opts: SafeFetchOptions = {}): Promise<LivenessResult> {
  let root: string;
  try {
    root = `${new URL(baseUrl).origin}/`;
  } catch {
    return { alive: false, failure: 'bad_url', detail: `Not a URL: ${baseUrl}` };
  }
  try {
    const r = await safeFetch(root, { maxBytes: 256 * 1024, timeoutMs: 15_000, ...opts });
    return { alive: true, detail: `HTTP ${r.status}` };
  } catch (err) {
    if (err instanceof SafeFetchError) {
      if (err.code === 'too_large') return { alive: true, detail: 'responded (large body)' };
      return { alive: false, failure: err.code, detail: err.message };
    }
    return { alive: false, failure: 'network', detail: String((err as Error)?.message || err) };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/safe-fetch.test.ts server/src/services/vendor-watch/liveness.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/vendor-watch/safe-fetch.ts server/src/services/vendor-watch/liveness.ts server/src/services/vendor-watch/safe-fetch.test.ts server/src/services/vendor-watch/liveness.test.ts
git commit -m "feat(vendor-watch): add SSRF-guarded fetch and liveness check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Feed and HTML normalization

**Files:**
- Modify: `package.json`, `package-lock.json` (add 3 deps)
- Create: `server/src/services/vendor-watch/normalize.ts`
- Test: `server/src/services/vendor-watch/normalize.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `sha1(s): string`, `collapseWhitespace(s): string`, `htmlToText(fragment): string`
  - `type Normalized = { hash: string; content: string }`
  - `type FeedEntry = { id, title, date: string|null, text, link }`
  - `parseFeed(xml): FeedEntry[]`, `normalizeFeed(entries): Normalized`, `newFeedEntries(entries, prevContent): FeedEntry[]`, `newestEntries(entries, n): FeedEntry[]`, `renderFeedEntries(entries): string`
  - `type HtmlBlock = { text: string; heading: string|null }`
  - `htmlBlocks(html): HtmlBlock[]`, `normalizeHtml(blocks): Normalized`, `addedHtmlBlocks(blocks, prevContent): HtmlBlock[]`, `renderBlocks(blocks): string`
  - `MIN_BLOCK_CHARS = 30`

- [ ] **Step 1: Install the parsers**

Run: `npm install fast-xml-parser yaml node-html-parser`
Expected: `package.json` gains the three dependencies and `package-lock.json` is updated. These are pure JS packages, with no native build.

- [ ] **Step 2: Write the failing tests**

`server/src/services/vendor-watch/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseFeed, normalizeFeed, newFeedEntries, newestEntries, renderFeedEntries,
  htmlBlocks, normalizeHtml, addedHtmlBlocks, renderBlocks, htmlToText,
} from './normalize.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Acme API changelog</title>
<item><title>Deprecating /v1/widgets</title><link>https://acme.dev/changelog/1</link><guid isPermaLink="false">0042</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;The &lt;b&gt;/v1/widgets&lt;/b&gt; endpoint will be removed on 2027-01-31.&lt;/p&gt;</description></item>
<item><title>New webhooks</title><link>https://acme.dev/changelog/2</link><guid>https://acme.dev/changelog/2</guid><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate><description>Webhooks for orders.</description></item>
</channel></rss>`;

const ATOM_ONE_ENTRY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>
<entry><id>tag:github.com,2008:Repository/1/v2.0.0</id><title>v2.0.0</title><updated>2026-09-20T00:00:00Z</updated>
<link rel="alternate" type="text/html" href="https://github.com/acme/sdk/releases/tag/v2.0.0"/>
<content type="html">&lt;h2&gt;Breaking&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Removed legacy auth&lt;/li&gt;&lt;/ul&gt;</content></entry>
</feed>`;

const RSS_NO_IDS = `<rss><channel><item><title>Quiet change</title><pubDate>Wed, 02 Sep 2026 00:00:00 GMT</pubDate><description>Something long enough to matter here.</description></item></channel></rss>`;

describe('parseFeed', () => {
  it('reads RSS items, keeping string guids and stripping HTML from descriptions', () => {
    const entries = parseFeed(RSS);
    expect(entries.map(e => e.id)).toEqual(['0042', 'https://acme.dev/changelog/2']);
    expect(entries[0].title).toBe('Deprecating /v1/widgets');
    expect(entries[0].text).toBe('The /v1/widgets endpoint will be removed on 2027-01-31.');
    expect(entries[0].link).toBe('https://acme.dev/changelog/1');
    expect(entries[0].date).toBe('Tue, 01 Sep 2026 10:00:00 GMT');
  });

  it('reads a single-entry Atom feed (object, not array) with href links and html content', () => {
    const [e] = parseFeed(ATOM_ONE_ENTRY);
    expect(e.id).toBe('tag:github.com,2008:Repository/1/v2.0.0');
    expect(e.link).toBe('https://github.com/acme/sdk/releases/tag/v2.0.0');
    expect(e.text).toBe('Breaking Removed legacy auth');
  });

  it('gives an item with no guid or link a stable id', () => {
    const a = parseFeed(RSS_NO_IDS);
    const b = parseFeed(RSS_NO_IDS);
    expect(a).toHaveLength(1);
    expect(a[0].id).toMatch(/^[0-9a-f]{40}$/);
    expect(a[0].id).toBe(b[0].id);
  });

  it('returns nothing for a non-feed document', () => {
    expect(parseFeed('<html><body>hi</body></html>')).toEqual([]);
  });
});

describe('feed snapshots', () => {
  it('hashes ids independent of order and finds only unseen entries', () => {
    const entries = parseFeed(RSS);
    const n1 = normalizeFeed(entries);
    expect(normalizeFeed([...entries].reverse()).hash).toBe(n1.hash);
    const fresh = newFeedEntries(entries, JSON.stringify(['0042']));
    expect(fresh.map(e => e.id)).toEqual(['https://acme.dev/changelog/2']);
  });

  it('orders the newest entries first when every entry has a date', () => {
    const entries = parseFeed(RSS);
    expect(newestEntries([...entries].reverse(), 1).map(e => e.id)).toEqual(['0042']);
  });

  it('renders entries with title, date, link and text', () => {
    const out = renderFeedEntries(parseFeed(RSS).slice(0, 1));
    expect(out).toBe('## Deprecating /v1/widgets (Tue, 01 Sep 2026 10:00:00 GMT)\nhttps://acme.dev/changelog/1\nThe /v1/widgets endpoint will be removed on 2027-01-31.');
  });
});

const PAGE = `<html><head><title>Changelog</title><script>var x = 1;</script></head>
<body><nav><a href="/">Home</a> navigation links that are long enough to count</nav>
<main>
<h2>2026-09-01</h2>
<p>The legacy /v1/widgets endpoint is deprecated and will be removed on 2027-01-31.</p>
<ul><li>Added cursor pagination to the list orders endpoint.<ul><li>Nested detail line that is long enough.</li></ul></li></ul>
<h2>2026-08-01</h2>
<p>Short.</p>
<p>Rate limits for the search endpoint went from 100 to 200 per minute.</p>
</main>
<footer>Copyright Acme Inc. All rights reserved. Long footer text here.</footer>
</body></html>`;

describe('htmlBlocks', () => {
  it('keeps main-content blocks with their heading, drops chrome, short blocks and nested duplicates', () => {
    expect(htmlBlocks(PAGE)).toEqual([
      { text: 'The legacy /v1/widgets endpoint is deprecated and will be removed on 2027-01-31.', heading: '2026-09-01' },
      { text: 'Added cursor pagination to the list orders endpoint. Nested detail line that is long enough.', heading: '2026-09-01' },
      { text: 'Rate limits for the search endpoint went from 100 to 200 per minute.', heading: '2026-08-01' },
    ]);
  });

  it('htmlToText keeps a space between block elements', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One Two');
  });
});

describe('html snapshots', () => {
  it('ignores reordering and reports only added blocks, under their heading', () => {
    const before = normalizeHtml(htmlBlocks(PAGE));
    const reordered = PAGE.replace(/<h2>2026-09-01<\/h2>[\s\S]*?(?=<h2>2026-08-01)/, '')
      .replace('</main>', '<h2>2026-09-01</h2><p>The legacy /v1/widgets endpoint is deprecated and will be removed on 2027-01-31.</p><ul><li>Added cursor pagination to the list orders endpoint.<ul><li>Nested detail line that is long enough.</li></ul></li></ul></main>');
    expect(normalizeHtml(htmlBlocks(reordered)).hash).toBe(before.hash);
    expect(addedHtmlBlocks(htmlBlocks(reordered), before.content)).toEqual([]);

    const after = PAGE.replace('<main>', '<main><h2>2026-10-01</h2><p>OAuth tokens now expire after 12 hours instead of never expiring.</p>');
    const added = addedHtmlBlocks(htmlBlocks(after), before.content);
    expect(added).toEqual([{ text: 'OAuth tokens now expire after 12 hours instead of never expiring.', heading: '2026-10-01' }]);
    expect(renderBlocks(added)).toBe('## 2026-10-01\n- OAuth tokens now expire after 12 hours instead of never expiring.');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/normalize.test.ts`
Expected: FAIL. `./normalize.js` does not exist yet.

- [ ] **Step 4: Implement `normalize.ts`**

`server/src/services/vendor-watch/normalize.ts`:

```ts
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';

export interface Normalized {
  hash: string;
  content: string;
}

export interface FeedEntry {
  id: string;
  title: string;
  date: string | null;
  text: string;
  link: string;
}

export interface HtmlBlock {
  text: string;
  /** The nearest heading above the block (often a release date), kept as context for the classifier. */
  heading: string | null;
}

export const MIN_BLOCK_CHARS = 30;

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const BLOCK_TAG = /<(\/?)(p|div|li|h[1-6]|tr|td|th|dt|dd|ul|ol|pre|blockquote|section|article|table)\b/gi;

/** Put a newline before every block tag so adjacent blocks don't glue together as text. */
function spaceBlocks(html: string): string {
  return html.replace(BLOCK_TAG, '\n<$1$2').replace(/<br\s*\/?>/gi, '\n');
}

export function htmlToText(fragment: string): string {
  return collapseWhitespace(parseHtml(`<div>${spaceBlocks(fragment)}</div>`).text);
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ── Feeds ──

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)['#text']);
  return '';
}

function atomLink(link: unknown): string {
  const links = asArray(link as any);
  const alt = links.find((l: any) => !l?.['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return typeof alt === 'string' ? alt : alt?.['@_href'] ?? '';
}

/** RSS 2.0, RSS 1.0 (RDF) and Atom. Returns [] for anything that isn't a feed. */
export function parseFeed(body: string): FeedEntry[] {
  const doc = xml.parse(body);
  const rssItems = [...asArray(doc?.rss?.channel?.item), ...asArray(doc?.['rdf:RDF']?.item)];
  const fromRss = rssItems.map((it: any): FeedEntry => {
    const link = textOf(it.link);
    const title = htmlToText(textOf(it.title));
    const date = textOf(it.pubDate) || textOf(it['dc:date']) || null;
    const text = htmlToText(textOf(it['content:encoded']) || textOf(it.description));
    return { id: textOf(it.guid) || link || sha1(`${title}|${date ?? ''}`), title, date, text, link };
  });
  const fromAtom = asArray(doc?.feed?.entry).map((e: any): FeedEntry => {
    const link = atomLink(e.link);
    const title = htmlToText(textOf(e.title));
    const date = textOf(e.updated) || textOf(e.published) || null;
    const text = htmlToText(textOf(e.content) || textOf(e.summary));
    return { id: textOf(e.id) || link || sha1(`${title}|${date ?? ''}`), title, date, text, link };
  });
  return [...fromRss, ...fromAtom];
}

export function normalizeFeed(entries: FeedEntry[]): Normalized {
  const ids = entries.map(e => e.id);
  return { hash: sha1([...ids].sort().join('\n')), content: JSON.stringify(ids) };
}

export function newFeedEntries(entries: FeedEntry[], previousContent: string): FeedEntry[] {
  const seen = new Set(safeJsonArray(previousContent));
  return entries.filter(e => !seen.has(e.id));
}

/** Newest first when every entry has a parseable date; otherwise document order. */
export function newestEntries(entries: FeedEntry[], n: number): FeedEntry[] {
  const dated = entries.map(e => ({ e, t: e.date ? Date.parse(e.date) : NaN }));
  if (dated.every(d => !Number.isNaN(d.t))) dated.sort((a, b) => b.t - a.t);
  return dated.slice(0, n).map(d => d.e);
}

export function renderFeedEntries(entries: FeedEntry[]): string {
  return entries
    .map(e => [`## ${e.title}${e.date ? ` (${e.date})` : ''}`, e.link, e.text].filter(Boolean).join('\n'))
    .join('\n\n');
}

// ── HTML pages ──

const DROP_SELECTORS = 'script, style, noscript, nav, header, footer, aside, svg, form';
const BLOCK_SELECTORS = 'h1, h2, h3, h4, h5, h6, p, li, tr, dt, dd, pre, blockquote';
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const BLOCK_TAGS = new Set(['P', 'LI', 'TR', 'DT', 'DD', 'PRE', 'BLOCKQUOTE']);

function hasBlockAncestor(el: HTMLElement, stop: HTMLElement): boolean {
  for (let p = el.parentNode; p && p !== stop; p = p.parentNode) {
    if (BLOCK_TAGS.has(p.tagName)) return true;
  }
  return false;
}

/** The readable blocks of a docs/changelog page, each with the heading above it. */
export function htmlBlocks(html: string): HtmlBlock[] {
  const root = parseHtml(spaceBlocks(html));
  for (const n of root.querySelectorAll(DROP_SELECTORS)) n.remove();
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;
  const out: HtmlBlock[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;
  for (const el of main.querySelectorAll(BLOCK_SELECTORS)) {
    const text = collapseWhitespace(el.text);
    if (HEADING_TAGS.has(el.tagName)) {
      if (text) heading = text.slice(0, 200);
      continue;
    }
    if (hasBlockAncestor(el, main) || text.length < MIN_BLOCK_CHARS || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, heading });
  }
  return out;
}

export function normalizeHtml(blocks: HtmlBlock[]): Normalized {
  const hashes = blocks.map(b => sha1(b.text));
  return { hash: sha1([...hashes].sort().join('\n')), content: JSON.stringify(hashes) };
}

export function addedHtmlBlocks(blocks: HtmlBlock[], previousContent: string): HtmlBlock[] {
  const seen = new Set(safeJsonArray(previousContent));
  return blocks.filter(b => !seen.has(sha1(b.text)));
}

export function renderBlocks(blocks: HtmlBlock[]): string {
  const lines: string[] = [];
  let current: string | null | undefined;
  for (const b of blocks) {
    if (b.heading !== current) {
      if (b.heading) lines.push(`## ${b.heading}`);
      current = b.heading;
    }
    lines.push(`- ${b.text}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/normalize.test.ts`
Expected: PASS. If the single-entry Atom test fails, check that `asArray` wraps `doc.feed.entry` and that `parseTagValue: false` is set.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/src/services/vendor-watch/normalize.ts server/src/services/vendor-watch/normalize.test.ts
git commit -m "feat(vendor-watch): parse and diff changelog feeds and pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OpenAPI diff and endpoint matching

**Files:**
- Create: `server/src/services/vendor-watch/openapi.ts`
- Create: `server/src/services/vendor-watch/endpoint-match.ts`
- Create: `server/src/services/vendor-watch/openapi-findings.ts`
- Test: `server/src/services/vendor-watch/openapi.test.ts`

**Interfaces:**
- Consumes:
  - `sha1`, `Normalized` from `normalize.ts` (Task 3)
  - `EndpointRef`, `FindingDraft` from `types.ts` (Task 1)
- Produces:
  - `parseSpec(body): unknown`, `isOpenApiDoc(doc): boolean`, `normalizePath(path): string`, `opKey(method, path): string`
  - `type OpMap = Record<string, { deprecated: boolean; params: { name, in, required }[] }>`
  - `buildOpMap(doc): OpMap`, `normalizeOpenApi(ops): Normalized`, `parseOpMap(content): OpMap`
  - `type OpenApiDiff = { removed: string[]; newlyDeprecated: string[]; newRequiredParams: {op, param}[]; added: string[] }`, `diffOpenApi(prev, next): OpenApiDiff`
  - `pathsMatch(a, b): boolean`, `targetsUsingOp(inventory, opKey): string[]`
  - `openApiFindings(diff, inventory, sourceUrl): FindingDraft[]`, `openApiBaselineFindings(ops, inventory, sourceUrl): FindingDraft[]`

- [ ] **Step 1: Write the failing tests**

`server/src/services/vendor-watch/openapi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSpec, isOpenApiDoc, normalizePath, buildOpMap, diffOpenApi, normalizeOpenApi, parseOpMap } from './openapi.js';
import { pathsMatch, targetsUsingOp } from './endpoint-match.js';
import { openApiFindings, openApiBaselineFindings } from './openapi-findings.js';
import type { EndpointRef } from './types.js';

const specV1 = {
  openapi: '3.0.0',
  paths: {
    '/v1/widgets/{widgetId}': {
      parameters: [{ $ref: '#/components/parameters/WidgetId' }],
      get: { parameters: [{ name: 'expand', in: 'query' }] },
      delete: {},
    },
    '/v1/orders': { get: {}, post: { requestBody: { required: true, content: {} } } },
  },
  components: { parameters: { WidgetId: { name: 'widgetId', in: 'path', required: true } } },
};

const specV2 = {
  openapi: '3.0.0',
  paths: {
    '/v1/widgets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: { deprecated: true, parameters: [{ name: 'expand', in: 'query' }] },
    },
    '/v1/orders': {
      get: { parameters: [{ $ref: '#/components/parameters/Cursor' }] },
      post: { requestBody: { required: true, content: {} } },
    },
    '/v1/invoices': { get: {} },
  },
  components: { parameters: { Cursor: { name: 'cursor', in: 'query', required: true } } },
};

const inventory: EndpointRef[] = [
  { target: 'delete_widget', target_kind: 'action', method: 'DELETE', path: '/widgets/${widgetId}' },
  { target: 'get_widget', target_kind: 'action', method: 'get', path: 'https://api.acme.dev/v1/widgets/:id' },
  { target: 'list_orders', target_kind: 'trigger', method: 'GET', path: '/v1/orders/' },
  { target: 'post_message', target_kind: 'action', method: 'SDK', path: 'sdk:@acme/sdk#messages.create' },
];

describe('parsing', () => {
  it('parses JSON and YAML specs and recognizes OpenAPI documents', () => {
    expect(isOpenApiDoc(parseSpec(JSON.stringify(specV1)))).toBe(true);
    const yaml = 'openapi: 3.1.0\npaths:\n  /v2/things:\n    get:\n      deprecated: true\n';
    expect(buildOpMap(parseSpec(yaml))).toEqual({ 'GET /v2/things': { deprecated: true, params: [] } });
    expect(isOpenApiDoc({ foo: 1 })).toBe(false);
    expect(isOpenApiDoc('openapi')).toBe(false);
  });

  it('normalizes path templates, base URLs, express params and trailing slashes', () => {
    expect(normalizePath('/v1/widgets/{widgetId}')).toBe('/v1/widgets/{}');
    expect(normalizePath('/widgets/${widgetId}/')).toBe('/widgets/{}');
    expect(normalizePath('https://api.acme.dev/v1/widgets/:id?x=1')).toBe('/v1/widgets/{}');
    expect(normalizePath('v1/things:batchGet')).toBe('/v1/things:batchGet');
  });

  it('resolves $ref and path-level parameters and records required request bodies', () => {
    const ops = buildOpMap(specV1);
    expect(ops['GET /v1/widgets/{}'].params).toEqual([
      { name: 'widgetId', in: 'path', required: true },
      { name: 'expand', in: 'query', required: false },
    ]);
    expect(ops['POST /v1/orders'].params).toEqual([{ name: '', in: 'body', required: true }]);
    expect(Object.keys(ops).sort()).toEqual(['DELETE /v1/widgets/{}', 'GET /v1/orders', 'GET /v1/widgets/{}', 'POST /v1/orders']);
  });

  it('round-trips an op map through its snapshot content with a stable hash', () => {
    const n = normalizeOpenApi(buildOpMap(specV1));
    expect(parseOpMap(n.content)).toEqual(buildOpMap(specV1));
    expect(normalizeOpenApi(parseOpMap(n.content)).hash).toBe(n.hash);
    expect(parseOpMap('not json')).toEqual({});
  });
});

describe('diffOpenApi', () => {
  it('finds removed, newly deprecated, new required (non-path) params and added operations', () => {
    expect(diffOpenApi(buildOpMap(specV1), buildOpMap(specV2))).toEqual({
      removed: ['DELETE /v1/widgets/{}'],
      newlyDeprecated: ['GET /v1/widgets/{}'],
      newRequiredParams: [{ op: 'GET /v1/orders', param: 'query:cursor' }],
      added: ['GET /v1/invoices'],
    });
  });
});

describe('endpoint matching', () => {
  it('matches by segment suffix and never on all-parameter paths or literal-vs-param', () => {
    expect(pathsMatch('/orders', '/v1/orders')).toBe(true);
    expect(pathsMatch('/v1/orders/', '/v1/orders')).toBe(true);
    expect(pathsMatch('/users/me', '/users/{id}')).toBe(false);
    expect(pathsMatch('/{id}', '/x/{y}')).toBe(false);
  });

  it('maps an operation to the targets that call it, ignoring SDK entries', () => {
    expect(targetsUsingOp(inventory, 'GET /v1/widgets/{}')).toEqual(['get_widget']);
    expect(targetsUsingOp(inventory, 'DELETE /v1/widgets/{}')).toEqual(['delete_widget']);
    expect(targetsUsingOp(inventory, 'POST /v1/orders')).toEqual([]);
  });
});

describe('openApiFindings', () => {
  it('turns a diff into findings: breaking/deprecation for used operations, one new_feature for additions', () => {
    const f = openApiFindings(diffOpenApi(buildOpMap(specV1), buildOpMap(specV2)), inventory, 'https://acme.dev/openapi.json');
    expect(f.map(x => [x.kind, x.severity, x.affected_targets, x.signature])).toEqual([
      ['breaking', 'high', ['delete_widget'], 'breaking|DELETE /v1/widgets/{}'],
      ['deprecation', 'high', ['get_widget'], 'deprecation|GET /v1/widgets/{}'],
      ['breaking', 'high', ['list_orders'], 'breaking|GET /v1/orders|query:cursor'],
      ['new_feature', 'low', [], expect.stringMatching(/^new_feature\|[0-9a-f]{40}$/)],
    ]);
    expect(f.every(x => x.evidence_verified && !x.is_baseline && x.evidence_url === 'https://acme.dev/openapi.json')).toBe(true);
    expect(f[3].title).toBe('1 new endpoint in the API');
  });

  it('reports changes to operations the piece does not use as low "other" findings', () => {
    const f = openApiFindings(diffOpenApi(buildOpMap(specV1), buildOpMap(specV2)), [], 'u');
    expect(f.filter(x => x.kind === 'other').map(x => x.severity)).toEqual(['low', 'low', 'low']);
    expect(f.some(x => x.kind === 'breaking' || x.kind === 'deprecation')).toBe(false);
  });

  it('on baseline, reports only deprecated operations the piece still calls', () => {
    const f = openApiBaselineFindings(buildOpMap(specV2), inventory, 'u');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'deprecation', severity: 'medium', affected_targets: ['get_widget'], is_baseline: true, signature: 'deprecation|GET /v1/widgets/{}' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/openapi.test.ts`
Expected: FAIL. The three modules do not exist yet.

- [ ] **Step 3: Implement `openapi.ts`**

`server/src/services/vendor-watch/openapi.ts`:

```ts
import { parse as parseYaml } from 'yaml';
import { sha1, type Normalized } from './normalize.js';

export interface OpParam {
  name: string;
  in: string;
  required: boolean;
}

export interface OpInfo {
  deprecated: boolean;
  params: OpParam[];
}

/** Key: "METHOD /normalized/{}/path". */
export type OpMap = Record<string, OpInfo>;

export interface OpenApiDiff {
  removed: string[];
  newlyDeprecated: string[];
  newRequiredParams: { op: string; param: string }[];
  added: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
type AnyObj = Record<string, any>;

export function parseSpec(body: string): unknown {
  const t = body.trim();
  return t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
}

export function isOpenApiDoc(doc: unknown): doc is { paths: Record<string, unknown> } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const d = doc as AnyObj;
  return ('openapi' in d || 'swagger' in d) && !!d.paths && typeof d.paths === 'object';
}

/** Drop host and query, turn every path parameter style ({x}, ${x}, :x) into {}, drop trailing slashes. */
export function normalizePath(path: string): string {
  let p = path.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = decodeURI(new URL(p).pathname);
    } catch {
      /* keep the raw string */
    }
  }
  p = p.split('?')[0].replace(/\$\{[^}]*\}|\{[^}]*\}|(?<=\/):[A-Za-z_]\w*(?=\/|$)/g, '{}');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function opKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function resolveRef(doc: AnyObj, v: any): any {
  if (!v || typeof v !== 'object' || typeof v.$ref !== 'string' || !v.$ref.startsWith('#/')) return v;
  const target = v.$ref
    .slice(2)
    .split('/')
    .reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  return target ?? v;
}

export function buildOpMap(doc: unknown): OpMap {
  const d = (doc ?? {}) as AnyObj;
  const out: OpMap = {};
  for (const [path, rawItem] of Object.entries<any>(d.paths ?? {})) {
    const item = resolveRef(d, rawItem) ?? {};
    const shared: any[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const params = new Map<string, OpParam>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = resolveRef(d, raw);
        if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
        params.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required === true || p.in === 'path' });
      }
      if (resolveRef(d, op.requestBody)?.required === true) params.set('body:', { name: '', in: 'body', required: true });
      out[opKey(m, path)] = {
        deprecated: op.deprecated === true,
        params: [...params.values()].sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`)),
      };
    }
  }
  return out;
}

export function normalizeOpenApi(ops: OpMap): Normalized {
  const sorted: OpMap = {};
  for (const k of Object.keys(ops).sort()) sorted[k] = ops[k];
  const content = JSON.stringify(sorted);
  return { hash: sha1(content), content };
}

export function parseOpMap(content: string): OpMap {
  try {
    const v = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Path parameters are skipped for "new required": renaming {id} → {customer_id} is not breaking. */
export function diffOpenApi(prev: OpMap, next: OpMap): OpenApiDiff {
  const has = (m: OpMap, k: string) => Object.prototype.hasOwnProperty.call(m, k);
  const removed = Object.keys(prev).filter(k => !has(next, k)).sort();
  const added = Object.keys(next).filter(k => !has(prev, k)).sort();
  const newlyDeprecated = Object.keys(next).filter(k => has(prev, k) && next[k].deprecated && !prev[k].deprecated).sort();
  const newRequiredParams: { op: string; param: string }[] = [];
  for (const k of Object.keys(next).sort()) {
    if (!has(prev, k)) continue;
    const before = new Set(prev[k].params.filter(p => p.required).map(p => `${p.in}:${p.name}`));
    for (const p of next[k].params) {
      const key = `${p.in}:${p.name}`;
      if (p.required && p.in !== 'path' && !before.has(key)) newRequiredParams.push({ op: k, param: key });
    }
  }
  return { removed, newlyDeprecated, newRequiredParams, added };
}
```

- [ ] **Step 4: Implement `endpoint-match.ts`**

`server/src/services/vendor-watch/endpoint-match.ts`:

```ts
import { normalizePath } from './openapi.js';
import type { EndpointRef } from './types.js';

/** Segment-wise suffix match, so an inventory path without the base path ('/orders') matches '/v1/orders'. */
export function pathsMatch(a: string, b: string): boolean {
  const sa = normalizePath(a).split('/').filter(Boolean);
  const sb = normalizePath(b).split('/').filter(Boolean);
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length === 0 || short.every(s => s === '{}')) return false;
  const tail = long.slice(long.length - short.length);
  return short.every((s, i) => s === tail[i]);
}

/** Inventory targets that call the operation "METHOD /path". SDK entries never match. */
export function targetsUsingOp(inventory: EndpointRef[], op: string): string[] {
  const space = op.indexOf(' ');
  const method = op.slice(0, space);
  const path = op.slice(space + 1);
  return [...new Set(
    inventory.filter(e => e.method.toUpperCase() === method && pathsMatch(e.path, path)).map(e => e.target),
  )];
}
```

- [ ] **Step 5: Implement `openapi-findings.ts`**

`server/src/services/vendor-watch/openapi-findings.ts`:

```ts
import { sha1 } from './normalize.js';
import { targetsUsingOp } from './endpoint-match.js';
import type { OpenApiDiff, OpMap } from './openapi.js';
import type { EndpointRef, FindingDraft, FindingKind, Severity } from './types.js';

const MAX_LISTED = 20;

function finding(
  kind: FindingKind, severity: Severity, targets: string[], title: string, summary: string,
  suggested: string, evidence: string, url: string, signature: string, isBaseline: boolean,
): FindingDraft {
  return {
    kind, severity, affected_targets: targets, effective_date: null, title: title.slice(0, 90), summary,
    suggested_action: suggested, evidence_url: url, evidence_excerpt: evidence, evidence_verified: true,
    is_baseline: isBaseline, signature,
  };
}

const who = (targets: string[]) => targets.map(t => `\`${t}\``).join(', ');

/** Deterministic findings from a spec diff. Changes to operations the piece calls are high; the rest are low. */
export function openApiFindings(diff: OpenApiDiff, inventory: EndpointRef[], sourceUrl: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const op of diff.removed) {
    const t = targetsUsingOp(inventory, op);
    out.push(t.length
      ? finding('breaking', 'high', t, `Endpoint removed: ${op}`,
        `The vendor's OpenAPI spec no longer has ${op}, which ${who(t)} call.`,
        'Find out whether the endpoint moved or was replaced, then update the affected targets.',
        op, sourceUrl, `breaking|${op}`, false)
      : finding('other', 'low', [], `Unused endpoint removed: ${op}`,
        `${op} was removed from the spec. The piece does not call it.`,
        'No action needed.', op, sourceUrl, `other|removed|${op}`, false));
  }
  for (const op of diff.newlyDeprecated) {
    const t = targetsUsingOp(inventory, op);
    out.push(t.length
      ? finding('deprecation', 'high', t, `Endpoint deprecated: ${op}`,
        `The vendor's OpenAPI spec now marks ${op} as deprecated; ${who(t)} call it.`,
        'Check the vendor changelog for the replacement and the removal date, then migrate the affected targets.',
        op, sourceUrl, `deprecation|${op}`, false)
      : finding('other', 'low', [], `Unused endpoint deprecated: ${op}`,
        `${op} is now deprecated. The piece does not call it.`,
        'No action needed.', op, sourceUrl, `other|deprecated|${op}`, false));
  }
  for (const { op, param } of diff.newRequiredParams) {
    const t = targetsUsingOp(inventory, op);
    out.push(t.length
      ? finding('breaking', 'high', t, `New required parameter on ${op}`,
        `${op} now requires ${param}; ${who(t)} call it.`,
        `Send ${param} from the affected targets, or confirm they already do.`,
        `${op} ${param}`, sourceUrl, `breaking|${op}|${param}`, false)
      : finding('other', 'low', [], `New required parameter on unused ${op}`,
        `${op} now requires ${param}. The piece does not call it.`,
        'No action needed.', `${op} ${param}`, sourceUrl, `other|param|${op}|${param}`, false));
  }
  if (diff.added.length) {
    const listed = diff.added.slice(0, MAX_LISTED);
    const more = diff.added.length - listed.length;
    out.push(finding('new_feature', 'low', [],
      `${diff.added.length} new endpoint${diff.added.length === 1 ? '' : 's'} in the API`,
      `New in the spec: ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
      'Consider whether any of these should become new actions or triggers.',
      listed.join('\n'), sourceUrl, `new_feature|${sha1(diff.added.join('\n'))}`, false));
  }
  return out;
}

/** First read of a spec: only operations that are already deprecated AND still called by the piece. */
export function openApiBaselineFindings(ops: OpMap, inventory: EndpointRef[], sourceUrl: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const [op, info] of Object.entries(ops)) {
    if (!info.deprecated) continue;
    const t = targetsUsingOp(inventory, op);
    if (!t.length) continue;
    out.push(finding('deprecation', 'medium', t, `Piece calls a deprecated endpoint: ${op}`,
      `The vendor's OpenAPI spec marks ${op} as deprecated, and ${who(t)} still call it.`,
      'Check the vendor docs for the replacement and plan the migration.',
      op, sourceUrl, `deprecation|${op}`, true));
  }
  return out;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/openapi.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/vendor-watch/openapi.ts server/src/services/vendor-watch/endpoint-match.ts server/src/services/vendor-watch/openapi-findings.ts server/src/services/vendor-watch/openapi.test.ts
git commit -m "feat(vendor-watch): diff OpenAPI specs against the piece's endpoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Finding rules and ticket text

**Files:**
- Create: `server/src/services/vendor-watch/findings.ts`
- Create: `server/src/services/vendor-watch/ticket-draft.ts`
- Test: `server/src/services/vendor-watch/findings.test.ts`
- Test: `server/src/services/vendor-watch/ticket-draft.test.ts`

**Interfaces:**
- Consumes:
  - from Task 3: `sha1`, `collapseWhitespace`
  - from Task 1: types `FINDING_KINDS`, `SEVERITIES`, `FindingDraft`, `SourceKind`, `EndpointRef`; row type `VendorFindingRow`; test util `sampleDraft`
- Produces:
  - `normalizeForMatch(s): string`, `classifierSignature(kind, targets, date, excerpt): string`
  - `validateClassifierFindings(raw: unknown, ctx: { sourceText; inventoryTargets: string[]; evidenceUrl; isBaseline }): FindingDraft[]`
  - `shouldAutoFile(f, sourceKind: SourceKind | null, config: { auto_file_enabled: number }): boolean`
  - `vendorDeadFinding(host, detail, failures, isBaseline, sourceUrl): FindingDraft`
  - `type TicketContext = { pieceDisplayName, pieceName, pieceVersion, inventory: EndpointRef[], sourceLabel, today: Date }`
  - `type TicketDraft = { title, description, priority }`, `PRIORITY_BY_SEVERITY`
  - `daysUntil(date, today)`, `describeEffectiveDate(date, today)`, `describeAffects(targets, inventory)`
  - `buildTicketDraft(f: VendorFindingRow, ctx, filedBy: 'auto'|'manual'): TicketDraft`, `buildCommentBody(f): string`

- [ ] **Step 1: Write the failing findings tests**

`server/src/services/vendor-watch/findings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateClassifierFindings, shouldAutoFile, vendorDeadFinding, classifierSignature } from './findings.js';
import { sampleDraft } from '../../db/vendor-watch-test-utils.js';

const text = 'Heads up!\n## 2026-09-01\n- The   Messages v1 API will be REMOVED on 2027-01-31. Please migrate to v2.';
const ctx = { sourceText: text, inventoryTargets: ['send_message', 'new_order'], evidenceUrl: 'https://acme.dev/changelog', isBaseline: false };
const raw = (over: Record<string, unknown> = {}) => ({
  kind: 'deprecation', severity: 'high', affected_targets: ['send_message'], effective_date: '2027-01-31',
  title: 'Messages v1 removed on 2027-01-31', summary: 's', suggested_action: 'a',
  evidence_excerpt: '"the messages v1 API will be removed on 2027-01-31"', ...over,
});

describe('validateClassifierFindings', () => {
  it('verifies an excerpt found in the text, ignoring case, quotes and whitespace', () => {
    const [f] = validateClassifierFindings([raw()], ctx);
    expect(f.evidence_verified).toBe(true);
    expect(f.evidence_url).toBe('https://acme.dev/changelog');
    expect(f.is_baseline).toBe(false);
  });

  it('does not verify an excerpt that is missing or too short', () => {
    expect(validateClassifierFindings([raw({ evidence_excerpt: 'Messages v2 is removed tomorrow' })], ctx)[0].evidence_verified).toBe(false);
    expect(validateClassifierFindings([raw({ evidence_excerpt: 'removed' })], ctx)[0].evidence_verified).toBe(false);
  });

  it('keeps only inventory targets, and * on its own', () => {
    expect(validateClassifierFindings([raw({ affected_targets: ['send_message', 'made_up'] })], ctx)[0].affected_targets).toEqual(['send_message']);
    expect(validateClassifierFindings([raw({ affected_targets: ['*', 'send_message'] })], ctx)[0].affected_targets).toEqual(['*']);
    expect(validateClassifierFindings([raw({ affected_targets: 'send_message' })], ctx)[0].affected_targets).toEqual([]);
  });

  it('drops findings with an unknown or reserved kind, a bad severity or no title', () => {
    expect(validateClassifierFindings([
      raw({ kind: 'vendor_dead' }), raw({ kind: 'nonsense' }), raw({ severity: 'urgent' }), raw({ title: '  ' }),
    ], ctx)).toEqual([]);
  });

  it('nulls impossible dates, caps the title, and returns [] for non-arrays', () => {
    const [f] = validateClassifierFindings([raw({ effective_date: '2027-02-30', title: 'x'.repeat(200) })], ctx);
    expect(f.effective_date).toBeNull();
    expect(f.title).toHaveLength(90);
    expect(validateClassifierFindings({ findings: [] }, ctx)).toEqual([]);
  });

  it('gives the same change the same signature, and a different date a different one', () => {
    const a = validateClassifierFindings([raw()], ctx)[0].signature;
    const b = validateClassifierFindings([raw({ title: 'Different words, same change' })], ctx)[0].signature;
    const c = validateClassifierFindings([raw({ effective_date: '2027-03-01' })], ctx)[0].signature;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(classifierSignature('deprecation', ['send_message'], '2027-01-31', '"the messages v1 API will be removed on 2027-01-31"'));
  });

  it('marks baseline findings', () => {
    expect(validateClassifierFindings([raw()], { ...ctx, isBaseline: true })[0].is_baseline).toBe(true);
  });
});

describe('shouldAutoFile', () => {
  const on = { auto_file_enabled: 1 };
  it.each([
    ['auto-file off', sampleDraft(), 'feed', { auto_file_enabled: 0 }, false],
    ['baseline', sampleDraft({ is_baseline: true }), 'feed', on, false],
    ['vendor dead', sampleDraft({ kind: 'vendor_dead', severity: 'critical', affected_targets: ['*'] }), 'liveness', on, true],
    ['verified high deprecation on a target', sampleDraft(), 'feed', on, true],
    ['critical breaking, whole piece', sampleDraft({ kind: 'breaking', severity: 'critical', affected_targets: ['*'] }), 'html', on, true],
    ['unverified, from a feed', sampleDraft({ evidence_verified: false }), 'feed', on, false],
    ['unverified, from an OpenAPI diff', sampleDraft({ evidence_verified: false }), 'openapi', on, true],
    ['medium severity', sampleDraft({ severity: 'medium' }), 'feed', on, false],
    ['new feature', sampleDraft({ kind: 'new_feature' }), 'feed', on, false],
    ['no targets', sampleDraft({ kind: 'breaking', affected_targets: [] }), 'feed', on, false],
  ] as const)('%s', (_name, draft, kind, config, expected) => {
    expect(shouldAutoFile(draft, kind, config)).toBe(expected);
  });
});

describe('vendorDeadFinding', () => {
  it('is a critical whole-piece finding keyed by host', () => {
    const f = vendorDeadFinding('api.acme.dev', 'DNS: api.acme.dev not found', 3, false, 'https://api.acme.dev/v1');
    expect(f).toMatchObject({ kind: 'vendor_dead', severity: 'critical', affected_targets: ['*'], signature: 'vendor_dead|api.acme.dev', evidence_verified: true, is_baseline: false });
    expect(f.summary).toContain('3 time(s) in a row');
  });
});
```

- [ ] **Step 2: Write the failing ticket-draft tests**

`server/src/services/vendor-watch/ticket-draft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTicketDraft, buildCommentBody, describeEffectiveDate, type TicketContext } from './ticket-draft.js';
import type { VendorFindingRow } from '../../db/vendor-watch-queries.js';

const row = (over: Partial<VendorFindingRow> = {}): VendorFindingRow => ({
  id: 7, plan_id: 1, piece_name: '@activepieces/piece-acme', source_id: 3, run_id: 2, kind: 'deprecation',
  severity: 'high', affects_piece: 1, affected_targets: '["send_message"]', effective_date: '2027-01-31',
  title: 'Messages v1 removed on 2027-01-31', summary: 'POST /v1/messages goes away.',
  suggested_action: 'Move send_message to /v2/messages.', evidence_url: 'https://acme.dev/changelog',
  evidence_excerpt: 'Messages v1 will be removed on 2027-01-31', evidence_verified: 1, is_baseline: 0, signature: 's',
  status: 'new', filed_by: null, linear_issue_id: null, linear_identifier: null, linear_url: null, file_error: '',
  created_at: '2026-10-06 04:00:00', updated_at: '2026-10-06 04:00:00', ...over,
});

const ctx: TicketContext = {
  pieceDisplayName: 'Acme', pieceName: '@activepieces/piece-acme', pieceVersion: '0.5.0',
  inventory: [{ target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' }],
  sourceLabel: 'Acme changelog', today: new Date('2026-10-06T12:00:00Z'),
};

describe('buildTicketDraft', () => {
  it('builds the title, body sections and priority', () => {
    const d = buildTicketDraft(row(), ctx, 'auto');
    expect(d.title).toBe('Acme: Messages v1 removed on 2027-01-31');
    expect(d.priority).toBe(2);
    expect(d.description).toContain('**Piece:** Acme (`@activepieces/piece-acme` 0.5.0)');
    expect(d.description).toContain('**What changed:** POST /v1/messages goes away.');
    expect(d.description).toContain('**Effective date:** 2027-01-31 (in 117 days)');
    expect(d.description).toContain('**Affects:** `send_message` (POST /v1/messages)');
    expect(d.description).toContain('**Suggested action:** Move send_message to /v2/messages.');
    expect(d.description).toContain('> Messages v1 will be removed on 2027-01-31');
    expect(d.description).toContain('Source: [Acme changelog](https://acme.dev/changelog) · seen 2026-10-06');
    expect(d.description).toContain('Finding #7 · deprecation · high · auto-filed');
  });

  it('says "filed by hand", "the whole piece" and maps critical/low priority', () => {
    expect(buildTicketDraft(row(), ctx, 'manual').description).toContain('filed by hand');
    expect(buildTicketDraft(row({ affected_targets: '["*"]' }), ctx, 'auto').description).toContain('**Affects:** the whole piece');
    expect(buildTicketDraft(row({ severity: 'critical' }), ctx, 'auto').priority).toBe(1);
    expect(buildTicketDraft(row({ severity: 'low' }), ctx, 'auto').priority).toBe(4);
  });

  it('caps the title at 120 characters', () => {
    expect(buildTicketDraft(row({ title: 'y'.repeat(300) }), ctx, 'auto').title).toHaveLength(120);
  });
});

describe('describeEffectiveDate', () => {
  const today = new Date('2026-10-06T23:30:00Z');
  it('handles future, past, today and missing dates', () => {
    expect(describeEffectiveDate('2026-10-07', today)).toBe('2026-10-07 (in 1 day)');
    expect(describeEffectiveDate('2026-10-01', today)).toBe('2026-10-01 (5 days ago)');
    expect(describeEffectiveDate('2026-10-06', today)).toBe('2026-10-06 (today)');
    expect(describeEffectiveDate(null, today)).toBe('not stated');
  });
});

describe('buildCommentBody', () => {
  it('names the finding and quotes the evidence', () => {
    const body = buildCommentBody(row());
    expect(body).toContain('Vendor watch saw this again');
    expect(body).toContain('finding #7');
    expect(body).toContain('> Messages v1 will be removed on 2027-01-31');
    expect(body).toContain('Source: https://acme.dev/changelog');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/findings.test.ts server/src/services/vendor-watch/ticket-draft.test.ts`
Expected: FAIL. The two modules do not exist yet.

- [ ] **Step 4: Implement `findings.ts`**

`server/src/services/vendor-watch/findings.ts`:

```ts
import { collapseWhitespace, sha1 } from './normalize.js';
import { FINDING_KINDS, SEVERITIES, type FindingDraft, type FindingKind, type Severity, type SourceKind } from './types.js';

const MIN_EXCERPT_CHARS = 12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercase, drop quote marks, collapse whitespace: how excerpts are compared with source text. */
export function normalizeForMatch(s: string): string {
  return collapseWhitespace(s.toLowerCase().replace(/[“”"'‘’`]/g, ''));
}

export function classifierSignature(kind: FindingKind, targets: string[], effectiveDate: string | null, excerpt: string): string {
  return sha1([kind, [...targets].sort().join(','), effectiveDate ?? '', normalizeForMatch(excerpt).slice(0, 120)].join('|'));
}

function asDate(v: unknown): string | null {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export interface ValidationContext {
  /** Exactly the text the classifier was shown. */
  sourceText: string;
  inventoryTargets: string[];
  evidenceUrl: string;
  isBaseline: boolean;
}

/**
 * Turn the classifier's raw tool input into drafts we can trust: known kinds/severities only
 * (vendor_dead is reserved for the liveness check), real targets only, real dates only, and
 * evidence_verified only when the quote is actually in the text.
 */
export function validateClassifierFindings(raw: unknown, ctx: ValidationContext): FindingDraft[] {
  if (!Array.isArray(raw)) return [];
  const haystack = normalizeForMatch(ctx.sourceText);
  const known = new Set(ctx.inventoryTargets);
  const out: FindingDraft[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const kind = (r as any).kind as FindingKind;
    const severity = (r as any).severity as Severity;
    if (!FINDING_KINDS.includes(kind) || kind === 'vendor_dead' || !SEVERITIES.includes(severity)) continue;
    const title = str((r as any).title, 90);
    if (!title) continue;
    const excerpt = str((r as any).evidence_excerpt, 300);
    const listed: unknown[] = Array.isArray((r as any).affected_targets) ? (r as any).affected_targets : [];
    const strings = listed.filter((t): t is string => typeof t === 'string');
    const targets = strings.includes('*') ? ['*'] : [...new Set(strings.filter(t => known.has(t)))];
    const effective_date = asDate((r as any).effective_date);
    const needle = normalizeForMatch(excerpt);
    out.push({
      kind, severity, affected_targets: targets, effective_date, title,
      summary: str((r as any).summary, 600),
      suggested_action: str((r as any).suggested_action, 300),
      evidence_url: ctx.evidenceUrl,
      evidence_excerpt: excerpt,
      evidence_verified: needle.length >= MIN_EXCERPT_CHARS && haystack.includes(needle),
      is_baseline: ctx.isBaseline,
      signature: classifierSignature(kind, targets, effective_date, excerpt),
    });
  }
  return out;
}

const BREAKAGE: ReadonlySet<FindingKind> = new Set(['breaking', 'deprecation', 'auth_change']);

/** The spec's auto-file rule (§4). Everything that fails it waits in the inbox. */
export function shouldAutoFile(
  f: Pick<FindingDraft, 'kind' | 'severity' | 'affected_targets' | 'evidence_verified' | 'is_baseline'>,
  sourceKind: SourceKind | null,
  config: { auto_file_enabled: number },
): boolean {
  if (!config.auto_file_enabled || f.is_baseline) return false;
  if (f.kind === 'vendor_dead') return true;
  if (!BREAKAGE.has(f.kind) || f.affected_targets.length === 0) return false;
  if (f.severity !== 'critical' && f.severity !== 'high') return false;
  return f.evidence_verified || sourceKind === 'openapi';
}

export function vendorDeadFinding(host: string, detail: string, failures: number, isBaseline: boolean, sourceUrl: string): FindingDraft {
  return {
    kind: 'vendor_dead',
    severity: 'critical',
    affected_targets: ['*'],
    effective_date: null,
    title: `Vendor API host ${host} is unreachable`,
    summary: `${host} failed the liveness check ${failures} time(s) in a row (${detail}). The vendor may have shut down or moved its API.`,
    suggested_action: 'Confirm the vendor is gone (DNS, status page, news). If it is, deprecate the piece (deprecated: true on createPiece + version bump); if the API moved, update the base URL.',
    evidence_url: sourceUrl,
    evidence_excerpt: detail,
    evidence_verified: true,
    is_baseline: isBaseline,
    signature: `vendor_dead|${host}`,
  };
}
```

- [ ] **Step 5: Implement `ticket-draft.ts`**

`server/src/services/vendor-watch/ticket-draft.ts`:

```ts
import { parseTargets, type VendorFindingRow } from '../../db/vendor-watch-queries.js';
import type { EndpointRef, Severity } from './types.js';

export interface TicketContext {
  pieceDisplayName: string;
  pieceName: string;
  pieceVersion: string;
  inventory: EndpointRef[];
  sourceLabel: string;
  today: Date;
}

export interface TicketDraft {
  title: string;
  description: string;
  priority: number;
}

/** Linear priority: 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const PRIORITY_BY_SEVERITY: Record<Severity, number> = { critical: 1, high: 2, medium: 3, low: 4 };

export function daysUntil(date: string, today: Date): number {
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86_400_000);
}

export function describeEffectiveDate(date: string | null, today: Date): string {
  if (!date) return 'not stated';
  const d = daysUntil(date, today);
  if (d === 0) return `${date} (today)`;
  const n = Math.abs(d);
  const unit = `day${n === 1 ? '' : 's'}`;
  return d > 0 ? `${date} (in ${n} ${unit})` : `${date} (${n} ${unit} ago)`;
}

export function describeAffects(targets: string[], inventory: EndpointRef[]): string {
  if (targets.includes('*')) return 'the whole piece';
  if (targets.length === 0) return 'nothing the piece uses';
  return targets.map(t => {
    const calls = inventory.filter(e => e.target === t).map(e => `${e.method} ${e.path}`);
    return calls.length ? `\`${t}\` (${calls.join(', ')})` : `\`${t}\``;
  }).join(', ');
}

export function buildTicketDraft(f: VendorFindingRow, ctx: TicketContext, filedBy: 'auto' | 'manual'): TicketDraft {
  const seen = f.created_at.slice(0, 10);
  const lines = [
    '**Vendor change found by Piece Tester vendor watch**',
    '',
    `**Piece:** ${ctx.pieceDisplayName} (\`${ctx.pieceName}\` ${ctx.pieceVersion})`,
    `**What changed:** ${f.summary || f.title}`,
    `**Effective date:** ${describeEffectiveDate(f.effective_date, ctx.today)}`,
    `**Affects:** ${describeAffects(parseTargets(f.affected_targets), ctx.inventory)}`,
    `**Suggested action:** ${f.suggested_action || 'Check the source and decide whether the piece needs a change.'}`,
    '',
  ];
  if (f.evidence_excerpt) lines.push(`> ${f.evidence_excerpt.replace(/\s*\n\s*/g, ' ')}`, '');
  lines.push(f.evidence_url ? `Source: [${ctx.sourceLabel || f.evidence_url}](${f.evidence_url}) · seen ${seen}` : `Seen ${seen}`);
  lines.push(`Finding #${f.id} · ${f.kind} · ${f.severity} · ${filedBy === 'auto' ? 'auto-filed' : 'filed by hand'}`);
  return {
    title: `${ctx.pieceDisplayName}: ${f.title}`.slice(0, 120),
    description: lines.join('\n'),
    priority: PRIORITY_BY_SEVERITY[f.severity] ?? 3,
  };
}

export function buildCommentBody(f: VendorFindingRow): string {
  const lines = [`**Vendor watch saw this again** (finding #${f.id}, ${f.severity})`, '', f.summary || f.title];
  if (f.evidence_excerpt) lines.push('', `> ${f.evidence_excerpt.replace(/\s*\n\s*/g, ' ')}`);
  if (f.evidence_url) lines.push('', `Source: ${f.evidence_url}`);
  return lines.join('\n');
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/findings.test.ts server/src/services/vendor-watch/ticket-draft.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/vendor-watch/findings.ts server/src/services/vendor-watch/ticket-draft.ts server/src/services/vendor-watch/findings.test.ts server/src/services/vendor-watch/ticket-draft.test.ts
git commit -m "feat(vendor-watch): add finding validation, auto-file rule and ticket text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Classifier

**Files:**
- Modify: `server/src/services/anthropic-client.ts` (export a `MessagesClient` type)
- Create: `server/src/services/vendor-watch/classifier.ts`
- Test: `server/src/services/vendor-watch/classifier.test.ts`

**Interfaces:**
- Consumes:
  - from Task 5: `validateClassifierFindings`
  - from Task 1: `EndpointRef`, `FindingDraft`, `SourceKind`
  - existing: `calculateCost`, `extractUsage`, `CostTracker` from `agents/v2/cost-tracker.ts`; `getSettings` from `db/queries.ts`; `buildAnthropicClientOptions`
- Produces:
  - `type MessagesClient = { messages: { create(body, opts?) => Promise<any> } }` (in `anthropic-client.ts`; Task 10 reuses it)
  - `MAX_CLASSIFIER_CHARS = 15_000`, `capText(text, max?) → { text, truncated }`
  - `type ClassifyInput = { pieceName, pieceDisplayName, vendorName, apiVersion, authType, inventory, source: { label, url, kind }, mode: 'change'|'baseline', text, today }`
  - `type ClassifyResult = { findings: FindingDraft[]; costUsd: number }`
  - `buildClassifierPrompt(input): string`
  - `classifyChange(input, deps?: { client?, model?, costTracker? }): Promise<ClassifyResult>`

- [ ] **Step 1: Export the `MessagesClient` type**

Append to `server/src/services/anthropic-client.ts`:

```ts
/** The one SDK surface the agent runner and the vendor-watch classifier use. Lets tests inject a fake. */
export type MessagesClient = { messages: { create: (body: any, opts?: any) => Promise<any> } };
```

- [ ] **Step 2: Write the failing tests**

`server/src/services/vendor-watch/classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyChange, buildClassifierPrompt, MAX_CLASSIFIER_CHARS, type ClassifyInput } from './classifier.js';
import type { MessagesClient } from '../anthropic-client.js';

const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  pieceName: '@activepieces/piece-acme', pieceDisplayName: 'Acme', vendorName: 'Acme', apiVersion: 'v1', authType: 'API key',
  inventory: [{ target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' }],
  source: { label: 'Acme changelog', url: 'https://acme.dev/changelog', kind: 'feed' },
  mode: 'change', text: '## Sunset\nPOST /v1/messages will be removed on 2027-01-31.', today: '2026-10-06', ...over,
});

function fake(response: any): { client: MessagesClient; calls: any[] } {
  const calls: any[] = [];
  return { calls, client: { messages: { create: async (body: any) => { calls.push(body); return response; } } } };
}

const reply = (findings: unknown[]) => ({
  stop_reason: 'tool_use',
  usage: { input_tokens: 1000, output_tokens: 200 },
  content: [{ type: 'tool_use', id: 't1', name: 'report_findings', input: { findings } }],
});

const finding = {
  kind: 'breaking', severity: 'high', affected_targets: ['send_message'], effective_date: '2027-01-31',
  title: 'Messages v1 removed', summary: 's', suggested_action: 'a',
  evidence_excerpt: 'POST /v1/messages will be removed on 2027-01-31',
};

describe('classifyChange', () => {
  it('forces the report_findings tool and returns validated findings with their cost', async () => {
    const { client, calls } = fake(reply([finding]));
    const r = await classifyChange(input(), { client, model: 'claude-haiku-4-5' });
    expect(calls[0].model).toBe('claude-haiku-4-5');
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'report_findings' });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'breaking', evidence_verified: true, is_baseline: false, evidence_url: 'https://acme.dev/changelog' });
    expect(r.costUsd).toBeCloseTo(0.002);
  });

  it('tells the model when it is reading a baseline, and marks the findings', async () => {
    const { client, calls } = fake(reply([finding]));
    const r = await classifyChange(input({ mode: 'baseline' }), { client });
    expect(calls[0].messages[0].content).toContain('FIRST read');
    expect(r.findings[0].is_baseline).toBe(true);
  });

  it('throws when the model does not call the tool or is cut off', async () => {
    await expect(classifyChange(input(), { client: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }).client })).rejects.toThrow(/report_findings/);
    await expect(classifyChange(input(), { client: fake({ ...reply([]), stop_reason: 'max_tokens' }).client })).rejects.toThrow(/truncated/);
  });

  it('caps oversized text and only verifies evidence inside what the model saw', async () => {
    const long = `${'A'.repeat(MAX_CLASSIFIER_CHARS + 5000)} POST /v1/messages will be removed on 2027-01-31`;
    const prompt = buildClassifierPrompt(input({ text: long }));
    expect(prompt).toContain(`cut at ${MAX_CLASSIFIER_CHARS} characters`);
    expect(prompt).not.toContain('will be removed on 2027-01-31');
    const { client } = fake(reply([finding]));
    const r = await classifyChange(input({ text: long }), { client });
    expect(r.findings[0].evidence_verified).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/classifier.test.ts`
Expected: FAIL. `./classifier.js` does not exist yet.

- [ ] **Step 4: Implement `classifier.ts`**

`server/src/services/vendor-watch/classifier.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { buildAnthropicClientOptions, type MessagesClient } from '../anthropic-client.js';
import { calculateCost, extractUsage, type CostTracker } from '../../agents/v2/cost-tracker.js';
import { getSettings } from '../../db/queries.js';
import { validateClassifierFindings } from './findings.js';
import type { EndpointRef, FindingDraft, SourceKind } from './types.js';

export const MAX_CLASSIFIER_CHARS = 15_000;

export interface ClassifyInput {
  pieceName: string;
  pieceDisplayName: string;
  vendorName: string;
  apiVersion: string;
  authType: string;
  inventory: EndpointRef[];
  source: { label: string; url: string; kind: SourceKind };
  mode: 'change' | 'baseline';
  text: string;
  /** YYYY-MM-DD */
  today: string;
}

export interface ClassifyResult {
  findings: FindingDraft[];
  costUsd: number;
}

export function capText(text: string, max = MAX_CLASSIFIER_CHARS): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

const REPORT_TOOL = {
  name: 'report_findings',
  description: 'Report every vendor change in the text that matters to this piece. Report an empty list when nothing does.',
  input_schema: {
    type: 'object' as const,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['breaking', 'deprecation', 'auth_change', 'new_feature', 'other'] },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            affected_targets: {
              type: 'array', items: { type: 'string' },
              description: 'Target names from the inventory this change hits; ["*"] when it hits every target (auth, base URL, API version, shutdown); [] when it hits nothing the piece uses.',
            },
            effective_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when the change takes effect, or null if the text gives no date.' },
            title: { type: 'string', description: 'At most 90 characters, plain words, e.g. "Conversations API v1 sunsets on 2027-03-01".' },
            summary: { type: 'string', description: 'At most 600 characters: what changes and what it means for this piece.' },
            suggested_action: { type: 'string', description: 'One sentence: what the Pieces team should do.' },
            evidence_excerpt: { type: 'string', description: 'A VERBATIM quote of at most 300 characters, copied from the text, that proves this finding.' },
          },
          required: ['kind', 'severity', 'affected_targets', 'effective_date', 'title', 'summary', 'suggested_action', 'evidence_excerpt'],
        },
      },
    },
    required: ['findings'],
  },
};

export const CLASSIFIER_SYSTEM = `You read vendor API changelogs for the Activepieces Pieces team and decide which changes matter to one piece.

A piece is an integration: its actions and triggers call the vendor endpoints listed in its endpoint inventory. Your job is to catch changes that will BREAK the piece before customers notice.

Kinds:
- breaking: something the piece relies on stops working or changes shape (endpoint removed, field removed or renamed, new required parameter, API version sunset, vendor shutting down).
- deprecation: something is deprecated or scheduled for removal but still works today.
- auth_change: authentication changes (scopes, token format, OAuth endpoints, API key retirement).
- new_feature: new endpoints or capabilities the piece could add.
- other: a real change that is none of the above.

Severity:
- critical: the vendor is shutting down, or something the piece uses stops working within 30 days of today or already has.
- high: something the piece uses is removed or breaks on a stated date more than 30 days out, or is already deprecated.
- medium: a deprecation with no date, or a change to an endpoint the piece uses that may change its output.
- low: a new feature, or a change to something the piece does not use.

Rules:
- Match changes to the inventory by endpoint path, SDK method name or feature name, and put the matching target names in affected_targets. Use ["*"] only for changes that hit every target (auth, base URL, API version, vendor shutdown).
- evidence_excerpt MUST be copied word for word from the text. Never paraphrase it.
- Marketing posts, docs typo fixes, UI-only changes and changes to products the piece does not call are NOT findings. An empty list is the normal answer.
- One finding per distinct change.`;

const BASELINE_NOTE = 'This is the FIRST read of this source, so the text is history, not news. Report only deprecations, sunsets, breaking changes and auth changes that are still upcoming or took effect in the last 90 days. Do not report new features or anything older.';

export function buildClassifierPrompt(input: ClassifyInput): string {
  const { text, truncated } = capText(input.text);
  const inventory = input.inventory.length
    ? input.inventory.map(e => `- ${e.target} (${e.target_kind}): ${e.method} ${e.path}`).join('\n')
    : '- (no endpoint inventory)';
  return [
    `Today: ${input.today}`,
    `Piece: ${input.pieceDisplayName} (${input.pieceName})`,
    `Vendor: ${input.vendorName || 'unknown'} · API version: ${input.apiVersion || 'unknown'} · Auth: ${input.authType || 'unknown'}`,
    '',
    'Endpoint inventory:',
    inventory,
    '',
    `Source: ${input.source.label || input.source.kind} — ${input.source.url}`,
    input.mode === 'baseline' ? BASELINE_NOTE : 'This text is NEW since the last check.',
    '',
    '<text>',
    text,
    '</text>',
    truncated ? `(The text was cut at ${MAX_CLASSIFIER_CHARS} characters.)` : '',
  ].join('\n');
}

/** One Claude call over the new text of one source. Throws on a missing/truncated tool call so the caller keeps the old snapshot. */
export async function classifyChange(
  input: ClassifyInput,
  deps: { client?: MessagesClient; model?: string; costTracker?: CostTracker } = {},
): Promise<ClassifyResult> {
  const settings = getSettings();
  if (!deps.client && !settings.anthropic_api_key) throw new Error('Anthropic API key not configured. Go to Settings to add it.');
  const client: MessagesClient = deps.client
    ?? (new Anthropic(buildAnthropicClientOptions(settings.anthropic_api_key)) as unknown as MessagesClient);
  const model = deps.model || settings.ai_model || 'claude-sonnet-4-6';

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: CLASSIFIER_SYSTEM,
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: REPORT_TOOL.name },
    messages: [{ role: 'user', content: buildClassifierPrompt(input) }],
  });
  deps.costTracker?.trackResponse(model, response, 'vendor_watch_classifier');
  const costUsd = calculateCost(model, extractUsage(response));

  if (response?.stop_reason === 'max_tokens') throw new Error('Classifier output was truncated');
  const call = (response?.content ?? []).find((b: any) => b?.type === 'tool_use' && b?.name === REPORT_TOOL.name);
  if (!call) throw new Error('Classifier returned no report_findings call');

  const findings = validateClassifierFindings(call.input?.findings, {
    sourceText: capText(input.text).text,
    inventoryTargets: input.inventory.map(e => e.target),
    evidenceUrl: input.source.url,
    isBaseline: input.mode === 'baseline',
  });
  return { findings, costUsd };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/classifier.test.ts`
Expected: PASS. Haiku pricing is $1/M input and $5/M output, so 1000 input + 200 output tokens = $0.002.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/anthropic-client.ts server/src/services/vendor-watch/classifier.ts server/src/services/vendor-watch/classifier.test.ts
git commit -m "feat(vendor-watch): classify changed changelog text against the piece's endpoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Linear filer

**Files:**
- Modify: `server/src/services/bug-trend/linear-client.ts` (export `linearQuery`)
- Create: `server/src/services/vendor-watch/linear-filer.ts`
- Test: `server/src/services/vendor-watch/linear-filer.test.ts`

**Interfaces:**
- Consumes: existing `linearQuery<T>(apiKey, query, variables?)` and `LinearError` from `bug-trend/linear-client.ts`.
- Produces:
  - `type LinearQueryFn = <T>(apiKey: string, query: string, variables?: Record<string, unknown>) => Promise<T>`
  - `type LinearTargets = { teamId, stateId, stateName, labelId, labelName }`
  - `resolveLinearTargets(apiKey, teamKey, labelName, q?, now?): Promise<LinearTargets>`, `clearLinearTargetCache()`
  - `createLinearIssue(apiKey, targets, { title, description, priority }, q?): Promise<{ id, identifier, url }>`
  - `addLinearComment(apiKey, issueId, body, q?): Promise<void>`

- [ ] **Step 1: Export `linearQuery`**

In `server/src/services/bug-trend/linear-client.ts`, change:

```ts
async function linearQuery<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
```

to:

```ts
export async function linearQuery<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
```

- [ ] **Step 2: Write the failing tests**

`server/src/services/vendor-watch/linear-filer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveLinearTargets, createLinearIssue, addLinearComment, clearLinearTargetCache, type LinearQueryFn } from './linear-filer.js';

type Handler = (variables: any) => unknown;

function fakeLinear(handlers: Record<string, Handler>) {
  const calls: { op: string; variables: any }[] = [];
  const q = (async (_key: string, query: string, variables: any = {}) => {
    const op = Object.keys(handlers).find(name => query.includes(name));
    if (!op) throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    calls.push({ op, variables });
    return handlers[op](variables);
  }) as unknown as LinearQueryFn;
  return { q, calls };
}

const team = { teams: { nodes: [{ id: 'team-1', key: 'PIE', states: { nodes: [
  { id: 'st-b', name: 'Backlog', type: 'backlog' }, { id: 'st-t', name: 'Triage', type: 'triage' },
] } }] } };

describe('resolveLinearTargets', () => {
  beforeEach(clearLinearTargetCache);

  it('picks the triage state and prefers the team label over a workspace label', async () => {
    const { q } = fakeLinear({
      VendorWatchTeam: () => team,
      VendorWatchLabel: () => ({ issueLabels: { nodes: [
        { id: 'lab-ws', name: 'vendor-watch', team: null },
        { id: 'lab-other', name: 'vendor-watch', team: { id: 'team-9' } },
        { id: 'lab-team', name: 'vendor-watch', team: { id: 'team-1' } },
      ] } }),
    });
    expect(await resolveLinearTargets('k', 'PIE', 'vendor-watch', q)).toEqual({
      teamId: 'team-1', stateId: 'st-t', stateName: 'Triage', labelId: 'lab-team', labelName: 'vendor-watch',
    });
  });

  it('falls back to backlog and to a workspace label', async () => {
    const { q } = fakeLinear({
      VendorWatchTeam: () => ({ teams: { nodes: [{ id: 'team-1', key: 'PIE', states: { nodes: [{ id: 'st-b', name: 'Backlog', type: 'backlog' }] } }] } }),
      VendorWatchLabel: () => ({ issueLabels: { nodes: [{ id: 'lab-ws', name: 'vendor-watch', team: null }] } }),
    });
    const t = await resolveLinearTargets('k', 'PIE', 'vendor-watch', q);
    expect(t).toMatchObject({ stateId: 'st-b', labelId: 'lab-ws' });
  });

  it('says exactly what is missing', async () => {
    const noLabel = fakeLinear({ VendorWatchTeam: () => team, VendorWatchLabel: () => ({ issueLabels: { nodes: [] } }) });
    await expect(resolveLinearTargets('k', 'PIE', 'vendor-watch', noLabel.q)).rejects.toThrow("Label 'vendor-watch' not found in PIE — create it in Linear");
    clearLinearTargetCache();
    const noTeam = fakeLinear({ VendorWatchTeam: () => ({ teams: { nodes: [] } }) });
    await expect(resolveLinearTargets('k', 'NOPE', 'vendor-watch', noTeam.q)).rejects.toThrow("Linear team 'NOPE' not found");
    await expect(resolveLinearTargets('', 'PIE', 'vendor-watch', noTeam.q)).rejects.toThrow(/No Linear API key/);
  });

  it('caches the answer for an hour', async () => {
    const { q, calls } = fakeLinear({
      VendorWatchTeam: () => team,
      VendorWatchLabel: () => ({ issueLabels: { nodes: [{ id: 'lab-ws', name: 'vendor-watch', team: null }] } }),
    });
    await resolveLinearTargets('k', 'PIE', 'vendor-watch', q, 1_000);
    await resolveLinearTargets('k', 'PIE', 'vendor-watch', q, 1_000 + 59 * 60_000);
    expect(calls).toHaveLength(2);
    await resolveLinearTargets('k', 'PIE', 'vendor-watch', q, 1_000 + 61 * 60_000);
    expect(calls).toHaveLength(4);
  });
});

describe('createLinearIssue / addLinearComment', () => {
  const targets = { teamId: 'team-1', stateId: 'st-t', stateName: 'Triage', labelId: 'lab-1', labelName: 'vendor-watch' };

  it('creates the issue in the triage state with only the vendor-watch label', async () => {
    const { q, calls } = fakeLinear({
      VendorWatchCreateIssue: () => ({ issueCreate: { success: true, issue: { id: 'iss-1', identifier: 'PIE-900', url: 'https://linear.app/x/PIE-900' } } }),
    });
    const issue = await createLinearIssue('k', targets, { title: 'T', description: 'D', priority: 2 }, q);
    expect(issue).toEqual({ id: 'iss-1', identifier: 'PIE-900', url: 'https://linear.app/x/PIE-900' });
    expect(calls[0].variables.input).toEqual({ teamId: 'team-1', stateId: 'st-t', labelIds: ['lab-1'], title: 'T', description: 'D', priority: 2 });
  });

  it('throws when Linear reports no success', async () => {
    const { q } = fakeLinear({ VendorWatchCreateIssue: () => ({ issueCreate: { success: false, issue: null } }) });
    await expect(createLinearIssue('k', targets, { title: 'T', description: 'D', priority: 2 }, q)).rejects.toThrow(/did not create/);
  });

  it('adds a comment', async () => {
    const { q, calls } = fakeLinear({ VendorWatchComment: () => ({ commentCreate: { success: true } }) });
    await addLinearComment('k', 'iss-1', 'again', q);
    expect(calls[0].variables.input).toEqual({ issueId: 'iss-1', body: 'again' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/linear-filer.test.ts`
Expected: FAIL. `./linear-filer.js` does not exist yet.

- [ ] **Step 4: Implement `linear-filer.ts`**

`server/src/services/vendor-watch/linear-filer.ts`:

```ts
import { linearQuery, LinearError } from '../bug-trend/linear-client.js';

export type LinearQueryFn = <T>(apiKey: string, query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface LinearTargets {
  teamId: string;
  stateId: string;
  stateName: string;
  labelId: string;
  labelName: string;
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

const TEAM_QUERY = `query VendorWatchTeam($key: String!) {
  teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type } } } }
}`;

const LABEL_QUERY = `query VendorWatchLabel($name: String!) {
  issueLabels(filter: { name: { eq: $name } }) { nodes { id name team { id } } }
}`;

const CREATE_ISSUE = `mutation VendorWatchCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

const CREATE_COMMENT = `mutation VendorWatchComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; targets: LinearTargets }>();

export function clearLinearTargetCache(): void {
  cache.clear();
}

/** Team id, its Triage state (else Backlog), and the label by exact name (team label first, then workspace). */
export async function resolveLinearTargets(
  apiKey: string, teamKey: string, labelName: string, q: LinearQueryFn = linearQuery, now = Date.now(),
): Promise<LinearTargets> {
  if (!apiKey) throw new LinearError('No Linear API key saved. Add one in Settings (Bug Trend card).');
  const key = `${teamKey}|${labelName}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.targets;

  const t = await q<{ teams: { nodes: { id: string; states: { nodes: { id: string; name: string; type: string }[] } }[] } }>(
    apiKey, TEAM_QUERY, { key: teamKey });
  const team = t.teams.nodes[0];
  if (!team) throw new LinearError(`Linear team '${teamKey}' not found`);
  const state = team.states.nodes.find(s => s.type === 'triage') ?? team.states.nodes.find(s => s.type === 'backlog');
  if (!state) throw new LinearError(`Linear team '${teamKey}' has no Triage or Backlog state`);

  const l = await q<{ issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] } }>(
    apiKey, LABEL_QUERY, { name: labelName });
  const label = l.issueLabels.nodes.find(n => n.team?.id === team.id) ?? l.issueLabels.nodes.find(n => !n.team);
  if (!label) throw new LinearError(`Label '${labelName}' not found in ${teamKey} — create it in Linear`);

  const targets = { teamId: team.id, stateId: state.id, stateName: state.name, labelId: label.id, labelName: label.name };
  cache.set(key, { at: now, targets });
  return targets;
}

export async function createLinearIssue(
  apiKey: string, targets: LinearTargets, issue: { title: string; description: string; priority: number }, q: LinearQueryFn = linearQuery,
): Promise<CreatedIssue> {
  const r = await q<{ issueCreate: { success: boolean; issue: CreatedIssue | null } }>(apiKey, CREATE_ISSUE, {
    input: {
      teamId: targets.teamId, stateId: targets.stateId, labelIds: [targets.labelId],
      title: issue.title, description: issue.description, priority: issue.priority,
    },
  });
  if (!r.issueCreate.success || !r.issueCreate.issue) throw new LinearError('Linear did not create the issue');
  return r.issueCreate.issue;
}

export async function addLinearComment(apiKey: string, issueId: string, body: string, q: LinearQueryFn = linearQuery): Promise<void> {
  const r = await q<{ commentCreate: { success: boolean } }>(apiKey, CREATE_COMMENT, { input: { issueId, body } });
  if (!r.commentCreate.success) throw new LinearError('Linear did not add the comment');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/linear-filer.test.ts server/src/services/bug-trend`
Expected: PASS. This includes the existing bug-trend tests, since `linear-client.ts` changed.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/bug-trend/linear-client.ts server/src/services/vendor-watch/linear-filer.ts server/src/services/vendor-watch/linear-filer.test.ts
git commit -m "feat(vendor-watch): file issues and comments in Linear" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Filing and the watch runner

**Files:**
- Create: `server/src/services/vendor-watch/filing.ts`
- Create: `server/src/services/vendor-watch/runner.ts`
- Test: `server/src/services/vendor-watch/filing.test.ts`
- Test: `server/src/services/vendor-watch/runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7, plus `getSettings`/`updateSettings` from `db/queries.ts` and `CostTracker`.
- Produces:
  - `type FilingPreview = { draft: TicketDraft; mode: 'create'|'comment'; existing: { linear_identifier, linear_url } | null }`
  - `previewFiling(findingId, today?): FilingPreview`
  - `fileFinding(findingId, { filedBy, override?, query?, today? }): Promise<VendorFindingRow>`
  - `type RunnerDeps = { fetch, liveness, classify, file, today }`
  - `type RunHandle = { runId: number; done: Promise<WatchRunRow> }`
  - `startWatchRun(planId, trigger, { cycleId?, deps? }): RunHandle`

- [ ] **Step 1: Write the failing filing tests**

`server/src/services/vendor-watch/filing.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { updateSettings } from '../../db/queries.js';
import { beginPlanGeneration, completePlanGeneration, insertFinding, getFinding, replaceSources } from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult, sampleDraft } from '../../db/vendor-watch-test-utils.js';
import { clearLinearTargetCache, type LinearQueryFn } from './linear-filer.js';
import { fileFinding, previewFiling } from './filing.js';

function fakeLinear(opts: { label?: boolean } = {}) {
  const calls: { op: string; variables: any }[] = [];
  const q = (async (_key: string, query: string, variables: any = {}) => {
    const op = ['VendorWatchTeam', 'VendorWatchLabel', 'VendorWatchCreateIssue', 'VendorWatchComment'].find(n => query.includes(n))!;
    calls.push({ op, variables });
    if (op === 'VendorWatchTeam') return { teams: { nodes: [{ id: 'team-1', key: 'PIE', states: { nodes: [{ id: 'st-t', name: 'Triage', type: 'triage' }] } }] } };
    if (op === 'VendorWatchLabel') return { issueLabels: { nodes: opts.label === false ? [] : [{ id: 'lab-1', name: 'vendor-watch', team: { id: 'team-1' } }] } };
    if (op === 'VendorWatchCreateIssue') return { issueCreate: { success: true, issue: { id: 'iss-1', identifier: 'PIE-900', url: 'https://linear.app/x/PIE-900' } } };
    return { commentCreate: { success: true } };
  }) as unknown as LinearQueryFn;
  return { q, calls };
}

function setup() {
  const p = beginPlanGeneration('@activepieces/piece-acme');
  const plan = completePlanGeneration(p.id, samplePlanResult());
  const [src] = replaceSources(plan.id, [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'Acme changelog' }]);
  const add = (signature: string, over = {}) =>
    insertFinding({ plan_id: plan.id, piece_name: plan.piece_name, source_id: src.id, run_id: null, draft: sampleDraft({ signature, ...over }) })!;
  return { plan, add };
}

describe('fileFinding', () => {
  beforeEach(() => { resetVendorWatch(); clearLinearTargetCache(); updateSettings({ linear_api_key: 'lin_test' }); });
  afterEach(() => updateSettings({ linear_api_key: '' }));

  it('creates a ticket and marks the finding filed', async () => {
    const { add } = setup();
    const f = add('a');
    const { q, calls } = fakeLinear();
    const filed = await fileFinding(f.id, { filedBy: 'auto', query: q });
    expect(filed).toMatchObject({ status: 'filed', filed_by: 'auto', linear_identifier: 'PIE-900', linear_issue_id: 'iss-1', file_error: '' });
    const create = calls.find(c => c.op === 'VendorWatchCreateIssue')!;
    expect(create.variables.input).toMatchObject({ teamId: 'team-1', stateId: 'st-t', labelIds: ['lab-1'], priority: 2 });
    expect(create.variables.input.title).toBe('Acme: Messages v1 is deprecated');
    expect(create.variables.input.description).toContain('Source: [Acme changelog](https://acme.dev/changelog)');
  });

  it('comments on the open ticket for an overlapping finding of the same kind', async () => {
    const { add } = setup();
    const { q, calls } = fakeLinear();
    await fileFinding(add('a').id, { filedBy: 'auto', query: q });
    const second = await fileFinding(add('b').id, { filedBy: 'manual', query: q });
    expect(second).toMatchObject({ status: 'filed', linear_identifier: 'PIE-900', filed_by: 'manual' });
    expect(calls.filter(c => c.op === 'VendorWatchCreateIssue')).toHaveLength(1);
    expect(calls.find(c => c.op === 'VendorWatchComment')!.variables.input.issueId).toBe('iss-1');
  });

  it('uses the edited title, description and priority from the inbox', async () => {
    const { add } = setup();
    const { q, calls } = fakeLinear();
    await fileFinding(add('a').id, { filedBy: 'manual', query: q, override: { title: 'Edited', description: 'Body', priority: 1 } });
    expect(calls.find(c => c.op === 'VendorWatchCreateIssue')!.variables.input).toMatchObject({ title: 'Edited', description: 'Body', priority: 1 });
  });

  it('leaves the finding new with file_error when filing fails', async () => {
    const { add } = setup();
    const f = add('a');
    await expect(fileFinding(f.id, { filedBy: 'auto', query: fakeLinear({ label: false }).q })).rejects.toThrow(/not found in PIE/);
    expect(getFinding(f.id)).toMatchObject({ status: 'new' });
    expect(getFinding(f.id)!.file_error).toContain("Label 'vendor-watch' not found");
  });

  it('refuses a finding that is not new', async () => {
    const { add } = setup();
    const f = add('a');
    const { q } = fakeLinear();
    await fileFinding(f.id, { filedBy: 'auto', query: q });
    await expect(fileFinding(f.id, { filedBy: 'manual', query: q })).rejects.toThrow(/already filed/);
  });
});

describe('previewFiling', () => {
  beforeEach(() => { resetVendorWatch(); clearLinearTargetCache(); updateSettings({ linear_api_key: 'lin_test' }); });
  afterEach(() => updateSettings({ linear_api_key: '' }));

  it('shows a create draft, then a comment draft once a matching ticket exists', async () => {
    const { add } = setup();
    const first = add('a');
    expect(previewFiling(first.id)).toMatchObject({ mode: 'create', existing: null });
    await fileFinding(first.id, { filedBy: 'auto', query: fakeLinear().q });
    const p = previewFiling(add('b').id);
    expect(p.mode).toBe('comment');
    expect(p.existing).toEqual({ linear_identifier: 'PIE-900', linear_url: 'https://linear.app/x/PIE-900' });
    expect(p.draft.description).toContain('Vendor watch saw this again');
  });
});
```

- [ ] **Step 2: Write the failing runner tests**

`server/src/services/vendor-watch/runner.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/schema.js';
import {
  beginPlanGeneration, completePlanGeneration, replaceSources, getSnapshot, listFindings, listSources,
  updateWatchConfig, type SourceInput,
} from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult, sampleDraft } from '../../db/vendor-watch-test-utils.js';
import { startWatchRun, type RunnerDeps } from './runner.js';
import type { ClassifyInput, ClassifyResult } from './classifier.js';
import type { LivenessResult } from './liveness.js';

const RSS = (ids: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${ids
  .map(id => `<item><guid>${id}</guid><title>Entry ${id}</title><description>Details about entry ${id}.</description></item>`)
  .join('')}</channel></rss>`;

function plan(sources: SourceInput[]) {
  const p = beginPlanGeneration('@activepieces/piece-acme');
  const done = completePlanGeneration(p.id, samplePlanResult());
  return { planId: done.id, rows: replaceSources(done.id, sources) };
}

function harness() {
  const h = {
    body: RSS(['a']),
    liveness: { alive: true, detail: 'HTTP 200' } as LivenessResult,
    classify: (async () => ({ findings: [], costUsd: 0.01 })) as (input: ClassifyInput) => Promise<ClassifyResult>,
    classifyCalls: [] as ClassifyInput[],
    fileCalls: [] as number[],
    deps: {} as Partial<RunnerDeps>,
  };
  h.deps = {
    fetch: async (url) => ({ status: 200, finalUrl: url, contentType: 'application/xml', body: h.body }),
    liveness: async () => h.liveness,
    classify: async (input) => { h.classifyCalls.push(input); return h.classify(input); },
    file: async (id) => { h.fileCalls.push(id); },
    today: () => new Date('2026-10-06T00:00:00Z'),
  };
  return h;
}

type H = ReturnType<typeof harness>;
const run = (planId: number, h: H, trigger: 'manual' | 'baseline' = 'manual') => startWatchRun(planId, trigger, { deps: h.deps }).done;
const breaking = (input: ClassifyInput) =>
  sampleDraft({ kind: 'breaking', severity: 'high', is_baseline: input.mode === 'baseline', signature: `${input.mode}-${input.text.length}` });
const FEED: SourceInput = { kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' };
const HOST: SourceInput = { kind: 'liveness', url: 'https://api.acme.dev/v1', label: 'host' };

describe('startWatchRun — feeds', () => {
  beforeEach(resetVendorWatch);

  it('baselines a new source: snapshot stored, newest entries classified, nothing auto-filed', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId, rows } = plan([FEED]);
    const h = harness();
    h.classify = async (input) => ({ findings: [breaking(input)], costUsd: 0.02 });
    const r = await run(planId, h, 'baseline');
    expect(r).toMatchObject({ status: 'completed', trigger_type: 'baseline', sources_checked: 1, sources_changed: 0, findings_created: 1 });
    expect(r.cost_usd).toBeCloseTo(0.02);
    expect(h.classifyCalls[0].mode).toBe('baseline');
    expect(getSnapshot(rows[0].id)).toBeDefined();
    expect(listFindings()[0].is_baseline).toBe(1);
    expect(h.fileCalls).toEqual([]);
  });

  it('does nothing when the source has not changed', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const r = await run(planId, h);
    expect(h.classifyCalls).toHaveLength(1);
    expect(r).toMatchObject({ sources_changed: 0, findings_created: 0 });
  });

  it('classifies only the new entries and auto-files a qualifying finding', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    h.body = RSS(['a', 'b']);
    h.classify = async (input) => ({ findings: [breaking(input)], costUsd: 0.02 });
    const r = await run(planId, h);
    const last = h.classifyCalls[h.classifyCalls.length - 1];
    expect(last.mode).toBe('change');
    expect(last.text).toContain('Entry b');
    expect(last.text).not.toContain('Entry a');
    expect(r).toMatchObject({ sources_changed: 1, findings_created: 1 });
    expect(h.fileCalls).toEqual([listFindings()[0].id]);
  });

  it('keeps a qualifying finding in the inbox when auto-file is off', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    h.body = RSS(['a', 'b']);
    h.classify = async (input) => ({ findings: [breaking(input)], costUsd: 0 });
    await run(planId, h);
    expect(h.fileCalls).toEqual([]);
    expect(listFindings()[0].status).toBe('new');
  });

  it('keeps the old snapshot when the classifier fails, so the change is retried next run', async () => {
    const { planId, rows } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const before = getSnapshot(rows[0].id)!.content_hash;
    h.body = RSS(['a', 'b']);
    h.classify = async () => { throw new Error('boom'); };
    const r = await run(planId, h);
    expect(r.status).toBe('completed');
    expect(r.error).toContain('boom');
    expect(getSnapshot(rows[0].id)!.content_hash).toBe(before);
    h.classify = async () => ({ findings: [], costUsd: 0 });
    await run(planId, h);
    expect(h.classifyCalls.filter(c => c.mode === 'change')).toHaveLength(2);
    expect(getSnapshot(rows[0].id)!.content_hash).not.toBe(before);
  });

  it('treats a feed that suddenly has no entries as a failure and leaves the snapshot alone', async () => {
    const { planId, rows } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const before = getSnapshot(rows[0].id)!.content_hash;
    h.body = '<html><body>Maintenance</body></html>';
    const r = await run(planId, h);
    expect(r.sources_failed).toBe(1);
    expect(getSnapshot(rows[0].id)!.content_hash).toBe(before);
    expect(listSources(planId)[0].consecutive_failures).toBe(1);
  });

  it('records an HTTP error as a source failure', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    h.deps.fetch = async (url) => ({ status: 404, finalUrl: url, contentType: 'text/html', body: 'nope' });
    const r = await run(planId, h);
    expect(r.sources_failed).toBe(1);
    expect(listSources(planId)[0].last_error).toBe('HTTP 404');
  });
});

describe('startWatchRun — OpenAPI', () => {
  beforeEach(resetVendorWatch);

  it('diffs specs without the classifier and auto-files a removed endpoint the piece calls', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([{ kind: 'openapi', url: 'https://acme.dev/openapi.json', label: 'spec' }]);
    const h = harness();
    h.body = JSON.stringify({ openapi: '3.0.0', paths: { '/v1/messages': { post: {} }, '/v1/orders': { get: {} } } });
    await run(planId, h);
    h.body = JSON.stringify({ openapi: '3.0.0', paths: { '/v1/orders': { get: {} } } });
    const r = await run(planId, h);
    expect(h.classifyCalls).toEqual([]);
    expect(r.findings_created).toBe(1);
    const [f] = listFindings();
    expect(f).toMatchObject({ kind: 'breaking', affected_targets: '["send_message"]' });
    expect(h.fileCalls).toEqual([f.id]);
  });
});

describe('startWatchRun — liveness', () => {
  beforeEach(resetVendorWatch);
  const gone: LivenessResult = { alive: false, failure: 'dns_not_found', detail: 'DNS: api.acme.dev not found' };

  it('creates and auto-files vendor_dead after dead_after_failures host-gone failures in a row', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([HOST]);
    const h = harness();
    await run(planId, h);
    h.liveness = gone;
    await run(planId, h);
    await run(planId, h);
    expect(listFindings()).toEqual([]);
    await run(planId, h);
    const [f] = listFindings();
    expect(f).toMatchObject({ kind: 'vendor_dead', signature: 'vendor_dead|api.acme.dev', is_baseline: 0 });
    expect(h.fileCalls).toEqual([f.id]);
    await run(planId, h);
    expect(listFindings()).toHaveLength(1);
  });

  it('never counts timeouts toward dead', async () => {
    const { planId } = plan([HOST]);
    const h = harness();
    await run(planId, h);
    h.liveness = { alive: false, failure: 'timeout', detail: 'Timed out' };
    for (let i = 0; i < 4; i++) await run(planId, h);
    expect(listFindings()).toEqual([]);
    expect(listSources(planId)[0]).toMatchObject({ consecutive_failures: 0, last_error: 'Timed out' });
  });

  it('reports a host that is already gone on its first check as a baseline finding', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([HOST]);
    const h = harness();
    h.liveness = gone;
    await run(planId, h, 'baseline');
    expect(listFindings()[0]).toMatchObject({ kind: 'vendor_dead', is_baseline: 1 });
    expect(h.fileCalls).toEqual([]);
  });
});

describe('startWatchRun — concurrency', () => {
  beforeEach(resetVendorWatch);

  it('returns the live run instead of starting a second one for the same plan', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    const a = startWatchRun(planId, 'manual', { deps: h.deps });
    const b = startWatchRun(planId, 'scheduled', { deps: h.deps });
    expect(b.runId).toBe(a.runId);
    await a.done;
    expect(getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM watch_runs')!.n).toBe(1);
    const c = startWatchRun(planId, 'manual', { deps: h.deps });
    expect(c.runId).not.toBe(a.runId);
    await c.done;
  });

  it('throws for an unknown plan', () => {
    expect(() => startWatchRun(999_999, 'manual')).toThrow(/not found/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/filing.test.ts server/src/services/vendor-watch/runner.test.ts`
Expected: FAIL. `./filing.js` and `./runner.js` do not exist yet.

- [ ] **Step 4: Implement `filing.ts`**

`server/src/services/vendor-watch/filing.ts`:

```ts
import { getSettings } from '../../db/queries.js';
import {
  findMergeTarget, getFinding, getPlan, getSource, getWatchConfig, markFindingFiled, parseTargets, setFindingFileError,
  type VendorFindingRow,
} from '../../db/vendor-watch-queries.js';
import { addLinearComment, createLinearIssue, resolveLinearTargets, type LinearQueryFn } from './linear-filer.js';
import { buildCommentBody, buildTicketDraft, PRIORITY_BY_SEVERITY, type TicketContext, type TicketDraft } from './ticket-draft.js';
import type { EndpointRef } from './types.js';

export interface FilingPreview {
  draft: TicketDraft;
  mode: 'create' | 'comment';
  existing: { linear_identifier: string; linear_url: string } | null;
}

export interface FileOptions {
  filedBy: 'auto' | 'manual';
  override?: Partial<TicketDraft>;
  query?: LinearQueryFn;
  today?: Date;
}

function mustGet(id: number): VendorFindingRow {
  const f = getFinding(id);
  if (!f) throw new Error(`Finding ${id} not found`);
  return f;
}

function ticketContext(f: VendorFindingRow, today: Date): TicketContext {
  const plan = getPlan(f.plan_id);
  let inventory: EndpointRef[] = [];
  try {
    inventory = JSON.parse(plan?.endpoint_inventory || '[]');
  } catch {
    inventory = [];
  }
  return {
    pieceDisplayName: plan?.piece_display_name || f.piece_name.replace('@activepieces/piece-', ''),
    pieceName: f.piece_name,
    pieceVersion: plan?.piece_version ?? '',
    inventory,
    sourceLabel: f.source_id ? getSource(f.source_id)?.label ?? '' : '',
    today,
  };
}

/** What the inbox "File…" modal shows: a new-ticket draft, or a comment on the matching filed ticket. */
export function previewFiling(findingId: number, today = new Date()): FilingPreview {
  const f = mustGet(findingId);
  const merge = findMergeTarget(f.piece_name, f.kind, parseTargets(f.affected_targets), f.id);
  if (merge) {
    return {
      draft: { title: merge.title, description: buildCommentBody(f), priority: PRIORITY_BY_SEVERITY[f.severity] },
      mode: 'comment',
      existing: { linear_identifier: merge.linear_identifier ?? '', linear_url: merge.linear_url ?? '' },
    };
  }
  return { draft: buildTicketDraft(f, ticketContext(f, today), 'manual'), mode: 'create', existing: null };
}

/** File one finding: comment on a matching filed ticket, or create a new one. On failure the finding stays 'new' with file_error set. */
export async function fileFinding(findingId: number, opts: FileOptions): Promise<VendorFindingRow> {
  const f = mustGet(findingId);
  if (f.status !== 'new') throw new Error(`Finding ${findingId} is already ${f.status}`);
  const apiKey = getSettings().linear_api_key;
  const config = getWatchConfig();
  try {
    const merge = findMergeTarget(f.piece_name, f.kind, parseTargets(f.affected_targets), f.id);
    if (merge?.linear_issue_id) {
      await addLinearComment(apiKey, merge.linear_issue_id, opts.override?.description?.trim() || buildCommentBody(f), opts.query);
      return markFindingFiled(f.id, {
        filed_by: opts.filedBy, linear_issue_id: merge.linear_issue_id,
        linear_identifier: merge.linear_identifier ?? '', linear_url: merge.linear_url ?? '',
      });
    }
    const targets = await resolveLinearTargets(apiKey, config.linear_team_key, config.linear_label, opts.query);
    const base = buildTicketDraft(f, ticketContext(f, opts.today ?? new Date()), opts.filedBy);
    const issue = await createLinearIssue(apiKey, targets, {
      title: opts.override?.title?.trim() || base.title,
      description: opts.override?.description?.trim() || base.description,
      priority: opts.override?.priority ?? base.priority,
    }, opts.query);
    return markFindingFiled(f.id, {
      filed_by: opts.filedBy, linear_issue_id: issue.id, linear_identifier: issue.identifier, linear_url: issue.url,
    });
  } catch (err: any) {
    setFindingFileError(f.id, err?.message || String(err));
    throw err;
  }
}
```

- [ ] **Step 5: Implement `runner.ts`**

`server/src/services/vendor-watch/runner.ts`:

```ts
import {
  createRun, finishRun, getPlan, getSnapshot, getWatchConfig, insertFinding, listSources, recordSourceFailure,
  recordSourceOk, saveSnapshot, touchPlanRun,
  type RunCounts, type WatchConfigRow, type WatchPlanRow, type WatchRunRow, type WatchSnapshotRow, type WatchSourceRow,
} from '../../db/vendor-watch-queries.js';
import { CostTracker } from '../../agents/v2/cost-tracker.js';
import { safeFetch, type SafeFetchResult } from './safe-fetch.js';
import { checkLiveness, countsTowardDead, hostOf, type LivenessResult } from './liveness.js';
import {
  addedHtmlBlocks, htmlBlocks, newFeedEntries, newestEntries, normalizeFeed, normalizeHtml, parseFeed, renderBlocks,
  renderFeedEntries, type FeedEntry, type Normalized,
} from './normalize.js';
import { buildOpMap, diffOpenApi, isOpenApiDoc, normalizeOpenApi, parseOpMap, parseSpec } from './openapi.js';
import { openApiBaselineFindings, openApiFindings } from './openapi-findings.js';
import { classifyChange, type ClassifyInput, type ClassifyResult } from './classifier.js';
import { shouldAutoFile, vendorDeadFinding } from './findings.js';
import { fileFinding } from './filing.js';
import type { EndpointRef, FindingDraft, RunTrigger } from './types.js';

export interface RunnerDeps {
  fetch: (url: string) => Promise<SafeFetchResult>;
  liveness: (baseUrl: string) => Promise<LivenessResult>;
  classify: (input: ClassifyInput) => Promise<ClassifyResult>;
  file: (findingId: number) => Promise<unknown>;
  today: () => Date;
}

export interface RunHandle {
  runId: number;
  done: Promise<WatchRunRow>;
}

interface SourceOutcome {
  changed: boolean;
  failed: boolean;
  findings: FindingDraft[];
  costUsd: number;
}

const BASELINE_FEED_ENTRIES = 20;
const NOTHING: SourceOutcome = { changed: false, failed: false, findings: [], costUsd: 0 };
const FAILED: SourceOutcome = { changed: false, failed: true, findings: [], costUsd: 0 };
const inFlight = new Map<number, RunHandle>();

function defaultDeps(config: WatchConfigRow): RunnerDeps {
  return {
    fetch: (url) => safeFetch(url),
    liveness: (url) => checkLiveness(url),
    classify: (input) => classifyChange(input, {
      model: config.classifier_model || undefined,
      costTracker: new CostTracker({ pieceName: input.pieceName, actionName: '', operation: 'vendor_watch_classify', version: 'vendor-watch-1' }),
    }),
    file: (id) => fileFinding(id, { filedBy: 'auto' }),
    today: () => new Date(),
  };
}

/** Start checking every enabled source of one plan. If the plan is already running, returns that run's handle. */
export function startWatchRun(
  planId: number, trigger: RunTrigger, opts: { cycleId?: string | null; deps?: Partial<RunnerDeps> } = {},
): RunHandle {
  const live = inFlight.get(planId);
  if (live) return live;
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Watch plan ${planId} not found`);
  const config = getWatchConfig();
  const deps: RunnerDeps = { ...defaultDeps(config), ...opts.deps };
  const run = createRun(planId, trigger, opts.cycleId ?? null);
  const handle: RunHandle = {
    runId: run.id,
    done: executeRun(plan, run.id, config, deps).finally(() => inFlight.delete(planId)),
  };
  inFlight.set(planId, handle);
  return handle;
}

async function executeRun(plan: WatchPlanRow, runId: number, config: WatchConfigRow, deps: RunnerDeps): Promise<WatchRunRow> {
  const counts: RunCounts = { sources_checked: 0, sources_changed: 0, sources_failed: 0, findings_created: 0, cost_usd: 0 };
  const errors: string[] = [];
  let inventory: EndpointRef[] = [];
  try {
    inventory = JSON.parse(plan.endpoint_inventory || '[]');
  } catch {
    inventory = [];
  }
  try {
    for (const source of listSources(plan.id).filter(s => s.enabled)) {
      counts.sources_checked++;
      let outcome: SourceOutcome;
      try {
        outcome = await checkSource(plan, source, inventory, config, deps);
      } catch (err: any) {
        errors.push(`${source.kind} ${source.url}: ${err?.message || err}`);
        continue;
      }
      if (outcome.failed) counts.sources_failed++;
      if (outcome.changed) counts.sources_changed++;
      counts.cost_usd += outcome.costUsd;
      for (const draft of outcome.findings) {
        const row = insertFinding({ plan_id: plan.id, piece_name: plan.piece_name, source_id: source.id, run_id: runId, draft });
        if (!row) continue;
        counts.findings_created++;
        if (!shouldAutoFile(draft, source.kind, config)) continue;
        try {
          await deps.file(row.id);
        } catch (err: any) {
          errors.push(`auto-file finding #${row.id}: ${err?.message || err}`);
        }
      }
    }
    touchPlanRun(plan.id);
    return finishRun(runId, 'completed', counts, errors.join('\n'));
  } catch (err: any) {
    return finishRun(runId, 'failed', counts, [...errors, String(err?.message || err)].join('\n'));
  }
}

async function checkSource(
  plan: WatchPlanRow, source: WatchSourceRow, inventory: EndpointRef[], config: WatchConfigRow, deps: RunnerDeps,
): Promise<SourceOutcome> {
  if (source.kind === 'liveness') return checkLivenessSource(source, config, deps);
  let res: SafeFetchResult;
  try {
    res = await deps.fetch(source.url);
  } catch (err: any) {
    recordSourceFailure(source.id, err?.message || String(err));
    return FAILED;
  }
  if (res.status >= 400) {
    recordSourceFailure(source.id, `HTTP ${res.status}`);
    return FAILED;
  }
  const prev = getSnapshot(source.id);
  if (source.kind === 'openapi') return checkOpenApi(source, res.body, prev, inventory);
  return checkTextSource(plan, source, res.body, prev, inventory, deps);
}

/** Only "host gone" failures count; on the very first check one is enough (a baseline finding). */
async function checkLivenessSource(source: WatchSourceRow, config: WatchConfigRow, deps: RunnerDeps): Promise<SourceOutcome> {
  const isBaseline = !getSnapshot(source.id);
  const r = await deps.liveness(source.url);
  if (isBaseline) saveSnapshot(source.id, 'checked', 'checked');
  if (r.alive) {
    recordSourceOk(source.id, false);
    return NOTHING;
  }
  const dead = countsTowardDead(r.failure);
  const failures = recordSourceFailure(source.id, r.detail, dead);
  if (dead && (isBaseline || failures >= config.dead_after_failures)) {
    return { ...FAILED, findings: [vendorDeadFinding(hostOf(source.url), r.detail, failures, isBaseline, source.url)] };
  }
  return FAILED;
}

function checkOpenApi(source: WatchSourceRow, body: string, prev: WatchSnapshotRow | undefined, inventory: EndpointRef[]): SourceOutcome {
  let doc: unknown;
  try {
    doc = parseSpec(body);
  } catch (err: any) {
    recordSourceFailure(source.id, `Not a parseable spec: ${err?.message || err}`);
    return FAILED;
  }
  if (!isOpenApiDoc(doc)) {
    recordSourceFailure(source.id, 'Not an OpenAPI document');
    return FAILED;
  }
  const ops = buildOpMap(doc);
  const norm = normalizeOpenApi(ops);
  if (prev && prev.content_hash === norm.hash) {
    recordSourceOk(source.id, false);
    return NOTHING;
  }
  const findings = prev
    ? openApiFindings(diffOpenApi(parseOpMap(prev.content), ops), inventory, source.url)
    : openApiBaselineFindings(ops, inventory, source.url);
  saveSnapshot(source.id, norm.hash, norm.content);
  recordSourceOk(source.id, !!prev);
  return { changed: !!prev, failed: false, findings, costUsd: 0 };
}

async function checkTextSource(
  plan: WatchPlanRow, source: WatchSourceRow, body: string, prev: WatchSnapshotRow | undefined,
  inventory: EndpointRef[], deps: RunnerDeps,
): Promise<SourceOutcome> {
  let norm: Normalized;
  let text: string;
  if (source.kind === 'feed') {
    let entries: FeedEntry[];
    try {
      entries = parseFeed(body);
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      recordSourceFailure(source.id, 'Feed parsed to zero entries');
      return FAILED;
    }
    norm = normalizeFeed(entries);
    if (prev && prev.content_hash === norm.hash) {
      recordSourceOk(source.id, false);
      return NOTHING;
    }
    text = renderFeedEntries(prev ? newFeedEntries(entries, prev.content) : newestEntries(entries, BASELINE_FEED_ENTRIES));
  } else {
    const blocks = htmlBlocks(body);
    if (blocks.length === 0) {
      recordSourceFailure(source.id, 'Page has no readable text blocks');
      return FAILED;
    }
    norm = normalizeHtml(blocks);
    if (prev && prev.content_hash === norm.hash) {
      recordSourceOk(source.id, false);
      return NOTHING;
    }
    text = renderBlocks(prev ? addedHtmlBlocks(blocks, prev.content) : blocks);
  }
  if (!text.trim()) {
    saveSnapshot(source.id, norm.hash, norm.content);
    recordSourceOk(source.id, false);
    return NOTHING;
  }
  const result = await deps.classify({
    pieceName: plan.piece_name,
    pieceDisplayName: plan.piece_display_name || plan.piece_name,
    vendorName: plan.vendor_name,
    apiVersion: plan.api_version,
    authType: plan.auth_type,
    inventory,
    source: { label: source.label, url: source.url, kind: source.kind },
    mode: prev ? 'change' : 'baseline',
    text,
    today: deps.today().toISOString().slice(0, 10),
  });
  saveSnapshot(source.id, norm.hash, norm.content);
  recordSourceOk(source.id, !!prev);
  return { changed: !!prev, failed: false, findings: result.findings, costUsd: result.costUsd };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/filing.test.ts server/src/services/vendor-watch/runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS. This includes the existing suites. If an older suite fails on `settings.linear_api_key`, make sure the filing tests' `afterEach` resets it.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/vendor-watch/filing.ts server/src/services/vendor-watch/runner.ts server/src/services/vendor-watch/filing.test.ts server/src/services/vendor-watch/runner.test.ts
git commit -m "feat(vendor-watch): run a watch plan's sources and file what breaks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Daily watch cycle and boot wiring

**Files:**
- Create: `server/src/services/vendor-watch/cron.ts`
- Modify: `server/src/index.ts` (`startBackgroundWork`)
- Test: `server/src/services/vendor-watch/cron.test.ts`

**Interfaces:**
- Consumes:
  - from Task 8: `startWatchRun`
  - from Task 1: `getWatchConfig`, `listRunnablePlans`, `markStalePlans`, `reconcileVendorWatch`
  - existing: `runWithConcurrency` (`services/concurrency.ts`), `createClient` (`services/test-engine.ts`)
- Produces:
  - `runWatchCycle(deps?: { catalogVersions?, runPlan? }): Promise<{ started, cycleId?, plans?, staleMarked? }>`
  - `isCycleRunning(): boolean`
  - `initVendorWatch(): boolean`, `reloadVendorWatch` (alias), `stopVendorWatch()`

- [ ] **Step 1: Write the failing tests**

`server/src/services/vendor-watch/cron.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { beginPlanGeneration, completePlanGeneration, getPlan, setPlanStatus, updateWatchConfig } from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult } from '../../db/vendor-watch-test-utils.js';
import { initVendorWatch, isCycleRunning, runWatchCycle, stopVendorWatch } from './cron.js';

function active(name: string) {
  const p = beginPlanGeneration(name);
  return completePlanGeneration(p.id, samplePlanResult());
}

describe('initVendorWatch', () => {
  beforeEach(resetVendorWatch);
  afterEach(stopVendorWatch);

  it('registers nothing while disabled', () => {
    expect(initVendorWatch()).toBe(false);
  });

  it('registers the cron when enabled with a valid expression', () => {
    updateWatchConfig({ enabled: 1 });
    expect(initVendorWatch()).toBe(true);
  });

  it('refuses an invalid expression', () => {
    updateWatchConfig({ enabled: 1, cron_expression: 'not a cron' });
    expect(initVendorWatch()).toBe(false);
  });
});

describe('runWatchCycle', () => {
  beforeEach(resetVendorWatch);

  it('marks stale plans, then runs only active and stale plans under one cycle id', async () => {
    const a = active('@activepieces/piece-a');
    const b = active('@activepieces/piece-b');
    const c = active('@activepieces/piece-c');
    setPlanStatus(c.id, 'paused');
    beginPlanGeneration('@activepieces/piece-d');
    const ran: { id: number; cycle: string }[] = [];
    const r = await runWatchCycle({
      catalogVersions: async () => new Map([[b.piece_name, '9.9.9']]),
      runPlan: async (id, cycle) => { ran.push({ id, cycle }); },
    });
    expect(r).toMatchObject({ started: true, plans: 2, staleMarked: 1 });
    expect(getPlan(b.id)!.status).toBe('stale');
    expect(ran.map(x => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(new Set(ran.map(x => x.cycle)).size).toBe(1);
  });

  it('refuses to overlap a running cycle', async () => {
    active('@activepieces/piece-a');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const first = runWatchCycle({ catalogVersions: async () => new Map(), runPlan: () => gate });
    expect(isCycleRunning()).toBe(true);
    expect(await runWatchCycle({ catalogVersions: async () => new Map(), runPlan: async () => {} })).toEqual({ started: false });
    release();
    await first;
    expect(isCycleRunning()).toBe(false);
  });

  it('still runs plans when the catalog cannot be reached', async () => {
    active('@activepieces/piece-a');
    const ran: number[] = [];
    const r = await runWatchCycle({
      catalogVersions: async () => { throw new Error('offline'); },
      runPlan: async (id) => { ran.push(id); },
    });
    expect(r).toMatchObject({ started: true, plans: 1, staleMarked: 0 });
    expect(ran).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/vendor-watch/cron.test.ts`
Expected: FAIL. `./cron.js` does not exist yet.

- [ ] **Step 3: Implement `cron.ts`**

`server/src/services/vendor-watch/cron.ts`:

```ts
import cron from 'node-cron';
import { getWatchConfig, listRunnablePlans, markStalePlans } from '../../db/vendor-watch-queries.js';
import { runWithConcurrency } from '../concurrency.js';
import { createClient } from '../test-engine.js';
import { startWatchRun } from './runner.js';

export interface CycleDeps {
  catalogVersions?: () => Promise<Map<string, string>>;
  runPlan?: (planId: number, cycleId: string) => Promise<unknown>;
}

export interface CycleResult {
  started: boolean;
  cycleId?: string;
  plans?: number;
  staleMarked?: number;
}

const PLAN_CONCURRENCY = 3;
let task: cron.ScheduledTask | null = null;
let cycleRunning = false;

export function isCycleRunning(): boolean {
  return cycleRunning;
}

async function catalogVersionsFromAp(): Promise<Map<string, string>> {
  const pieces = await createClient().listPieces();
  return new Map(pieces.map(p => [p.name, p.version]));
}

/** One watch cycle: mark stale plans, then run every active/stale plan, 3 at a time. Never overlaps itself. */
export async function runWatchCycle(deps: CycleDeps = {}): Promise<CycleResult> {
  if (cycleRunning) return { started: false };
  cycleRunning = true;
  const cycleId = `vw-${Date.now()}`;
  try {
    let staleMarked = 0;
    try {
      staleMarked = markStalePlans(await (deps.catalogVersions ?? catalogVersionsFromAp)());
    } catch (err: any) {
      console.warn(`[vendor-watch] stale check skipped: ${err?.message || err}`);
    }
    const plans = listRunnablePlans();
    const runPlan = deps.runPlan ?? ((id: number, c: string) => startWatchRun(id, 'scheduled', { cycleId: c }).done);
    await runWithConcurrency(plans, PLAN_CONCURRENCY, async (p) => {
      try {
        await runPlan(p.id, cycleId);
      } catch (err: any) {
        console.error(`[vendor-watch] ${p.piece_name} failed: ${err?.message || err}`);
      }
    });
    console.log(`[vendor-watch] cycle ${cycleId}: ${plans.length} plan(s), ${staleMarked} marked stale`);
    return { started: true, cycleId, plans: plans.length, staleMarked };
  } finally {
    cycleRunning = false;
  }
}

export function stopVendorWatch(): void {
  task?.stop();
  task = null;
}

/** (Re)register the daily cycle from vendor_watch_config. Returns whether a cron task is now registered. */
export function initVendorWatch(): boolean {
  stopVendorWatch();
  const c = getWatchConfig();
  if (!c.enabled) return false;
  if (!cron.validate(c.cron_expression)) {
    console.warn(`[vendor-watch] invalid cron "${c.cron_expression}" — not scheduled`);
    return false;
  }
  try {
    task = cron.schedule(c.cron_expression, () => { void runWatchCycle(); }, { timezone: c.timezone || 'UTC' });
  } catch (err: any) {
    console.warn(`[vendor-watch] could not register the cron: ${err?.message || err}`);
    return false;
  }
  console.log(`[vendor-watch] cycle scheduled: ${c.cron_expression} (${c.timezone || 'UTC'})`);
  return true;
}

export const reloadVendorWatch = initVendorWatch;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/vendor-watch/cron.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire boot reconcile and the cron into the server**

In `server/src/index.ts`, add these imports next to the other service imports:

```ts
import { reconcileVendorWatch } from './db/vendor-watch-queries.js';
import { initVendorWatch } from './services/vendor-watch/cron.js';
```

In `startBackgroundWork()`, replace:

```ts
  initScheduler();
  initFlowReaper();
}
```

with:

```ts
  const vw = reconcileVendorWatch();
  if (vw.runs + vw.plans > 0) console.log(`[server] Vendor watch: closed ${vw.runs} interrupted run(s), ${vw.plans} interrupted generation(s)`);

  initScheduler();
  initFlowReaper();
  initVendorWatch();
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add server/src/services/vendor-watch/cron.ts server/src/services/vendor-watch/cron.test.ts server/src/index.ts
git commit -m "feat(vendor-watch): run the daily watch cycle and reconcile on boot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Agent runner: server tools, `pause_turn`, terminal validation

**Files:**
- Modify: `server/src/agents/v2/types.ts`
- Modify: `server/src/agents/v2/tool-registry.ts`
- Modify: `server/src/agents/v2/tools/index.ts` (tool names + `TERMINAL_TOOLS`)
- Modify: `server/src/agents/v2/agent-runner.ts`
- Modify: `server/src/agents/v2/cost-tracker.ts`
- Test: `server/src/agents/v2/agent-runner.test.ts`
- Test: `server/src/agents/v2/cost-tracker.test.ts`

**Interfaces:**
- Consumes:
  - from Task 6: `MessagesClient` (from `services/anthropic-client.ts`)
  - from Task 1: `ProbeResult`
- Produces:
  - `AgentRole` gains `'watch_planner'`
  - `ToolContext.probedSources?: Map<string, ProbeResult>`
  - `ToolDefinition.validateTerminal?(input, ctx): string | null`
  - `AgentRunnerConfig.serverTools?: unknown[]`, `.disableMcp?: boolean`, `.client?: MessagesClient`
  - `ToolRegistry.validateTerminal(name, input, ctx): string | null`
  - `TOOL_NAMES.PROBE_SOURCE = 'probe_source'`, `TOOL_NAMES.SET_WATCH_PLAN = 'set_watch_plan'`, and `TERMINAL_TOOLS` includes `set_watch_plan`
  - `WEB_SEARCH_COST_USD`, `webSearchCost(response)`
  - Existing workers are untouched: every new field is optional.

- [ ] **Step 1: Write the failing tests**

`server/src/agents/v2/agent-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runAgentLoop } from './agent-runner.js';
import { ToolRegistry } from './tool-registry.js';
import type { AgentRunnerConfig, ToolContext } from './types.js';
import type { MessagesClient } from '../../services/anthropic-client.js';

function scripted(responses: any[]) {
  const calls: any[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body: any) => {
        calls.push(JSON.parse(JSON.stringify(body)));
        const next = responses.shift();
        if (!next) throw new Error('no scripted response left');
        return next;
      },
    },
  };
  return { client, calls };
}

function registry() {
  const r = new ToolRegistry();
  r.register({
    name: 'set_watch_plan',
    description: 'test terminal',
    input_schema: { type: 'object', properties: {} },
    validateTerminal: (input) => (input.ok ? null : 'sources: never probed'),
    handler: async () => 'saved',
  });
  return r;
}

const ctx = (): ToolContext => ({ pieceMeta: { name: 'p', actions: {}, triggers: {} } as unknown as ToolContext['pieceMeta'], actionName: '' });
const config = (over: Partial<AgentRunnerConfig>): AgentRunnerConfig => ({
  role: 'watch_planner', model: 'claude-sonnet-4-6', systemPrompt: 'sys',
  initialMessages: [{ role: 'user', content: 'go' }], maxIterations: 5, toolNames: ['set_watch_plan'],
  disableMcp: true, onLog: () => {}, ...over,
});
const usage = { input_tokens: 10, output_tokens: 5 };

describe('runAgentLoop', () => {
  it('passes server tools through and continues after pause_turn without a cache breakpoint on the assistant turn', async () => {
    const { client, calls } = scripted([
      { stop_reason: 'pause_turn', usage, content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'acme changelog' } }] },
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'set_watch_plan', input: { ok: true } }] },
    ]);
    const web = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
    const r = await runAgentLoop(registry(), config({ client, serverTools: [web] }), ctx());
    expect(r.terminatedByTool).toBe(true);
    expect(r.output).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.map((t: any) => t.name)).toEqual(['set_watch_plan', 'web_search']);
    const last = calls[1].messages[calls[1].messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(calls[1].messages)).not.toContain('cache_control');
  });

  it('returns a rejected terminal call to the model as an error and keeps going', async () => {
    const { client, calls } = scripted([
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'set_watch_plan', input: { ok: false } }] },
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't2', name: 'set_watch_plan', input: { ok: true } }] },
    ]);
    const r = await runAgentLoop(registry(), config({ client }), ctx());
    expect(r.terminatedByTool).toBe(true);
    expect(r.output).toEqual({ ok: true });
    const feedback = calls[1].messages[calls[1].messages.length - 1].content[0];
    expect(feedback).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
    expect(feedback.content).toContain('sources: never probed');
  });

  it('stops without a terminal call on end_turn', async () => {
    const { client } = scripted([{ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] }]);
    const r = await runAgentLoop(registry(), config({ client }), ctx());
    expect(r.terminatedByTool).toBe(false);
    expect(r.output).toBeNull();
  });
});
```

`server/src/agents/v2/cost-tracker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { webSearchCost, WEB_SEARCH_COST_USD } from './cost-tracker.js';

describe('webSearchCost', () => {
  it('charges per web search request', () => {
    expect(WEB_SEARCH_COST_USD).toBe(0.01);
    expect(webSearchCost({ usage: { server_tool_use: { web_search_requests: 3 } } })).toBeCloseTo(0.03);
    expect(webSearchCost({ usage: {} })).toBe(0);
    expect(webSearchCost(undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/agents/v2/agent-runner.test.ts server/src/agents/v2/cost-tracker.test.ts`
Expected: FAIL. `'watch_planner'` is not an `AgentRole`, `client`/`serverTools` are ignored (the runner throws "Anthropic API key not configured"), and `webSearchCost` is not exported.

- [ ] **Step 3: Extend the types**

In `server/src/agents/v2/types.ts`:

1. Add the imports at the top:

```ts
import type { MessagesClient } from '../../services/anthropic-client.js';
import type { ProbeResult } from '../../services/vendor-watch/types.js';
```

2. Change the role union:

```ts
export type AgentRole = 'coordinator' | 'research' | 'planner' | 'verifier' | 'fixer' | 'watch_planner';
```

3. In `interface ToolContext`, after `createdFlowIds?: Set<string>;`, add:

```ts
  /** Vendor watch planner: every URL probe_source fetched this session (keyed by requested and final URL). */
  probedSources?: Map<string, ProbeResult>;
```

4. In `interface ToolDefinition`, after `handler`, add:

```ts
  /** Terminal tools only: return an error message to send back to the model instead of accepting the call. */
  validateTerminal?: (input: Record<string, any>, ctx: ToolContext) => string | null;
```

5. In `interface AgentRunnerConfig`, after `onLog: OnLogCallback;`, add:

```ts
  /** Anthropic server tools (e.g. web_search) appended to the local tools. */
  serverTools?: unknown[];
  /** Skip the Activepieces MCP tools even when a token is configured. */
  disableMcp?: boolean;
  /** Inject a client (tests). Defaults to the SDK client built from Settings. */
  client?: MessagesClient;
```

- [ ] **Step 4: Add `validateTerminal` to the registry**

In `server/src/agents/v2/tool-registry.ts`, add this method inside `class ToolRegistry`, after `execute`:

```ts
  /** Run a terminal tool's validator, if it has one. Returns an error message, or null to accept. */
  validateTerminal(toolName: string, input: Record<string, any>, ctx: ToolContext): string | null {
    const tool = this.tools.get(toolName);
    return tool?.validateTerminal ? tool.validateTerminal(input, ctx) : null;
  }
```

- [ ] **Step 5: Register the new tool names**

In `server/src/agents/v2/tools/index.ts`:

1. In `TOOL_NAMES`, after `CLEANUP_FLOW: 'cleanup_flow',`, add:

```ts
  PROBE_SOURCE: 'probe_source',
  SET_WATCH_PLAN: 'set_watch_plan',
```

2. Replace:

```ts
export const TERMINAL_TOOLS = new Set([TOOL_NAMES.SET_TEST_PLAN]);
```

with:

```ts
export const TERMINAL_TOOLS = new Set<string>([TOOL_NAMES.SET_TEST_PLAN, TOOL_NAMES.SET_WATCH_PLAN]);
```

- [ ] **Step 6: Change the runner**

In `server/src/agents/v2/agent-runner.ts`:

1. Change the types import to include `MessagesClient`. Add this import, and keep the existing `./types.js` import as is:

```ts
import type { MessagesClient } from '../../services/anthropic-client.js';
```

2. In `applyMessageCacheBreakpoint`, replace:

```ts
  const last = messages[messages.length - 1];
  if (!last) return;
```

with:

```ts
  const last = messages[messages.length - 1];
  // After a pause_turn the last message is the assistant's own turn; it is resent untouched.
  if (!last || last.role !== 'user') return;
```

3. Replace:

```ts
  const settings = getSettings();
  if (!settings.anthropic_api_key) {
    throw new Error('Anthropic API key not configured. Go to Settings to add it.');
  }
```

with:

```ts
  const settings = getSettings();
  if (!config.client && !settings.anthropic_api_key) {
    throw new Error('Anthropic API key not configured. Go to Settings to add it.');
  }
```

4. Replace:

```ts
  const client = new Anthropic(buildAnthropicClientOptions(settings.anthropic_api_key));
```

with:

```ts
  const client: MessagesClient = config.client
    ?? (new Anthropic(buildAnthropicClientOptions(settings.anthropic_api_key)) as unknown as MessagesClient);
```

5. Replace:

```ts
  const mcpEnabled = hasMcpOAuth || hasMcpLegacy;
```

with:

```ts
  const mcpEnabled = !config.disableMcp && (hasMcpOAuth || hasMcpLegacy);
```

6. Replace:

```ts
  const localTools = registry.getTools(toolNames);
  let allTools: any[] = [...localTools];
```

with:

```ts
  const localTools = registry.getTools(toolNames);
  const serverTools = config.serverTools ?? [];
  let allTools: any[] = [...localTools, ...serverTools];
```

and replace:

```ts
      allTools = [...localTools, ...mcpAnthropicTools];
```

with:

```ts
      allTools = [...localTools, ...serverTools, ...mcpAnthropicTools];
```

7. Directly after the existing `max_tokens` block (the one ending in `break;` after "stopping without acting on a possibly-incomplete tool call"), add:

```ts

    // A server tool (web_search) used up its per-turn budget; resend the turn as-is so the model carries on.
    if (response.stop_reason === 'pause_turn') {
      log('thinking', `[${role}] Server tool paused the turn — continuing.`);
      continue;
    }
```

8. Replace the start of the terminal-tool branch:

```ts
      // Terminal tool — capture output and stop loop
      if (TERMINAL_TOOLS.has(toolUse.name as any)) {
```

with:

```ts
      // Terminal tool — capture output and stop loop, unless its validator rejects the input
      if (TERMINAL_TOOLS.has(toolUse.name as any)) {
        const rejection = registry.validateTerminal(toolUse.name, input, toolCtx);
        if (rejection) {
          log('error', `[${role}] ${toolUse.name} rejected: ${rejection.slice(0, 300)}`);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Rejected. Fix these and call ${toolUse.name} again:\n${rejection}`, is_error: true });
          continue;
        }
```

The rest of that branch (`log('decision', …)`, `terminalOutput = input`, `break`) stays as it is.

- [ ] **Step 7: Charge web searches in the cost tracker**

In `server/src/agents/v2/cost-tracker.ts`, add below `extractUsage`:

```ts
/** Anthropic bills each server-side web search separately from tokens. */
export const WEB_SEARCH_COST_USD = 0.01;

export function webSearchCost(response: any): number {
  return (response?.usage?.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_COST_USD;
}
```

and in `CostTracker.trackResponse`, replace:

```ts
    const cost = calculateCost(model, usage);
```

with:

```ts
    const cost = calculateCost(model, usage) + webSearchCost(response);
```

- [ ] **Step 8: Run the tests, then the whole suite**

Run: `npx vitest run server/src/agents/v2/agent-runner.test.ts server/src/agents/v2/cost-tracker.test.ts`
Expected: PASS.

Run: `npm test && npx tsc --noEmit -p tsconfig.json`
Expected: PASS and no type errors. The existing workers do not set any of the new fields, so they behave exactly as before.

- [ ] **Step 9: Commit**

```bash
git add server/src/agents/v2/types.ts server/src/agents/v2/tool-registry.ts server/src/agents/v2/tools/index.ts server/src/agents/v2/agent-runner.ts server/src/agents/v2/cost-tracker.ts server/src/agents/v2/agent-runner.test.ts server/src/agents/v2/cost-tracker.test.ts
git commit -m "feat(agents): let workers use server tools, resume pause_turn and validate terminal calls" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `probe_source` and `set_watch_plan` tools

**Files:**
- Create: `server/src/agents/v2/tools/probe-source.ts`
- Create: `server/src/agents/v2/tools/set-watch-plan.ts`
- Modify: `server/src/agents/v2/tools/index.ts` (register tools + `WATCH_PLANNER_TOOLS`)
- Test: `server/src/agents/v2/tools/probe-source.test.ts`
- Test: `server/src/agents/v2/tools/set-watch-plan.test.ts`

**Interfaces:**
- Consumes:
  - from Task 2: `safeFetch`, `SafeFetchError`, `SafeFetchOptions`
  - from Task 3: `parseFeed`, `htmlBlocks`
  - from Task 4: `parseSpec`, `isOpenApiDoc`
  - from Task 10: `ToolContext.probedSources`, `ToolDefinition.validateTerminal`, `TOOL_NAMES`
- Produces:
  - `MIN_HTML_CHARS = 500`, `detectKind(body, contentType) → { kind, text }`, `probeSource(url, opts?): Promise<ProbeResult>`, `probeSourceTool`
  - `type WatchPlanDraft = { vendor_name, api_base_urls: string[], api_version, auth_type, endpoint_inventory: EndpointRef[], sources: { kind: string; url; label }[], note }`
  - `type WatchPlanValidation = { errors: string[]; warnings: string[]; plan: WatchPlanDraft }`
  - `MAX_SOURCES = 8`, `parseWatchPlanInput(input): WatchPlanDraft`, `validateWatchPlan(draft, ctx): WatchPlanValidation`, `setWatchPlanTool`
  - `WATCH_PLANNER_TOOLS` (in `tools/index.ts`)

- [ ] **Step 1: Write the failing tests**

`server/src/agents/v2/tools/probe-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectKind, probeSource } from './probe-source.js';
import type { LookupFn } from '../../../services/vendor-watch/safe-fetch.js';

const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const serve = (body: string, contentType: string, status = 200) =>
  (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>1</guid><title>Hello</title><description>World news here.</description></item></channel></rss>';
const LONG_HTML = `<html><body><main>${Array.from({ length: 10 }, (_, i) => `<p>Release ${i}: this changelog paragraph is long enough to count as text.</p>`).join('')}</main></body></html>`;
const SPA = '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';

describe('detectKind', () => {
  it('recognizes feeds, OpenAPI (JSON and YAML), readable HTML and JS-only shells', () => {
    expect(detectKind(RSS, 'application/rss+xml').kind).toBe('feed');
    expect(detectKind(JSON.stringify({ openapi: '3.0.0', paths: { '/a': { get: {} } } }), 'application/json').kind).toBe('openapi');
    expect(detectKind('openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n', 'text/yaml').kind).toBe('openapi');
    expect(detectKind(LONG_HTML, 'text/html').kind).toBe('html');
    expect(detectKind(SPA, 'text/html').kind).toBe('unreadable');
    expect(detectKind('{"hello":"world"}', 'application/json').kind).toBe('unreadable');
  });
});

describe('probeSource', () => {
  it('reports a readable feed as ok with a sample', async () => {
    const r = await probeSource('https://acme.dev/rss', { lookup, fetchImpl: serve(RSS, 'application/rss+xml') });
    expect(r).toMatchObject({ ok: true, status: 200, detected_kind: 'feed', problem: '' });
    expect(r.sample).toContain('Hello');
  });

  it('reports HTTP errors, JS-only pages and blocked hosts as not ok', async () => {
    expect((await probeSource('https://acme.dev/x', { lookup, fetchImpl: serve('nope', 'text/html', 404) })).problem).toBe('HTTP 404');
    expect((await probeSource('https://acme.dev/app', { lookup, fetchImpl: serve(SPA, 'text/html') })).problem).toMatch(/JavaScript-only/);
    const blocked = await probeSource('http://10.0.0.1/', { lookup });
    expect(blocked).toMatchObject({ ok: false, status: null });
    expect(blocked.problem).toMatch(/^blocked_address/);
  });
});
```

`server/src/agents/v2/tools/set-watch-plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseWatchPlanInput, validateWatchPlan, setWatchPlanTool } from './set-watch-plan.js';
import type { ProbeResult } from '../../../services/vendor-watch/types.js';
import type { ToolContext } from '../types.js';

const probe = (url: string, kind: ProbeResult['detected_kind'], ok = true): ProbeResult => ({
  url, ok, status: ok ? 200 : 404, final_url: url, content_type: '', detected_kind: kind,
  text_chars: 900, sample: '', problem: ok ? '' : 'HTTP 404',
});

const ctx = (probes: ProbeResult[] = []): ToolContext => ({
  pieceMeta: {
    name: '@activepieces/piece-acme',
    actions: { send_message: { name: 'send_message', displayName: 'Send' } },
    triggers: { new_order: { name: 'new_order', displayName: 'New order' } },
  } as unknown as ToolContext['pieceMeta'],
  actionName: '',
  probedSources: new Map(probes.map(p => [p.url, p])),
});

const input = (over: Record<string, unknown> = {}) => ({
  vendor_name: 'Acme', api_base_urls: ['https://api.acme.dev/v1'], api_version: 'v1', auth_type: 'API key',
  endpoint_inventory: [
    { target: 'send_message', target_kind: 'action', method: 'post', path: '/v1/messages' },
    { target: 'new_order', target_kind: 'trigger', method: 'GET', path: '/v1/orders' },
    { target: 'ghost', target_kind: 'action', method: 'GET', path: '/v1/ghost' },
  ],
  sources: [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS' }],
  note: 'ok', ...over,
});

const check = (over: Record<string, unknown> = {}, probes = [probe('https://acme.dev/rss', 'feed')]) =>
  validateWatchPlan(parseWatchPlanInput(input(over)), ctx(probes));

describe('validateWatchPlan', () => {
  it('accepts a plan whose sources were all probed ok, dropping unknown targets with a warning', () => {
    const v = check();
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual(['endpoint_inventory: dropped "ghost" — not a action of this piece.']);
    expect(v.plan.endpoint_inventory.map(e => [e.target, e.method])).toEqual([['send_message', 'POST'], ['new_order', 'GET']]);
  });

  it('rejects unprobed, unreadable and mis-typed sources', () => {
    expect(check({}, []).errors[0]).toMatch(/never probed/);
    expect(check({}, [probe('https://acme.dev/rss', 'unreadable', false)]).errors[0]).toMatch(/unreadable \(HTTP 404\)/);
    expect(check({}, [probe('https://acme.dev/rss', 'html')]).errors[0]).toMatch(/probed as "html", not "feed"/);
  });

  it('rejects liveness sources, duplicates, too many sources and no sources', () => {
    expect(check({ sources: [{ kind: 'liveness', url: 'https://api.acme.dev', label: 'x' }] }).errors[0]).toMatch(/liveness is added for you/);
    const dup = [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'a' }, { kind: 'feed', url: 'https://acme.dev/rss', label: 'b' }];
    expect(check({ sources: dup }).errors).toContain('sources: "https://acme.dev/rss" is listed twice.');
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'feed', url: `https://acme.dev/${i}`, label: String(i) }));
    expect(check({ sources: many }, many.map(s => probe(s.url, 'feed'))).errors).toContain('sources: at most 8, got 9.');
    expect(check({ sources: [] }).errors).toContain('sources: add at least one feed, openapi or html source.');
  });

  it('requires at least one http(s) base URL', () => {
    expect(check({ api_base_urls: [] }).errors[0]).toMatch(/at least one URL/);
    expect(check({ api_base_urls: ['ftp://acme.dev'] }).errors[0]).toMatch(/not an http\(s\) URL/);
  });
});

describe('setWatchPlanTool.validateTerminal', () => {
  it('accepts a valid plan and explains an invalid one', () => {
    expect(setWatchPlanTool.validateTerminal!(input(), ctx([probe('https://acme.dev/rss', 'feed')]))).toBeNull();
    expect(setWatchPlanTool.validateTerminal!(input(), ctx([]))).toMatch(/never probed/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/agents/v2/tools/probe-source.test.ts server/src/agents/v2/tools/set-watch-plan.test.ts`
Expected: FAIL. Neither module exists yet.

- [ ] **Step 3: Implement `probe-source.ts`**

`server/src/agents/v2/tools/probe-source.ts`:

```ts
import type { ToolDefinition } from '../types.js';
import type { ProbeResult } from '../../../services/vendor-watch/types.js';
import { safeFetch, SafeFetchError, type SafeFetchOptions } from '../../../services/vendor-watch/safe-fetch.js';
import { htmlBlocks, parseFeed } from '../../../services/vendor-watch/normalize.js';
import { isOpenApiDoc, parseSpec } from '../../../services/vendor-watch/openapi.js';

/** Below this much text a page is a JavaScript shell or a stub, not a changelog. */
export const MIN_HTML_CHARS = 500;

export function detectKind(body: string, contentType: string): { kind: ProbeResult['detected_kind']; text: string } {
  const head = body.slice(0, 2000).toLowerCase();
  if (head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf')) {
    try {
      const entries = parseFeed(body);
      if (entries.length > 0) return { kind: 'feed', text: entries.map(e => `${e.title} — ${e.text}`).join('\n') };
    } catch {
      /* not a feed after all */
    }
  }
  if (!head.trimStart().startsWith('<')) {
    try {
      const doc = parseSpec(body);
      if (isOpenApiDoc(doc)) return { kind: 'openapi', text: Object.keys(doc.paths).slice(0, 40).join('\n') };
    } catch {
      /* not a spec */
    }
  }
  if (contentType.toLowerCase().includes('html') || head.includes('<html') || head.includes('<!doctype html')) {
    const text = htmlBlocks(body).map(b => b.text).join('\n');
    if (text.length >= MIN_HTML_CHARS) return { kind: 'html', text };
  }
  return { kind: 'unreadable', text: '' };
}

/** Fetch a candidate source exactly as a watch run will, and say whether it is usable. Never throws. */
export async function probeSource(url: string, opts: SafeFetchOptions = {}): Promise<ProbeResult> {
  try {
    const r = await safeFetch(url, opts);
    const { kind, text } = detectKind(r.body, r.contentType);
    const problem = r.status >= 400
      ? `HTTP ${r.status}`
      : kind === 'unreadable' ? 'No feed, OpenAPI document or readable HTML text (JavaScript-only page?)' : '';
    return {
      url, ok: !problem, status: r.status, final_url: r.finalUrl, content_type: r.contentType,
      detected_kind: kind, text_chars: text.length, sample: text.slice(0, 1500), problem,
    };
  } catch (err) {
    return {
      url, ok: false, status: null, final_url: url, content_type: '', detected_kind: 'unreadable', text_chars: 0, sample: '',
      problem: err instanceof SafeFetchError ? `${err.code}: ${err.message}` : String((err as Error)?.message || err),
    };
  }
}

export const probeSourceTool: ToolDefinition = {
  name: 'probe_source',
  description: 'Fetch a candidate vendor source URL the way the watcher will, and report whether it is readable and what kind it is (feed, openapi, html, unreadable). Every source in set_watch_plan must be probed first and come back ok.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL' },
      expected_kind: { type: 'string', enum: ['feed', 'openapi', 'html'], description: 'What you expect it to be' },
    },
    required: ['url'],
  },
  async handler(input, ctx) {
    const result = await probeSource(String(input.url || ''));
    if (!ctx.probedSources) ctx.probedSources = new Map();
    ctx.probedSources.set(result.url, result);
    if (result.final_url !== result.url) ctx.probedSources.set(result.final_url, result);
    return JSON.stringify(result);
  },
};
```

- [ ] **Step 4: Implement `set-watch-plan.ts`**

`server/src/agents/v2/tools/set-watch-plan.ts`:

```ts
import type { ToolContext, ToolDefinition } from '../types.js';
import type { EndpointRef } from '../../../services/vendor-watch/types.js';

export interface WatchPlanDraft {
  vendor_name: string;
  api_base_urls: string[];
  api_version: string;
  auth_type: string;
  endpoint_inventory: EndpointRef[];
  /** kind is checked by validateWatchPlan: feed | openapi | html. */
  sources: { kind: string; url: string; label: string }[];
  note: string;
}

export interface WatchPlanValidation {
  errors: string[];
  warnings: string[];
  plan: WatchPlanDraft;
}

export const MAX_SOURCES = 8;
const SOURCE_KINDS = new Set(['feed', 'openapi', 'html']);

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export function parseWatchPlanInput(input: Record<string, any>): WatchPlanDraft {
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  return {
    vendor_name: String(input.vendor_name ?? '').trim(),
    api_base_urls: arr(input.api_base_urls).map(u => String(u).trim()).filter(Boolean),
    api_version: String(input.api_version ?? '').trim(),
    auth_type: String(input.auth_type ?? '').trim(),
    endpoint_inventory: arr(input.endpoint_inventory)
      .filter(e => e && typeof e.target === 'string')
      .map(e => ({
        target: e.target,
        target_kind: e.target_kind === 'trigger' ? 'trigger' as const : 'action' as const,
        method: String(e.method ?? '').toUpperCase(),
        path: String(e.path ?? ''),
        ...(e.note ? { note: String(e.note) } : {}),
      })),
    sources: arr(input.sources)
      .filter(s => s && typeof s.url === 'string')
      .map(s => ({ kind: String(s.kind ?? ''), url: s.url.trim(), label: String(s.label ?? '').trim() })),
    note: String(input.note ?? '').trim(),
  };
}

/** The rules set_watch_plan enforces (spec §2). Unknown inventory targets are dropped with a warning, not an error. */
export function validateWatchPlan(draft: WatchPlanDraft, ctx: Pick<ToolContext, 'pieceMeta' | 'probedSources'>): WatchPlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (draft.api_base_urls.length === 0) errors.push('api_base_urls: add at least one URL (the liveness check uses the first).');
  for (const u of draft.api_base_urls) if (!isHttpUrl(u)) errors.push(`api_base_urls: "${u}" is not an http(s) URL.`);
  if (draft.sources.length === 0) errors.push('sources: add at least one feed, openapi or html source.');
  if (draft.sources.length > MAX_SOURCES) errors.push(`sources: at most ${MAX_SOURCES}, got ${draft.sources.length}.`);
  const seen = new Set<string>();
  for (const s of draft.sources) {
    if (seen.has(s.url)) {
      errors.push(`sources: "${s.url}" is listed twice.`);
      continue;
    }
    seen.add(s.url);
    if (!SOURCE_KINDS.has(s.kind)) {
      errors.push(`sources: "${s.url}" has kind "${s.kind}"; use feed, openapi or html (liveness is added for you).`);
      continue;
    }
    const p = ctx.probedSources?.get(s.url);
    if (!p) errors.push(`sources: "${s.url}" was never probed. Call probe_source on it first.`);
    else if (!p.ok) errors.push(`sources: "${s.url}" is unreadable (${p.problem}). Drop it or find another URL.`);
    else if (p.detected_kind !== s.kind) errors.push(`sources: "${s.url}" probed as "${p.detected_kind}", not "${s.kind}".`);
  }
  const actions = new Set(Object.keys(ctx.pieceMeta.actions ?? {}));
  const triggers = new Set(Object.keys(ctx.pieceMeta.triggers ?? {}));
  const kept: EndpointRef[] = [];
  for (const e of draft.endpoint_inventory) {
    const known = e.target_kind === 'trigger' ? triggers.has(e.target) : actions.has(e.target);
    if (known) kept.push(e);
    else warnings.push(`endpoint_inventory: dropped "${e.target}" — not a ${e.target_kind} of this piece.`);
  }
  return { errors, warnings, plan: { ...draft, endpoint_inventory: kept } };
}

export const setWatchPlanTool: ToolDefinition = {
  name: 'set_watch_plan',
  description: 'Save the watch plan. Call it once, at the end, after every source has been probed ok. If it is rejected, fix the listed problems and call it again.',
  input_schema: {
    type: 'object' as const,
    properties: {
      vendor_name: { type: 'string' },
      api_base_urls: { type: 'array', items: { type: 'string' }, description: 'API base URL(s) the piece calls, e.g. ["https://api.stripe.com/v1"]. The first is used for the liveness check.' },
      api_version: { type: 'string', description: 'API version the piece targets, e.g. "v3" or "2024-06-20". Empty if none.' },
      auth_type: { type: 'string', description: 'e.g. "OAuth2", "API key (header)", "Basic"' },
      endpoint_inventory: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Action or trigger name exactly as in the piece, e.g. "send_message"' },
            target_kind: { type: 'string', enum: ['action', 'trigger'] },
            method: { type: 'string', description: 'HTTP method, or "SDK" for vendor SDK calls' },
            path: { type: 'string', description: 'Path with {} for parameters, e.g. "/v1/customers/{}"; for SDK calls "sdk:<package>#<method>"' },
            note: { type: 'string' },
          },
          required: ['target', 'target_kind', 'method', 'path'],
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['feed', 'openapi', 'html'] },
            url: { type: 'string' },
            label: { type: 'string', description: 'Short name, e.g. "Stripe API changelog (RSS)"' },
          },
          required: ['kind', 'url', 'label'],
        },
      },
      note: { type: 'string', description: 'One or two plain sentences for the team: what you found and what is missing.' },
    },
    required: ['vendor_name', 'api_base_urls', 'endpoint_inventory', 'sources', 'note'],
  },
  validateTerminal(input, ctx) {
    const v = validateWatchPlan(parseWatchPlanInput(input), ctx);
    return v.errors.length ? v.errors.join('\n') : null;
  },
  async handler() {
    return 'Watch plan saved.';
  },
};
```

- [ ] **Step 5: Register the tools**

In `server/src/agents/v2/tools/index.ts`:

1. Add the imports:

```ts
import { probeSourceTool } from './probe-source.js';
import { setWatchPlanTool } from './set-watch-plan.js';
```

2. Add the tool list after `FIXER_TOOLS_MCP`:

```ts
/** Tools for the vendor watch planner. web_search is an Anthropic server tool, passed separately. */
export const WATCH_PLANNER_TOOLS = [
  TOOL_NAMES.FETCH_PIECE_SOURCE,
  TOOL_NAMES.FETCH_ACTION_SOURCE,
  TOOL_NAMES.FETCH_TRIGGER_SOURCE,
  TOOL_NAMES.LIST_ACTIONS,
  TOOL_NAMES.LIST_TRIGGERS,
  TOOL_NAMES.PROBE_SOURCE,
  TOOL_NAMES.SET_WATCH_PLAN,
] as const;
```

3. In `createToolRegistry()`, before `return registry;`, add:

```ts
  registry.register(probeSourceTool);
  registry.register(setWatchPlanTool);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/src/agents/v2/tools/probe-source.test.ts server/src/agents/v2/tools/set-watch-plan.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/agents/v2/tools/probe-source.ts server/src/agents/v2/tools/set-watch-plan.ts server/src/agents/v2/tools/index.ts server/src/agents/v2/tools/probe-source.test.ts server/src/agents/v2/tools/set-watch-plan.test.ts
git commit -m "feat(agents): add probe_source and set_watch_plan tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Watch-planner agent and plan generation

**Files:**
- Create: `server/src/agents/v2/prompts/watch-planner.ts`
- Create: `server/src/agents/v2/workers/watch-planner.ts`
- Create: `server/src/services/vendor-watch/generate.ts`
- Test: `server/src/agents/v2/workers/watch-planner.test.ts`
- Test: `server/src/services/vendor-watch/generate.test.ts`

**Interfaces:**
- Consumes:
  - from Task 10: `runAgentLoop` with `serverTools`/`disableMcp`/`client`
  - from Task 11: `WATCH_PLANNER_TOOLS`, `parseWatchPlanInput`, `validateWatchPlan`, `WatchPlanValidation`
  - from Task 8: `startWatchRun`
  - from Task 1: plan/source queries
  - existing: `submitPieceUnit` (`batch-scheduler.ts`), `createClient().getPieceMetadata`
- Produces:
  - `WATCH_PLANNER_SYSTEM_PROMPT`, `buildWatchPlannerUserPrompt(meta)`
  - `WEB_SEARCH_TOOL`, `runWatchPlannerWorker({ pieceMeta, onLog, abortSignal?, costTracker?, client? }): Promise<WatchPlanValidation | null>`
  - `type GenerateDeps = { getPieceMetadata, runWorker, startBaseline }`
  - `generateWatchPlan(pieceName, deps?): Promise<WatchPlanRow>` (never throws)
  - `generateWatchPlansInBackground(pieceNames, deps?): number[]`

- [ ] **Step 1: Write the failing tests**

`server/src/agents/v2/workers/watch-planner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runWatchPlannerWorker, WEB_SEARCH_TOOL } from './watch-planner.js';
import type { MessagesClient } from '../../../services/anthropic-client.js';

const meta = {
  name: '@activepieces/piece-acme', displayName: 'Acme', description: 'Acme API', logoUrl: '', version: '0.5.0',
  actions: { send_message: { name: 'send_message', displayName: 'Send message', description: '', requireAuth: true, props: {} } },
  triggers: {}, pieceType: 'OFFICIAL', packageType: 'REGISTRY',
} as any;

describe('runWatchPlannerWorker', () => {
  it('offers web_search with the planner tools, rejects an unprobed plan, and returns null when the agent gives up', async () => {
    const calls: any[] = [];
    const responses = [
      { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'set_watch_plan', input: {
        vendor_name: 'Acme', api_base_urls: ['https://api.acme.dev'], endpoint_inventory: [],
        sources: [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' }], note: '',
      } }] },
      { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'I could not verify any source.' }] },
    ];
    const client: MessagesClient = { messages: { create: async (body: any) => { calls.push(JSON.parse(JSON.stringify(body))); return responses.shift(); } } };

    const result = await runWatchPlannerWorker({ pieceMeta: meta, onLog: () => {}, client });

    expect(result).toBeNull();
    const names = calls[0].tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['fetch_piece_source', 'fetch_trigger_source', 'probe_source', 'set_watch_plan', 'web_search']));
    expect(calls[0].tools.find((t: any) => t.name === 'web_search')).toEqual(WEB_SEARCH_TOOL);
    expect(calls[0].system[0].text).toContain('WATCH PLAN');
    expect(calls[0].messages[0].content[0].text).toContain('- send_message: Send message');
    const feedback = calls[1].messages[calls[1].messages.length - 1].content[0];
    expect(feedback).toMatchObject({ is_error: true });
    expect(feedback.content).toContain('never probed');
  });
});
```

`server/src/services/vendor-watch/generate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { beginPlanGeneration, completePlanGeneration, getPlan, listSources } from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult } from '../../db/vendor-watch-test-utils.js';
import { generateWatchPlan, generateWatchPlansInBackground, type GenerateDeps } from './generate.js';
import type { WatchPlanValidation } from '../../agents/v2/tools/set-watch-plan.js';

const meta = (name: string) => ({
  name, displayName: 'Acme', description: '', logoUrl: '', version: '0.6.0', actions: {}, triggers: {},
  pieceType: 'OFFICIAL', packageType: 'REGISTRY',
}) as any;

const good: WatchPlanValidation = {
  errors: [],
  warnings: ['endpoint_inventory: dropped "ghost"'],
  plan: {
    vendor_name: 'Acme', api_base_urls: ['https://api.acme.dev/v1'], api_version: 'v1', auth_type: 'API key',
    endpoint_inventory: [{ target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' }],
    sources: [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS' }],
    note: 'Found an RSS changelog.',
  },
};

function deps(over: Partial<GenerateDeps> = {}) {
  const baselines: number[] = [];
  const d: Partial<GenerateDeps> = {
    getPieceMetadata: async (name) => meta(name),
    runWorker: async () => good,
    startBaseline: (id) => { baselines.push(id); },
    ...over,
  };
  return { d, baselines };
}

describe('generateWatchPlan', () => {
  beforeEach(resetVendorWatch);

  it('saves the plan, puts the liveness source first, and starts the baseline', async () => {
    const { d, baselines } = deps();
    const plan = await generateWatchPlan('@activepieces/piece-acme', d);
    expect(plan).toMatchObject({ status: 'active', piece_version: '0.6.0', piece_display_name: 'Acme', vendor_name: 'Acme' });
    expect(plan.generation_note).toBe('Found an RSS changelog.\nendpoint_inventory: dropped "ghost"');
    expect(listSources(plan.id).map(s => [s.kind, s.url])).toEqual([['liveness', 'https://api.acme.dev/v1'], ['feed', 'https://acme.dev/rss']]);
    expect(baselines).toEqual([plan.id]);
  });

  it('fails a first generation that saves nothing, and keeps a regenerated plan running as stale', async () => {
    const first = await generateWatchPlan('@activepieces/piece-new', deps({ runWorker: async () => null }).d);
    expect(first.status).toBe('failed');
    expect(first.generation_note).toMatch(/without saving/);

    const p = beginPlanGeneration('@activepieces/piece-old');
    completePlanGeneration(p.id, samplePlanResult());
    const again = await generateWatchPlan('@activepieces/piece-old', deps({ getPieceMetadata: async () => { throw new Error('catalog down'); } }).d);
    expect(again).toMatchObject({ status: 'stale', generation_note: 'catalog down' });
  });
});

describe('generateWatchPlansInBackground', () => {
  beforeEach(resetVendorWatch);

  it('dedupes names, skips plans already generating, and finishes in the background', async () => {
    const busy = beginPlanGeneration('@activepieces/piece-busy');
    let calls = 0;
    const { d } = deps({ runWorker: async () => { calls++; return good; } });
    const ids = generateWatchPlansInBackground(['@activepieces/piece-a', '@activepieces/piece-a', '@activepieces/piece-busy'], d);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(busy.id);
    expect(getPlan(ids[0])!.status).toBe('generating');
    for (let i = 0; i < 100 && getPlan(ids[0])!.status === 'generating'; i++) await new Promise(r => setTimeout(r, 10));
    expect(getPlan(ids[0])!.status).toBe('active');
    expect(calls).toBe(1);
    expect(getPlan(busy.id)!.status).toBe('generating');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/agents/v2/workers/watch-planner.test.ts server/src/services/vendor-watch/generate.test.ts`
Expected: FAIL. The modules do not exist yet.

- [ ] **Step 3: Write the prompt**

`server/src/agents/v2/prompts/watch-planner.ts`:

```ts
import type { PieceMetadataFull } from '../../../services/ap-client.js';

export const WATCH_PLANNER_SYSTEM_PROMPT = `You build a vendor WATCH PLAN for one Activepieces piece. The plan lets the Piece Tester notice when the vendor changes its API in a way that breaks the piece.

## Your tools
- fetch_piece_source / fetch_action_source / fetch_trigger_source / list_actions / list_triggers: read the piece.
- web_search: find the vendor's official pages.
- probe_source: fetch a candidate URL exactly as the watcher will. Only sources that probe ok can be saved.
- set_watch_plan: save the plan (terminal). If it is rejected, fix the listed problems and call it again.

## Step 1 — Endpoint inventory
Read the piece source: index.ts, the common/ helpers, every action and trigger. Record:
- api_base_urls: the base URL(s) the piece calls. The first must be the main API host.
- api_version and auth_type.
- endpoint_inventory: for EVERY action and trigger, each HTTP call it makes, as method + path with {} for path parameters (e.g. "/v1/customers/{}") and WITHOUT the host. If the piece calls a vendor SDK instead of raw HTTP, use method "SDK" and path "sdk:<package>#<method>" (e.g. "sdk:@slack/web-api#chat.postMessage"). Skip the generic Custom API Call action.

## Step 2 — Find sources
Search for the vendor's OFFICIAL:
1. API changelog. Prefer an RSS/Atom feed: look for /rss, /feed, /atom.xml, or a feed link on the changelog page.
2. GitHub releases of the vendor's official OpenAPI spec repo or official SDK: https://github.com/<org>/<repo>/releases.atom
3. OpenAPI spec as a raw JSON or YAML URL (e.g. on raw.githubusercontent.com).
4. API deprecation / sunset / versioning policy page, and the HTML changelog page when there is no feed.
Never use third-party aggregators, blogs, or status pages.

## Step 3 — Verify
Call probe_source on every candidate. Keep only sources that come back ok with the kind you expect. JavaScript-only docs sites come back "unreadable": look for their feed or GitHub source instead.
Aim for 2–5 sources, at most 8. At least one is required.

## Finish
Call set_watch_plan once. In note, say in one or two plain sentences what you found and what is missing (e.g. "No changelog feed; watching the HTML changelog and the OpenAPI spec.").`;

export function buildWatchPlannerUserPrompt(piece: PieceMetadataFull): string {
  const list = (entries: [string, { displayName?: string }][]) =>
    entries.length ? entries.map(([name, t]) => `- ${name}: ${t.displayName ?? name}`).join('\n') : '- (none)';
  return [
    `Piece: ${piece.displayName} (${piece.name} v${piece.version})`,
    `Description: ${piece.description || '(none)'}`,
    `Auth: ${piece.auth?.type ?? 'none'}`,
    '',
    'Actions:',
    list(Object.entries(piece.actions ?? {})),
    '',
    'Triggers:',
    list(Object.entries(piece.triggers ?? {})),
    '',
    'Build the watch plan.',
  ].join('\n');
}
```

- [ ] **Step 4: Write the worker**

`server/src/agents/v2/workers/watch-planner.ts`:

```ts
import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { MessagesClient } from '../../../services/anthropic-client.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, WATCH_PLANNER_TOOLS } from '../tools/index.js';
import { WATCH_PLANNER_SYSTEM_PROMPT, buildWatchPlannerUserPrompt } from '../prompts/watch-planner.js';
import { parseWatchPlanInput, validateWatchPlan, type WatchPlanValidation } from '../tools/set-watch-plan.js';
import type { CostTracker } from '../cost-tracker.js';
import type { OnLogCallback, ToolContext } from '../types.js';

export const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 10 } as const;

/** Run the watch planner. Returns the validated plan, or null when the agent never saved one. */
export async function runWatchPlannerWorker(params: {
  pieceMeta: PieceMetadataFull;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker;
  client?: MessagesClient;
}): Promise<WatchPlanValidation | null> {
  const toolCtx: ToolContext = { pieceMeta: params.pieceMeta, actionName: '', abortSignal: params.abortSignal, probedSources: new Map() };
  const result = await runAgentLoop(createToolRegistry(), {
    role: 'watch_planner',
    model: '',
    systemPrompt: WATCH_PLANNER_SYSTEM_PROMPT,
    initialMessages: [{ role: 'user', content: buildWatchPlannerUserPrompt(params.pieceMeta) }],
    maxIterations: 30,
    toolNames: [...WATCH_PLANNER_TOOLS],
    serverTools: [WEB_SEARCH_TOOL],
    disableMcp: true,
    abortSignal: params.abortSignal,
    onLog: params.onLog,
    client: params.client,
  }, toolCtx, params.costTracker);
  if (!result.terminatedByTool || !result.output) return null;
  return validateWatchPlan(parseWatchPlanInput(result.output as Record<string, any>), toolCtx);
}
```

`model: ''` makes the runner fall back to `settings.ai_model`.

- [ ] **Step 5: Write the generation service**

`server/src/services/vendor-watch/generate.ts`:

```ts
import {
  beginPlanGeneration, completePlanGeneration, failPlanGeneration, getPlan, getPlanByPiece, replaceSources,
  type SourceInput, type WatchPlanRow,
} from '../../db/vendor-watch-queries.js';
import { CostTracker } from '../../agents/v2/cost-tracker.js';
import { runWatchPlannerWorker } from '../../agents/v2/workers/watch-planner.js';
import type { PieceMetadataFull } from '../ap-client.js';
import { submitPieceUnit } from '../batch-scheduler.js';
import { createClient } from '../test-engine.js';
import { startWatchRun } from './runner.js';
import type { SourceKind } from './types.js';

export interface GenerateDeps {
  getPieceMetadata: (name: string) => Promise<PieceMetadataFull>;
  runWorker: typeof runWatchPlannerWorker;
  startBaseline: (planId: number) => void;
}

function defaultDeps(): GenerateDeps {
  return {
    getPieceMetadata: (name) => createClient().getPieceMetadata(name),
    runWorker: runWatchPlannerWorker,
    startBaseline: (planId) => {
      startWatchRun(planId, 'baseline').done.catch(err => console.error(`[vendor-watch] baseline for plan ${planId} failed:`, err));
    },
  };
}

/** Generate (or regenerate) one piece's watch plan. Resolves with the final row and never throws. */
export async function generateWatchPlan(pieceName: string, deps: Partial<GenerateDeps> = {}): Promise<WatchPlanRow> {
  const d: GenerateDeps = { ...defaultDeps(), ...deps };
  const plan = beginPlanGeneration(pieceName);
  const tracker = new CostTracker({ pieceName, actionName: '', operation: 'vendor_watch_generate', version: 'vendor-watch-1' });
  const agentErrors: string[] = [];
  try {
    const meta = await d.getPieceMetadata(pieceName);
    const result = await d.runWorker({
      pieceMeta: meta,
      costTracker: tracker,
      onLog: (l) => { if (l.type === 'error') agentErrors.push(l.message); },
    });
    const cost = tracker.getTotals().cost_usd;
    if (!result) {
      return failPlanGeneration(plan.id, agentErrors.slice(-3).join('\n') || 'The agent finished without saving a watch plan.', cost);
    }
    if (result.errors.length) return failPlanGeneration(plan.id, `Watch plan rejected: ${result.errors.join('; ')}`, cost);
    const p = result.plan;
    completePlanGeneration(plan.id, {
      piece_version: meta.version,
      piece_display_name: meta.displayName,
      vendor_name: p.vendor_name,
      api_base_urls: p.api_base_urls,
      api_version: p.api_version,
      auth_type: p.auth_type,
      endpoint_inventory: p.endpoint_inventory,
      generation_note: [p.note, ...result.warnings].filter(Boolean).join('\n'),
      generation_cost_usd: cost,
    });
    const sources: SourceInput[] = [
      { kind: 'liveness', url: p.api_base_urls[0], label: 'API host' },
      ...p.sources.map(s => ({ kind: s.kind as SourceKind, url: s.url, label: s.label })),
    ];
    replaceSources(plan.id, sources);
    d.startBaseline(plan.id);
    return getPlan(plan.id)!;
  } catch (err: any) {
    return failPlanGeneration(plan.id, String(err?.message || err), tracker.getTotals().cost_usd);
  }
}

/** Queue generation for many pieces on the shared AI concurrency cap. Returns the plan ids at once. */
export function generateWatchPlansInBackground(pieceNames: string[], deps: Partial<GenerateDeps> = {}): number[] {
  const batchId = `vw-${Date.now()}`;
  const ids: number[] = [];
  for (const name of new Set(pieceNames.map(n => n.trim()).filter(Boolean))) {
    const existing = getPlanByPiece(name);
    if (existing?.status === 'generating') {
      ids.push(existing.id);
      continue;
    }
    ids.push(beginPlanGeneration(name).id);
    void submitPieceUnit(batchId, async () => { await generateWatchPlan(name, deps); });
  }
  return ids;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/src/agents/v2/workers/watch-planner.test.ts server/src/services/vendor-watch/generate.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/agents/v2/prompts/watch-planner.ts server/src/agents/v2/workers/watch-planner.ts server/src/services/vendor-watch/generate.ts server/src/agents/v2/workers/watch-planner.test.ts server/src/services/vendor-watch/generate.test.ts
git commit -m "feat(vendor-watch): generate watch plans with an agent" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: API routes

**Files:**
- Create: `server/src/services/vendor-watch/config.ts`
- Create: `server/src/routes/vendor-watch.ts`
- Modify: `server/src/index.ts` (mount the router)
- Test: `server/src/services/vendor-watch/config.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–12. `LinearError` from `bug-trend/linear-client.ts`.
- Produces: `parseConfigPatch(body) → { patch, error? }`, plus the HTTP API from spec §6 under `/api/vendor-watch`. The JSON shapes are the row types from Task 1, except:
  - `GET /plans/by-piece/:name` → `(WatchPlanRow & { open_findings: number }) | null`
  - `GET /plans/:id` → `{ plan, sources, runs }`
  - `GET /findings/:id/draft` → `FilingPreview`
  - `POST /plans/generate` → `{ plan_id }`, and `/plans/generate-batch` → `{ plan_ids }`
  - `POST /plans/:id/run` → `{ run_id }`
  - `POST /run-cycle` → `{ started: true }`
  - `POST /config/test-linear` → `{ ok, team, state, label }`

- [ ] **Step 1: Write the failing config tests**

`server/src/services/vendor-watch/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseConfigPatch } from './config.js';

describe('parseConfigPatch', () => {
  it('accepts a full valid patch and normalizes flags and the team key', () => {
    expect(parseConfigPatch({
      enabled: true, auto_file_enabled: 0, cron_expression: '0 5 * * *', timezone: 'Asia/Amman',
      linear_team_key: 'pie', linear_label: 'vendor-watch', classifier_model: '', dead_after_failures: 4,
    })).toEqual({ patch: {
      enabled: 1, auto_file_enabled: 0, cron_expression: '0 5 * * *', timezone: 'Asia/Amman',
      linear_team_key: 'PIE', linear_label: 'vendor-watch', classifier_model: '', dead_after_failures: 4,
    } });
  });

  it('returns an empty patch for an empty body', () => {
    expect(parseConfigPatch({})).toEqual({ patch: {} });
  });

  it.each([
    [{ cron_expression: 'every day' }, /Invalid cron/],
    [{ timezone: 'Mars/Olympus' }, /Unknown timezone/],
    [{ linear_team_key: 'p-1' }, /team key/],
    [{ linear_label: '' }, /1–80/],
    [{ linear_label: 'piece-tester' }, /Bug Trend/],
    [{ dead_after_failures: 0 }, /1 to 30/],
    [{ dead_after_failures: 2.5 }, /1 to 30/],
  ])('rejects %j', (body, message) => {
    expect(parseConfigPatch(body).error).toMatch(message);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/src/services/vendor-watch/config.test.ts`
Expected: FAIL. `./config.js` does not exist yet.

- [ ] **Step 3: Implement `config.ts`**

`server/src/services/vendor-watch/config.ts`:

```ts
import cron from 'node-cron';
import type { WatchConfigPatch } from '../../db/vendor-watch-queries.js';

/** Validate a PUT /config body. Only fields present in the body end up in the patch. */
export function parseConfigPatch(body: Record<string, unknown>): { patch: WatchConfigPatch; error?: string } {
  const patch: WatchConfigPatch = {};
  const flag = (v: unknown) => (v === true || v === 1 || v === '1' ? 1 : 0);
  if (body.enabled !== undefined) patch.enabled = flag(body.enabled);
  if (body.auto_file_enabled !== undefined) patch.auto_file_enabled = flag(body.auto_file_enabled);
  if (body.cron_expression !== undefined) {
    const v = String(body.cron_expression).trim();
    if (!cron.validate(v)) return { patch, error: `Invalid cron expression: "${v}"` };
    patch.cron_expression = v;
  }
  if (body.timezone !== undefined) {
    const v = String(body.timezone).trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
    } catch {
      return { patch, error: `Unknown timezone: "${v}"` };
    }
    patch.timezone = v;
  }
  if (body.linear_team_key !== undefined) {
    const v = String(body.linear_team_key).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(v)) return { patch, error: 'Linear team key must look like PIE' };
    patch.linear_team_key = v;
  }
  if (body.linear_label !== undefined) {
    const v = String(body.linear_label).trim();
    if (!v || v.length > 80) return { patch, error: 'Linear label must be 1–80 characters' };
    if (v === 'piece-tester') return { patch, error: 'Do not use the piece-tester label: Bug Trend counts those issues as tester bugs' };
    patch.linear_label = v;
  }
  if (body.classifier_model !== undefined) {
    const v = String(body.classifier_model).trim();
    if (v.length > 100) return { patch, error: 'Model name is too long' };
    patch.classifier_model = v;
  }
  if (body.dead_after_failures !== undefined) {
    const n = Number(body.dead_after_failures);
    if (!Number.isInteger(n) || n < 1 || n > 30) return { patch, error: 'dead_after_failures must be a whole number from 1 to 30' };
    patch.dead_after_failures = n;
  }
  return { patch };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/src/services/vendor-watch/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the router**

`server/src/routes/vendor-watch.ts`:

```ts
import { Router } from 'express';
import { getSettings } from '../db/queries.js';
import {
  countOpenFindings, deletePlan, dismissFinding, getFinding, getPlan, getPlanByPiece, getSource, getWatchConfig,
  listFindings, listPlans, listRuns, listSources, setPlanStatus, setSourceEnabled, updateWatchConfig,
} from '../db/vendor-watch-queries.js';
import type { FindingStatus } from '../services/vendor-watch/types.js';
import { LinearError } from '../services/bug-trend/linear-client.js';
import { parseConfigPatch } from '../services/vendor-watch/config.js';
import { isCycleRunning, reloadVendorWatch, runWatchCycle } from '../services/vendor-watch/cron.js';
import { fileFinding, previewFiling } from '../services/vendor-watch/filing.js';
import { generateWatchPlansInBackground } from '../services/vendor-watch/generate.js';
import { clearLinearTargetCache, resolveLinearTargets } from '../services/vendor-watch/linear-filer.js';
import { startWatchRun } from '../services/vendor-watch/runner.js';

const router = Router();
const MAX_BATCH = 100;
const FINDING_STATUSES: FindingStatus[] = ['new', 'filed', 'dismissed'];

const idParam = (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ── Config ──

router.get('/config', (_req, res) => {
  res.json(getWatchConfig());
});

router.put('/config', (req, res) => {
  const { patch, error } = parseConfigPatch(req.body ?? {});
  if (error) { res.status(400).json({ error }); return; }
  const row = updateWatchConfig(patch);
  if (patch.linear_team_key !== undefined || patch.linear_label !== undefined) clearLinearTargetCache();
  reloadVendorWatch();
  res.json(row);
});

// Read-only: resolves team, triage state and label with the saved key. Never writes to Linear.
router.post('/config/test-linear', async (_req, res) => {
  try {
    const c = getWatchConfig();
    clearLinearTargetCache();
    const t = await resolveLinearTargets(getSettings().linear_api_key, c.linear_team_key, c.linear_label);
    res.json({ ok: true, team: c.linear_team_key, state: t.stateName, label: t.labelName });
  } catch (err: any) {
    res.status(err instanceof LinearError ? 400 : 500).json({ ok: false, error: err.message });
  }
});

// ── Plans ──

router.get('/plans', (_req, res) => {
  res.json(listPlans());
});

router.get('/plans/by-piece/:pieceName', (req, res) => {
  const plan = getPlanByPiece(req.params.pieceName);
  res.json(plan ? { ...plan, open_findings: countOpenFindings(plan.piece_name) } : null);
});

router.get('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  res.json({ plan, sources: listSources(plan.id), runs: listRuns(plan.id, 20) });
});

router.post('/plans/generate', (req, res) => {
  const name = typeof req.body?.piece_name === 'string' ? req.body.piece_name.trim() : '';
  if (!name) { res.status(400).json({ error: 'piece_name is required' }); return; }
  const [plan_id] = generateWatchPlansInBackground([name]);
  res.status(202).json({ plan_id });
});

router.post('/plans/generate-batch', (req, res) => {
  const names: string[] = Array.isArray(req.body?.piece_names)
    ? req.body.piece_names.filter((n: unknown): n is string => typeof n === 'string' && n.trim() !== '')
    : [];
  if (names.length === 0) { res.status(400).json({ error: 'piece_names must be a non-empty list' }); return; }
  if (names.length > MAX_BATCH) { res.status(400).json({ error: `At most ${MAX_BATCH} pieces per batch` }); return; }
  res.status(202).json({ plan_ids: generateWatchPlansInBackground(names) });
});

router.post('/plans/:id/run', (req, res) => {
  const id = idParam(req.params.id);
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  if (plan.status === 'generating' || plan.status === 'failed') {
    res.status(409).json({ error: `Plan is ${plan.status}; generate it first` });
    return;
  }
  const handle = startWatchRun(plan.id, 'manual');
  handle.done.catch(err => console.error(`[vendor-watch] manual run of plan ${plan.id} failed:`, err));
  res.status(202).json({ run_id: handle.runId });
});

router.patch('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const status = req.body?.status;
  if (status !== 'active' && status !== 'paused') { res.status(400).json({ error: "status must be 'active' or 'paused'" }); return; }
  const plan = id ? getPlan(id) : undefined;
  if (!plan) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  if (plan.status === 'generating') { res.status(409).json({ error: 'Plan is generating' }); return; }
  res.json(setPlanStatus(plan.id, status));
});

router.delete('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (!id || !deletePlan(id)) { res.status(404).json({ error: 'Watch plan not found' }); return; }
  res.json({ ok: true });
});

router.patch('/sources/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (!id || !getSource(id)) { res.status(404).json({ error: 'Source not found' }); return; }
  res.json(setSourceEnabled(id, !!req.body?.enabled));
});

router.post('/run-cycle', (_req, res) => {
  if (isCycleRunning()) { res.status(409).json({ error: 'A watch cycle is already running' }); return; }
  runWatchCycle().catch(err => console.error('[vendor-watch] manual cycle failed:', err));
  res.status(202).json({ started: true });
});

// ── Findings ──

router.get('/findings', (req, res) => {
  const status = FINDING_STATUSES.find(s => s === req.query.status);
  const piece = typeof req.query.piece === 'string' && req.query.piece ? req.query.piece : undefined;
  res.json(listFindings({ status, piece }));
});

router.get('/findings/:id/draft', (req, res) => {
  const id = idParam(req.params.id);
  if (!id || !getFinding(id)) { res.status(404).json({ error: 'Finding not found' }); return; }
  res.json(previewFiling(id));
});

router.post('/findings/:id/file', async (req, res) => {
  const id = idParam(req.params.id);
  if (!id || !getFinding(id)) { res.status(404).json({ error: 'Finding not found' }); return; }
  const { title, description, priority } = req.body ?? {};
  try {
    const row = await fileFinding(id, {
      filedBy: 'manual',
      override: {
        title: typeof title === 'string' ? title.slice(0, 200) : undefined,
        description: typeof description === 'string' ? description : undefined,
        priority: [0, 1, 2, 3, 4].includes(priority) ? priority : undefined,
      },
    });
    res.json(row);
  } catch (err: any) {
    res.status(err instanceof LinearError ? 502 : 400).json({ error: err.message });
  }
});

router.post('/findings/:id/dismiss', (req, res) => {
  const id = idParam(req.params.id);
  const before = id ? getFinding(id) : undefined;
  if (!before) { res.status(404).json({ error: 'Finding not found' }); return; }
  if (before.status !== 'new') { res.status(409).json({ error: `Finding is already ${before.status}` }); return; }
  res.json(dismissFinding(before.id));
});

export default router;
```

- [ ] **Step 6: Mount the router**

In `server/src/index.ts`, add the import next to `bugTrendRoutes`:

```ts
import vendorWatchRoutes from './routes/vendor-watch.js';
```

and after `app.use('/api/bug-trend', bugTrendRoutes);` add:

```ts
app.use('/api/vendor-watch', vendorWatchRoutes);
```

- [ ] **Step 7: Typecheck, test, and smoke-test the routes**

Run: `npx tsc --noEmit -p tsconfig.json && npm test`
Expected: no type errors; all tests pass.

Smoke-test against a scratch DB, with no keys and no network:

```bash
DB_PATH=./data/vw-smoke.db APP_AUTH_PASSWORD=smoke SESSION_SECRET=smoke-secret-smoke-secret PORT=4555 npx tsx server/src/index.ts &
sleep 4
curl -s -c /tmp/vw.cookies -H 'content-type: application/json' -d '{"password":"smoke"}' localhost:4555/api/auth/login
curl -s -b /tmp/vw.cookies localhost:4555/api/vendor-watch/config
curl -s -b /tmp/vw.cookies -X PUT -H 'content-type: application/json' -d '{"linear_label":"piece-tester"}' localhost:4555/api/vendor-watch/config
curl -s -b /tmp/vw.cookies localhost:4555/api/vendor-watch/plans/by-piece/%40activepieces%2Fpiece-slack
kill %1; rm -f ./data/vw-smoke.db* /tmp/vw.cookies
```

Expected, in order:
1. login → `{"success":true}`
2. config → the default row (`"enabled":0`, `"linear_label":"vendor-watch"`)
3. the PUT → `{"error":"Do not use the piece-tester label: …"}`
4. by-piece → `null`

If the login route or env var names differ, check `server/src/routes/auth.ts` and `.env.example` and adjust only the smoke command.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/vendor-watch/config.ts server/src/services/vendor-watch/config.test.ts server/src/routes/vendor-watch.ts server/src/index.ts
git commit -m "feat(vendor-watch): add the /api/vendor-watch routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Client API, helpers, and the Inbox/Filed tabs

**Files:**
- Modify: `client/src/lib/api.ts` (types + methods)
- Create: `client/src/lib/vendorWatch.ts`
- Test: `client/src/lib/vendorWatch.test.ts`
- Create: `client/src/components/vendor-watch/FindingsTable.tsx`
- Create: `client/src/components/vendor-watch/FileFindingModal.tsx`
- Create: `client/src/pages/VendorWatch.tsx`
- Modify: `client/src/App.tsx` (lazy route), `client/src/components/Layout.tsx` (nav)

**Interfaces:**
- Consumes: the HTTP API from Task 13.
- Produces:
  - client types: `VwConfig`, `VwConfigPatch`, `VwPlan`, `VwSource`, `VwRun`, `VwFinding`, `VwDraft`, `VwPlanStatus`, `VwSourceKind`, `VwFindingKind`, `VwSeverity`, `VwFindingStatus`
  - `api.vw*` methods (listed in Step 3)
  - helpers: `KIND_LABEL`, `SEVERITY_CLASS`, `PLAN_STATUS_CLASS`, `PRIORITY_LABEL`, `shortPieceName`, `parseJsonArray`, `describeTargets`, `sourceHealth`, `effectiveLabel`
  - the `VendorWatch` page, whose tabs (`inbox`, `filed`, `watchers`, `config`) are selected by `?tab=` and filtered by `?piece=`. The `watchers` and `config` tabs render components from Task 15.

- [ ] **Step 1: Write the failing helper tests**

`client/src/lib/vendorWatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { describeTargets, effectiveLabel, parseJsonArray, shortPieceName, sourceHealth } from './vendorWatch';

describe('vendorWatch helpers', () => {
  it('describes targets', () => {
    expect(describeTargets('["*"]')).toBe('whole piece');
    expect(describeTargets('["a","b"]')).toBe('a, b');
    expect(describeTargets('[]')).toBe('—');
    expect(describeTargets('nope')).toBe('—');
  });

  it('labels effective dates relative to today', () => {
    const today = new Date('2026-10-06T20:00:00Z');
    expect(effectiveLabel('2026-10-16', today)).toBe('2026-10-16 (in 10d)');
    expect(effectiveLabel('2026-10-01', today)).toBe('2026-10-01 (5d ago)');
    expect(effectiveLabel('2026-10-06', today)).toBe('2026-10-06 (today)');
    expect(effectiveLabel(null, today)).toBe('—');
  });

  it('classifies source health, counting a noted error as failing', () => {
    expect(sourceHealth({ last_checked_at: null, consecutive_failures: 0, last_error: '' })).toBe('never');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 0, last_error: '' })).toBe('ok');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 2, last_error: 'HTTP 500' })).toBe('failing');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 0, last_error: 'Timed out' })).toBe('failing');
  });

  it('parses JSON arrays defensively and shortens piece names', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(shortPieceName('@activepieces/piece-slack')).toBe('slack');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run client/src/lib/vendorWatch.test.ts`
Expected: FAIL. `./vendorWatch` does not exist yet.

- [ ] **Step 3: Add the client types and API methods**

In `client/src/lib/api.ts`, directly above `export const api = {`, add:

```ts
// ── Vendor watch ──

export type VwPlanStatus = 'generating' | 'active' | 'paused' | 'stale' | 'failed';
export type VwSourceKind = 'liveness' | 'feed' | 'openapi' | 'html';
export type VwFindingKind = 'vendor_dead' | 'breaking' | 'deprecation' | 'auth_change' | 'new_feature' | 'other';
export type VwSeverity = 'critical' | 'high' | 'medium' | 'low';
export type VwFindingStatus = 'new' | 'filed' | 'dismissed';

export interface VwConfig {
  enabled: number;
  cron_expression: string;
  timezone: string;
  auto_file_enabled: number;
  linear_team_key: string;
  linear_label: string;
  classifier_model: string;
  dead_after_failures: number;
  updated_at: string;
}

export type VwConfigPatch = Partial<Omit<VwConfig, 'updated_at'>>;

export interface VwPlan {
  id: number;
  piece_name: string;
  piece_version: string;
  piece_display_name: string;
  vendor_name: string;
  api_base_urls: string;
  api_version: string;
  auth_type: string;
  endpoint_inventory: string;
  status: VwPlanStatus;
  generation_note: string;
  generation_cost_usd: number;
  generated_at: string | null;
  last_run_at: string | null;
  created_at: string;
  sources_total?: number;
  sources_failing?: number;
  open_findings?: number;
}

export interface VwSource {
  id: number;
  plan_id: number;
  kind: VwSourceKind;
  url: string;
  label: string;
  enabled: number;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_changed_at: string | null;
  consecutive_failures: number;
  last_error: string;
}

export interface VwRun {
  id: number;
  plan_id: number;
  trigger_type: 'baseline' | 'scheduled' | 'manual';
  cycle_id: string | null;
  status: 'running' | 'completed' | 'failed';
  sources_checked: number;
  sources_changed: number;
  sources_failed: number;
  findings_created: number;
  cost_usd: number;
  error: string;
  started_at: string;
  finished_at: string | null;
}

export interface VwFinding {
  id: number;
  plan_id: number;
  piece_name: string;
  source_id: number | null;
  run_id: number | null;
  kind: VwFindingKind;
  severity: VwSeverity;
  affects_piece: number;
  affected_targets: string;
  effective_date: string | null;
  title: string;
  summary: string;
  suggested_action: string;
  evidence_url: string;
  evidence_excerpt: string;
  evidence_verified: number;
  is_baseline: number;
  signature: string;
  status: VwFindingStatus;
  filed_by: 'auto' | 'manual' | null;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_url: string | null;
  file_error: string;
  created_at: string;
  updated_at: string;
}

export interface VwDraft {
  draft: { title: string; description: string; priority: number };
  mode: 'create' | 'comment';
  existing: { linear_identifier: string; linear_url: string } | null;
}
```

Inside the `api` object, after the last entry (`getAiCostByPiece: …`, just before the closing `};`), add:

```ts
  // Vendor watch
  vwConfig: () => request<VwConfig>('GET', '/vendor-watch/config'),
  vwUpdateConfig: (patch: VwConfigPatch) => request<VwConfig>('PUT', '/vendor-watch/config', patch),
  vwTestLinear: () => request<{ ok: boolean; team: string; state: string; label: string }>('POST', '/vendor-watch/config/test-linear'),
  vwPlans: () => request<VwPlan[]>('GET', '/vendor-watch/plans'),
  vwPlan: (id: number) => request<{ plan: VwPlan; sources: VwSource[]; runs: VwRun[] }>('GET', `/vendor-watch/plans/${id}`),
  vwPlanByPiece: (pieceName: string) =>
    request<(VwPlan & { open_findings: number }) | null>('GET', `/vendor-watch/plans/by-piece/${encodeURIComponent(pieceName)}`),
  vwGenerate: (piece_name: string) => request<{ plan_id: number }>('POST', '/vendor-watch/plans/generate', { piece_name }),
  vwGenerateBatch: (piece_names: string[]) => request<{ plan_ids: number[] }>('POST', '/vendor-watch/plans/generate-batch', { piece_names }),
  vwRunPlan: (id: number) => request<{ run_id: number }>('POST', `/vendor-watch/plans/${id}/run`),
  vwSetPlanStatus: (id: number, status: 'active' | 'paused') => request<VwPlan>('PATCH', `/vendor-watch/plans/${id}`, { status }),
  vwDeletePlan: (id: number) => request<{ ok: true }>('DELETE', `/vendor-watch/plans/${id}`),
  vwSetSourceEnabled: (id: number, enabled: boolean) => request<VwSource>('PATCH', `/vendor-watch/sources/${id}`, { enabled }),
  vwRunCycle: () => request<{ started: boolean }>('POST', '/vendor-watch/run-cycle'),
  vwFindings: (status: VwFindingStatus, piece?: string) =>
    request<VwFinding[]>('GET', `/vendor-watch/findings?status=${status}${piece ? `&piece=${encodeURIComponent(piece)}` : ''}`),
  vwFindingDraft: (id: number) => request<VwDraft>('GET', `/vendor-watch/findings/${id}/draft`),
  vwFileFinding: (id: number, body: { title: string; description: string; priority: number }) =>
    request<VwFinding>('POST', `/vendor-watch/findings/${id}/file`, body),
  vwDismissFinding: (id: number) => request<VwFinding>('POST', `/vendor-watch/findings/${id}/dismiss`),
```

- [ ] **Step 4: Write the helpers**

`client/src/lib/vendorWatch.ts`:

```ts
import type { VwFindingKind, VwPlanStatus, VwSeverity, VwSource } from './api';

export const KIND_LABEL: Record<VwFindingKind, string> = {
  vendor_dead: 'Vendor dead',
  breaking: 'Breaking',
  deprecation: 'Deprecation',
  auth_change: 'Auth change',
  new_feature: 'New feature',
  other: 'Other',
};

export const SEVERITY_CLASS: Record<VwSeverity, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/30',
  low: 'bg-gray-700/40 text-gray-300 border-gray-600/40',
};

export const PLAN_STATUS_CLASS: Record<VwPlanStatus, string> = {
  generating: 'bg-blue-500/15 text-blue-300',
  active: 'bg-green-500/15 text-green-300',
  paused: 'bg-gray-700/50 text-gray-300',
  stale: 'bg-amber-500/15 text-amber-300',
  failed: 'bg-red-500/15 text-red-300',
};

/** Linear priority numbers. */
export const PRIORITY_LABEL: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

export function shortPieceName(name: string): string {
  return name.replace('@activepieces/piece-', '');
}

export function parseJsonArray<T = string>(s: string | null | undefined): T[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function describeTargets(json: string): string {
  const t = parseJsonArray(json);
  if (t.includes('*')) return 'whole piece';
  return t.length ? t.join(', ') : '—';
}

/** A liveness timeout only notes last_error without counting a failure, so a noted error also reads as failing. */
export function sourceHealth(s: Pick<VwSource, 'last_checked_at' | 'consecutive_failures' | 'last_error'>): 'never' | 'ok' | 'failing' {
  if (!s.last_checked_at) return 'never';
  return s.consecutive_failures > 0 || s.last_error ? 'failing' : 'ok';
}

export function effectiveLabel(date: string | null, today = new Date()): string {
  if (!date) return '—';
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86_400_000);
  if (d === 0) return `${date} (today)`;
  return d > 0 ? `${date} (in ${d}d)` : `${date} (${-d}d ago)`;
}
```

- [ ] **Step 5: Run the helper tests to verify they pass**

Run: `npx vitest run client/src/lib/vendorWatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the File modal**

`client/src/components/vendor-watch/FileFindingModal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2, Send, X } from 'lucide-react';
import { api, type VwFinding } from '../../lib/api';
import { PRIORITY_LABEL } from '../../lib/vendorWatch';

export default function FileFindingModal({ finding, onClose }: { finding: VwFinding; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(3);
  const [err, setErr] = useState('');

  const preview = useQuery({
    queryKey: ['vw-draft', finding.id],
    queryFn: () => api.vwFindingDraft(finding.id),
    staleTime: Infinity,
  });

  // Seed the editable fields once, so a background refetch never clobbers the user's edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (preview.data && !seeded.current) {
      setTitle(preview.data.draft.title);
      setDescription(preview.data.draft.description);
      setPriority(preview.data.draft.priority);
      seeded.current = true;
    }
  }, [preview.data]);

  const submit = useMutation({
    mutationFn: () => api.vwFileFinding(finding.id, { title, description, priority }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vw-findings'] }); onClose(); },
    onError: (e: Error) => setErr(e.message || 'Filing failed'),
  });

  const mode = preview.data?.mode ?? 'create';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg border border-gray-800 bg-gray-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">File vendor change in Linear</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>

        {preview.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Building draft…
          </div>
        ) : preview.isError ? (
          <p className="py-6 text-sm text-red-400">Couldn't build a draft: {(preview.error as Error).message}</p>
        ) : (
          <>
            {mode === 'comment' && preview.data?.existing && (
              <div className="mb-3 flex items-start gap-2 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-[12px] text-amber-200">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  A ticket for the same change is already filed. Filing adds a comment to{' '}
                  <a href={preview.data.existing.linear_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
                    {preview.data.existing.linear_identifier || 'the existing issue'} <ExternalLink size={11} />
                  </a>.
                </span>
              </div>
            )}

            {mode === 'create' && (
              <>
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">Title</label>
                <input value={title} onChange={e => setTitle(e.target.value)}
                  className="mb-3 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
              </>
            )}

            <label className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">{mode === 'create' ? 'Description' : 'Comment'}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={12}
              className="mb-3 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-[12px] text-gray-200" />

            {mode === 'create' && (
              <div className="mb-3 flex items-center gap-2 text-[12px] text-gray-400">
                <span>Priority</span>
                <select value={priority} onChange={e => setPriority(Number(e.target.value))}
                  className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
                  {[1, 2, 3, 4].map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              </div>
            )}

            {err && <p className="mb-2 text-[12px] text-red-400">{err}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button onClick={() => { setErr(''); submit.mutate(); }}
                disabled={submit.isPending || (mode === 'create' && !title.trim())}
                className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
                {submit.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {mode === 'create' ? 'File in Linear' : 'Add comment in Linear'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write the findings table**

`client/src/components/vendor-watch/FindingsTable.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Send, X } from 'lucide-react';
import { api, type VwFinding } from '../../lib/api';
import { KIND_LABEL, SEVERITY_CLASS, describeTargets, effectiveLabel, shortPieceName } from '../../lib/vendorWatch';
import FileFindingModal from './FileFindingModal';

export default function FindingsTable({ status, piece }: { status: 'new' | 'filed'; piece?: string }) {
  const qc = useQueryClient();
  const [filing, setFiling] = useState<VwFinding | null>(null);
  const findings = useQuery({
    queryKey: ['vw-findings', status, piece ?? ''],
    queryFn: () => api.vwFindings(status, piece),
    refetchInterval: 30_000,
  });
  const dismiss = useMutation({
    mutationFn: (id: number) => api.vwDismissFinding(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-findings'] }),
  });

  if (findings.isLoading) return <div className="text-sm text-gray-400">Loading…</div>;
  if (findings.isError) return <div className="text-sm text-red-400">{(findings.error as Error).message}</div>;
  const rows = findings.data ?? [];
  if (rows.length === 0) {
    return <div className="text-sm text-gray-500">{status === 'new' ? 'Nothing waiting. New findings land here.' : 'Nothing filed yet.'}</div>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Piece</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Severity</th>
              <th className="px-3 py-2">Finding</th>
              <th className="px-3 py-2">Effective</th>
              <th className="px-3 py-2">Affects</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(f => (
              <tr key={f.id} className="border-t border-gray-800 align-top">
                <td className="px-3 py-2 font-mono text-[12px] text-gray-300">{shortPieceName(f.piece_name)}</td>
                <td className="px-3 py-2 text-gray-300">
                  {KIND_LABEL[f.kind]}
                  {f.is_baseline ? <span className="ml-1 text-[10px] text-gray-500">baseline</span> : null}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${SEVERITY_CLASS[f.severity]}`}>{f.severity}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="text-gray-100">{f.title}</div>
                  {f.summary && <div className="mt-0.5 text-[12px] text-gray-400">{f.summary}</div>}
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[11px]">
                    {f.evidence_url && (
                      <a href={f.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary-400 hover:underline">
                        source <ExternalLink size={10} />
                      </a>
                    )}
                    {!f.evidence_verified && f.evidence_excerpt ? <span className="text-amber-400">quote not found in source</span> : null}
                  </div>
                  {f.file_error && <div className="mt-1 text-[11px] text-red-400">Filing failed: {f.file_error}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[12px] text-gray-400">{effectiveLabel(f.effective_date)}</td>
                <td className="px-3 py-2 text-[12px] text-gray-400">{describeTargets(f.affected_targets)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {status === 'new' ? (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setFiling(f)} className="flex items-center gap-1 rounded bg-primary-600 px-2 py-1 text-[12px] text-white hover:bg-primary-500">
                        <Send size={12} /> File…
                      </button>
                      <button onClick={() => dismiss.mutate(f.id)} disabled={dismiss.isPending}
                        className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-gray-400 hover:text-gray-200">
                        <X size={12} /> Dismiss
                      </button>
                    </div>
                  ) : (
                    <div>
                      {f.linear_url && (
                        <a href={f.linear_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-primary-400 hover:underline">
                          {f.linear_identifier || 'Linear'} <ExternalLink size={11} />
                        </a>
                      )}
                      <div className="text-[10px] text-gray-500">{f.filed_by === 'auto' ? 'auto-filed' : 'filed by hand'}</div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filing && <FileFindingModal finding={filing} onClose={() => setFiling(null)} />}
    </>
  );
}
```

- [ ] **Step 8: Write the page**

`client/src/pages/VendorWatch.tsx` (the Watchers and Config tabs come from Task 15; until then, the imports are created as stubs in Step 9):

```tsx
import { useSearchParams } from 'react-router-dom';
import FindingsTable from '../components/vendor-watch/FindingsTable';
import WatchersTab from '../components/vendor-watch/WatchersTab';
import VendorWatchConfigCard from '../components/vendor-watch/VendorWatchConfigCard';

const TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'filed', label: 'Filed' },
  { id: 'watchers', label: 'Watchers' },
  { id: 'config', label: 'Config' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function VendorWatch() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.find(t => t.id === params.get('tab'))?.id ?? 'inbox';
  const piece = params.get('piece') || undefined;

  const update = (fn: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    fn(next);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">Vendor Watch</h1>
      <p className="mb-4 text-sm text-gray-400">
        Watches vendor changelogs, OpenAPI specs and API hosts, and files breaking changes in Linear.
      </p>
      {piece && (
        <div className="mb-3 flex items-center gap-2 text-xs text-gray-400">
          Showing <span className="font-mono text-gray-200">{piece}</span>
          <button onClick={() => update(p => p.delete('piece'))} className="text-primary-400 hover:underline">show all</button>
        </div>
      )}
      <div className="mb-4 flex gap-1 border-b border-gray-800">
        {TABS.map(t => (
          <button key={t.id} onClick={() => update(p => p.set('tab', t.id))}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-primary-500 text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'inbox' && <FindingsTable status="new" piece={piece} />}
      {tab === 'filed' && <FindingsTable status="filed" piece={piece} />}
      {tab === 'watchers' && <WatchersTab piece={piece} />}
      {tab === 'config' && <VendorWatchConfigCard />}
    </div>
  );
}
```

- [ ] **Step 9: Add temporary stubs for the Task 15 components**

So this task compiles on its own:

`client/src/components/vendor-watch/WatchersTab.tsx`:

```tsx
export default function WatchersTab(_props: { piece?: string }) {
  return <div className="text-sm text-gray-500">Watchers arrive in the next task.</div>;
}
```

`client/src/components/vendor-watch/VendorWatchConfigCard.tsx`:

```tsx
export default function VendorWatchConfigCard() {
  return <div className="text-sm text-gray-500">Config arrives in the next task.</div>;
}
```

- [ ] **Step 10: Route and nav**

In `client/src/App.tsx`, after `const BugTrend = lazy(() => import('./pages/BugTrend'));` add:

```tsx
const VendorWatch = lazy(() => import('./pages/VendorWatch'));
```

and after the `/bug-trend` route add:

```tsx
            <Route path="/vendor-watch" element={<LazyPage><VendorWatch /></LazyPage>} />
```

In `client/src/components/Layout.tsx`, add `Radar` to the `lucide-react` import, and add this nav entry right after the Bug Trend entry:

```tsx
  { to: '/vendor-watch', label: 'Vendor Watch', icon: Radar },
```

- [ ] **Step 11: Typecheck, test, build**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run client/src/lib/vendorWatch.test.ts && npm run build:client`
Expected: no type errors, tests pass, and Vite builds. `VendorWatch` appears as its own lazy chunk.

- [ ] **Step 12: Commit**

```bash
git add client/src/lib/api.ts client/src/lib/vendorWatch.ts client/src/lib/vendorWatch.test.ts client/src/components/vendor-watch client/src/pages/VendorWatch.tsx client/src/App.tsx client/src/components/Layout.tsx
git commit -m "feat(vendor-watch): add the Vendor Watch page with Inbox and Filed tabs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Watchers and Config tabs

**Files:**
- Replace: `client/src/components/vendor-watch/WatchersTab.tsx` (was a stub)
- Replace: `client/src/components/vendor-watch/VendorWatchConfigCard.tsx` (was a stub)
- Create: `client/src/components/vendor-watch/PlanDetail.tsx`
- Create: `client/src/components/vendor-watch/GenerateWatchersModal.tsx`

**Interfaces:**
- Consumes: from Task 14, `api.vw*`, the `Vw*` types and the helpers; also `api.listPieces()`, which returns the catalog with `name`/`displayName`.
- Produces: the finished `WatchersTab({ piece? })` and `VendorWatchConfigCard()`.

- [ ] **Step 1: Write the plan detail panel**

`client/src/components/vendor-watch/PlanDetail.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, type VwSource } from '../../lib/api';
import { parseJsonArray, sourceHealth } from '../../lib/vendorWatch';

const HEALTH_DOT = { ok: 'bg-green-500', failing: 'bg-red-500', never: 'bg-gray-600' } as const;

export default function PlanDetail({ planId }: { planId: number }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['vw-plan', planId], queryFn: () => api.vwPlan(planId), refetchInterval: 15_000 });
  const toggle = useMutation({
    mutationFn: (s: VwSource) => api.vwSetSourceEnabled(s.id, !s.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-plan', planId] }),
  });

  if (detail.isLoading) return <div className="p-3 text-sm text-gray-400">Loading…</div>;
  if (detail.isError || !detail.data) {
    return <div className="p-3 text-sm text-red-400">{(detail.error as Error | null)?.message ?? 'Not found'}</div>;
  }
  const { plan, sources, runs } = detail.data;
  const inventory = parseJsonArray<{ target: string; method: string; path: string }>(plan.endpoint_inventory);

  return (
    <div className="grid gap-4 p-3 md:grid-cols-2">
      <div>
        <h4 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Sources</h4>
        <ul className="space-y-1.5">
          {sources.map(s => {
            const health = sourceHealth(s);
            return (
              <li key={s.id} className="text-[12px]">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT[health]}`} title={health} />
                  <span className="rounded bg-gray-800 px-1 text-[10px] text-gray-400">{s.kind}</span>
                  <a href={s.url} target="_blank" rel="noreferrer"
                    className={`inline-flex items-center gap-1 truncate hover:underline ${s.enabled ? 'text-gray-200' : 'text-gray-500 line-through'}`}>
                    {s.label || s.url} <ExternalLink size={10} />
                  </a>
                  <button onClick={() => toggle.mutate(s)} className="ml-auto text-[11px] text-primary-400 hover:underline">
                    {s.enabled ? 'disable' : 'enable'}
                  </button>
                </div>
                {s.last_error && <div className="ml-4 text-[11px] text-red-400">{s.last_error}</div>}
              </li>
            );
          })}
        </ul>
        {plan.generation_note && <p className="mt-3 whitespace-pre-line text-[12px] text-gray-400">{plan.generation_note}</p>}
        <p className="mt-1 text-[11px] text-gray-500">
          {plan.vendor_name || 'Unknown vendor'} · API {plan.api_version || '—'} · {plan.auth_type || '—'} · generated for ${plan.generation_cost_usd.toFixed(2)}
        </p>
      </div>
      <div>
        <h4 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Endpoint inventory ({inventory.length})</h4>
        <ul className="max-h-48 overflow-auto font-mono text-[11px] text-gray-400">
          {inventory.map((e, i) => <li key={i}>{e.target}: {e.method} {e.path}</li>)}
        </ul>
        <h4 className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-gray-500">Last runs</h4>
        <ul className="space-y-0.5 text-[11px] text-gray-400">
          {runs.length === 0 && <li>No runs yet.</li>}
          {runs.map(r => (
            <li key={r.id}>
              {r.started_at} · {r.trigger_type} · {r.status} · {r.sources_changed}/{r.sources_checked} changed · {r.findings_created} finding(s)
              {r.error ? <span className="text-red-400"> · {r.error.split('\n')[0]}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the generate modal**

`client/src/components/vendor-watch/GenerateWatchersModal.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Search, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { shortPieceName } from '../../lib/vendorWatch';

const MAX_BATCH = 100;

interface PieceSummary { name: string; displayName: string }

export default function GenerateWatchersModal({ watched, onClose }: { watched: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const pieces = useQuery({
    queryKey: ['vw-catalog'],
    queryFn: () => api.listPieces() as Promise<PieceSummary[]>,
    staleTime: 5 * 60_000,
  });

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (pieces.data ?? []).filter(p => !f || `${p.displayName} ${p.name}`.toLowerCase().includes(f));
  }, [pieces.data, filter]);

  const generate = useMutation({
    mutationFn: () => api.vwGenerateBatch([...picked]),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vw-plans'] }); onClose(); },
    onError: (e: Error) => setErr(e.message),
  });

  const toggle = (name: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-gray-800 bg-gray-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Generate watchers</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <p className="mb-2 text-[12px] text-gray-400">
          An agent reads each piece's source, finds the vendor's changelog, spec and deprecation pages, and checks it can read them.
          Roughly $0.20–0.60 per piece. Generating again replaces the inventory and sources.
        </p>
        <div className="mb-2 flex items-center gap-2 rounded border border-gray-700 bg-gray-950 px-2">
          <Search size={13} className="text-gray-500" />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter pieces…"
            className="w-full bg-transparent py-1.5 text-sm text-gray-200 outline-none" />
        </div>
        <div className="mb-3 min-h-0 flex-1 overflow-auto rounded border border-gray-800">
          {pieces.isLoading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-gray-400"><Loader2 size={13} className="animate-spin" /> Loading pieces…</div>
          ) : pieces.isError ? (
            <div className="p-3 text-sm text-red-400">{(pieces.error as Error).message}</div>
          ) : (
            <ul>
              {list.map(p => (
                <li key={p.name}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-800">
                    <input type="checkbox" checked={picked.has(p.name)} onChange={() => toggle(p.name)} />
                    <span className="text-gray-200">{p.displayName}</span>
                    <span className="font-mono text-[11px] text-gray-500">{shortPieceName(p.name)}</span>
                    {watched.has(p.name) && <span className="ml-auto rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">has watcher</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <p className="mb-2 text-[12px] text-red-400">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[12px] text-gray-500">{picked.size} selected (max {MAX_BATCH})</span>
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button onClick={() => { setErr(''); generate.mutate(); }}
            disabled={generate.isPending || picked.size === 0 || picked.size > MAX_BATCH}
            className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
            {generate.isPending ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            Generate {picked.size || ''} watcher{picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace the Watchers tab stub**

`client/src/components/vendor-watch/WatchersTab.tsx`:

```tsx
import { Fragment, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Pause, Play, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { api, type VwPlan } from '../../lib/api';
import { PLAN_STATUS_CLASS, shortPieceName } from '../../lib/vendorWatch';
import GenerateWatchersModal from './GenerateWatchersModal';
import PlanDetail from './PlanDetail';

type PlanAction = 'run' | 'pause' | 'resume' | 'regenerate' | 'delete';

export default function WatchersTab({ piece }: { piece?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [note, setNote] = useState('');

  const plans = useQuery({
    queryKey: ['vw-plans'],
    queryFn: api.vwPlans,
    refetchInterval: (query) => (query.state.data?.some(p => p.status === 'generating') ? 3000 : 30_000),
  });

  const act = useMutation({
    mutationFn: ({ action, plan }: { action: PlanAction; plan: VwPlan }): Promise<unknown> => {
      if (action === 'run') return api.vwRunPlan(plan.id);
      if (action === 'pause') return api.vwSetPlanStatus(plan.id, 'paused');
      if (action === 'resume') return api.vwSetPlanStatus(plan.id, 'active');
      if (action === 'regenerate') return api.vwGenerate(plan.piece_name);
      return api.vwDeletePlan(plan.id);
    },
    onSuccess: (_data, { action, plan }) => {
      setNote(action === 'run' ? `Run started for ${shortPieceName(plan.piece_name)}.` : '');
      qc.invalidateQueries({ queryKey: ['vw-plans'] });
      qc.invalidateQueries({ queryKey: ['vw-plan', plan.id] });
    },
    onError: (e: Error) => setNote(e.message),
  });

  const runAll = useMutation({
    mutationFn: api.vwRunCycle,
    onSuccess: () => setNote('Watch cycle started. Runs show up under each watcher.'),
    onError: (e: Error) => setNote(e.message),
  });

  const all = plans.data ?? [];
  const rows = all.filter(p => !piece || p.piece_name === piece);
  const watched = new Set(all.map(p => p.piece_name));

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button onClick={() => setShowGenerate(true)} className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500">
          <Wand2 size={14} /> Generate watchers
        </button>
        <button onClick={() => runAll.mutate()} disabled={runAll.isPending}
          className="flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50">
          <Play size={14} /> Run all now
        </button>
        {note && <span className="text-[12px] text-gray-400">{note}</span>}
      </div>

      {plans.isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : plans.isError ? (
        <div className="text-sm text-red-400">{(plans.error as Error).message}</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500">No watchers yet. Generate one for a piece to start watching its vendor.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2" />
                <th className="px-3 py-2">Piece</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sources</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2">Open</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const runnable = p.status === 'active' || p.status === 'stale';
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t border-gray-800">
                      <td className="px-3 py-2">
                        <button onClick={() => setOpen(open === p.id ? null : p.id)} className="text-gray-500 hover:text-gray-300">
                          {open === p.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-gray-100">{p.piece_display_name || shortPieceName(p.piece_name)}</div>
                        <div className="font-mono text-[11px] text-gray-500">{p.piece_name}{p.piece_version ? ` · v${p.piece_version}` : ''}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${PLAN_STATUS_CLASS[p.status]}`}>
                          {p.status === 'generating' && <Loader2 size={10} className="mr-1 inline animate-spin" />}
                          {p.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-gray-400">
                        {p.sources_total ?? 0}
                        {p.sources_failing ? <span className="ml-1 text-red-400">({p.sources_failing} failing)</span> : null}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-gray-400">{p.last_run_at ?? '—'}</td>
                      <td className="px-3 py-2 text-[12px] text-gray-300">{p.open_findings ?? 0}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {runnable && <IconButton title="Run now" onClick={() => act.mutate({ action: 'run', plan: p })}><Play size={13} /></IconButton>}
                          {runnable && <IconButton title="Pause" onClick={() => act.mutate({ action: 'pause', plan: p })}><Pause size={13} /></IconButton>}
                          {p.status === 'paused' && <IconButton title="Resume" onClick={() => act.mutate({ action: 'resume', plan: p })}><Play size={13} /></IconButton>}
                          {p.status !== 'generating' && (
                            <IconButton title="Regenerate" onClick={() => act.mutate({ action: 'regenerate', plan: p })}><RefreshCw size={13} /></IconButton>
                          )}
                          {p.status !== 'generating' && (
                            <IconButton title="Delete" onClick={() => {
                              if (window.confirm(`Delete the watcher for ${p.piece_name} and all its findings?`)) act.mutate({ action: 'delete', plan: p });
                            }}>
                              <Trash2 size={13} />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open === p.id && (
                      <tr className="border-t border-gray-800 bg-gray-950/50">
                        <td colSpan={7}><PlanDetail planId={p.id} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showGenerate && <GenerateWatchersModal watched={watched} onClose={() => setShowGenerate(false)} />}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200">
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Replace the Config tab stub**

`client/src/components/vendor-watch/VendorWatchConfigCard.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { api, type VwConfig } from '../../lib/api';

const INPUT = 'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200';

export default function VendorWatchConfigCard() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['vw-config'], queryFn: api.vwConfig });
  const [form, setForm] = useState<VwConfig | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config.data && !form) setForm(config.data);
  }, [config.data, form]);

  const save = useMutation({
    mutationFn: (f: VwConfig) => api.vwUpdateConfig({
      enabled: f.enabled,
      cron_expression: f.cron_expression,
      timezone: f.timezone,
      auto_file_enabled: f.auto_file_enabled,
      linear_team_key: f.linear_team_key,
      linear_label: f.linear_label,
      classifier_model: f.classifier_model,
      dead_after_failures: f.dead_after_failures,
    }),
    onSuccess: (row) => { setForm(row); qc.setQueryData(['vw-config'], row); setMsg({ ok: true, text: 'Saved.' }); },
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });

  const testLinear = useMutation({
    mutationFn: api.vwTestLinear,
    onSuccess: (r) => setMsg({ ok: true, text: `Linear OK: new tickets go to ${r.team} → ${r.state} with label "${r.label}".` }),
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });

  if (config.isError) return <div className="text-sm text-red-400">{(config.error as Error).message}</div>;
  if (!form) return <div className="text-sm text-gray-400">Loading…</div>;
  const set = <K extends keyof VwConfig>(k: K, v: VwConfig[K]) => setForm({ ...form, [k]: v });

  return (
    <div className="max-w-xl space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <Toggle label="Daily watch cycle" hint="Checks every active watcher on the schedule below. Manual runs work either way."
        checked={!!form.enabled} onChange={v => set('enabled', v ? 1 : 0)} />
      <Toggle label="Auto-file breakage in Linear"
        hint="Vendor dead, or a high/critical breaking change, deprecation or auth change that hits a target, with a quote found in the source. Everything else waits in the Inbox. Baselines never auto-file."
        checked={!!form.auto_file_enabled} onChange={v => set('auto_file_enabled', v ? 1 : 0)} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Schedule (cron)">
          <input value={form.cron_expression} onChange={e => set('cron_expression', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Timezone">
          <input value={form.timezone} onChange={e => set('timezone', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Linear team key">
          <input value={form.linear_team_key} onChange={e => set('linear_team_key', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Linear label">
          <input value={form.linear_label} onChange={e => set('linear_label', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Classifier model">
          <input value={form.classifier_model} placeholder="default: the AI model in Settings"
            onChange={e => set('classifier_model', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Failed days before 'vendor dead'">
          <input type="number" min={1} max={30} value={form.dead_after_failures}
            onChange={e => set('dead_after_failures', Number(e.target.value))} className={INPUT} />
        </Field>
      </div>
      <p className="text-[11px] text-gray-500">
        Uses the Linear API key and Anthropic key saved in Settings. The label must already exist on the team; the app never
        creates labels. Don't use <span className="font-mono">piece-tester</span>: Bug Trend counts those issues as tester bugs.
      </p>
      <div className="flex items-center gap-2">
        <button onClick={() => { setMsg(null); save.mutate(form); }} disabled={save.isPending}
          className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
          {save.isPending && <Loader2 size={13} className="animate-spin" />} Save
        </button>
        <button onClick={() => { setMsg(null); testLinear.mutate(); }} disabled={testLinear.isPending}
          className="flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50">
          {testLinear.isPending && <Loader2 size={13} className="animate-spin" />} Test Linear
        </button>
      </div>
      {msg && (
        <div className={`flex items-center gap-2 text-sm ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>
          {msg.ok ? <CheckCircle size={15} /> : <XCircle size={15} />} {msg.text}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-1" />
      <span>
        <span className="block text-sm text-gray-200">{label}</span>
        <span className="block text-[12px] text-gray-500">{hint}</span>
      </span>
    </label>
  );
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build:client`
Expected: no type errors and a clean Vite build.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/vendor-watch
git commit -m "feat(vendor-watch): add the Watchers and Config tabs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: PieceDetail chip

**Files:**
- Create: `client/src/components/vendor-watch/VendorWatchChip.tsx`
- Modify: `client/src/pages/PieceDetail.tsx` (header row)

**Interfaces:**
- Consumes: `api.vwPlanByPiece`, `api.vwGenerate` (Task 14).
- Produces: `VendorWatchChip({ pieceName })`.

- [ ] **Step 1: Write the chip**

`client/src/components/vendor-watch/VendorWatchChip.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Radar } from 'lucide-react';
import { api } from '../../lib/api';

const CHIP = 'flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-gray-300 hover:bg-gray-700 disabled:opacity-50';

/** PieceDetail header chip: start a watcher for this piece, or jump to its watcher. */
export default function VendorWatchChip({ pieceName }: { pieceName: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const plan = useQuery({
    queryKey: ['vw-plan-by-piece', pieceName],
    queryFn: () => api.vwPlanByPiece(pieceName),
    refetchInterval: (query) => (query.state.data?.status === 'generating' ? 3000 : false),
  });
  const generate = useMutation({
    mutationFn: () => api.vwGenerate(pieceName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-plan-by-piece', pieceName] }),
  });

  if (plan.isLoading || plan.isError) return null;
  if (!plan.data) {
    return (
      <button onClick={() => generate.mutate()} disabled={generate.isPending} className={CHIP}
        title="Watch this piece's vendor API for breaking changes">
        <Radar size={12} /> {generate.isPending ? 'Starting…' : 'Generate watcher'}
      </button>
    );
  }
  const open = plan.data.open_findings ?? 0;
  return (
    <button onClick={() => navigate(`/vendor-watch?tab=watchers&piece=${encodeURIComponent(pieceName)}`)} className={CHIP}>
      <Radar size={12} /> Watcher: {plan.data.status}{open > 0 ? ` · ${open} open` : ''}
    </button>
  );
}
```

- [ ] **Step 2: Put it in the PieceDetail header**

In `client/src/pages/PieceDetail.tsx`, add the import below the other component imports:

```tsx
import VendorWatchChip from '../components/vendor-watch/VendorWatchChip';
```

In the header's `<div className="flex gap-4 mt-2 text-xs text-gray-500">` row, after this existing block:

```tsx
            {localConn && needsAuth && (
              <span className="text-green-400 flex items-center gap-1">
                <Link2 size={12} /> {localConn.display_name}
                {inactiveConns.length > 0 && <span className="text-gray-500 ml-1">(+{inactiveConns.length} saved)</span>}
              </span>
            )}
```

add:

```tsx
            <VendorWatchChip pieceName={piece.name} />
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build:client`
Expected: no type errors and a clean build.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/vendor-watch/VendorWatchChip.tsx client/src/pages/PieceDetail.tsx
git commit -m "feat(vendor-watch): show the watcher chip on PieceDetail" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Verify end to end

**Files:** none new. This task proves the branch works and stops before anything leaves the machine.

- [ ] **Step 1: Full suite, typecheck, build**

Run: `npm test && npx tsc --noEmit -p tsconfig.json && npm run build:client`
Expected: everything green. Paste the test count into the PR body later.

- [ ] **Step 2: Click through the UI against a scratch DB, with no keys**

```bash
DB_PATH=./data/vw-ui.db APP_AUTH_PASSWORD=ui SESSION_SECRET=ui-secret-ui-secret-ui-secret npm run dev
```

Open the Vite URL the command prints, log in with `ui`, and check:
1. The nav shows **Vendor Watch**; the page opens on **Inbox** with "Nothing waiting".
2. **Filed** shows "Nothing filed yet"; **Watchers** shows "No watchers yet".
3. **Config** loads the defaults (both toggles off, label `vendor-watch`). Saving the label `piece-tester` shows the Bug Trend error in red. Saving a valid change shows "Saved."
4. **Test Linear** shows "No Linear API key saved…" in red, because the scratch DB has no key.
5. **Generate watchers** opens the modal. Without Activepieces settings the piece list shows the server's error, and that is expected.

Stop the dev server and delete `./data/vw-ui.db*`.

- [ ] **Step 3: Live pilot run (only with Ibrahim's go: it spends Anthropic credit and needs real keys)**

On a local copy that has the Anthropic key, the Activepieces settings and the Linear key (never the production DB file):
1. Generate a watcher for one piece with a known changelog feed (e.g. Stripe or Slack). Expected: status goes `generating` → `active` within a few minutes. The Watchers row shows a liveness source plus 1–5 verified sources and a non-empty endpoint inventory, and the baseline run appears under **Last runs**.
2. Read the generation note and every baseline finding in the Inbox. Expected: baseline findings only for still-open deprecations; none auto-filed.
3. **Test Linear** → "Linear OK: new tickets go to PIE → Triage with label "vendor-watch"". This needs the label created first (see Step 5).
4. Do **not** file a ticket from the pilot unless Ibrahim asks; a real PIE ticket is outward-facing.

- [ ] **Step 4: Whole-branch review**

Use superpowers:requesting-code-review on the full branch diff (`git diff origin/main...HEAD`). Fix what it finds, re-run Step 1, and commit the fixes.

- [ ] **Step 5: Stop and hand back**

Do not push, open a PR or deploy without Ibrahim's explicit go. A merge to `main` auto-deploys to the droplet. Hand back with:
- the branch name and commit list
- the test count
- the pilot result, if Step 3 ran
- the two prerequisites from the spec's Rollout §1, which must happen before any auto-filing:
  - create the `vendor-watch` label on the PIE team in Linear
  - confirm web search is enabled for the Anthropic org whose key the tester uses
- the rollout order:
  1. merge with cron and auto-file off
  2. pilot about 10 pieces by hand for a week
  3. enable the daily cron
  4. after a clean week, enable auto-file
