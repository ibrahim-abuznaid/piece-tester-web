import { describe, it, expect } from 'vitest';
import { assignColumn, isConfirmed, sortByConfidence, groupByColumn } from './healthBoard';
import type { AttentionItem } from './api';

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    plan_id: 1, piece_name: '@activepieces/piece-x', action_name: 'do', bucket: 'likely_broken',
    category: 'piece_error', fail_streak: 2, flaky: false, error: null, reason: '',
    failing_since: null, last_run_at: null, last_run_id: 1, quarantined: false,
    quarantine_id: null, backlinks: null, ...over,
  };
}
const noReports = new Set<string>();

describe('assignColumn', () => {
  it('routes piece_error to the errors column', () => {
    expect(assignColumn(item({ category: 'piece_error' }), noReports)).toBe('errors');
  });
  it('routes auth / connection_broken / reauth-bucket to connection', () => {
    expect(assignColumn(item({ category: 'auth' }), noReports)).toBe('connection');
    expect(assignColumn(item({ category: 'connection_broken', bucket: 'reauth' }), noReports)).toBe('connection');
    expect(assignColumn(item({ category: 'whatever', bucket: 'reauth' }), noReports)).toBe('connection');
  });
  it('routes bad_request / not_found / assert_failed / unknown to the errors column', () => {
    for (const c of ['bad_request', 'not_found', 'assert_failed', 'unknown']) {
      expect(assignColumn(item({ category: c }), noReports)).toBe('errors');
    }
  });
  it('muted takes precedence over everything (quarantined or noise bucket)', () => {
    expect(assignColumn(item({ quarantined: true, category: 'piece_error' }), noReports)).toBe('muted');
    expect(assignColumn(item({ bucket: 'noise', category: 'transient' }), noReports)).toBe('muted');
  });
  it('reported takes precedence over category but not over muted', () => {
    const reported = new Set(['@activepieces/piece-x']);
    expect(assignColumn(item({ category: 'piece_error' }), reported)).toBe('reported');
    expect(assignColumn(item({ category: 'piece_error', quarantined: true }), reported)).toBe('muted');
  });
});

describe('isConfirmed', () => {
  it('is true for a 2x+ non-flaky streak', () => {
    expect(isConfirmed(item({ fail_streak: 2, flaky: false }))).toBe(true);
  });
  it('is false for a single failure or a flaky one', () => {
    expect(isConfirmed(item({ fail_streak: 1, flaky: false }))).toBe(false);
    expect(isConfirmed(item({ fail_streak: 3, flaky: true }))).toBe(false);
  });
});

describe('sortByConfidence', () => {
  it('puts confirmed above unconfirmed, then streak descending', () => {
    const a = item({ plan_id: 1, fail_streak: 1, flaky: false }); // unconfirmed
    const b = item({ plan_id: 2, fail_streak: 5, flaky: false }); // confirmed, hi
    const c = item({ plan_id: 3, fail_streak: 2, flaky: false }); // confirmed, lo
    expect(sortByConfidence([a, b, c]).map(x => x.plan_id)).toEqual([2, 3, 1]);
  });
});

describe('groupByColumn', () => {
  it('distributes items into the four columns and sorts each', () => {
    const g = groupByColumn([
      item({ plan_id: 1, category: 'piece_error' }),
      item({ plan_id: 2, category: 'auth', bucket: 'reauth' }),
      item({ plan_id: 3, category: 'bad_request' }),
      item({ plan_id: 4, quarantined: true }),
    ], new Set());
    // piece_error + bad_request both land in the merged errors column.
    expect(g.errors.map(x => x.plan_id).sort()).toEqual([1, 3]);
    expect(g.connection.map(x => x.plan_id)).toEqual([2]);
    expect(g.muted.map(x => x.plan_id)).toEqual([4]);
    expect(g.reported).toEqual([]);
  });
});
