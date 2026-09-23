import { describe, it, expect, beforeEach } from 'vitest';
import {
  configureBatchScheduler, submitPieceUnit, resetBatchScheduler, pickNextIndex,
} from './batch-scheduler.js';

const tick = () => new Promise(r => setTimeout(r, 5));

describe('pickNextIndex (fairness)', () => {
  it('prefers the batch with the fewest active units, FIFO on ties', () => {
    const pending = [{ batchId: 'a' }, { batchId: 'b' }, { batchId: 'a' }];
    expect(pickNextIndex(pending, { a: 2, b: 0 })).toBe(1); // b has fewer active → its task (idx 1)
    expect(pickNextIndex(pending, { a: 0, b: 0 })).toBe(0); // tie → first pending (idx 0)
    expect(pickNextIndex([], {})).toBe(-1);
  });
});

describe('batch scheduler', () => {
  beforeEach(() => { resetBatchScheduler(); configureBatchScheduler(() => 2); });

  it('never runs more than the global limit at once, across batches', async () => {
    let inFlight = 0, maxInFlight = 0;
    const mk = (batchId: string) => submitPieceUnit(batchId, async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight--;
    });
    await Promise.all([mk('a'), mk('a'), mk('a'), mk('b'), mk('b'), mk('b')]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('interleaves batches so both make progress (not all of A first)', async () => {
    const started: string[] = [];
    const mk = (batchId: string) => submitPieceUnit(batchId, async () => { started.push(batchId); await tick(); });
    await Promise.all([mk('a'), mk('a'), mk('b'), mk('b')]);
    // With limit 2 and fairness, the first two started must be one A and one B.
    expect(new Set(started.slice(0, 2))).toEqual(new Set(['a', 'b']));
  });
});
