import { getTestPlan, createPlanRun, updatePlanRun } from '../db/queries.js';
import { executePlan } from './plan-executor.js';
import { runWithConcurrency } from './concurrency.js';

export interface BatchPair { plan_id: number; run_id: number; }

const DEFAULT_CONCURRENCY = 3;

/**
 * Create a run record for each valid plan up front (so callers get run ids
 * synchronously), then execute them in the background behind a concurrency cap.
 * Unknown plan ids are skipped. Returns the pairs plus a `done` promise that
 * resolves when all background runs finish (used by tests).
 */
export function runPlanBatch(
  planIds: number[],
  triggerType: string = 'manual',
  concurrency: number = DEFAULT_CONCURRENCY,
): { pairs: BatchPair[]; done: Promise<void> } {
  const pairs: BatchPair[] = [];
  for (const planId of planIds) {
    if (!getTestPlan(planId)) continue;
    const run = createPlanRun(planId, triggerType);
    pairs.push({ plan_id: planId, run_id: run.id });
  }

  const done = runWithConcurrency(pairs, concurrency, async ({ plan_id, run_id }) => {
    try {
      await executePlan(plan_id, () => {}, triggerType, undefined, undefined, run_id);
    } catch (err) {
      updatePlanRun(run_id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        step_results: JSON.stringify([{
          stepId: 'error', label: 'Run failed to start', status: 'failed',
          output: null, error: err instanceof Error ? err.message : String(err), duration_ms: 0,
        }]),
      });
    }
  });

  return { pairs, done };
}
