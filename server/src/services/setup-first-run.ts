import { listTestPlans, startSetupFirstRun, completeSetupFirstRun, type ScheduleTarget, type TestPlanRow, type WaveInfo } from '../db/queries.js';
import { runScheduledTests } from './test-engine.js';

export interface FirstRunDeps {
  run: (targets: ScheduleTarget[], wave: WaveInfo) => Promise<void>;
}

function hasSteps(json: string): boolean {
  try {
    const steps = JSON.parse(json);
    return Array.isArray(steps) && steps.length > 0;
  } catch { return false; }
}

/** Approved plans with runnable steps for these pieces — the same set a schedule fire would run. */
export function firstRunPlans(pieceNames: string[]): TestPlanRow[] {
  const wanted = new Set(pieceNames);
  return listTestPlans().filter(p => wanted.has(p.piece_name) && p.status === 'approved' && hasSteps(p.steps));
}

/**
 * Fire the one tracked wave a setup run gets right after plan generation, so Health shows a
 * status before the schedule's first fire. Runs in the background; resolves to what was started.
 */
export function startFirstRun(
  setupRunId: number,
  pieceNames: string[],
  deps: FirstRunDeps = { run: runScheduledTests },
): { waveId: string; total: number } | null {
  const plans = firstRunPlans(pieceNames);
  if (plans.length === 0) return null;

  const pieces = [...new Set(plans.map(p => p.piece_name))];
  const waveId = `setup${setupRunId}-${Date.now()}`;
  startSetupFirstRun(setupRunId, { wave_id: waveId, total: plans.length });

  deps.run(pieces.map(piece_name => ({ piece_name })), { wave_id: waveId })
    .catch(err => console.error(`[batch-setup] first run for setup run #${setupRunId} failed:`, err?.message ?? err))
    .finally(() => completeSetupFirstRun(setupRunId));

  return { waveId, total: plans.length };
}
