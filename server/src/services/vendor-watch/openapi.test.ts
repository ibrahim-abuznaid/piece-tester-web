import { describe, it, expect } from 'vitest';
import { parseSpec, isOpenApiDoc, normalizePath, buildOpMap, diffOpenApi, normalizeOpenApi, parseOpMap, type OpMap } from './openapi.js';
import { matchDistance, pathsMatch, resolveEntry, targetsUsingOp } from './endpoint-match.js';
import { openApiFindings, openApiBaselineFindings } from './openapi-findings.js';
import type { EndpointRef } from './types.js';

const specV1 = {
  openapi: '3.0.0',
  paths: {
    '/v1/widgets/{widgetId}': {
      parameters: [{ $ref: '#/components/parameters/WidgetId' }],
      get: { parameters: [{ name: 'expand', in: 'query' }] },
      delete: {},
    },
    '/v1/orders': { get: {}, post: { requestBody: { required: true, content: {} } } },
  },
  components: { parameters: { WidgetId: { name: 'widgetId', in: 'path', required: true } } },
};

const specV2 = {
  openapi: '3.0.0',
  paths: {
    '/v1/widgets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: { deprecated: true, parameters: [{ name: 'expand', in: 'query' }] },
    },
    '/v1/orders': {
      get: { parameters: [{ $ref: '#/components/parameters/Cursor' }] },
      post: { requestBody: { required: true, content: {} } },
    },
    '/v1/invoices': { get: {} },
  },
  components: { parameters: { Cursor: { name: 'cursor', in: 'query', required: true } } },
};

const opsOf = (...keys: string[]): OpMap => Object.fromEntries(keys.map(k => [k, { deprecated: false, params: [] }]));

const inventory: EndpointRef[] = [
  { target: 'delete_widget', target_kind: 'action', method: 'DELETE', path: '/widgets/${widgetId}' },
  { target: 'get_widget', target_kind: 'action', method: 'get', path: 'https://api.acme.dev/v1/widgets/:id' },
  { target: 'list_orders', target_kind: 'trigger', method: 'GET', path: '/v1/orders/' },
  { target: 'post_message', target_kind: 'action', method: 'SDK', path: 'sdk:@acme/sdk#messages.create' },
];

describe('parsing', () => {
  it('parses JSON and YAML specs and recognizes OpenAPI documents', () => {
    expect(isOpenApiDoc(parseSpec(JSON.stringify(specV1)))).toBe(true);
    const yaml = 'openapi: 3.1.0\npaths:\n  /v2/things:\n    get:\n      deprecated: true\n';
    expect(buildOpMap(parseSpec(yaml))).toEqual({ 'GET /v2/things': { deprecated: true, params: [] } });
    expect(isOpenApiDoc({ foo: 1 })).toBe(false);
    expect(isOpenApiDoc('openapi')).toBe(false);
  });

  it('normalizes path templates, base URLs, express params and trailing slashes', () => {
    expect(normalizePath('/v1/widgets/{widgetId}')).toBe('/v1/widgets/{}');
    expect(normalizePath('/widgets/${widgetId}/')).toBe('/widgets/{}');
    expect(normalizePath('https://api.acme.dev/v1/widgets/:id?x=1')).toBe('/v1/widgets/{}');
    expect(normalizePath('v1/things:batchGet')).toBe('/v1/things:batchGet');
  });

  it('resolves $ref and path-level parameters and records required request bodies', () => {
    const ops = buildOpMap(specV1);
    expect(ops['GET /v1/widgets/{}'].params).toEqual([
      { name: 'widgetId', in: 'path', required: true },
      { name: 'expand', in: 'query', required: false },
    ]);
    expect(ops['POST /v1/orders'].params).toEqual([{ name: '', in: 'body', required: true }]);
    expect(Object.keys(ops).sort()).toEqual(['DELETE /v1/widgets/{}', 'GET /v1/orders', 'GET /v1/widgets/{}', 'POST /v1/orders']);
  });

  it('round-trips an op map through its snapshot content with a stable hash', () => {
    const n = normalizeOpenApi(buildOpMap(specV1));
    expect(parseOpMap(n.content)).toEqual(buildOpMap(specV1));
    expect(normalizeOpenApi(parseOpMap(n.content)).hash).toBe(n.hash);
    expect(parseOpMap('not json')).toEqual({});
  });
});

describe('diffOpenApi', () => {
  it('finds removed, newly deprecated, new required (non-path) params and added operations', () => {
    expect(diffOpenApi(buildOpMap(specV1), buildOpMap(specV2))).toEqual({
      removed: ['DELETE /v1/widgets/{}'],
      newlyDeprecated: ['GET /v1/widgets/{}'],
      newRequiredParams: [{ op: 'GET /v1/orders', param: 'query:cursor' }],
      added: ['GET /v1/invoices'],
    });
  });

  it('catches a required parameter added only through a path-level $ref', () => {
    const before = { openapi: '3.0.0', paths: { '/v1/customers/{id}': { get: {}, post: {} } } };
    const after = {
      openapi: '3.0.0',
      paths: { '/v1/customers/{id}': { parameters: [{ $ref: '#/components/parameters/ApiVersion' }], get: {}, post: {} } },
      components: { parameters: { ApiVersion: { name: 'Api-Version', in: 'header', required: true } } },
    };
    expect(diffOpenApi(buildOpMap(before), buildOpMap(after)).newRequiredParams).toEqual([
      { op: 'GET /v1/customers/{}', param: 'header:Api-Version' },
      { op: 'POST /v1/customers/{}', param: 'header:Api-Version' },
    ]);
  });

  it('does not report renaming a path parameter as a change', () => {
    const before = { openapi: '3.0.0', paths: { '/v1/customers/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true }] } } } };
    const after = {
      openapi: '3.0.0',
      paths: { '/v1/customers/{customer_id}': { parameters: [{ $ref: '#/components/parameters/CustomerId' }], get: {} } },
      components: { parameters: { CustomerId: { name: 'customer_id', in: 'path', required: true } } },
    };
    const diff = diffOpenApi(buildOpMap(before), buildOpMap(after));
    expect(diff).toEqual({ removed: [], newlyDeprecated: [], newRequiredParams: [], added: [] });
    const used: EndpointRef[] = [{ target: 'get_customer', target_kind: 'action', method: 'GET', path: '/v1/customers/{id}' }];
    expect(openApiFindings(diff, used, 'u', buildOpMap(before), buildOpMap(after))).toEqual([]);
  });
});

describe('endpoint matching', () => {
  it('matches by segment suffix and never on all-parameter paths or literal-vs-param', () => {
    expect(pathsMatch('/orders', '/v1/orders')).toBe(true);
    expect(pathsMatch('/v1/orders/', '/v1/orders')).toBe(true);
    expect(pathsMatch('/users/me', '/users/{id}')).toBe(false);
    expect(pathsMatch('/{id}', '/x/{y}')).toBe(false);
  });

  it('maps an operation to the targets that call it, ignoring SDK entries', () => {
    const ops = buildOpMap(specV1);
    expect(targetsUsingOp(inventory, 'GET /v1/widgets/{}', ops)).toEqual(['get_widget']);
    expect(targetsUsingOp(inventory, 'DELETE /v1/widgets/{}', ops)).toEqual(['delete_widget']);
    expect(targetsUsingOp(inventory, 'POST /v1/orders', ops)).toEqual([]);
  });

  it('resolves an entry to the op whose segment count is closest, keeping ties, when no path is exact', () => {
    const ops = opsOf('GET /v1/sources/{}', 'GET /v1/customers/{}/sources/{}');
    const entry: EndpointRef = { target: 'get_source', target_kind: 'action', method: 'GET', path: '/sources/{id}' };
    expect(resolveEntry(entry, ops)).toEqual(['GET /v1/sources/{}']);
    expect(targetsUsingOp([entry], 'GET /v1/customers/{}/sources/{}', ops)).toEqual([]);
    expect(resolveEntry(entry, opsOf('GET /v1/sources/{}', 'GET /v2/sources/{}'))).toEqual(['GET /v1/sources/{}', 'GET /v2/sources/{}']);
    expect(resolveEntry({ ...entry, method: 'SDK', path: 'sdk:@acme/sdk#sources.get' }, ops)).toEqual([]);
    expect(matchDistance(entry, ops)).toBe(1);
    expect(matchDistance(entry, opsOf('GET /v1/sources/{}/items'))).toBe(Infinity);
  });
});

describe('openApiFindings', () => {
  it('turns a diff into findings: breaking/deprecation for used operations, one new_feature for additions', () => {
    const [prev, next] = [buildOpMap(specV1), buildOpMap(specV2)];
    const f = openApiFindings(diffOpenApi(prev, next), inventory, 'https://acme.dev/openapi.json', prev, next);
    expect(f.map(x => [x.kind, x.severity, x.affected_targets, x.signature])).toEqual([
      ['breaking', 'high', ['delete_widget'], 'breaking|DELETE /v1/widgets/{}'],
      ['deprecation', 'high', ['get_widget'], 'deprecation|GET /v1/widgets/{}'],
      ['breaking', 'high', ['list_orders'], 'breaking|GET /v1/orders|query:cursor'],
      ['new_feature', 'low', [], expect.stringMatching(/^new_feature\|[0-9a-f]{40}$/)],
    ]);
    expect(f.every(x => x.evidence_verified && !x.is_baseline && x.evidence_url === 'https://acme.dev/openapi.json')).toBe(true);
    expect(f[3].title).toBe('1 new endpoint in the API');
  });

  it('reports changes to operations the piece does not use as low "other" findings', () => {
    const [prev, next] = [buildOpMap(specV1), buildOpMap(specV2)];
    const f = openApiFindings(diffOpenApi(prev, next), [], 'u', prev, next);
    expect(f.filter(x => x.kind === 'other').map(x => x.severity)).toEqual(['low', 'low', 'low']);
    expect(f.some(x => x.kind === 'breaking' || x.kind === 'deprecation')).toBe(false);
  });

  it('does not hit a target that calls a nested path when the top-level op with the same tail is deprecated', () => {
    const prev = opsOf('GET /issues', 'GET /repos/{}/{}/issues');
    const next: OpMap = { ...prev, 'GET /issues': { deprecated: true, params: [] } };
    const inv: EndpointRef[] = [{ target: 'list_repo_issues', target_kind: 'action', method: 'GET', path: '/repos/${owner}/${repo}/issues' }];
    const f = openApiFindings(diffOpenApi(prev, next), inv, 'u', prev, next);
    expect(f.map(x => [x.kind, x.affected_targets, x.signature])).toEqual([['other', [], 'other|deprecated|GET /issues']]);
  });

  it('still reports a removed nested op as breaking when only a shorter op with the same tail survives', () => {
    const [prev, next] = [opsOf('GET /issues', 'GET /repos/{}/{}/issues'), opsOf('GET /issues')];
    const inv: EndpointRef[] = [{ target: 'list_repo_issues', target_kind: 'action', method: 'GET', path: '/repos/${owner}/${repo}/issues' }];
    const f = openApiFindings(diffOpenApi(prev, next), inv, 'u', prev, next);
    expect(f.map(x => [x.kind, x.severity, x.affected_targets, x.signature])).toEqual([
      ['breaking', 'high', ['list_repo_issues'], 'breaking|GET /repos/{}/{}/issues'],
    ]);
  });

  it('does not report a base-path move as a removal for a target that still resolves in the new spec', () => {
    const [prev, next] = [opsOf('GET /orders'), opsOf('GET /v1/orders')];
    const f = openApiFindings(diffOpenApi(prev, next), inventory, 'u', prev, next);
    expect(f.map(x => [x.kind, x.affected_targets])).toEqual([['other', []], ['new_feature', []]]);
    const [tiedPrev, tiedNext] = [opsOf('GET /v1/sources/{}', 'GET /v2/sources/{}'), opsOf('GET /v2/sources/{}')];
    const inv: EndpointRef[] = [{ target: 'get_source', target_kind: 'action', method: 'GET', path: '/sources/{id}' }];
    const tied = openApiFindings(diffOpenApi(tiedPrev, tiedNext), inv, 'u', tiedPrev, tiedNext);
    expect(tied.map(x => [x.kind, x.affected_targets])).toEqual([['other', []]]);
  });

  it('on baseline, reports only deprecated operations the piece still calls', () => {
    const f = openApiBaselineFindings(buildOpMap(specV2), inventory, 'u');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'deprecation', severity: 'medium', affected_targets: ['get_widget'], is_baseline: true, signature: 'deprecation|GET /v1/widgets/{}' });
  });
});
