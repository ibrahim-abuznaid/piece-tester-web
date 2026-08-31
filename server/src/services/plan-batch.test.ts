import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { getPlanRun } from '../db/queries.js';
import { runPlanBatch } from './plan-batch.js';

function seedStalePlan(action: string): number {
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Do it', description: '', actionName: 'x',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['slack', action, 'action', steps, 'approved', 1],
  ).lastId;
}

describe('runPlanBatch', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('creates one manual run per plan and returns run ids', async () => {
    const a = seedStalePlan('send_message');
    const b = seedStalePlan('update_message');

    const { pairs, done } = runPlanBatch([a, b, 99999], 'manual', 2); // 99999 = unknown → filtered

    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.plan_id).sort()).toEqual([a, b].sort());
    for (const p of pairs) {
      const run = getPlanRun(p.run_id)!;
      expect(run.trigger_type).toBe('manual');
    }

    await done; // stale plans short-circuit (no live AP) → blocked
    for (const p of pairs) {
      expect(getPlanRun(p.run_id)!.status).toBe('blocked');
    }
  });
});
