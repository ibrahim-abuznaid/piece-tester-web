import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginPlanGeneration, completePlanGeneration, countOpenFindings, getPlan, getSnapshot, insertFinding, listSources, saveSnapshot,
} from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, sampleDraft, samplePlanResult } from '../../db/vendor-watch-test-utils.js';
import { generateWatchPlan, generateWatchPlansInBackground, type GenerateDeps } from './generate.js';
import type { WatchPlanValidation } from '../../agents/v2/tools/set-watch-plan.js';

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

describe('generateWatchPlansInBackground', () => {
  beforeEach(resetVendorWatch);

  it('dedupes names, skips plans already generating, and finishes in the background', async () => {
    const busy = beginPlanGeneration('@activepieces/piece-busy');
    let calls = 0;
    const { d } = deps({ runWorker: async () => { calls++; return good; } });
    const ids = generateWatchPlansInBackground(['@activepieces/piece-a', '@activepieces/piece-a', '@activepieces/piece-busy'], d);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(busy.id);
    expect(getPlan(ids[0])!.status).toBe('generating');
    for (let i = 0; i < 100 && getPlan(ids[0])!.status === 'generating'; i++) await new Promise(r => setTimeout(r, 10));
    expect(getPlan(ids[0])!.status).toBe('active');
    expect(calls).toBe(1);
    expect(getPlan(busy.id)!.status).toBe('generating');
  });
});
