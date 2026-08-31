import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from './concurrency.js';

describe('runWithConcurrency', () => {
  it('never exceeds the limit and processes every item', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];

    await runWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item);
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('resolves immediately for an empty list', async () => {
    let called = 0;
    await runWithConcurrency([], 3, async () => { called++; });
    expect(called).toBe(0);
  });
});
