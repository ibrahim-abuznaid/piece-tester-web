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
  /** Abort all in-flight Anthropic calls and executePlan for this job */
  abortController: AbortController;
}

// ── Batch Queue types ──

export interface BatchQueueItem {
  pieceName: string;
  pieceDisplayName: string;
  actionName: string;            // holds the target name (action OR trigger)
  actionDisplayName: string;     // holds the target displayName
  targetType: 'action' | 'trigger';
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  error?: string;
  setupItemId?: number;          // row id in setup_run_items
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
  setupRunId?: number;
}

const activeJobs = new Map<string, PlanJob>();
const batches = new Map<string, BatchQueue>();
let batchCounter = 0;

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
  // Also check running batches
  for (const q of batches.values()) {
    if (q.status !== 'running') continue;
    for (const item of q.items) {
      if (item.pieceName === pieceName && (item.status === 'running' || item.status === 'pending')) {
        if (!result[item.actionName]) {
          result[item.actionName] = { status: item.status, startedAt: q.startedAt, source: 'batch' };
        }
      }
    }
  }
  return result;
}

/** In-progress plan jobs per piece (running individual jobs + running/pending batch items), for the Coverage "generating" badge. */
export function getActiveJobCountsByPiece(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, job] of activeJobs) {
    if (job.status === 'running') {
      counts[job.pieceName] = (counts[job.pieceName] ?? 0) + 1;
    }
  }
  for (const q of batches.values()) {
    if (q.status !== 'running') continue;
    for (const item of q.items) {
      if (item.status === 'running' || item.status === 'pending') {
        counts[item.pieceName] = (counts[item.pieceName] ?? 0) + 1;
      }
    }
  }
  return counts;
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
    abortController: new AbortController(),
  };
  job.emitter.setMaxListeners(50);
  activeJobs.set(key, job);
  return job;
}

/** Stop a running plan-creation background job (cancels Claude + plan execution). */
export function cancelPlanJob(pieceName: string, actionKey: string): boolean {
  const key = jobKey(pieceName, actionKey);
  const job = activeJobs.get(key);
  if (!job || job.status !== 'running') return false;
  try {
    job.abortController.abort();
  } catch {
    /* ignore */
  }
  emitJobEvent(job, 'error', { message: 'Cancelled by user.', cancelled: true });
  emitJobEvent(job, 'done', {});
  completeJob(job, 'error');
  return true;
}

/** Cancel every running AI plan job (v1 and v2). Returns how many were cancelled. */
export function cancelAllPlanJobs(): number {
  const keys = [...activeJobs.keys()];
  let n = 0;
  for (const key of keys) {
    const slash = key.indexOf('/');
    if (slash === -1) continue;
    const pieceName = key.slice(0, slash);
    const actionKey = key.slice(slash + 1);
    if (cancelPlanJob(pieceName, actionKey)) n++;
  }
  return n;
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

export function createBatchQueue(items: BatchQueueItem[]): BatchQueue {
  const id = `batch_${++batchCounter}_${Date.now()}`;
  const queue: BatchQueue = {
    id, status: 'running', items, currentIndex: -1, startedAt: Date.now(),
    emitter: new EventEmitter(), events: [], cancelled: false,
  };
  queue.emitter.setMaxListeners(50);
  batches.set(id, queue);
  return queue;
}

export function getBatch(id: string): BatchQueue | null { return batches.get(id) ?? null; }
export function listBatches(): BatchQueue[] { return [...batches.values()].sort((a, b) => b.startedAt - a.startedAt); }

export function getBatchStatus(id: string) {
  const q = batches.get(id);
  if (!q) return null;
  const stats = { pending: 0, running: 0, done: 0, error: 0, skipped: 0 };
  for (const it of q.items) stats[it.status]++;
  return {
    id: q.id, status: q.status, startedAt: q.startedAt, completedAt: q.completedAt,
    currentIndex: q.currentIndex, totalItems: q.items.length,
    items: q.items.map(i => ({ pieceName: i.pieceName, pieceDisplayName: i.pieceDisplayName, actionName: i.actionName, actionDisplayName: i.actionDisplayName, targetType: i.targetType, status: i.status })),
    stats,
  };
}

/** Pieces held by batches still running — used to keep a piece out of a second concurrent batch. */
export function activeBatchPieceNames(): Set<string> {
  const names = new Set<string>();
  for (const q of batches.values()) {
    if (q.status === 'running') for (const it of q.items) names.add(it.pieceName);
  }
  return names;
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
  setTimeout(() => { batches.delete(queue.id); }, 5 * CLEANUP_DELAY_MS);
}

export function cancelBatch(id: string): boolean {
  const q = batches.get(id);
  if (!q || q.status !== 'running') return false;
  q.cancelled = true;
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
