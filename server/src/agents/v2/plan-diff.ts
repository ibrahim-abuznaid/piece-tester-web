import type { TestPlanStep } from './types.js';

/**
 * True when the fixer handed back a plan identical to the one it was asked to
 * fix — i.e. it produced no change. This is the fixer's failure path
 * (workers/fixer.ts returns `previousSteps` verbatim when it never calls
 * set_test_plan), and re-verifying an identical plan we already know fails is
 * pure wasted latency. Reordered/edited steps count as a real change, so we
 * err toward re-verifying rather than silently skipping a genuine fix.
 */
export function planStepsUnchanged(before: TestPlanStep[], after: TestPlanStep[]): boolean {
  if (before === after) return true;
  return JSON.stringify(before) === JSON.stringify(after);
}
