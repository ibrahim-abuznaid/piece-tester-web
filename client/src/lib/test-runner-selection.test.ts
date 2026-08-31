import { describe, it, expect } from 'vitest';
import { buildPieceGroups } from './test-runner-selection';
import type { CoverageRow, TestPlan } from './api';

function cov(piece: string, connected: boolean, requiresAuth = true): CoverageRow {
  return {
    piece_name: piece, display_name: piece.toUpperCase(), logo_url: null,
    connected, requires_auth: requiresAuth, covered: true, schedule_id: null,
    cadence: null, has_plans: true,
    plan_count: 1, planned_targets: 1, total_targets: 1, health: 'unknown',
    actions_failing: 0, last_run_at: null, last_run_id: null,
  };
}
function plan(
  id: number, piece: string, action: string, status: 'draft' | 'approved',
  needsRegen = 0, automationStatus: TestPlan['automation_status'] = 'unknown',
): TestPlan {
  return {
    id, piece_name: piece, target_action: action, target_type: 'action',
    steps: [], status, agent_memory: '', automation_status: automationStatus,
    needs_regen: needsRegen, created_at: '', updated_at: '',
  };
}

describe('buildPieceGroups', () => {
  it('includes only approved plans, grouped by piece', () => {
    const groups = buildPieceGroups(
      [cov('slack', true)],
      [plan(1, 'slack', 'send', 'approved'), plan(2, 'slack', 'draft_action', 'draft')],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].targets.map((t) => t.planId)).toEqual([1]);
  });

  it('marks targets of an unconnected auth-requiring piece non-runnable', () => {
    const groups = buildPieceGroups([cov('slack', false)], [plan(1, 'slack', 'send', 'approved')]);
    expect(groups[0].runnable).toBe(false);
    expect(groups[0].targets[0].runnable).toBe(false);
    expect(groups[0].targets[0].reason).toMatch(/connection/i);
  });

  it('keeps an auth-less piece runnable without a connection', () => {
    const groups = buildPieceGroups(
      [cov('delay', false, false)],
      [plan(1, 'delay', 'wait', 'approved')],
    );
    expect(groups[0].targets[0].runnable).toBe(true);
    expect(groups[0].targets[0].reason).toBeUndefined();
    expect(groups[0].runnable).toBe(true);
  });

  it('marks a stale plan non-runnable but keeps the piece runnable if a fresh target exists', () => {
    const groups = buildPieceGroups(
      [cov('slack', true)],
      [plan(1, 'slack', 'send', 'approved', 1), plan(2, 'slack', 'edit', 'approved', 0)],
    );
    const stale = groups[0].targets.find((t) => t.planId === 1)!;
    const fresh = groups[0].targets.find((t) => t.planId === 2)!;
    expect(stale.runnable).toBe(false);
    expect(stale.reason).toMatch(/stale/i);
    expect(fresh.runnable).toBe(true);
    expect(groups[0].runnable).toBe(true);
  });

  it('marks a requires_human plan non-runnable (would pause an unattended batch)', () => {
    const groups = buildPieceGroups(
      [cov('slack', true)],
      [plan(1, 'slack', 'ask', 'approved', 0, 'requires_human')],
    );
    expect(groups[0].targets[0].runnable).toBe(false);
    expect(groups[0].targets[0].reason).toMatch(/human/i);
    expect(groups[0].runnable).toBe(false);
  });
});
