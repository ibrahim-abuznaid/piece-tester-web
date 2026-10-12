import { describe, it, expect } from 'vitest';
import { getDb } from './schema.js';

describe('run-history indexes', () => {
  it('creates the indexes the board queries rely on', () => {
    const names = getDb().all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`,
    ).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'idx_test_plan_runs_plan_id',
      'idx_test_plan_runs_wave_id',
      'idx_test_plan_runs_status',
      'idx_ai_usage_logs_created_at',
    ]));
  });
});
