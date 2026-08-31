import { describe, it, expect } from 'vitest';
import { parseDbTime, runDurationSeconds } from './time';

describe('parseDbTime', () => {
  it('treats a space-separated SQLite timestamp as UTC', () => {
    // Same instant, two encodings, must be equal:
    expect(parseDbTime('2026-08-31 12:00:00')).toBe(Date.parse('2026-08-31T12:00:00Z'));
  });
  it('passes through an ISO string with Z unchanged', () => {
    expect(parseDbTime('2026-08-31T12:00:05.000Z')).toBe(Date.parse('2026-08-31T12:00:05.000Z'));
  });
});

describe('runDurationSeconds', () => {
  it('computes a small positive duration across the two encodings (no TZ skew)', () => {
    // 5 seconds apart — must NOT be ~19,800s regardless of the machine timezone.
    const d = runDurationSeconds('2026-08-31 12:00:00', '2026-08-31T12:00:05.000Z');
    expect(d).toBe(5);
  });
  it('returns null when either side is missing', () => {
    expect(runDurationSeconds('2026-08-31 12:00:00', null)).toBeNull();
    expect(runDurationSeconds(null, '2026-08-31T12:00:05.000Z')).toBeNull();
  });
});
