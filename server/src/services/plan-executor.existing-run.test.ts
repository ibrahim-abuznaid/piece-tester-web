import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { createPlanRun, listPlanRuns } from '../db/queries.js';
import { executePlan } from './plan-executor.js';

function seedStalePlan(): number {
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Do it', description: '', actionName: 'x',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['slack', 'send_message', 'action', steps, 'approved', 1],
  ).lastId;
}

describe('executePlan — existingRunId', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('reuses a pre-created run instead of creating a new one', async () => {
    const planId = seedStalePlan();
    const pre = createPlanRun(planId, 'manual'); // status 'running'

    const run = await executePlan(planId, () => {}, 'manual', undefined, undefined, pre.id);

    expect(run.id).toBe(pre.id);              // same run, not a fresh one
    expect(run.status).toBe('blocked');       // stale gate still fires
    expect(listPlanRuns(planId)).toHaveLength(1); // no duplicate run row
  });
});
