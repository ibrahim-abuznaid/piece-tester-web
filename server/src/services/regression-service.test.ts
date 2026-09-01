import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { getPieceRegressions, getPerformanceSummary, getFailureBreakdown } from './regression-service.js';

function seedPlan(piece: string, action: string): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, status, updated_at)
     VALUES (?,?,?,?,?)`,
    [piece, action, 'action', 'approved', '2026-01-01 00:00:00'],
  ).lastId;
}
function seedRun(planId: number, status: string, startedAt: string, stepResults = '[]'): void {
  getDb().run(
    `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at, completed_at)
     VALUES (?,?,?,?,?,?)`,
    [planId, status, 'scheduled', stepResults, startedAt, startedAt],
  );
}
const AUTH_FAIL = JSON.stringify([
  { stepId: 'call', label: 'Call API', status: 'failed', error: 'Request failed with status code 401', duration_ms: 120 },
]);
const TIMEOUT_FAIL = JSON.stringify([
  { stepId: 'call', label: 'Call API', status: 'failed', error: 'Request timed out after 90s', duration_ms: 90000 },
]);

describe('getPieceRegressions', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('classifies a piece that just broke, with its failure count and reliability', () => {
    const plan = seedPlan('newbroke', 'do_thing');
    for (let d = 15; d <= 19; d++) seedRun(plan, 'completed', `2026-08-${d} 10:00:00`);
    for (let d = 20; d <= 24; d++) seedRun(plan, 'failed', `2026-08-${d} 10:00:00`, AUTH_FAIL);

    const row = getPieceRegressions().find(r => r.piece_name === 'newbroke')!;
    expect(row.lane).toBe('newly_broken');
    expect(row.failed).toBe(5);
    expect(row.overallRate).toBe(50); // 5 passed / 10 decided
  });

  it('classifies a consistently passing piece as stable', () => {
    const plan = seedPlan('steady', 'ok');
    for (let d = 20; d <= 25; d++) seedRun(plan, 'completed', `2026-08-${d} 10:00:00`);
    const row = getPieceRegressions().find(r => r.piece_name === 'steady')!;
    expect(row.lane).toBe('stable');
    expect(row.overallRate).toBe(100);
  });

  it('computes p95 latency across mixed timestamp formats (guards the TZ-offset bug)', () => {
    // Real data stores started_at as naive local ("2026-08-20 10:00:00") but completed_at
    // as ISO-Z ("...T10:00:05Z"). A JS `new Date()` diff mis-parses these by the local
    // offset (~5.5h = ~19.8M ms); SQLite julianday handles both. p95 must be in seconds.
    const plan = seedPlan('lat', 'a');
    for (let d = 20; d <= 23; d++) {
      getDb().run(
        `INSERT INTO test_plan_runs (plan_id, status, trigger_type, step_results, started_at, completed_at)
         VALUES (?,?,?,?,?,?)`,
        [plan, 'completed', 'scheduled', '[]', `2026-08-${d} 10:00:00`, `2026-08-${d}T10:00:05.000Z`],
      );
    }
    const row = getPieceRegressions().find(r => r.piece_name === 'lat')!;
    expect(row.p95Ms).toBeGreaterThan(0);
    expect(row.p95Ms).toBeLessThan(60_000);
  });

  it('excludes blocked runs from the reliability rate', () => {
    const plan = seedPlan('blk', 'a');
    for (let d = 20; d <= 24; d++) seedRun(plan, 'completed', `2026-08-${d} 10:00:00`);
    seedRun(plan, 'blocked', '2026-08-25 10:00:00');

    const row = getPieceRegressions().find(r => r.piece_name === 'blk')!;
    expect(row.overallRate).toBe(100); // 5 passed / 5 decided; blocked ignored
  });

  it('scopes rows to the given date range', () => {
    const plan = seedPlan('scoped', 'a');
    for (let d = 15; d <= 21; d++) seedRun(plan, 'completed', `2026-08-${d} 10:00:00`); // 7 in-range
    for (let d = 22; d <= 24; d++) seedRun(plan, 'failed', `2026-08-${d} 10:00:00`, AUTH_FAIL); // 3 in-range
    seedRun(plan, 'failed', '2026-06-01 10:00:00', AUTH_FAIL); // out of range

    const all = getPieceRegressions().find(r => r.piece_name === 'scoped')!;
    expect(all.failed).toBe(4); // 3 August + 1 June
    const scoped = getPieceRegressions('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z').find(r => r.piece_name === 'scoped')!;
    expect(scoped.failed).toBe(3); // June excluded
  });
});

describe('getPerformanceSummary', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('reports overall rate, blocked count, tested pieces and lane tallies', () => {
    const a = seedPlan('alpha', 'x');
    for (let d = 20; d <= 25; d++) seedRun(a, 'completed', `2026-08-${d} 10:00:00`);
    const b = seedPlan('beta', 'y');
    for (let d = 15; d <= 19; d++) seedRun(b, 'completed', `2026-08-${d} 10:00:00`);
    for (let d = 20; d <= 24; d++) seedRun(b, 'failed', `2026-08-${d} 10:00:00`, AUTH_FAIL);
    seedRun(b, 'blocked', '2026-08-25 10:00:00');

    const s = getPerformanceSummary();
    expect(s.tested_pieces).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.lane_counts.newly_broken).toBe(1);
    expect(s.lane_counts.stable).toBe(1);
    // decided = alpha 6C + beta (5C + 5F) = 16; passed = 11; blocked excluded → 11/16 = 69%
    expect(s.success_rate).toBe(69);
  });
});

describe('getFailureBreakdown', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans;'));

  it('buckets scheduled failures by category, most common first', () => {
    const p = seedPlan('x', 'a');
    seedRun(p, 'failed', '2026-08-20 10:00:00', AUTH_FAIL);
    seedRun(p, 'failed', '2026-08-21 10:00:00', TIMEOUT_FAIL);
    seedRun(p, 'failed', '2026-08-22 10:00:00', AUTH_FAIL);
    seedRun(p, 'completed', '2026-08-23 10:00:00'); // ignored — not a failure

    const bd = getFailureBreakdown();
    const map = Object.fromEntries(bd.map(b => [b.category, b.count]));
    expect(map.auth).toBe(2);
    expect(map.timeout).toBe(1);
    expect(bd[0].category).toBe('auth'); // sorted by count desc
  });

  it('scopes the breakdown to the given date range', () => {
    const p = seedPlan('x', 'a');
    seedRun(p, 'failed', '2026-08-20 10:00:00', AUTH_FAIL); // in range
    seedRun(p, 'failed', '2026-06-01 10:00:00', TIMEOUT_FAIL); // out of range

    const bd = getFailureBreakdown('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z');
    const map = Object.fromEntries(bd.map(b => [b.category, b.count]));
    expect(map.auth).toBe(1);
    expect(map.timeout).toBeUndefined();
  });
});
