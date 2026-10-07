import { describe, it, expect } from 'vitest';
import { describeTargets, effectiveLabel, parseJsonArray, shortPieceName, sourceHealth } from './vendorWatch';

describe('vendorWatch helpers', () => {
  it('describes targets', () => {
    expect(describeTargets('["*"]')).toBe('whole piece');
    expect(describeTargets('["a","b"]')).toBe('a, b');
    expect(describeTargets('[]')).toBe('—');
    expect(describeTargets('nope')).toBe('—');
  });

  it('labels effective dates relative to today', () => {
    const today = new Date('2026-10-06T20:00:00Z');
    expect(effectiveLabel('2026-10-16', today)).toBe('2026-10-16 (in 10d)');
    expect(effectiveLabel('2026-10-01', today)).toBe('2026-10-01 (5d ago)');
    expect(effectiveLabel('2026-10-06', today)).toBe('2026-10-06 (today)');
    expect(effectiveLabel(null, today)).toBe('—');
  });

  it('classifies source health, counting a noted error as failing', () => {
    expect(sourceHealth({ last_checked_at: null, consecutive_failures: 0, last_error: '' })).toBe('never');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 0, last_error: '' })).toBe('ok');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 2, last_error: 'HTTP 500' })).toBe('failing');
    expect(sourceHealth({ last_checked_at: 'x', consecutive_failures: 0, last_error: 'Timed out' })).toBe('failing');
  });

  it('parses JSON arrays defensively and shortens piece names', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(shortPieceName('@activepieces/piece-slack')).toBe('slack');
  });
});
