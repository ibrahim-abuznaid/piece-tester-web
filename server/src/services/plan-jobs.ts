import { EventEmitter } from 'events';

export interface PlanJobEvent {
  event: string;
  data: any;
}

export interface PlanJob {
  id: string;
  pieceName: string;
  actionName: string;
  status: 'running' | 'done' | 'error';
  events: PlanJobEvent[];
  startedAt: number;
  completedAt?: number;
  emitter: EventEmitter;
}

// ── Batch Queue types ──

export interface BatchQueueItem {
  pieceName: string;
  pieceDisplayName: string;
  actionName: string;
  actionDisplayName: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  error?: string;
}

export interface BatchQueue {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  items: BatchQueueItem[];
  currentIndex: number;
  startedAt: number;
  completedAt?: number;
  emitter: EventEmitter;
  events: PlanJobEvent[];
  cancelled: boolean;
}

const activeJobs = new Map<string, PlanJob>();
let activeBatchQueue: BatchQueue | null = null;

const CLEANUP_DELAY_MS = 2 * 60 * 1000;

function jobKey(pieceName: string, actionName: string): string {
  return `${pieceName}/${actionName}`;
}

export function getJob(pieceName: string, actionName: string): PlanJob | undefined {
  return activeJobs.get(jobKey(pieceName, actionName));
}

export function getActiveJobsForPiece(pieceName: string): Record<string, { status: string; startedAt: number; source?: string }> {
  const result: Record<string, { status: string; startedAt: number; source?: string }> = {};
  for (const [, job] of activeJobs) {
    if (job.pieceName === pieceName) {
      result[job.actionName] = { status: job.status, startedAt: job.startedAt, source: 'individual' };
    }
  }
  // Also check the batch queue
  if (activeBatchQueue && activeBatchQueue.status === 'running') {
    for (const item of activeBatchQueue.items) {
      if (item.pieceName === pieceName && (item.status === 'running' || item.status === 'pending')) {
        if (!result[item.actionName]) {
          result[item.actionName] = { status: item.status, startedAt: activeBatchQueue.startedAt, source: 'batch' };
        }
      }
    }
  }
  return result;
}

export function createJob(pieceName: string, actionName: string): PlanJob {
  const key = jobKey(pieceName, actionName);

  const job: PlanJob = {
    id: key,
    pieceName,
    actionName,
    status: 'running',
    events: [],
    startedAt: Date.now(),
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(50);
  activeJobs.set(key, job);
  return job;
}

export function emitJobEvent(job: PlanJob, event: string, data: any): void {
  const evt: PlanJobEvent = { event, data };
  job.events.push(evt);
  job.emitter.emit('event', evt);
}

export function completeJob(job: PlanJob, status: 'done' | 'error' = 'done'): void {
  job.status = status;
  job.completedAt = Date.now();
  job.emitter.emit('complete');

  setTimeout(() => {
    const key = jobKey(job.pieceName, job.actionName);
    if (activeJobs.get(key) === job) {
      activeJobs.delete(key);
    }
  }, CLEANUP_DELAY_MS);
}

/**
 * Subscribe an SSE response to a job's event stream.
 * Replays all buffered events, then streams live events until
 * the job completes or the client disconnects.
 */
export function subscribeToJob(
  job: PlanJob,
  sendEvent: (event: string, data: unknown) => void,
  onEnd: () => void,
): void {
  // Replay buffered events
  for (const evt of job.events) {
    sendEvent(evt.event, evt.data);
  }

  if (job.status !== 'running') {
    onEnd();
    return;
  }

  const onEvent = (evt: PlanJobEvent) => sendEvent(evt.event, evt.data);
  const onComplete = () => {
    job.emitter.off('event', onEvent);
    job.emitter.off('complete', onComplete);
    onEnd();
  };

  job.emitter.on('event', onEvent);
  job.emitter.on('complete', onComplete);

  // Return cleanup in case caller needs to unsubscribe early (client disconnect)
  return void 0;
}

/**
 * Subscribe with cleanup handle for client disconnect.
 * Returns an unsubscribe function.
 */
export function subscribeToJobWithCleanup(
  job: PlanJob,
  sendEvent: (event: string, data: unknown) => void,
  onEnd: () => void,
): () => void {
  for (const evt of job.events) {
    sendEvent(evt.event, evt.data);
  }

  if (job.status !== 'running') {
    onEnd();
    return () => {};
  }

  const onEvent = (evt: PlanJobEvent) => sendEvent(evt.event, evt.data);
  const onComplete = () => {
    cleanup();
    onEnd();
  };

  job.emitter.on('event', onEvent);
  job.emitter.on('complete', onComplete);

  function cleanup() {
    job.emitter.off('event', onEvent);
    job.emitter.off('complete', onComplete);
  }

  return cleanup;
}

// ══════════════════════════════════════════════════════════════
// Batch Queue
// ══════════════════════════════════════════════════════════════

export function getBatchQueue(): BatchQueue | null {
  return activeBatchQueue;
}

export function getBatchQueueStatus(): {
  id: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  currentIndex: number;
  totalItems: number;
  items: Omit<BatchQueueItem, 'error'>[];
  stats: { pending: number; running: number; done: number; error: number; skipped: number };
} | null {
  if (!activeBatchQueue) return null;
  const q = activeBatchQueue;
  const stats = { pending: 0, running: 0, done: 0, error: 0, skipped: 0 };
  for (const item of q.items) {
    stats[item.status]++;
  }
  return {
    id: q.id,
    status: q.status,
    startedAt: q.startedAt,
    completedAt: q.completedAt,
    currentIndex: q.currentIndex,
    totalItems: q.items.length,
    items: q.items.map(i => ({ pieceName: i.pieceName, pieceDisplayName: i.pieceDisplayName, actionName: i.actionName, actionDisplayName: i.actionDisplayName, status: i.status })),
    stats,
  };
}

export function createBatchQueue(items: BatchQueueItem[]): BatchQueue {
  if (activeBatchQueue && activeBatchQueue.status === 'running') {
    throw new Error('A batch queue is already running');
  }
  const queue: BatchQueue = {
    id: `batch_${Date.now()}`,
    status: 'running',
    items,
    currentIndex: -1,
    startedAt: Date.now(),
    emitter: new EventEmitter(),
    events: [],
    cancelled: false,
  };
  queue.emitter.setMaxListeners(50);
  activeBatchQueue = queue;
  return queue;
}

export function emitBatchEvent(queue: BatchQueue, event: string, data: any): void {
  const evt: PlanJobEvent = { event, data };
  queue.events.push(evt);
  queue.emitter.emit('event', evt);
}

export function completeBatchQueue(queue: BatchQueue, status: 'done' | 'cancelled' = 'done'): void {
  queue.status = status;
  queue.completedAt = Date.now();
  queue.emitter.emit('complete');

  setTimeout(() => {
    if (activeBatchQueue === queue) {
      activeBatchQueue = null;
    }
  }, 5 * CLEANUP_DELAY_MS);
}

export function cancelBatchQueue(): boolean {
  if (!activeBatchQueue || activeBatchQueue.status !== 'running') return false;
  activeBatchQueue.cancelled = true;
  return true;
}

export function subscribeToBatchWithCleanup(
  queue: BatchQueue,
  sendEvent: (event: string, data: unknown) => void,
  onEnd: () => void,
): () => void {
  for (const evt of queue.events) {
    sendEvent(evt.event, evt.data);
  }

  if (queue.status !== 'running') {
    onEnd();
    return () => {};
  }

  const onEvent = (evt: PlanJobEvent) => sendEvent(evt.event, evt.data);
  const onComplete = () => {
    doCleanup();
    onEnd();
  };

  queue.emitter.on('event', onEvent);
  queue.emitter.on('complete', onComplete);

  function doCleanup() {
    queue.emitter.off('event', onEvent);
    queue.emitter.off('complete', onComplete);
  }

  return doCleanup;
}
