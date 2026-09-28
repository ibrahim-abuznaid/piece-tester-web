import { describe, it, expect, vi } from 'vitest';
import { createBugCache, BUG_CACHE_TTL_MS } from './bug-trend-cache.js';
import type { TrackedBugsResult } from './linear-client.js';

const T0 = Date.parse('2026-09-24T17:31:00Z');
const RESULT: TrackedBugsResult = { bugs: [], matched: { GIT: 3, PIE: 1 } };
const INPUT = { apiKey: 'k', rosterIds: ['u2', 'u1'] };

function setup() {
  let t = T0;
  const fetch = vi.fn(async () => RESULT);
  const cache = createBugCache({ fetch, now: () => t });
  return { cache, fetch, advance: (ms: number) => { t += ms; } };
}

describe('createBugCache', () => {
  it('serves a second request inside the TTL from memory', async () => {
    const { cache, fetch, advance } = setup();
    const first = await cache.get(INPUT);
    advance(BUG_CACHE_TTL_MS - 1);
    const second = await cache.get(INPUT);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.fetchedAt).toBe('2026-09-24T17:31:00.000Z');
    expect(second.fetchedAt).toBe('2026-09-24T17:31:00.000Z');
    expect(second.warnings).toEqual([]);
  });

  it('refetches once the TTL has passed', async () => {
    const { cache, fetch, advance } = setup();
    await cache.get(INPUT);
    advance(BUG_CACHE_TTL_MS);
    await cache.get(INPUT);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache on refresh', async () => {
    const { cache, fetch } = setup();
    await cache.get(INPUT);
    await cache.get({ ...INPUT, refresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refetches after invalidate()', async () => {
    const { cache, fetch } = setup();
    await cache.get(INPUT);
    cache.invalidate();
    await cache.get(INPUT);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a different roster as a different entry, ignoring roster order', async () => {
    const { cache, fetch } = setup();
    await cache.get(INPUT);
    await cache.get({ apiKey: 'k', rosterIds: ['u1', 'u2'] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.get({ apiKey: 'k', rosterIds: ['u1'] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to the cached copy with a warning when a fetch fails', async () => {
    const { cache, fetch, advance } = setup();
    await cache.get(INPUT);
    advance(BUG_CACHE_TTL_MS);
    fetch.mockRejectedValueOnce(new Error('Linear rejected the API key'));
    const r = await cache.get(INPUT);
    expect(r.matched).toEqual({ GIT: 3, PIE: 1 });
    expect(r.fetchedAt).toBe('2026-09-24T17:31:00.000Z');
    expect(r.warnings).toEqual(["Couldn't reach Linear (Linear rejected the API key). Showing data from 17:31 UTC."]);
  });

  it('throws when a fetch fails and nothing is cached', async () => {
    const { cache, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error('boom'));
    await expect(cache.get(INPUT)).rejects.toThrow('boom');
  });
});
