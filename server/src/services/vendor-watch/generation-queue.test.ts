import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VW_GENERATION_CONCURRENCY, enqueueGeneration, getGenerationQueueState, resetGenerationQueueForTests,
} from './generation-queue.js';

const gh = vi.hoisted(() => ({ until: 0 }));
vi.mock('../github-api.js', () => ({
  getGitHubRateLimitedUntil: () => (gh.until > Date.now() ? gh.until : 0),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('generation queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    gh.until = 0;
    resetGenerationQueueForTests();
  });

  afterEach(() => {
    resetGenerationQueueForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs one job at a time: the next starts only after the current one settles', async () => {
    expect(VW_GENERATION_CONCURRENCY).toBe(1);
    const a = deferred();
    const b = deferred();
    const started: string[] = [];
    enqueueGeneration('a', () => { started.push('a'); return a.promise; });
    enqueueGeneration('b', () => { started.push('b'); return b.promise; });
    await flush();
    expect(started).toEqual(['a']);
    expect(getGenerationQueueState()).toEqual({ pending: 1, running: 1, github_wait_until: null });

    a.resolve();
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(getGenerationQueueState()).toEqual({ pending: 0, running: 1, github_wait_until: null });

    b.resolve();
    await flush();
    expect(getGenerationQueueState()).toEqual({ pending: 0, running: 0, github_wait_until: null });
  });

  it('puts a front job ahead of everything still pending', async () => {
    const gate = deferred();
    const started: string[] = [];
    const job = (name: string) => async () => { started.push(name); if (name === 'a') await gate.promise; };
    enqueueGeneration('a', job('a'));
    enqueueGeneration('b', job('b'));
    enqueueGeneration('c', job('c'));
    enqueueGeneration('single', job('single'), { front: true });
    await flush();
    expect(started).toEqual(['a']);
    gate.resolve();
    await flush();
    expect(started).toEqual(['a', 'single', 'b', 'c']);
  });

  it('logs a job that throws or rejects and moves on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started: string[] = [];
    enqueueGeneration('sync-throw', () => { started.push('sync-throw'); throw new Error('boom'); });
    enqueueGeneration('rejects', async () => { started.push('rejects'); throw new Error('bad'); });
    enqueueGeneration('ok', async () => { started.push('ok'); });
    await flush();
    expect(started).toEqual(['sync-throw', 'rejects', 'ok']);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain('sync-throw');
    expect(String(error.mock.calls[0][0])).toContain('boom');
    expect(getGenerationQueueState()).toEqual({ pending: 0, running: 0, github_wait_until: null });
  });

  it('waits for the GitHub reset plus 5 s before starting, on a single timer', async () => {
    gh.until = Date.now() + 10 * 60_000;
    const started: string[] = [];
    enqueueGeneration('a', async () => { started.push('a'); });
    enqueueGeneration('b', async () => { started.push('b'); });
    await flush();
    expect(started).toEqual([]);
    expect(getGenerationQueueState()).toEqual({ pending: 2, running: 0, github_wait_until: new Date(gh.until).toISOString() });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 4_999);
    expect(started).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(['a', 'b']);
    expect(getGenerationQueueState()).toEqual({ pending: 0, running: 0, github_wait_until: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the next job when the limit is hit during the current one', async () => {
    const started: string[] = [];
    enqueueGeneration('a', async () => { started.push('a'); gh.until = Date.now() + 30_000; });
    enqueueGeneration('b', async () => { started.push('b'); });
    await flush();
    expect(started).toEqual(['a']);
    expect(getGenerationQueueState()).toMatchObject({ pending: 1, running: 0 });

    await vi.advanceTimersByTimeAsync(34_999);
    expect(started).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(['a', 'b']);
  });

  it('re-checks at least every minute, so a cleared limit (token saved) unblocks the wait', async () => {
    gh.until = Date.now() + 45 * 60_000;
    const started: string[] = [];
    enqueueGeneration('a', async () => { started.push('a'); });
    await vi.advanceTimersByTimeAsync(20_000);
    gh.until = 0;
    await vi.advanceTimersByTimeAsync(39_999);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(['a']);
  });

  it('a front job enqueued during a wait still goes first once the wait ends', async () => {
    gh.until = Date.now() + 1_000;
    const started: string[] = [];
    enqueueGeneration('a', async () => { started.push('a'); });
    enqueueGeneration('single', async () => { started.push('single'); }, { front: true });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(started).toEqual(['single', 'a']);
  });

  it('reset drops pending jobs and the wait timer', async () => {
    gh.until = Date.now() + 60_000;
    const run = vi.fn(async () => {});
    enqueueGeneration('a', run);
    resetGenerationQueueForTests();
    expect(vi.getTimerCount()).toBe(0);
    expect(getGenerationQueueState()).toEqual({ pending: 0, running: 0, github_wait_until: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();
  });
});
