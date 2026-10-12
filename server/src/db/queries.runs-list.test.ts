import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { listAllPlanRuns } from './queries.js';

describe('listAllPlanRuns', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('returns per-step statuses instead of the full step results', () => {
    const planId = getDb().run(
      `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES ('slack','send','action','approved')`,
    ).lastId;
    getDb().run(
      `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results) VALUES (?, 'failed', 'scheduled', ?)`,
      [planId, JSON.stringify([
        { stepId: 's1', status: 'completed', output: { big: 'x'.repeat(5000) }, error: null, duration_ms: 1 },
        { stepId: 's2', status: 'failed', output: null, error: 'boom', duration_ms: 1 },
        { stepId: 's3', status: 'skipped', output: null, error: null, duration_ms: 0 },
      ])],
    );

    const [run] = listAllPlanRuns({ limit: 10 });
    expect(run.step_statuses).toEqual(['completed', 'failed', 'skipped']);
    expect(run).not.toHaveProperty('step_results');
    expect(run.piece_name).toBe('slack');
  });

  it('gives an empty status list for unreadable step results', () => {
    const planId = getDb().run(
      `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES ('slack','send','action','approved')`,
    ).lastId;
    getDb().run(
      `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results) VALUES (?, 'failed', 'scheduled', 'not json')`,
      [planId],
    );
    expect(listAllPlanRuns({ limit: 10 })[0].step_statuses).toEqual([]);
  });
});
