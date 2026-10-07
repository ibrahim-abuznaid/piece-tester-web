import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beginPlanGeneration, completePlanGeneration, countOpenFindings, deletePlan, getPlan, getPlanByPiece, getSnapshot,
  insertFinding, listSources, queuePlanGeneration, saveSnapshot,
} from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, sampleDraft, samplePlanResult } from '../../db/vendor-watch-test-utils.js';
import { __resetGitHubRateLimitForTests, __setHttpForTests, githubApiGet } from '../github-api.js';
import {
  generateWatchPlan, generateWatchPlanInBackground, generateWatchPlansInBackground, type GenerateDeps,
} from './generate.js';
import { getGenerationQueueState, resetGenerationQueueForTests } from './generation-queue.js';
import type { WatchPlanValidation } from '../../agents/v2/tools/set-watch-plan.js';

const RATE_LIMIT_LINE =
  'GitHub rate limit was hit while reading the piece source; action files may be missing. Add a GitHub token in Settings and regenerate.';

const meta = (name: string) => ({
  name, displayName: 'Acme', description: '', logoUrl: '', version: '0.6.0', actions: {}, triggers: {},
  pieceType: 'OFFICIAL', packageType: 'REGISTRY',
}) as any;

const good: WatchPlanValidation = {
  errors: [],
  warnings: ['endpoint_inventory: dropped "ghost"'],
  plan: {
    vendor_name: 'Acme', api_base_urls: ['https://api.acme.dev/v1'], api_version: 'v1', auth_type: 'API key',
    endpoint_inventory: [{ target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' }],
    sources: [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS' }],
    note: 'Found an RSS changelog.',
  },
};

function deps(over: Partial<GenerateDeps> = {}) {
  const baselines: number[] = [];
  const d: Partial<GenerateDeps> = {
    getPieceMetadata: async (name) => meta(name),
    runWorker: async () => good,
    startBaseline: (id) => { baselines.push(id); },
    ...over,
  };
  return { d, baselines };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** Make one GitHub API call that comes back rate-limited, so github-api records a hit now. */
async function hitGitHubRateLimit(): Promise<void> {
  __setHttpForTests(async () => {
    throw Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } },
    });
  });
  await githubApiGet('https://api.github.com/repos/activepieces/activepieces/contents/x').catch(() => {});
}

describe('generateWatchPlan', () => {
  beforeEach(resetVendorWatch);

  it('saves the plan, puts the liveness source first, and starts the baseline', async () => {
    const { d, baselines } = deps();
    const plan = await generateWatchPlan('@activepieces/piece-acme', d);
    expect(plan).toMatchObject({ status: 'active', piece_version: '0.6.0', piece_display_name: 'Acme', vendor_name: 'Acme' });
    expect(plan.generation_note).toBe('Found an RSS changelog.\nendpoint_inventory: dropped "ghost"');
    expect(listSources(plan.id).map(s => [s.kind, s.url])).toEqual([['liveness', 'https://api.acme.dev/v1'], ['feed', 'https://acme.dev/rss']]);
    expect(baselines).toEqual([plan.id]);
  });

  it('fails a first generation that saves nothing, and keeps a regenerated plan running as stale', async () => {
    const first = await generateWatchPlan('@activepieces/piece-new', deps({ runWorker: async () => null }).d);
    expect(first.status).toBe('failed');
    expect(first.generation_note).toMatch(/without saving/);

    const p = beginPlanGeneration('@activepieces/piece-old');
    completePlanGeneration(p.id, samplePlanResult());
    const again = await generateWatchPlan('@activepieces/piece-old', deps({ getPieceMetadata: async () => { throw new Error('catalog down'); } }).d);
    expect(again).toMatchObject({ status: 'stale', generation_note: 'catalog down' });
  });

  it('regenerates in place: keeps the plan id, findings and an unchanged source snapshot, and drops removed sources', async () => {
    const first = await generateWatchPlan('@activepieces/piece-acme', deps().d);
    const [oldLiveness, feed] = listSources(first.id);
    saveSnapshot(oldLiveness.id, 'h0', '[]');
    saveSnapshot(feed.id, 'h1', '[]');
    insertFinding({ plan_id: first.id, piece_name: first.piece_name, source_id: feed.id, run_id: null, draft: sampleDraft() });

    const moved: WatchPlanValidation = { ...good, plan: { ...good.plan, api_base_urls: ['https://api.acme.dev/v2'] } };
    const again = await generateWatchPlan('@activepieces/piece-acme', deps({ runWorker: async () => moved }).d);

    expect(again).toMatchObject({ id: first.id, status: 'active' });
    const sources = listSources(again.id);
    expect(sources.map(s => [s.kind, s.url])).toEqual(expect.arrayContaining([['liveness', 'https://api.acme.dev/v2'], ['feed', 'https://acme.dev/rss']]));
    expect(sources).toHaveLength(2);
    expect(sources.find(s => s.kind === 'feed')!.id).toBe(feed.id);
    expect(getSnapshot(feed.id)?.content_hash).toBe('h1');
    expect(getSnapshot(oldLiveness.id)).toBeUndefined();
    expect(countOpenFindings(first.piece_name)).toBe(1);
  });
});

describe('generateWatchPlan and the GitHub rate limit', () => {
  beforeEach(() => {
    resetVendorWatch();
    __resetGitHubRateLimitForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    __setHttpForTests(null);
    __resetGitHubRateLimitForTests();
    vi.restoreAllMocks();
  });

  it('appends the rate-limit line when GitHub limited this generation', async () => {
    const { d } = deps({ runWorker: async () => { await hitGitHubRateLimit(); return good; } });
    const plan = await generateWatchPlan('@activepieces/piece-acme', d);
    expect(plan.status).toBe('active');
    expect(plan.generation_note).toBe(['Found an RSS changelog.', 'endpoint_inventory: dropped "ghost"', RATE_LIMIT_LINE].join('\n'));
  });

  it('leaves the note alone when the only hit came before this generation started', async () => {
    await hitGitHubRateLimit();
    await new Promise(r => setTimeout(r, 5));
    const plan = await generateWatchPlan('@activepieces/piece-acme', deps().d);
    expect(plan.generation_note).toBe('Found an RSS changelog.\nendpoint_inventory: dropped "ghost"');
  });
});

describe('generateWatchPlansInBackground', () => {
  beforeEach(() => {
    resetVendorWatch();
    resetGenerationQueueForTests();
    __resetGitHubRateLimitForTests();
  });

  afterEach(resetGenerationQueueForTests);

  it('queues the batch, then each plan goes generating → active, one at a time', async () => {
    const gates = { '@activepieces/piece-a': deferred(), '@activepieces/piece-b': deferred() };
    const started: string[] = [];
    const { d, baselines } = deps({
      runWorker: async ({ pieceMeta }) => {
        started.push(pieceMeta.name);
        await gates[pieceMeta.name as keyof typeof gates].promise;
        return good;
      },
    });
    const ids = generateWatchPlansInBackground(['@activepieces/piece-a', '@activepieces/piece-b'], d);
    expect(ids.map(id => getPlan(id)!.status)).toEqual(['queued', 'queued']);

    await waitFor(() => started.length === 1);
    expect(ids.map(id => getPlan(id)!.status)).toEqual(['generating', 'queued']);
    expect(getGenerationQueueState()).toEqual({ pending: 1, running: 1, github_wait_until: null });

    gates['@activepieces/piece-a'].resolve();
    await waitFor(() => started.length === 2);
    expect(ids.map(id => getPlan(id)!.status)).toEqual(['active', 'generating']);

    gates['@activepieces/piece-b'].resolve();
    await waitFor(() => getPlan(ids[1])!.status === 'active');
    expect(baselines).toEqual(ids);
    await waitFor(() => getGenerationQueueState().running === 0);
    expect(getGenerationQueueState()).toEqual({ pending: 0, running: 0, github_wait_until: null });
  });

  it('enqueues each piece once: dedupes names and skips plans already queued or generating', async () => {
    const queued = queuePlanGeneration('@activepieces/piece-queued');
    const busy = beginPlanGeneration('@activepieces/piece-busy');
    const gate = deferred();
    let calls = 0;
    const { d } = deps({ runWorker: async () => { calls++; await gate.promise; return good; } });
    const ids = generateWatchPlansInBackground(
      ['@activepieces/piece-a', ' @activepieces/piece-a ', '@activepieces/piece-queued', '@activepieces/piece-busy', '  '], d,
    );
    const a = getPlanByPiece('@activepieces/piece-a')!;
    expect(ids).toEqual([a.id, queued.id, busy.id]);
    expect(generateWatchPlansInBackground(['@activepieces/piece-a'], d)).toEqual([a.id]);
    expect(generateWatchPlanInBackground('@activepieces/piece-queued', d)).toBe(queued.id);
    const state = getGenerationQueueState();
    expect(state.pending + state.running).toBe(1);

    gate.resolve();
    await waitFor(() => getPlan(a.id)!.status === 'active');
    expect(calls).toBe(1);
    expect(getPlan(queued.id)!.status).toBe('queued');
    expect(getPlan(busy.id)!.status).toBe('generating');
  });

  it('runs a single Generate click ahead of the rest of a batch', async () => {
    const gate = deferred();
    const started: string[] = [];
    const { d } = deps({
      runWorker: async ({ pieceMeta }) => {
        started.push(pieceMeta.name);
        if (started.length === 1) await gate.promise;
        return good;
      },
    });
    generateWatchPlansInBackground(['@activepieces/piece-a', '@activepieces/piece-b'], d);
    await waitFor(() => started.length === 1);
    const single = generateWatchPlanInBackground('@activepieces/piece-single', d);
    expect(getPlan(single)!.status).toBe('queued');

    gate.resolve();
    await waitFor(() => started.length === 3);
    expect(started).toEqual(['@activepieces/piece-a', '@activepieces/piece-single', '@activepieces/piece-b']);
  });

  it('skips the job of a queued plan that was deleted before its turn', async () => {
    const gate = deferred();
    const started: string[] = [];
    const { d } = deps({
      getPieceMetadata: async (name) => { started.push(name); return meta(name); },
      runWorker: async ({ pieceMeta }) => {
        if (pieceMeta.name === '@activepieces/piece-a') await gate.promise;
        return good;
      },
    });
    const [, b, c] = generateWatchPlansInBackground(['@activepieces/piece-a', '@activepieces/piece-b', '@activepieces/piece-c'], d);
    await waitFor(() => started.length === 1);
    expect(deletePlan(b)).toBe(true);

    gate.resolve();
    await waitFor(() => getPlan(c)?.status === 'active');
    expect(started).toEqual(['@activepieces/piece-a', '@activepieces/piece-c']);
    expect(getPlanByPiece('@activepieces/piece-b')).toBeUndefined();
  });
});
