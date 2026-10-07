import {
  createRun, finishRun, getPlan, getSnapshot, getWatchConfig, insertFinding, listSources, recordSourceFailure,
  recordSourceOk, saveSnapshot, touchPlanRun,
  type RunCounts, type VendorFindingRow, type WatchConfigRow, type WatchPlanRow, type WatchRunRow, type WatchSnapshotRow,
  type WatchSourceRow,
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
import { parseInventory, shouldAutoFile, vendorDeadFinding } from './findings.js';
import { fileFinding } from './filing.js';
import type { EndpointRef, FindingDraft, RunTrigger } from './types.js';

export interface RunnerDeps {
  fetch: (url: string) => Promise<SafeFetchResult>;
  liveness: (baseUrl: string) => Promise<LivenessResult>;
  /** A failure may carry `costUsd`: what the failed call spent. */
  classify: (input: ClassifyInput) => Promise<ClassifyResult>;
  file: (findingId: number) => Promise<unknown>;
  today: () => Date;
}

export interface RunHandle {
  runId: number;
  /** Never rejects. */
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

/** A failed classifier call rethrows with `costUsd` attached: CostTracker totals live in memory only. */
function defaultDeps(config: WatchConfigRow): RunnerDeps {
  return {
    fetch: (url) => safeFetch(url),
    liveness: (url) => checkLiveness(url),
    classify: async (input) => {
      const costTracker = new CostTracker({
        pieceName: input.pieceName, actionName: '', operation: 'vendor_watch_classify', version: 'vendor-watch-1',
      });
      try {
        return await classifyChange(input, { model: config.classifier_model || undefined, costTracker });
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { costUsd: costTracker.getTotals().cost_usd });
      }
    },
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
    done: executeRun(plan, run, config, deps).finally(() => inFlight.delete(planId)),
  };
  inFlight.set(planId, handle);
  return handle;
}

async function executeRun(plan: WatchPlanRow, run: WatchRunRow, config: WatchConfigRow, deps: RunnerDeps): Promise<WatchRunRow> {
  const counts: RunCounts = { sources_checked: 0, sources_changed: 0, sources_failed: 0, findings_created: 0, cost_usd: 0 };
  const errors: string[] = [];
  try {
    const inventory = parseInventory(plan.endpoint_inventory);
    for (const source of listSources(plan.id).filter(s => s.enabled)) {
      if (!getPlan(plan.id)) break;
      counts.sources_checked++;
      let outcome: SourceOutcome;
      try {
        outcome = await checkSource(plan, source, inventory, config, deps);
      } catch (err: any) {
        counts.cost_usd += Number(err?.costUsd) || 0;
        errors.push(`${source.kind} ${source.url}: ${err?.message || err}`);
        continue;
      }
      if (outcome.failed) counts.sources_failed++;
      if (outcome.changed) counts.sources_changed++;
      counts.cost_usd += outcome.costUsd;
      for (const draft of outcome.findings) {
        let row: VendorFindingRow | null;
        try {
          row = insertFinding({ plan_id: plan.id, piece_name: plan.piece_name, source_id: source.id, run_id: run.id, draft });
        } catch (err: any) {
          errors.push(`store finding "${draft.title}": ${err?.message || err}`);
          continue;
        }
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
  } catch (err: any) {
    errors.push(String(err?.message || err));
    return closeRun(run, 'failed', counts, errors);
  }
  return closeRun(run, 'completed', counts, errors);
}

/**
 * Save the run's final state. Never throws. If the plan was deleted mid-run, its runs went with it
 * (cascade), so this resolves with the run's in-memory state, marked failed.
 */
function closeRun(run: WatchRunRow, status: 'completed' | 'failed', counts: RunCounts, errors: string[]): WatchRunRow {
  try {
    if (getPlan(run.plan_id)) return finishRun(run.id, status, counts, errors.join('\n'));
    errors.push(`Plan ${run.plan_id} was deleted during the run`);
  } catch (err: any) {
    errors.push(`Could not save the run: ${err?.message || err}`);
  }
  return { ...run, ...counts, status: 'failed', error: errors.join('\n'), finished_at: new Date().toISOString() };
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
  const prevOps = prev ? parseOpMap(prev.content) : null;
  const findings = prevOps
    ? openApiFindings(diffOpenApi(prevOps, ops), inventory, source.url, prevOps, ops)
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
