import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from './schema.js';
import { getSettings, updateSettings } from './queries.js';

describe('bug trend settings columns', () => {
  afterEach(() => { updateSettings({ linear_api_key: '', bug_trend_roster: '[]' }); });

  it('adds both columns with empty defaults', () => {
    const cols = getDb().pragma('table_info(settings)') as { name: string; dflt_value: string | null }[];
    expect(cols.find(c => c.name === 'linear_api_key')?.dflt_value).toBe("''");
    expect(cols.find(c => c.name === 'bug_trend_roster')?.dflt_value).toBe("'[]'");
  });

  it('round-trips the key and roster, and keeps them across unrelated updates', () => {
    updateSettings({ linear_api_key: 'lin_api_test', bug_trend_roster: '[{"id":"u1","name":"A"}]' });
    updateSettings({ batch_concurrency: 3 });
    const s = getSettings();
    expect(s.linear_api_key).toBe('lin_api_test');
    expect(s.bug_trend_roster).toBe('[{"id":"u1","name":"A"}]');
  });
});
