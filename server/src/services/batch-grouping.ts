import type { BatchQueueItem } from './plan-jobs.js';

export interface IndexedItem { item: BatchQueueItem; index: number; }

/** Group items by pieceName into per-piece groups, preserving first-seen order and original indices. */
export function groupByPiece(items: BatchQueueItem[]): IndexedItem[][] {
  const byPiece = new Map<string, IndexedItem[]>();
  items.forEach((item, index) => {
    const g = byPiece.get(item.pieceName) ?? [];
    g.push({ item, index });
    byPiece.set(item.pieceName, g);
  });
  return [...byPiece.values()];
}
