import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../db/schema.js';
import {
  beginPlanGeneration, completePlanGeneration, replaceSources, getSnapshot, listFindings, listSources,
  updateWatchConfig, deletePlan, getRun, type SourceInput,
} from '../../db/vendor-watch-queries.js';
import { resetVendorWatch, samplePlanResult, sampleDraft } from '../../db/vendor-watch-test-utils.js';
import { startWatchRun, type RunnerDeps } from './runner.js';
import { classifyChange, type ClassifyInput, type ClassifyResult } from './classifier.js';
import { fileFinding } from './filing.js';
import type { LinearQueryFn } from './linear-filer.js';
import type { LivenessResult } from './liveness.js';

vi.mock('./classifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./classifier.js')>();
  return { ...actual, classifyChange: vi.fn(actual.classifyChange) };
});

const RSS = (ids: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${ids
  .map(id => `<item><guid>${id}</guid><title>Entry ${id}</title><description>Details about entry ${id}.</description></item>`)
  .join('')}</channel></rss>`;

function plan(sources: SourceInput[]) {
  const p = beginPlanGeneration('@activepieces/piece-acme');
  const done = completePlanGeneration(p.id, samplePlanResult());
  return { planId: done.id, rows: replaceSources(done.id, sources) };
}

function harness() {
  const h = {
    body: RSS(['a']),
    liveness: { alive: true, detail: 'HTTP 200' } as LivenessResult,
    classify: (async () => ({ findings: [], costUsd: 0.01 })) as (input: ClassifyInput) => Promise<ClassifyResult>,
    classifyCalls: [] as ClassifyInput[],
    fileCalls: [] as number[],
    deps: {} as Partial<RunnerDeps>,
  };
  h.deps = {
    fetch: async (url) => ({ status: 200, finalUrl: url, contentType: 'application/xml', body: h.body }),
    liveness: async () => h.liveness,
    classify: async (input) => { h.classifyCalls.push(input); return h.classify(input); },
    file: async (id) => { h.fileCalls.push(id); },
    today: () => new Date('2026-10-06T00:00:00Z'),
  };
  return h;
}

/** A fetch that records each URL and holds every response until `open()`. */
function gatedFetch(h: H) {
  let open!: () => void;
  const opened = new Promise<void>(r => { open = r; });
  const fetched: string[] = [];
  h.deps.fetch = async (url) => {
    fetched.push(url);
    await opened;
    return { status: 200, finalUrl: url, contentType: 'application/xml', body: h.body };
  };
  return { open, fetched };
}

type H = ReturnType<typeof harness>;
const run = (planId: number, h: H, trigger: 'manual' | 'baseline' = 'manual') => startWatchRun(planId, trigger, { deps: h.deps }).done;
const breaking = (input: ClassifyInput) =>
  sampleDraft({ kind: 'breaking', severity: 'high', is_baseline: input.mode === 'baseline', signature: `${input.mode}-${input.text.length}` });
const FEED: SourceInput = { kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' };
const HOST: SourceInput = { kind: 'liveness', url: 'https://api.acme.dev/v1', label: 'host' };
const SPEC: SourceInput = { kind: 'openapi', url: 'https://acme.dev/openapi.json', label: 'spec' };

describe('startWatchRun — feeds', () => {
  beforeEach(resetVendorWatch);

  it('baselines a new source: snapshot stored, newest entries classified, nothing auto-filed', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId, rows } = plan([FEED]);
    const h = harness();
    h.classify = async (input) => ({ findings: [breaking(input)], costUsd: 0.02 });
    const r = await run(planId, h, 'baseline');
    expect(r).toMatchObject({ status: 'completed', trigger_type: 'baseline', sources_checked: 1, sources_changed: 0, findings_created: 1 });
    expect(r.cost_usd).toBeCloseTo(0.02);
    expect(h.classifyCalls[0].mode).toBe('baseline');
    expect(getSnapshot(rows[0].id)).toBeDefined();
    expect(listFindings()[0].is_baseline).toBe(1);
    expect(h.fileCalls).toEqual([]);
  });

  it('does nothing when the source has not changed', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const r = await run(planId, h);
    expect(h.classifyCalls).toHaveLength(1);
    expect(r).toMatchObject({ sources_changed: 0, findings_created: 0 });
  });

  it('classifies only the new entries and auto-files a qualifying finding', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    h.body = RSS(['a', 'b']);
    h.classify = async (input) => ({ findings: [breaking(input)], costUsd: 0.02 });
    const r = await run(planId, h);
    const last = h.classifyCalls[h.classifyCalls.length - 1];
    expect(last.mode).toBe('change');
    expect(last.text).toContain('Entry b');
    expect(last.text).not.toContain('Entry a');
    expect(r).toMatchObject({ sources_changed: 1, findings_created: 1 });
    expect(h.fileCalls).toEqual([listFindings()[0].id]);
  });

  it('keeps a qualifying finding in the inbox when auto-file is off', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    h.body = RSS(['a', 'b']);
    h.classify = async (input) => ({ findings: [breaking(input)], costUsd: 0 });
    await run(planId, h);
    expect(h.fileCalls).toEqual([]);
    expect(listFindings()[0].status).toBe('new');
  });

  it('keeps the old snapshot when the classifier fails, so the change is retried next run', async () => {
    const { planId, rows } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const before = getSnapshot(rows[0].id)!.content_hash;
    h.body = RSS(['a', 'b']);
    h.classify = async () => { throw new Error('boom'); };
    const r = await run(planId, h);
    expect(r.status).toBe('completed');
    expect(r.error).toContain('boom');
    expect(getSnapshot(rows[0].id)!.content_hash).toBe(before);
    h.classify = async () => ({ findings: [], costUsd: 0 });
    await run(planId, h);
    expect(h.classifyCalls.filter(c => c.mode === 'change')).toHaveLength(2);
    expect(getSnapshot(rows[0].id)!.content_hash).not.toBe(before);
  });

  it('counts the cost of a classifier call that failed', async () => {
    const { planId, rows } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const before = getSnapshot(rows[0].id)!.content_hash;
    h.body = RSS(['a', 'b']);
    h.classify = async () => { throw Object.assign(new Error('Classifier output was truncated'), { costUsd: 0.02 }); };
    const r = await run(planId, h);
    expect(r.cost_usd).toBeGreaterThanOrEqual(0.02);
    expect(r.error).toContain('truncated');
    expect(getSnapshot(rows[0].id)!.content_hash).toBe(before);
  });

  it('keeps the cost of a failed call to the default classifier', async () => {
    vi.mocked(classifyChange).mockImplementationOnce(async (_input, d) => {
      d?.costTracker?.trackResponse('claude-sonnet-4-6', { usage: { input_tokens: 10_000, output_tokens: 0 } }, 'vendor_watch_classifier');
      throw new Error('Classifier returned malformed report_findings input');
    });
    const { planId, rows } = plan([FEED]);
    const deps = harness().deps;
    delete deps.classify;
    const r = await startWatchRun(planId, 'baseline', { deps }).done;
    getDb().run(`DELETE FROM ai_usage_logs WHERE operation = 'vendor_watch_classify'`);
    expect(r.cost_usd).toBeCloseTo(0.03);
    expect(r.error).toContain('malformed');
    expect(getSnapshot(rows[0].id)).toBeUndefined();
  });

  it('notes a finding it could not store and keeps the rest', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    h.classify = async () => ({
      findings: [sampleDraft({ signature: 'bad', title: null as unknown as string }), sampleDraft({ signature: 'good' })],
      costUsd: 0,
    });
    const r = await run(planId, h, 'baseline');
    expect(r).toMatchObject({ status: 'completed', findings_created: 1 });
    expect(r.error).toContain('NOT NULL');
    expect(listFindings().map(f => f.signature)).toEqual(['good']);
  });

  it('leaves a failed auto-file in the inbox and never retries it', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const linearDown = (async () => { throw new Error('Linear is down'); }) as unknown as LinearQueryFn;
    h.deps.file = async (id) => { h.fileCalls.push(id); return fileFinding(id, { filedBy: 'auto', query: linearDown }); };
    h.classify = async () => ({ findings: [sampleDraft({ kind: 'breaking', signature: 'same-change' })], costUsd: 0 });
    h.body = RSS(['a', 'b']);
    const r = await run(planId, h);
    expect(r.error).toContain(`auto-file finding #${h.fileCalls[0]}`);
    expect(listFindings()[0]).toMatchObject({ status: 'new' });
    expect(listFindings()[0].file_error).not.toBe('');
    h.body = RSS(['a', 'b', 'c']);
    await run(planId, h);
    expect(h.fileCalls).toHaveLength(1);
  });

  it('treats a feed that suddenly has no entries as a failure and leaves the snapshot alone', async () => {
    const { planId, rows } = plan([FEED]);
    const h = harness();
    await run(planId, h);
    const before = getSnapshot(rows[0].id)!.content_hash;
    h.body = '<html><body>Maintenance</body></html>';
    const r = await run(planId, h);
    expect(r.sources_failed).toBe(1);
    expect(getSnapshot(rows[0].id)!.content_hash).toBe(before);
    expect(listSources(planId)[0].consecutive_failures).toBe(1);
  });

  it('treats a spec that suddenly has no operations as a failure and leaves the snapshot alone', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId, rows } = plan([SPEC]);
    const h = harness();
    h.body = JSON.stringify({ openapi: '3.0.0', paths: { '/v1/messages': { post: {} }, '/v1/orders': { get: {} } } });
    await run(planId, h);
    const before = getSnapshot(rows[0].id)!.content_hash;
    h.body = JSON.stringify({ openapi: '3.0.0', paths: {} });
    const r = await run(planId, h);
    expect(r).toMatchObject({ sources_failed: 1, findings_created: 0 });
    expect(listFindings()).toEqual([]);
    expect(h.fileCalls).toEqual([]);
    expect(getSnapshot(rows[0].id)!.content_hash).toBe(before);
    expect(listSources(planId)[0].last_error).toBe('Spec has no operations');
  });

  it('stores no snapshot when the first read of a spec has no operations', async () => {
    const { planId, rows } = plan([SPEC]);
    const h = harness();
    h.body = JSON.stringify({ openapi: '3.0.0', paths: {} });
    const r = await run(planId, h, 'baseline');
    expect(r).toMatchObject({ sources_failed: 1, findings_created: 0 });
    expect(getSnapshot(rows[0].id)).toBeUndefined();
    expect(listSources(planId)[0]).toMatchObject({ consecutive_failures: 1, last_error: 'Spec has no operations' });
  });

  it('records an HTTP error as a source failure', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    h.deps.fetch = async (url) => ({ status: 404, finalUrl: url, contentType: 'text/html', body: 'nope' });
    const r = await run(planId, h);
    expect(r.sources_failed).toBe(1);
    expect(listSources(planId)[0].last_error).toBe('HTTP 404');
  });
});

describe('startWatchRun — OpenAPI', () => {
  beforeEach(resetVendorWatch);

  it('diffs specs without the classifier and auto-files a removed endpoint the piece calls', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([{ kind: 'openapi', url: 'https://acme.dev/openapi.json', label: 'spec' }]);
    const h = harness();
    h.body = JSON.stringify({ openapi: '3.0.0', paths: { '/v1/messages': { post: {} }, '/v1/orders': { get: {} } } });
    await run(planId, h);
    h.body = JSON.stringify({ openapi: '3.0.0', paths: { '/v1/orders': { get: {} } } });
    const r = await run(planId, h);
    expect(h.classifyCalls).toEqual([]);
    expect(r.findings_created).toBe(1);
    const [f] = listFindings();
    expect(f).toMatchObject({ kind: 'breaking', affected_targets: '["send_message"]' });
    expect(h.fileCalls).toEqual([f.id]);
  });
});

describe('startWatchRun — liveness', () => {
  beforeEach(resetVendorWatch);
  const gone: LivenessResult = { alive: false, failure: 'dns_not_found', detail: 'DNS: api.acme.dev not found' };

  it('creates and auto-files vendor_dead after dead_after_failures host-gone failures in a row', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([HOST]);
    const h = harness();
    await run(planId, h);
    h.liveness = gone;
    await run(planId, h);
    await run(planId, h);
    expect(listFindings()).toEqual([]);
    await run(planId, h);
    const [f] = listFindings();
    expect(f).toMatchObject({ kind: 'vendor_dead', signature: 'vendor_dead|api.acme.dev', is_baseline: 0 });
    expect(h.fileCalls).toEqual([f.id]);
    await run(planId, h);
    expect(listFindings()).toHaveLength(1);
  });

  it('never counts timeouts toward dead', async () => {
    const { planId } = plan([HOST]);
    const h = harness();
    await run(planId, h);
    h.liveness = { alive: false, failure: 'timeout', detail: 'Timed out' };
    for (let i = 0; i < 4; i++) await run(planId, h);
    expect(listFindings()).toEqual([]);
    expect(listSources(planId)[0]).toMatchObject({ consecutive_failures: 0, last_error: 'Timed out' });
  });

  it('reports a host that is already gone on its first check as a baseline finding', async () => {
    updateWatchConfig({ auto_file_enabled: 1 });
    const { planId } = plan([HOST]);
    const h = harness();
    h.liveness = gone;
    await run(planId, h, 'baseline');
    expect(listFindings()[0]).toMatchObject({ kind: 'vendor_dead', is_baseline: 1 });
    expect(h.fileCalls).toEqual([]);
  });
});

describe('startWatchRun — concurrency', () => {
  beforeEach(resetVendorWatch);

  it('returns the live run instead of starting a second one for the same plan', async () => {
    const { planId } = plan([FEED]);
    const h = harness();
    const a = startWatchRun(planId, 'manual', { deps: h.deps });
    const b = startWatchRun(planId, 'scheduled', { deps: h.deps });
    expect(b.runId).toBe(a.runId);
    await a.done;
    expect(getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM watch_runs')!.n).toBe(1);
    const c = startWatchRun(planId, 'manual', { deps: h.deps });
    expect(c.runId).not.toBe(a.runId);
    await c.done;
  });

  it('checks each source once when "Run now" lands while the daily cycle is running the plan', async () => {
    const { planId, rows } = plan([FEED]);
    const h = harness();
    const gate = gatedFetch(h);
    const cycle = startWatchRun(planId, 'scheduled', { cycleId: 'vw-1', deps: h.deps });
    const manual = startWatchRun(planId, 'manual', { deps: h.deps });
    expect(manual).toBe(cycle);
    gate.open();
    await manual.done;
    expect(gate.fetched).toEqual([FEED.url]);
    expect(h.classifyCalls).toHaveLength(1);
    expect(getDb().all('SELECT trigger_type, cycle_id FROM watch_runs')).toEqual([{ trigger_type: 'scheduled', cycle_id: 'vw-1' }]);
    expect(getSnapshot(rows[0].id)).toBeDefined();
  });

  it('resolves instead of rejecting when its plan is deleted mid-run, and stops checking sources', async () => {
    const { planId } = plan([FEED, { kind: 'html', url: 'https://acme.dev/changelog', label: 'page' }]);
    const h = harness();
    const gate = gatedFetch(h);
    const handle = startWatchRun(planId, 'manual', { deps: h.deps });
    deletePlan(planId);
    gate.open();
    const r = await handle.done;
    expect(r).toMatchObject({ id: handle.runId, plan_id: planId, status: 'failed' });
    expect(r.error).toContain(`Plan ${planId} was deleted during the run`);
    expect(gate.fetched).toEqual([FEED.url]);
    expect(getRun(handle.runId)).toBeUndefined();
    expect(() => startWatchRun(planId, 'manual', { deps: h.deps })).toThrow(/not found/);
  });

  it('throws for an unknown plan', () => {
    expect(() => startWatchRun(999_999, 'manual')).toThrow(/not found/);
  });
});
