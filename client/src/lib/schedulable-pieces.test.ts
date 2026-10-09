import { describe, it, expect } from 'vitest';
import { schedulablePieces } from './schedulable-pieces';
import type { CoverageRow } from './api';

function cov(piece: string, display: string, connected: boolean, hasPlans: boolean): CoverageRow {
  return {
    piece_name: piece, display_name: display, logo_url: null,
    connected, requires_auth: true, covered: false, schedule_id: null,
    cadence: null, has_plans: hasPlans,
    plan_count: hasPlans ? 1 : 0, planned_targets: hasPlans ? 1 : 0, total_targets: 1, health: null,
    actions_failing: 0, last_run_at: null, last_run_id: null,
  };
}

describe('schedulablePieces', () => {
  it('offers connected pieces and pieces that already have plans, sorted by display name', () => {
    const rows = [
      cov('@activepieces/piece-slack', 'Slack', true, false),
      cov('@activepieces/piece-ai', 'AI', false, true),
      cov('@activepieces/piece-hubspot', 'HubSpot', false, false),
    ];
    expect(schedulablePieces(rows).map(p => p.display_name)).toEqual(['AI', 'Slack']);
  });

  it('returns nothing for an empty catalog', () => {
    expect(schedulablePieces([])).toEqual([]);
  });
});
