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

  describe('importance settings', () => {
    const saved = { importance_high_min: 300, importance_medium_min: 50 };

    it('accepts thresholds and a deduped, trimmed enterprise list', () => {
      expect(parseConfigPatch({
        importance_high_min: 500, importance_medium_min: 40,
        enterprise_pieces: [' @activepieces/piece-salesforce', '@activepieces/piece-salesforce', '@activepieces/piece-sap'],
      }, saved)).toEqual({ patch: {
        importance_high_min: 500, importance_medium_min: 40,
        enterprise_pieces: '["@activepieces/piece-salesforce","@activepieces/piece-sap"]',
      } });
    });

    it('accepts an empty enterprise list', () => {
      expect(parseConfigPatch({ enterprise_pieces: [] }, saved)).toEqual({ patch: { enterprise_pieces: '[]' } });
    });

    it('checks High above Medium against the saved value when only one threshold changes', () => {
      expect(parseConfigPatch({ importance_medium_min: 300 }, saved).error).toMatch(/High must be above Medium/);
      expect(parseConfigPatch({ importance_high_min: 50 }, saved).error).toMatch(/High must be above Medium/);
      expect(parseConfigPatch({ importance_high_min: 51 }, saved)).toEqual({ patch: { importance_high_min: 51 } });
    });

    it.each([
      [{ importance_high_min: 0 }, /whole number/],
      [{ importance_medium_min: 1.5 }, /whole number/],
      [{ importance_high_min: 2_000_000 }, /whole number/],
      [{ enterprise_pieces: 'piece-sap' }, /list of piece names/],
      [{ enterprise_pieces: [42] }, /list of piece names/],
      [{ enterprise_pieces: ['not a piece name!'] }, /Not a piece name/],
      [{ enterprise_pieces: Array.from({ length: 201 }, (_, i) => `@x/piece-${i}`) }, /At most 200/],
    ])('rejects %j', (body, message) => {
      expect(parseConfigPatch(body, saved).error).toMatch(message);
    });
  });
});
