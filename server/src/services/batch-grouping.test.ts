import { describe, it, expect } from 'vitest';
import { groupByPiece } from './batch-grouping.js';
import type { BatchQueueItem } from './plan-jobs.js';

const item = (pieceName: string, actionName: string): BatchQueueItem => ({
  pieceName, pieceDisplayName: pieceName, actionName, actionDisplayName: actionName,
  targetType: 'action', status: 'pending',
});

describe('groupByPiece', () => {
  it('groups items by piece, preserving original index and order', () => {
    const items = [item('slack', 'a1'), item('hubspot', 'b1'), item('slack', 'a2')];
    const groups = groupByPiece(items);
    expect(groups).toEqual([
      [{ item: items[0], index: 0 }, { item: items[2], index: 2 }],
      [{ item: items[1], index: 1 }],
    ]);
  });

  it('returns [] for no items', () => {
    expect(groupByPiece([])).toEqual([]);
  });
});
