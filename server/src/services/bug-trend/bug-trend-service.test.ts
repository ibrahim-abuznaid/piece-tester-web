import { describe, it, expect, vi } from 'vitest';
import { resolveBugTrendRequest, emptyQueryWarnings } from './bug-trend-service.js';
import type { BugCache, CachedBugs } from './bug-trend-cache.js';

const NOW = new Date('2026-09-24T12:00:00Z');
const ROSTER = '[{"id":"u-kishan","name":"Kishan Parmar"}]';
const CACHED: CachedBugs = {
  bugs: [{
    identifier: 'GIT-1', title: 'Broken', url: 'https://linear.app/x/issue/GIT-1', team: 'GIT', source: 'support',
    assigneeName: 'Kishan Parmar', createdAt: '2026-09-22T10:00:00.000Z', completedAt: null,
  }],
  matched: { GIT: 1, PIE: 1 },
  fetchedAt: '2026-09-24T11:50:00.000Z',
  warnings: [],
};

function stubCache(impl: () => Promise<CachedBugs> = async () => CACHED) {
  const get = vi.fn(impl);
  return { cache: { get, invalidate: vi.fn() } as unknown as BugCache, get };
}
const req = (p: Partial<Parameters<typeof resolveBugTrendRequest>[1]> = {}) =>
  ({ apiKey: 'lin_api_x', rosterJson: ROSTER, refresh: false, now: NOW, ...p });

describe('resolveBugTrendRequest', () => {
  it('asks for a key when none is saved, without calling Linear', async () => {
    const { cache, get } = stubCache();
    expect(await resolveBugTrendRequest(cache, req({ apiKey: '' })))
      .toEqual({ status: 200, body: { state: 'needs-setup', missing: 'key' } });
    expect(get).not.toHaveBeenCalled();
  });

  it('asks for the roster when it is empty or unreadable', async () => {
    const { cache } = stubCache();
    for (const rosterJson of ['[]', 'not json']) {
      expect(await resolveBugTrendRequest(cache, req({ rosterJson })))
        .toEqual({ status: 200, body: { state: 'needs-setup', missing: 'roster' } });
    }
  });

  it('rejects a malformed or impossible `from`', async () => {
    const { cache } = stubCache();
    for (const from of ['June', '2026-6-1', '2026-02-30']) {
      expect((await resolveBugTrendRequest(cache, req({ from }))).status).toBe(400);
    }
  });

  it('rejects a `from` in the future but accepts today', async () => {
    const { cache } = stubCache();
    expect((await resolveBugTrendRequest(cache, req({ from: '2026-09-25' }))).status).toBe(400);
    expect((await resolveBugTrendRequest(cache, req({ from: '2026-09-24' }))).status).toBe(200);
  });

  it('builds the trend as of the fetch time, defaulting `from` to 2026-06-01', async () => {
    const { cache, get } = stubCache();
    const r = await resolveBugTrendRequest(cache, req({ refresh: true }));
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.state).toBe('ok');
    expect(body.fetchedAt).toBe('2026-09-24T11:50:00.000Z');
    expect(body.trend.from).toBe('2026-06-01');
    expect(body.trend.asOf).toBe('2026-09-24T11:50:00.000Z');
    expect(body.trend.markerDate).toBe('2026-08-01');
    expect(body.trend.kpis.openNow).toBe(1);
    expect(get).toHaveBeenCalledWith({ apiKey: 'lin_api_x', rosterIds: ['u-kishan'], refresh: true });
  });

  it('clamps `from` to the fetch day when cached data predates UTC midnight', async () => {
    const { cache } = stubCache(async () => ({ ...CACHED, fetchedAt: '2026-09-23T23:55:00.000Z' }));
    const r = await resolveBugTrendRequest(cache, req({ from: '2026-09-24', now: new Date('2026-09-24T00:05:00Z') }));
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.trend.from).toBe('2026-09-23');
    expect(body.trend.days.length).toBeGreaterThan(0);
  });

  it('merges cache warnings with empty-query warnings', async () => {
    const { cache } = stubCache(async () => ({ ...CACHED, matched: { GIT: 0, PIE: 1 }, warnings: ['stale'] }));
    const body = (await resolveBugTrendRequest(cache, req())).body as any;
    expect(body.warnings).toEqual(['stale', ...emptyQueryWarnings({ GIT: 0, PIE: 1 })]);
  });

  it('returns 502 with the Linear message when the fetch fails', async () => {
    const { cache } = stubCache(async () => { throw new Error('Linear rejected the API key'); });
    expect(await resolveBugTrendRequest(cache, req()))
      .toEqual({ status: 502, body: { error: 'Linear rejected the API key' } });
  });
});

describe('emptyQueryWarnings', () => {
  it('warns per team only when that query matched nothing', () => {
    expect(emptyQueryWarnings({ GIT: 2, PIE: 1 })).toEqual([]);
    expect(emptyQueryWarnings({ GIT: 0, PIE: 0 })).toEqual([
      'No GIT issues matched label "🐛 bug" for the roster. Check the label name and the roster.',
      'No PIE issues matched label "piece-tester". Check the label name.',
    ]);
  });
});
