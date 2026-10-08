import { getGitHubRateLimitedUntil } from '../github-api.js';

/**
 * Watch-plan generation runs on its own in-memory FIFO, apart from the shared batch scheduler, so a big batch
 * never takes AI slots from test runs and reads GitHub at a steady pace. Nothing is persisted: on a restart
 * the queue is gone and reconcileVendorWatch() closes the plans still marked queued: a first generation as
 * failed, a regeneration as stale.
 */
export const VW_GENERATION_CONCURRENCY = 1;
const GITHUB_RESET_MARGIN_MS = 5_000;
const GITHUB_RECHECK_MS = 60_000;

interface Job { pieceName: string; run: () => Promise<void>; }

export interface GenerationQueueState {
  pending: number;
  running: number;
  github_wait_until: string | null;
}

let pending: Job[] = [];
let running = 0;
let waitTimer: ReturnType<typeof setTimeout> | null = null;
/** The GitHub reset the queue is waiting out; kept so the 5 s margin still applies once the limit itself reads as over. */
let waitingForReset = 0;
/** Bumped by the test reset so jobs from before it can't touch the new state when they settle. */
let epoch = 0;

/** Add one generation. `front` puts it ahead of everything pending (a single Generate click jumps a batch). */
export function enqueueGeneration(pieceName: string, run: () => Promise<void>, opts: { front?: boolean } = {}): void {
  const job = { pieceName, run };
  if (opts.front) pending.unshift(job); else pending.push(job);
  pump();
}

export function getGenerationQueueState(): GenerationQueueState {
  const until = waitTimer ? getGitHubRateLimitedUntil() : 0;
  return { pending: pending.length, running, github_wait_until: until ? new Date(until).toISOString() : null };
}

/** Test helper: drop pending jobs and any wait, and forget running ones. */
export function resetGenerationQueueForTests(): void {
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = null;
  pending = [];
  running = 0;
  waitingForReset = 0;
  epoch++;
}

/**
 * How long to hold the next job for GitHub: until the reset plus a margin, re-checked at least every minute
 * so a token saved mid-wait (which clears the limit early) frees the queue. 0 = start now.
 */
function githubDelayMs(): number {
  const until = getGitHubRateLimitedUntil();
  const now = Date.now();
  if (until) waitingForReset = until;
  else if (waitingForReset > now) waitingForReset = 0;
  if (!waitingForReset) return 0;
  const left = waitingForReset + GITHUB_RESET_MARGIN_MS - now;
  if (left <= 0) {
    waitingForReset = 0;
    return 0;
  }
  return Math.min(left, GITHUB_RECHECK_MS);
}

function pump(): void {
  if (waitTimer) return;
  while (running < VW_GENERATION_CONCURRENCY && pending.length > 0) {
    const delay = githubDelayMs();
    if (delay > 0) {
      waitTimer = setTimeout(() => { waitTimer = null; pump(); }, delay);
      return;
    }
    start(pending.shift()!);
  }
}

function start(job: Job): void {
  const startedIn = epoch;
  running++;
  Promise.resolve()
    .then(() => job.run())
    .catch(err => console.error(`[vendor-watch] generating ${job.pieceName} failed: ${err?.message || err}`))
    .finally(() => {
      if (startedIn !== epoch) return;
      running--;
      pump();
    });
}
