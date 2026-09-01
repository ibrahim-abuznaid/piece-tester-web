import { describe, it, expect } from 'vitest';
import { classifyPiece, categorizeError, type RunLite } from './regression-classifier.js';

// Helper: build decided runs with sequential timestamps. `pattern` is oldest→newest,
// e.g. 'CCCCCFFFFF' = 5 completed then 5 failed. C=completed, F=failed, B=blocked.
function runs(pattern: string, startDay = 1): RunLite[] {
  return pattern.split('').map((ch, i) => ({
    status: ch === 'C' ? 'completed' : ch === 'F' ? 'failed' : 'blocked',
    started_at: `2026-08-${String(startDay + i).padStart(2, '0')} 10:00:00`,
  }));
}
const NOW = '2026-08-25 12:00:00';

describe('classifyPiece — lanes', () => {
  it('newly_broken: was healthy, recent runs fail, last run failed', () => {
    const c = classifyPiece(runs('CCCCCFFFFF', 10), { now: NOW });
    expect(c.lane).toBe('newly_broken');
    expect(c.recentRate).toBe(0);
    expect(c.priorRate).toBe(100);
  });

  it('recovered: was broken, recent runs pass, last run passed', () => {
    const c = classifyPiece(runs('FFFFFCCCCC', 10), { now: NOW });
    expect(c.lane).toBe('recovered');
    expect(c.recentRate).toBe(100);
    expect(c.priorRate).toBe(0);
  });

  it('degrading: material drop but not a clean break', () => {
    // prior 5 = 100%, recent 5 (oldest→newest) = C,C,C,F,F = 60%
    const c = classifyPiece(runs('CCCCCCCCFF', 10), { now: NOW });
    expect(c.lane).toBe('degrading');
    expect(c.recentRate).toBe(60);
    expect(c.priorRate).toBe(100);
  });

  it('flaky: alternating pass/fail with no plan change', () => {
    // both windows alternate → no big drop, but many flips
    const c = classifyPiece(runs('CFCFCCFCFC', 10), { now: NOW, planUpdatedAt: '2026-01-01 00:00:00' });
    expect(c.lane).toBe('flaky');
  });

  it('not flaky when the plan changed inside the window', () => {
    const c = classifyPiece(runs('CFCFCCFCFC', 10), { now: NOW, planUpdatedAt: '2026-08-24 00:00:00' });
    expect(c.lane).not.toBe('flaky');
  });

  it('still_broken: failing in both windows, no change', () => {
    const c = classifyPiece(runs('FFFFFFFFFF', 10), { now: NOW });
    expect(c.lane).toBe('still_broken');
  });

  it('stable: consistently passing', () => {
    const c = classifyPiece(runs('CCCCCCCCCC', 10), { now: NOW });
    expect(c.lane).toBe('stable');
  });

  it('stale: last run older than the staleness window', () => {
    const c = classifyPiece(runs('CCCCCCCCCC', 1).map(r => ({ ...r, started_at: '2026-07-01 10:00:00' })), { now: NOW });
    expect(c.lane).toBe('stale');
  });

  it('stale: fewer than the minimum number of runs', () => {
    const c = classifyPiece(runs('CC', 20), { now: NOW });
    expect(c.lane).toBe('stale');
  });

  it('ignores blocked runs when computing rates', () => {
    // 5 completed prior, then 5 completed recent with blocked interleaved (blocked ignored)
    const c = classifyPiece(runs('CCCCCBBCCCCC', 10), { now: NOW });
    expect(c.lane).toBe('stable');
    expect(c.recentRate).toBe(100);
  });
});

describe('categorizeError — failure buckets for the "why tests fail" chart', () => {
  it.each([
    ['Request failed with status code 401', 'auth'],
    ['Authentication required', 'auth'],
    ['Request timed out after 90s', 'timeout'],
    ['No trigger event was captured within the timeout', 'no_trigger'],
    ['Request failed with status code 429', 'rate_limit'],
    ['Request failed with status code 404', 'not_found'],
    ['Request failed with status code 500', 'server_error'],
    ['Something totally unexpected happened', 'other'],
  ])('categorizes %j as %j', (error, expected) => {
    expect(categorizeError(error)).toBe(expected);
  });
});
