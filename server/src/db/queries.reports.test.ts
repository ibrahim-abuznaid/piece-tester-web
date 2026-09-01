import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getReportOverviewStats, getRunTrends } from './queries.js';

function seedPlan(piece: string, action: string): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES (?,?,?,?)`,
    [piece, action, 'action', 'approved'],
  ).lastId;
}
function seedScheduledRun(planId: number, status: string, startedAt: string): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at, completed_at)
     VALUES (?,?,?,?,?,?)`,
    [planId, status, 'scheduled', '[]', startedAt, startedAt],
  ).lastId;
}

describe('getReportOverviewStats — blocked runs', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('excludes blocked runs from the success rate and surfaces a blocked count', () => {
    const plan = seedPlan('hubspot', 'create_contact');
    seedScheduledRun(plan, 'completed', '2026-08-14 10:00:00');
    seedScheduledRun(plan, 'failed', '2026-08-14 10:01:00');
    seedScheduledRun(plan, 'blocked', '2026-08-14 10:02:00');

    const stats = getReportOverviewStats();

    expect(stats.total_plan_runs).toBe(3);
    expect(stats.passed_plan_runs).toBe(1);
    expect(stats.failed_plan_runs).toBe(1);
    expect(stats.blocked_plan_runs).toBe(1);
    // Success rate is over pass/fail outcomes only — blocked is skipped, not a failure.
    // 1 passed / (1 passed + 1 failed) = 50%, NOT 1/3 = 33%.
    expect(stats.success_rate).toBe(50);
  });
});

describe('getRunTrends — honors "all time"', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('includes runs older than 30 days when no date range is given', () => {
    const plan = seedPlan('slack', 'send_message');
    seedScheduledRun(plan, 'completed', '2020-01-01 10:00:00'); // far older than 30 days
    seedScheduledRun(plan, 'completed', '2026-08-14 10:00:00');

    const trends = getRunTrends();
    const dates = trends.map(t => t.date);

    expect(dates).toContain('2020-01-01');
    expect(dates).toContain('2026-08-14');
  });
});
