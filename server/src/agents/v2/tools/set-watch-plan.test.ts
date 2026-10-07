import { describe, it, expect } from 'vitest';
import { parseWatchPlanInput, validateWatchPlan, setWatchPlanTool } from './set-watch-plan.js';
import type { ProbeResult } from '../../../services/vendor-watch/types.js';
import type { ToolContext } from '../types.js';

const probe = (url: string, kind: ProbeResult['detected_kind'], ok = true): ProbeResult => ({
  url, ok, status: ok ? 200 : 404, final_url: url, content_type: '', detected_kind: kind,
  text_chars: 900, sample: '', problem: ok ? '' : 'HTTP 404',
});

const ctx = (probes: ProbeResult[] = []): ToolContext => ({
  pieceMeta: {
    name: '@activepieces/piece-acme',
    actions: { send_message: { name: 'send_message', displayName: 'Send' } },
    triggers: { new_order: { name: 'new_order', displayName: 'New order' } },
  } as unknown as ToolContext['pieceMeta'],
  actionName: '',
  probedSources: new Map(probes.map(p => [p.url, p])),
});

const input = (over: Record<string, unknown> = {}) => ({
  vendor_name: 'Acme', api_base_urls: ['https://api.acme.dev/v1'], api_version: 'v1', auth_type: 'API key',
  endpoint_inventory: [
    { target: 'send_message', target_kind: 'action', method: 'post', path: '/v1/messages' },
    { target: 'new_order', target_kind: 'trigger', method: 'GET', path: '/v1/orders' },
    { target: 'ghost', target_kind: 'action', method: 'GET', path: '/v1/ghost' },
  ],
  sources: [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS' }],
  note: 'ok', ...over,
});

const check = (over: Record<string, unknown> = {}, probes = [probe('https://acme.dev/rss', 'feed')]) =>
  validateWatchPlan(parseWatchPlanInput(input(over)), ctx(probes));

describe('validateWatchPlan', () => {
  it('accepts a plan whose sources were all probed ok, dropping unknown targets with a warning', () => {
    const v = check();
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual(['endpoint_inventory: dropped "ghost" — not an action of this piece.']);
    expect(v.plan.endpoint_inventory.map(e => [e.target, e.method])).toEqual([['send_message', 'POST'], ['new_order', 'GET']]);
  });

  it('says "a trigger" when it drops an unknown trigger', () => {
    const inventory = [{ target: 'ghost', target_kind: 'trigger', method: 'GET', path: '/v1/ghost' }];
    expect(check({ endpoint_inventory: inventory }).warnings).toEqual(['endpoint_inventory: dropped "ghost" — not a trigger of this piece.']);
  });

  it('rejects unprobed, unreadable and mis-typed sources', () => {
    expect(check({}, []).errors[0]).toMatch(/never probed/);
    expect(check({}, [probe('https://acme.dev/rss', 'unreadable', false)]).errors[0]).toMatch(/unreadable \(HTTP 404\)/);
    expect(check({}, [probe('https://acme.dev/rss', 'html')]).errors[0]).toMatch(/probed as "html", not "feed"/);
  });

  it('rejects liveness sources, duplicates, too many sources and no sources', () => {
    expect(check({ sources: [{ kind: 'liveness', url: 'https://api.acme.dev', label: 'x' }] }).errors[0]).toMatch(/liveness is added for you/);
    const dup = [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'a' }, { kind: 'feed', url: 'https://acme.dev/rss', label: 'b' }];
    expect(check({ sources: dup }).errors).toContain('sources: "https://acme.dev/rss" is listed twice.');
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'feed', url: `https://acme.dev/${i}`, label: String(i) }));
    expect(check({ sources: many }, many.map(s => probe(s.url, 'feed'))).errors).toContain('sources: at most 8, got 9.');
    expect(check({ sources: [] }).errors).toContain('sources: add at least one feed, openapi or html source.');
  });

  it('rejects a source at the API base URL, because the liveness source is stored there', () => {
    const base = 'https://api.acme.dev/v1';
    expect(check({ sources: [{ kind: 'openapi', url: base, label: 'API' }] }, [probe(base, 'openapi')]).errors).toEqual([
      `sources: "${base}" is the API base URL the liveness check already watches; pick a changelog, feed or spec URL.`,
    ]);
  });

  it('requires at least one http(s) base URL', () => {
    expect(check({ api_base_urls: [] }).errors[0]).toMatch(/at least one URL/);
    expect(check({ api_base_urls: ['ftp://acme.dev'] }).errors[0]).toMatch(/not an http\(s\) URL/);
  });
});

describe('validateWatchPlan on malformed input', () => {
  it('reports missing lists, non-object sources and non-string kind/url as errors', () => {
    const v = check({
      api_base_urls: 'https://api.acme.dev/v1',
      endpoint_inventory: undefined,
      sources: ['https://acme.dev/rss', { kind: 7, url: 'https://acme.dev/rss', label: 'x' }, { kind: 'feed', url: null, label: 'y' }, null],
    });
    expect(v.errors).toEqual([
      'api_base_urls: expected an array, got string.',
      'endpoint_inventory: expected an array, got nothing.',
      'sources[0]: expected an object with kind, url and label, got string.',
      'sources[1]: kind must be a string, got number.',
      'sources[2]: url must be a string, got nothing.',
      'sources[3]: expected an object with kind, url and label, got nothing.',
      'api_base_urls: add at least one URL (the liveness check uses the first).',
      'sources: add at least one feed, openapi or html source.',
    ]);
  });

  it('reports non-string base URLs and inventory entries without a string target or method', () => {
    const v = check({
      api_base_urls: ['https://api.acme.dev/v1', 42],
      endpoint_inventory: ['POST /v1/messages', { target: 3, target_kind: 'action', method: 'GET', path: '/x' }, { target: 'send_message', method: null }],
      sources: { kind: 'feed', url: 'https://acme.dev/rss', label: 'RSS' },
    });
    expect(v.errors).toEqual([
      'api_base_urls[1]: expected a URL string, got number.',
      'endpoint_inventory[0]: expected an object with target, target_kind, method and path, got string.',
      'endpoint_inventory[1]: target must be a string, got number.',
      'endpoint_inventory[2]: method must be a string, got nothing.',
      'sources: expected an array, got object.',
      'sources: add at least one feed, openapi or html source.',
    ]);
    expect(v.plan).not.toHaveProperty('input_errors');
  });

  it('never throws, even on input that is not a plan at all', () => {
    for (const bad of [null, 'plan', [], { vendor_name: { toString: 1 }, sources: [[]], endpoint_inventory: [{ target: 'x', method: 'GET', note: { toString: 1 } }] }]) {
      expect(validateWatchPlan(parseWatchPlanInput(bad as any), ctx()).errors.length).toBeGreaterThan(0);
      expect(setWatchPlanTool.validateTerminal!(bad as any, ctx())).toEqual(expect.any(String));
    }
  });
});

describe('setWatchPlanTool.validateTerminal', () => {
  it('accepts a valid plan and explains an invalid one', () => {
    expect(setWatchPlanTool.validateTerminal!(input(), ctx([probe('https://acme.dev/rss', 'feed')]))).toBeNull();
    expect(setWatchPlanTool.validateTerminal!(input(), ctx([]))).toMatch(/never probed/);
  });

  it('explains malformed input instead of throwing', () => {
    expect(setWatchPlanTool.validateTerminal!(input({ sources: 'https://acme.dev/rss' }), ctx())).toMatch(/^sources: expected an array, got string\.$/m);
  });
});
