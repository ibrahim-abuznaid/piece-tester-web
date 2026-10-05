import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getAttentionItems } from './queries.js';

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

function seedRetestRun(planId: number, status: string, stepResults = '[]'): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'retest', stepResults, '2026-08-14 11:00:00'],
  ).lastId;
}

describe('getAttentionItems — blocked connection', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('emits a reauth / connection_broken item with backlinks', () => {
    const plan = seedPlan('hubspot', 'create_contact');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'connection', status: 'skipped', error: 'Connection was deleted in Activepieces' },
    ]));

    const item = getAttentionItems().find(i => i.piece_name === 'hubspot')!;
    expect(item.bucket).toBe('reauth');
    expect(item.category).toBe('connection_broken');
    expect(item.error).toContain('deleted');
    expect(item.backlinks?.reimport).toBe('/connections?piece=hubspot');
  });
});

describe('getAttentionItems — retest', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('a passing retest closes the item', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'completed');
    expect(getAttentionItems().find(i => i.piece_name === 'gmail')).toBeUndefined();
  });

  it('a still-running retest keeps the item open', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'running');
    expect(getAttentionItems().find(i => i.piece_name === 'gmail')).toBeDefined();
  });

  it('a manual run does not close the item', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    getDb().run(
      `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results) VALUES (?,?,?,?)`,
      [plan, 'completed', 'manual', '[]'],
    );
    expect(getAttentionItems().find(i => i.piece_name === 'gmail')).toBeDefined();
  });

  it('a scheduled pass after a failed retest still closes the item', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'failed');
    seedScheduledRun(plan, 'completed');
    expect(getAttentionItems().find(i => i.piece_name === 'gmail')).toBeUndefined();
  });
});
