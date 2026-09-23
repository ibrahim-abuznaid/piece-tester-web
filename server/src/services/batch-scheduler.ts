interface Task { batchId: string; run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void; }

let pending: Task[] = [];
let active = 0;
let pumpScheduled = false;
const activeByBatch: Record<string, number> = {};
let getLimit: () => number = () => 3;

export function configureBatchScheduler(limitFn: () => number): void { getLimit = limitFn; }

/** Test/support helper: clear all state. */
export function resetBatchScheduler(): void { pending = []; active = 0; pumpScheduled = false; for (const k of Object.keys(activeByBatch)) delete activeByBatch[k]; }

/** Fair pick: the pending task whose batch has the fewest active units; ties → earliest pending. */
export function pickNextIndex(p: { batchId: string }[], byBatch: Record<string, number>): number {
  let best = -1, bestActive = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = byBatch[p[i].batchId] ?? 0;
    if (a < bestActive) { bestActive = a; best = i; }
  }
  return best;
}

/** Enqueue one piece's serial work; resolves when it finishes. Respects the global cap + fairness. */
export function submitPieceUnit(batchId: string, run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => { pending.push({ batchId, run, resolve, reject }); schedulePump(); });
}

/** Defer pumping so a burst of synchronous submits all enqueue before fairness picks. */
function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(() => { pumpScheduled = false; pump(); });
}

function pump(): void {
  while (active < getLimit() && pending.length > 0) {
    const idx = pickNextIndex(pending, activeByBatch);
    if (idx < 0) break;
    const task = pending.splice(idx, 1)[0];
    active++; activeByBatch[task.batchId] = (activeByBatch[task.batchId] ?? 0) + 1;
    task.run().then(task.resolve, task.reject).finally(() => {
      active--; activeByBatch[task.batchId] = (activeByBatch[task.batchId] ?? 1) - 1;
      pump();
    });
  }
}
