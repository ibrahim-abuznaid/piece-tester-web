import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getPieceHealth } from './queries.js';

function seedPlan(piece: string, action: string): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status) VALUES (?,?,?,?)`,
    [piece, action, 'action', 'approved'],
  ).lastId;
}
function seedScheduledRun(planId: number, status: string, stepResults = '[]'): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'scheduled', stepResults, '2026-08-14 10:00:00'],
  ).lastId;
}

describe('getPieceHealth — blocked connection', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('reports a blocked connection as status "blocked", not "failing"', () => {
    const plan = seedPlan('hubspot', 'create_contact');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'connection', status: 'skipped', error: 'Connection was deleted in Activepieces' },
    ]));

    const hub = getPieceHealth().find(r => r.piece_name === 'hubspot')!;
    expect(hub.status).toBe('blocked');
    expect(hub.actions_failing).toBe(0);
    expect(hub.actions_blocked).toBe(1);
    expect(hub.blocked_reason).toContain('deleted');
    expect(hub.backlinks?.reimport).toBe('/connections?piece=hubspot');
    expect(hub.backlinks?.activepieces).toContain('/connections');
  });

  it('a passing run is still healthy (regression guard)', () => {
    const plan = seedPlan('slack', 'send_message');
    seedScheduledRun(plan, 'completed');
    expect(getPieceHealth().find(r => r.piece_name === 'slack')!.status).toBe('healthy');
  });
});
