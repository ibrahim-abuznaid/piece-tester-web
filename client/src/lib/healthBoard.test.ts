import { describe, it, expect } from 'vitest';
import {
  assignColumn, assignPieceColumn, isConfirmed, sortByConfidence,
  groupByPiece, groupPiecesByColumn, pieceKindCounts,
} from './healthBoard';
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

describe('assignPieceColumn', () => {
  const px = '@activepieces/piece-x';
  it('routes a piece with any live error to the errors lane, even mixed with auth', () => {
    const items = [item({ category: 'piece_error' }), item({ category: 'auth', bucket: 'reauth' })];
    expect(assignPieceColumn(items, noReports)).toBe('errors');
  });
  it('routes a connection-only piece to the connection lane', () => {
    const items = [item({ category: 'auth' }), item({ category: 'connection_broken', bucket: 'reauth' })];
    expect(assignPieceColumn(items, noReports)).toBe('connection');
  });
  it('is muted only when ALL failing actions are muted', () => {
    expect(assignPieceColumn([item({ quarantined: true }), item({ bucket: 'noise', category: 'transient' })], noReports)).toBe('muted');
    // one muted + one live error → not muted, the error wins.
    expect(assignPieceColumn([item({ quarantined: true }), item({ category: 'piece_error' })], noReports)).toBe('errors');
  });
  it('treats reported/muted as terminal: reported wins over a live error, muted-all wins over reported', () => {
    const reported = new Set([px]);
    expect(assignPieceColumn([item({ category: 'piece_error' })], reported)).toBe('reported');
    expect(assignPieceColumn([item({ category: 'piece_error', quarantined: true })], reported)).toBe('muted');
  });
});

describe('pieceKindCounts', () => {
  it('counts error / connection / muted actions', () => {
    const counts = pieceKindCounts([
      item({ category: 'piece_error' }),
      item({ category: 'bad_request' }),
      item({ category: 'auth', bucket: 'reauth' }),
      item({ quarantined: true }),
    ]);
    expect(counts).toEqual({ error: 2, connection: 1, muted: 1 });
  });
});

describe('groupByPiece', () => {
  it('collapses multiple failing actions of one piece into a single group', () => {
    const groups = groupByPiece([
      item({ plan_id: 1, piece_name: '@activepieces/piece-slack', action_name: 'send', category: 'piece_error' }),
      item({ plan_id: 2, piece_name: '@activepieces/piece-slack', action_name: 'update', category: 'piece_error' }),
      item({ plan_id: 3, piece_name: '@activepieces/piece-gmail', action_name: 'send', category: 'auth', bucket: 'reauth' }),
    ], noReports);
    expect(groups).toHaveLength(2);
    const slack = groups.find(g => g.piece_name.endsWith('slack'))!;
    expect(slack.items).toHaveLength(2);
    expect(slack.lane).toBe('errors');
    expect(slack.confirmed).toBe(true);
  });
});

describe('groupPiecesByColumn', () => {
  it('places one card per piece into its lane, sorted confirmed-first', () => {
    const g = groupPiecesByColumn([
      item({ plan_id: 1, piece_name: '@activepieces/piece-slack', category: 'piece_error', fail_streak: 1, flaky: true }), // unconfirmed
      item({ plan_id: 2, piece_name: '@activepieces/piece-hubspot', category: 'bad_request', fail_streak: 4 }),            // confirmed
      item({ plan_id: 3, piece_name: '@activepieces/piece-dropbox', category: 'auth', bucket: 'reauth' }),
      item({ plan_id: 4, piece_name: '@activepieces/piece-noisy', quarantined: true }),
    ], new Set());
    expect(g.errors.map(x => x.piece_name)).toEqual(['@activepieces/piece-hubspot', '@activepieces/piece-slack']);
    expect(g.connection.map(x => x.piece_name)).toEqual(['@activepieces/piece-dropbox']);
    expect(g.muted.map(x => x.piece_name)).toEqual(['@activepieces/piece-noisy']);
    expect(g.reported).toEqual([]);
  });
});
