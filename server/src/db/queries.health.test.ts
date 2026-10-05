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

function seedRetestRun(planId: number, status: string, stepResults = '[]'): number {
  return getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at)
     VALUES (?,?,?,?,?)`,
    [planId, status, 'retest', stepResults, '2026-08-14 11:00:00'],
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

describe('getPieceHealth — retest', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('a passing retest after a scheduled failure makes the piece healthy', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'completed');
    const gmail = getPieceHealth().find(r => r.piece_name === 'gmail')!;
    expect(gmail.status).toBe('healthy');
    expect(gmail.actions_failing).toBe(0);
  });

  it('a still-running retest does not hide the scheduled failure', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'running');
    expect(getPieceHealth().find(r => r.piece_name === 'gmail')!.status).toBe('failing');
  });

  it('retests stay out of the scheduled sparkline', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'completed');
    expect(getPieceHealth().find(r => r.piece_name === 'gmail')!.recent).toEqual(['failed']);
  });
});

describe('getPieceHealth — flaky', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('a healthy piece with a recent scheduled failure is flaky', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedScheduledRun(plan, 'completed');
    const gmail = getPieceHealth().find(r => r.piece_name === 'gmail')!;
    expect(gmail.status).toBe('healthy');
    expect(gmail.flaky).toBe(true);
    expect(gmail.flap_count).toBe(1);
  });

  it('recovering on retest marks the piece flaky', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    seedRetestRun(plan, 'completed');
    expect(getPieceHealth().find(r => r.piece_name === 'gmail')!.flaky).toBe(true);
  });

  it('a clean history is not flaky', () => {
    const plan = seedPlan('slack', 'send_message');
    seedScheduledRun(plan, 'completed');
    seedScheduledRun(plan, 'completed');
    const slack = getPieceHealth().find(r => r.piece_name === 'slack')!;
    expect(slack.flaky).toBe(false);
    expect(slack.flap_count).toBe(0);
  });

  it('a failing piece is not flaky', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'completed');
    seedScheduledRun(plan, 'failed');
    expect(getPieceHealth().find(r => r.piece_name === 'gmail')!.flaky).toBe(false);
  });

  it('a failure older than the 12-run window no longer counts', () => {
    const plan = seedPlan('gmail', 'send_email');
    seedScheduledRun(plan, 'failed');
    for (let i = 0; i < 12; i++) seedScheduledRun(plan, 'completed');
    expect(getPieceHealth().find(r => r.piece_name === 'gmail')!.flaky).toBe(false);
  });

  it('sorts failing, blocked, flaky, then clean', () => {
    const failing = seedPlan('a-failing', 'x'); seedScheduledRun(failing, 'failed');
    const clean = seedPlan('b-clean', 'x'); seedScheduledRun(clean, 'completed');
    const flaky = seedPlan('c-flaky', 'x'); seedScheduledRun(flaky, 'failed'); seedScheduledRun(flaky, 'completed');
    const blocked = seedPlan('d-blocked', 'x'); seedScheduledRun(blocked, 'blocked');
    expect(getPieceHealth().map(r => r.piece_name)).toEqual(['a-failing', 'd-blocked', 'c-flaky', 'b-clean']);
  });
});
