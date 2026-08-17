import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { executePlan } from './plan-executor.js';

function seedStepPlan(needsRegen: number): number {
  // One real step so the `steps.length === 0` guard passes; no active connection is seeded,
  // so the broken-connection gate is skipped and getPieceMetadata is never reached.
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Do it', description: '', actionName: 'x',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['slack', 'send_message', 'action', steps, 'approved', needsRegen],
  ).lastId;
}

describe('executePlan — stale plan gate', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('blocks a stale plan without executing steps', async () => {
    const planId = seedStepPlan(1);
    const run = await executePlan(planId, () => {});
    expect(run.status).toBe('blocked');
    const steps = JSON.parse(run.step_results);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepId).toBe('stale');
    expect(steps[0].status).toBe('skipped');
  });

  it('does NOT block a fresh (needs_regen=0) plan at the stale gate', async () => {
    const planId = seedStepPlan(0);
    // needs_regen=0 → passes both gates → proceeds to getPieceMetadata, which throws in tests
    // (no live AP). The point: it must NOT be stopped by the stale gate.
    await expect(executePlan(planId, () => {})).rejects.toThrow();
  });
});
