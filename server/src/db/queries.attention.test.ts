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

describe('getAttentionItems — out of credits', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  // Stored with the stale piece_error category the old classifier assigned.
  const credits = JSON.stringify([{
    stepId: 'test', status: 'failed', errorCategory: 'piece_error',
    error: JSON.stringify({
      status: 'FAILED',
      errorMessage: JSON.stringify({ message: 'Failed to perform inference: You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.', status: 402 }),
    }),
  }]);

  it('lands in the quota lane even with a stale stored piece_error category', () => {
    const plan = seedPlan('hugging-face', 'inference');
    seedScheduledRun(plan, 'failed', credits);
    const item = getAttentionItems().find(i => i.piece_name === 'hugging-face')!;
    expect(item.bucket).toBe('quota');
    expect(item.category).toBe('quota');
    expect(item.reason).toBe('out of credits — vendor account needs billing, not a piece bug');
  });

  it('shows the vendor message, not the stored wrapper JSON', () => {
    const plan = seedPlan('hugging-face', 'inference');
    seedScheduledRun(plan, 'failed', credits);
    const item = getAttentionItems().find(i => i.piece_name === 'hugging-face')!;
    expect(item.error).toMatch(/^Failed to perform inference: You have no remaining credits/);
  });

  it('keeps the hint to one line and falls back when the vendor message is empty', () => {
    const plan = seedPlan('slack', 'send_message');
    const err = (message: string) => JSON.stringify([{ stepId: 'test', status: 'failed', error: JSON.stringify({ status: 'FAILED', errorMessage: JSON.stringify({ message }) }) }]);
    seedScheduledRun(plan, 'failed', err('Line one\n    at Object.run'));
    expect(getAttentionItems().find(i => i.piece_name === 'slack')!.error).toBe('Line one');
    seedScheduledRun(plan, 'failed', err(''));
    expect(getAttentionItems().find(i => i.piece_name === 'slack')!.error).toMatch(/^\{"status":"FAILED"/);
  });

  it('never escalates to likely_broken on repeated failures', () => {
    const plan = seedPlan('hugging-face', 'inference');
    seedScheduledRun(plan, 'failed', credits);
    seedScheduledRun(plan, 'failed', credits);
    seedScheduledRun(plan, 'failed', credits);
    const item = getAttentionItems().find(i => i.piece_name === 'hugging-face')!;
    expect(item.bucket).toBe('quota');
    expect(item.fail_streak).toBe(3);
  });

  it('sorts after watching and before noise', () => {
    const q = seedPlan('hugging-face', 'inference');
    seedScheduledRun(q, 'failed', credits);
    const w = seedPlan('slack', 'send_message');
    seedScheduledRun(w, 'failed', JSON.stringify([{ stepId: 'test', status: 'failed', error: 'boom' }]));
    const n = seedPlan('gmail', 'send_email');
    seedScheduledRun(n, 'failed', JSON.stringify([{ stepId: 'test', status: 'failed', error: 'Request failed with status code 503' }]));
    expect(getAttentionItems().map(i => i.bucket)).toEqual(['watching', 'quota', 'noise']);
  });
});
