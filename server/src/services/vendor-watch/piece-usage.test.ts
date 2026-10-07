import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../db/schema.js';
import { beginPlanGeneration, getPieceImportance, upsertPieceUsage } from '../../db/vendor-watch-queries.js';
import { resetVendorWatch } from '../../db/vendor-watch-test-utils.js';
import {
  _resetUsageRefresh, ensureWatchedUsage, fetchCloudUsage, getUsageRefreshState, refreshPieceUsage,
  UsageRefreshRunningError, type FetchJson,
} from './piece-usage.js';

const P = (s: string) => `@activepieces/piece-${s}`;
const API = 'https://cloud.activepieces.com/api/v1';

/** A fake Cloud: registry rows and per-version usage; `fail` holds name@version keys that throw. */
function fakeCloud(usage: Record<string, Record<string, number>>, fail = new Set<string>(), opts: { flagsFail?: boolean } = {}) {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    if (url === `${API}/flags`) {
      if (opts.flagsFail) throw new Error('HTTP 503');
      return { CURRENT_VERSION: '0.92.0' };
    }
    if (url === `${API}/pieces/registry?release=0.92.0&edition=cloud`) {
      return Object.entries(usage).flatMap(([name, versions]) => Object.keys(versions).map(version => ({ name, version })));
    }
    const m = url.match(/\/pieces\/([^?]+)\?version=(.+)$/);
    if (!m) throw new Error(`unexpected ${url}`);
    const name = decodeURIComponent(m[1]);
    const version = decodeURIComponent(m[2]);
    if (fail.has(`${name}@${version}`)) throw new Error('HTTP 502');
    return { name, version, projectUsage: usage[name][version] };
  };
  return { fetchJson, calls };
}

const CLOUD = {
  [P('slack')]: { '0.9.0': 19, '0.10.0': 1, '0.20.0': 2 },
  [P('stripe')]: { '0.8.0': 3, '0.7.0': 488 },
  [P('zagomail')]: { '0.1.0': 1 },
};

describe('fetchCloudUsage', () => {
  it('sums projectUsage over every Cloud version of each asked piece', async () => {
    const cloud = fakeCloud(CLOUD);
    const rows = await fetchCloudUsage([P('slack'), P('stripe')], { fetchJson: cloud.fetchJson });
    expect(rows).toEqual([
      { piece_name: P('slack'), projects: 22, versions: 3, versions_failed: 0 },
      { piece_name: P('stripe'), projects: 491, versions: 2, versions_failed: 0 },
    ]);
    expect(cloud.calls.filter(u => u.includes('zagomail'))).toEqual([]);
    expect(cloud.calls).toContain(`${API}/pieces/${encodeURIComponent(P('slack'))}?version=0.9.0`);
  });

  it('covers every registry piece for "all"', async () => {
    const rows = await fetchCloudUsage('all', { fetchJson: fakeCloud(CLOUD).fetchJson });
    expect(rows.map(r => r.piece_name).sort()).toEqual([P('slack'), P('stripe'), P('zagomail')]);
  });

  it('stores a piece that is not on Cloud as 0 projects over 0 versions', async () => {
    const rows = await fetchCloudUsage([P('custom-thing')], { fetchJson: fakeCloud(CLOUD).fetchJson });
    expect(rows).toEqual([{ piece_name: P('custom-thing'), projects: 0, versions: 0, versions_failed: 0 }]);
  });

  it('counts failed versions and leaves them out of the sum', async () => {
    const cloud = fakeCloud(CLOUD, new Set([`${P('slack')}@0.9.0`]));
    const [row] = await fetchCloudUsage([P('slack')], { fetchJson: cloud.fetchJson, retryDelayMs: 0 });
    expect(row).toEqual({ piece_name: P('slack'), projects: 3, versions: 3, versions_failed: 1 });
  });

  it('retries a failed version once before counting it as failed', async () => {
    let first = true;
    const cloud = fakeCloud(CLOUD);
    const flaky: FetchJson = async (url) => {
      if (url.includes('version=0.8.0') && first) { first = false; throw new Error('HTTP 502'); }
      return cloud.fetchJson(url);
    };
    const [row] = await fetchCloudUsage([P('stripe')], { fetchJson: flaky, retryDelayMs: 0 });
    expect(row).toMatchObject({ projects: 491, versions_failed: 0 });
  });

  it('treats a missing or non-numeric projectUsage as a failed version', async () => {
    const cloud = fakeCloud(CLOUD);
    const odd: FetchJson = async (url) => (url.includes('version=0.8.0') ? { name: P('stripe') } : cloud.fetchJson(url));
    const [row] = await fetchCloudUsage([P('stripe')], { fetchJson: odd, retryDelayMs: 0 });
    expect(row).toMatchObject({ projects: 488, versions: 2, versions_failed: 1 });
  });

  it('reports progress in versions', async () => {
    const progress: Array<[number, number]> = [];
    await fetchCloudUsage([P('slack'), P('stripe')], { fetchJson: fakeCloud(CLOUD).fetchJson, onProgress: (d, t) => progress.push([d, t]) });
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it('throws when the release or the registry cannot be read', async () => {
    await expect(fetchCloudUsage([P('slack')], { fetchJson: fakeCloud(CLOUD, new Set(), { flagsFail: true }).fetchJson }))
      .rejects.toThrow(/503/);
    await expect(fetchCloudUsage([P('slack')], { fetchJson: async (u) => (u.endsWith('/flags') ? { CURRENT_VERSION: '0.92.0' } : { oops: 1 }) }))
      .rejects.toThrow(/registry/i);
    await expect(fetchCloudUsage([P('slack')], { fetchJson: async () => ({}) })).rejects.toThrow(/CURRENT_VERSION/);
  });
});

describe('refreshPieceUsage', () => {
  beforeEach(() => { resetVendorWatch(); _resetUsageRefresh(); });

  it('rates the watched pieces and records the run', async () => {
    beginPlanGeneration(P('slack'));
    beginPlanGeneration(P('stripe'));
    const res = await refreshPieceUsage('watched', { fetchJson: fakeCloud(CLOUD).fetchJson });
    expect(res).toMatchObject({ pieces: 2, updated: 2, versions_failed: 0 });
    expect(getPieceImportance(P('stripe'))).toMatchObject({ importance: 'high', usage_projects: 491 });
    expect(getPieceImportance(P('slack'))).toMatchObject({ importance: 'low', usage_projects: 22 });
    expect(getPieceImportance(P('zagomail')).importance).toBeNull();
    expect(getUsageRefreshState()).toMatchObject({ running: false, scope: 'watched', done: 5, total: 5, error: '' });
  });

  it('rates every Cloud piece for the catalog scope', async () => {
    const res = await refreshPieceUsage('catalog', { fetchJson: fakeCloud(CLOUD).fetchJson });
    expect(res.updated).toBe(3);
  });

  it('keeps the old row of a piece whose versions all failed', async () => {
    upsertPieceUsage([{ piece_name: P('zagomail'), projects: 7, versions: 1, versions_failed: 0 }], '2026-01-01 00:00:00');
    const res = await refreshPieceUsage({ pieces: [P('zagomail'), P('stripe')] }, {
      fetchJson: fakeCloud(CLOUD, new Set([`${P('zagomail')}@0.1.0`])).fetchJson, retryDelayMs: 0,
    });
    expect(res).toMatchObject({ pieces: 2, updated: 1, versions_failed: 1 });
    expect(getPieceImportance(P('zagomail'))).toMatchObject({ usage_projects: 7, usage_fetched_at: '2026-01-01 00:00:00' });
  });

  it('changes nothing and records the error when the registry fails', async () => {
    upsertPieceUsage([{ piece_name: P('slack'), projects: 9, versions: 1, versions_failed: 0 }]);
    await expect(refreshPieceUsage({ pieces: [P('slack')] }, { fetchJson: fakeCloud(CLOUD, new Set(), { flagsFail: true }).fetchJson }))
      .rejects.toThrow(/503/);
    expect(getPieceImportance(P('slack')).usage_projects).toBe(9);
    expect(getUsageRefreshState()).toMatchObject({ running: false, error: expect.stringContaining('503') });
  });

  it('runs one refresh at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const cloud = fakeCloud(CLOUD);
    const slow: FetchJson = async (url) => { await gate; return cloud.fetchJson(url); };
    const first = refreshPieceUsage('catalog', { fetchJson: slow });
    expect(getUsageRefreshState().running).toBe(true);
    await expect(refreshPieceUsage('watched', { fetchJson: slow })).rejects.toBeInstanceOf(UsageRefreshRunningError);
    release();
    await first;
    expect(getUsageRefreshState().running).toBe(false);
  });
});

describe('ensureWatchedUsage', () => {
  beforeEach(() => { resetVendorWatch(); _resetUsageRefresh(); });

  it('refreshes only watched pieces that have no row, an old row, or a partial row', async () => {
    for (const n of ['slack', 'stripe', 'zagomail']) beginPlanGeneration(P(n));
    upsertPieceUsage([{ piece_name: P('stripe'), projects: 491, versions: 2, versions_failed: 0 }]);
    upsertPieceUsage([{ piece_name: P('zagomail'), projects: 0, versions: 1, versions_failed: 1 }]);
    const cloud = fakeCloud(CLOUD);
    const started = ensureWatchedUsage({ fetchJson: cloud.fetchJson });
    expect(started).toBe(true);
    await vi.waitFor(() => expect(getUsageRefreshState().running).toBe(false));
    const asked = cloud.calls.filter(u => u.includes('?version=')).map(u => decodeURIComponent(u.split('/pieces/')[1].split('?')[0]));
    expect([...new Set(asked)].sort()).toEqual([P('slack'), P('zagomail')]);
  });

  it('does nothing when every watched piece is fresh', () => {
    beginPlanGeneration(P('stripe'));
    upsertPieceUsage([{ piece_name: P('stripe'), projects: 491, versions: 2, versions_failed: 0 }]);
    expect(ensureWatchedUsage({ fetchJson: fakeCloud(CLOUD).fetchJson })).toBe(false);
  });

  it('waits an hour before retrying pieces whose refresh failed', async () => {
    beginPlanGeneration(P('slack'));
    const failing = fakeCloud(CLOUD, new Set(), { flagsFail: true });
    let now = Date.parse('2026-10-07T10:00:00Z');
    const deps = { fetchJson: failing.fetchJson, now: () => now };
    expect(ensureWatchedUsage(deps)).toBe(true);
    await vi.waitFor(() => expect(getUsageRefreshState().running).toBe(false));
    now += 30 * 60_000;
    expect(ensureWatchedUsage(deps)).toBe(false);
    now += 31 * 60_000;
    expect(ensureWatchedUsage(deps)).toBe(true);
    await vi.waitFor(() => expect(getUsageRefreshState().running).toBe(false));
  });

  it('does not start while another refresh runs', async () => {
    beginPlanGeneration(P('slack'));
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const cloud = fakeCloud(CLOUD);
    const running = refreshPieceUsage('catalog', { fetchJson: async (u) => { await gate; return cloud.fetchJson(u); } });
    expect(ensureWatchedUsage({ fetchJson: cloud.fetchJson })).toBe(false);
    release();
    await running;
    expect(getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM piece_usage')!.n).toBe(3);
  });
});
