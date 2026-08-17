import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getTestPlan, markPlansStaleByPiece, createTestPlan, updateTestPlan, getPieceHealth, getAttentionItems } from './queries.js';

function seedPlan(piece: string, action: string, status = 'approved'): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status)
     VALUES (?,?,?,?,?)`,
    [piece, action, 'action', '[]', status],
  ).lastId;
}

describe('test_plans.needs_regen column', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('defaults needs_regen to 0 on a new plan', () => {
    const id = seedPlan('slack', 'send_message');
    expect(getTestPlan(id)!.needs_regen).toBe(0);
  });
});

describe('markPlansStaleByPiece', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('flags only approved plans of the named piece', () => {
    const approved = seedPlan('slack', 'send_message', 'approved');
    const draft = seedPlan('slack', 'find_channel', 'draft');
    const other = seedPlan('github', 'create_issue', 'approved');

    const changed = markPlansStaleByPiece('slack');

    expect(changed).toBe(1);
    expect(getTestPlan(approved)!.needs_regen).toBe(1);
    expect(getTestPlan(draft)!.needs_regen).toBe(0);   // drafts untouched
    expect(getTestPlan(other)!.needs_regen).toBe(0);   // other pieces untouched
  });

  it('returns 0 when the piece has no approved plans', () => {
    seedPlan('slack', 'send_message', 'draft');
    expect(markPlansStaleByPiece('slack')).toBe(0);
  });
});

describe('needs_regen clears on rewrite/approve', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('createTestPlan (regenerate) clears the flag on the reused row', () => {
    const id = seedPlan('slack', 'send_message', 'approved');
    markPlansStaleByPiece('slack');
    expect(getTestPlan(id)!.needs_regen).toBe(1);

    // Regeneration reuses the same (piece, action, type) row via createTestPlan's update branch.
    createTestPlan({ piece_name: 'slack', target_action: 'send_message', steps: '[]', status: 'draft' });
    expect(getTestPlan(id)!.needs_regen).toBe(0);
  });

  it('updateTestPlan clears the flag when steps are rewritten', () => {
    const id = seedPlan('slack', 'send_message', 'approved');
    markPlansStaleByPiece('slack');
    updateTestPlan(id, { steps: '[]' });
    expect(getTestPlan(id)!.needs_regen).toBe(0);
  });

  it('updateTestPlan does NOT clear the flag on a status-only update', () => {
    const id = seedPlan('slack', 'send_message', 'approved');
    markPlansStaleByPiece('slack');
    updateTestPlan(id, { status: 'approved' });
    expect(getTestPlan(id)!.needs_regen).toBe(1);
  });
});

function seedScheduledRun(planId: number, status: string, stepResults: string): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'scheduled', stepResults, '2026-08-17 10:00:00'],
  ).lastId;
}

describe('blocked backlinks guard (stale vs connection)', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('a STALE block gets no connection backlinks', () => {
    const plan = seedPlan('linear', 'update_issue', 'approved');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'stale', status: 'skipped', error: 'Connection changed — regenerate the plan.' },
    ]));

    const row = getPieceHealth().find(r => r.piece_name === 'linear')!;
    expect(row.status).toBe('blocked');
    expect(row.backlinks).toBeNull();
    expect(row.blocked_reason).toContain('regenerate');

    const att = getAttentionItems().find(i => i.piece_name === 'linear')!;
    expect(att.backlinks).toBeNull();
  });

  it('a CONNECTION block still gets backlinks (regression guard)', () => {
    const plan = seedPlan('hubspot', 'create_contact', 'approved');
    seedScheduledRun(plan, 'blocked', JSON.stringify([
      { stepId: 'connection', status: 'skipped', error: 'Connection was deleted in Activepieces' },
    ]));

    const row = getPieceHealth().find(r => r.piece_name === 'hubspot')!;
    expect(row.backlinks?.reimport).toBe('/connections?piece=hubspot');
  });
});
