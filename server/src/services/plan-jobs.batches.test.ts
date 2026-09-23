import { describe, it, expect } from 'vitest';
import {
  createBatchQueue, getBatch, listBatches, cancelBatch, activeBatchPieceNames,
  type BatchQueueItem,
} from './plan-jobs.js';

const item = (pieceName: string): BatchQueueItem => ({
  pieceName, pieceDisplayName: pieceName, actionName: 'a', actionDisplayName: 'a',
  targetType: 'action', status: 'pending',
});

describe('batch registry', () => {
  it('creates independent batches with distinct ids', () => {
    const a = createBatchQueue([item('slack')]);
    const b = createBatchQueue([item('gmail')]);
    expect(a.id).not.toBe(b.id);
    expect(getBatch(a.id)?.id).toBe(a.id);
    expect(listBatches().map(x => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('reports the pieces held by running batches', () => {
    createBatchQueue([item('slack'), item('slack')]);
    createBatchQueue([item('gmail')]);
    expect(activeBatchPieceNames()).toEqual(new Set(['slack', 'gmail']));
  });
});
