import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getCoverage } from './queries.js';

function seedPlan(piece: string, action: string, status: string) {
  getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status) VALUES (?,?,?,?,?)`,
    [piece, action, 'action', '[]', status],
  );
}

describe('getCoverage — planned_targets counts approved plans only', () => {
  beforeEach(() => getDb().exec(
    'DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM schedules; DELETE FROM piece_connections;',
  ));

  it('excludes draft plans from planned_targets', () => {
    seedPlan('slack', 'send_message', 'approved');
    seedPlan('slack', 'find_channel', 'draft');

    const rows = getCoverage([{ name: 'slack', displayName: 'Slack', actions: 3, triggers: 0 }]);
    const slack = rows.find(r => r.piece_name === 'slack')!;

    expect(slack.planned_targets).toBe(1); // only the approved plan, not the draft
    expect(slack.total_targets).toBe(3);
    expect(slack.plan_count).toBe(1);
    expect(slack.has_plans).toBe(true);
  });

  it('planned_targets is 0 when a piece has only draft plans', () => {
    seedPlan('github', 'create_issue', 'draft');

    const rows = getCoverage([{ name: 'github', displayName: 'GitHub', actions: 2, triggers: 1 }]);
    const gh = rows.find(r => r.piece_name === 'github')!;

    expect(gh.planned_targets).toBe(0);
    expect(gh.has_plans).toBe(false);
  });
});
