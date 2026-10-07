import { describe, it, expect } from 'vitest';
import { parseConfigPatch } from './config.js';

describe('parseConfigPatch', () => {
  it('accepts a full valid patch and normalizes flags and the team key', () => {
    expect(parseConfigPatch({
      enabled: true, auto_file_enabled: 0, cron_expression: '0 5 * * *', timezone: 'Asia/Amman',
      linear_team_key: 'pie', linear_label: 'vendor-watch', classifier_model: '', dead_after_failures: 4,
    })).toEqual({ patch: {
      enabled: 1, auto_file_enabled: 0, cron_expression: '0 5 * * *', timezone: 'Asia/Amman',
      linear_team_key: 'PIE', linear_label: 'vendor-watch', classifier_model: '', dead_after_failures: 4,
    } });
  });

  it('returns an empty patch for an empty body', () => {
    expect(parseConfigPatch({})).toEqual({ patch: {} });
  });

  it.each([
    [{ cron_expression: 'every day' }, /Invalid cron/],
    [{ timezone: 'Mars/Olympus' }, /Unknown timezone/],
    [{ linear_team_key: 'p-1' }, /team key/],
    [{ linear_label: '' }, /1–80/],
    [{ linear_label: 'piece-tester' }, /Bug Trend/],
    [{ linear_label: 'Piece-Tester' }, /Bug Trend/],
    [{ linear_label: ' piece-tester ' }, /Bug Trend/],
    [{ dead_after_failures: 0 }, /1 to 30/],
    [{ dead_after_failures: 2.5 }, /1 to 30/],
  ])('rejects %j', (body, message) => {
    expect(parseConfigPatch(body).error).toMatch(message);
  });
});
