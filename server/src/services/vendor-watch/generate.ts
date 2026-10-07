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
    submitPieceUnit(batchId, async () => { await generateWatchPlan(name, deps); })
      .catch(err => console.error(`[vendor-watch] generating ${name} failed: ${err?.message || err}`));
  }
  return ids;
}
