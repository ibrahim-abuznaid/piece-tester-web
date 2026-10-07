import {
  beginPlanGeneration, completePlanGeneration, failPlanGeneration, getPlan, getPlanByPiece, MAX_FAILURE_NOTE,
  queuePlanGeneration, replaceSources, type SourceInput, type WatchPlanRow,
} from '../../db/vendor-watch-queries.js';
import { CostTracker } from '../../agents/v2/cost-tracker.js';
import { runWatchPlannerWorker } from '../../agents/v2/workers/watch-planner.js';
import type { PieceMetadataFull } from '../ap-client.js';
import { githubRateLimitHitsSince } from '../github-api.js';
import { createClient } from '../test-engine.js';
import { enqueueGeneration } from './generation-queue.js';
import { startWatchRun } from './runner.js';
import type { SourceKind } from './types.js';

const GITHUB_LIMIT_NOTE =
  'GitHub rate limit was hit while reading the piece source; action files may be missing. Add a GitHub token in Settings and regenerate.';

/** One stuck agent run must not hold the single-lane generation queue. */
export const VW_GENERATION_TIMEOUT_MS = 20 * 60_000;
const TIMEOUT_NOTE = `Generation timed out after ${VW_GENERATION_TIMEOUT_MS / 60_000} minutes.`;

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
  const startedAt = Date.now();
  const tracker = new CostTracker({ pieceName, actionName: '', operation: 'vendor_watch_generate', version: 'vendor-watch-1' });
  const agentErrors: string[] = [];
  const githubNote = () => (githubRateLimitHitsSince(startedAt) ? GITHUB_LIMIT_NOTE : '');
  /** The GitHub line goes last; a long error is cut, not the line. */
  const fail = (note: string, cost: number) => {
    const line = githubNote();
    const kept = line ? `${note.slice(0, MAX_FAILURE_NOTE - line.length - 1)}\n${line}` : note;
    return failPlanGeneration(plan.id, kept, cost);
  };
  let timeout: AbortSignal | undefined;
  try {
    const meta = await d.getPieceMetadata(pieceName);
    timeout = AbortSignal.timeout(VW_GENERATION_TIMEOUT_MS);
    const result = await d.runWorker({
      pieceMeta: meta,
      costTracker: tracker,
      abortSignal: timeout,
      onLog: (l) => { if (l.type === 'error') agentErrors.push(l.message); },
    });
    const cost = tracker.getTotals().cost_usd;
    if (!result) {
      return fail(agentErrors.slice(-3).join('\n') || 'The agent finished without saving a watch plan.', cost);
    }
    if (result.errors.length) return fail(`Watch plan rejected: ${result.errors.join('; ')}`, cost);
    const p = result.plan;
    completePlanGeneration(plan.id, {
      piece_version: meta.version,
      piece_display_name: meta.displayName,
      vendor_name: p.vendor_name,
      api_base_urls: p.api_base_urls,
      api_version: p.api_version,
      auth_type: p.auth_type,
      endpoint_inventory: p.endpoint_inventory,
      generation_note: [p.note, ...result.warnings, githubNote()].filter(Boolean).join('\n'),
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
    return fail(timeout?.aborted ? TIMEOUT_NOTE : String(err?.message || err), tracker.getTotals().cost_usd);
  }
}

/**
 * Put one piece in the generation queue, marking its plan queued. A plan already queued or generating keeps its
 * place. When the job's turn comes, a plan that was deleted or is no longer queued is skipped.
 */
function queueGeneration(pieceName: string, deps: Partial<GenerateDeps>, front: boolean): number {
  const existing = getPlanByPiece(pieceName);
  if (existing?.status === 'generating' || existing?.status === 'queued') return existing.id;
  const plan = queuePlanGeneration(pieceName);
  enqueueGeneration(pieceName, async () => {
    if (getPlan(plan.id)?.status !== 'queued') return;
    await generateWatchPlan(pieceName, deps);
  }, { front });
  return plan.id;
}

/** Queue generation for many pieces; they run one at a time on the Vendor Watch queue. Returns the plan ids at once. */
export function generateWatchPlansInBackground(pieceNames: string[], deps: Partial<GenerateDeps> = {}): number[] {
  const names = new Set(pieceNames.map(n => n.trim()).filter(Boolean));
  return [...names].map(name => queueGeneration(name, deps, false));
}

/** Queue one piece (a Generate watcher click) ahead of any batch still waiting. Returns its plan id at once. */
export function generateWatchPlanInBackground(pieceName: string, deps: Partial<GenerateDeps> = {}): number {
  return queueGeneration(pieceName.trim(), deps, true);
}
