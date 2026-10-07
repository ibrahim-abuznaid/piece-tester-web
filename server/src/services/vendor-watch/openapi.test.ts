import { describe, it, expect } from 'vitest';
import { parseSpec, isOpenApiDoc, normalizePath, buildOpMap, diffOpenApi, normalizeOpenApi, parseOpMap } from './openapi.js';
import { pathsMatch, targetsUsingOp } from './endpoint-match.js';
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
    expect(openApiFindings(diff, used, 'u')).toEqual([]);
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
    expect(targetsUsingOp(inventory, 'GET /v1/widgets/{}')).toEqual(['get_widget']);
    expect(targetsUsingOp(inventory, 'DELETE /v1/widgets/{}')).toEqual(['delete_widget']);
    expect(targetsUsingOp(inventory, 'POST /v1/orders')).toEqual([]);
  });
});

describe('openApiFindings', () => {
  it('turns a diff into findings: breaking/deprecation for used operations, one new_feature for additions', () => {
    const f = openApiFindings(diffOpenApi(buildOpMap(specV1), buildOpMap(specV2)), inventory, 'https://acme.dev/openapi.json');
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
    const f = openApiFindings(diffOpenApi(buildOpMap(specV1), buildOpMap(specV2)), [], 'u');
    expect(f.filter(x => x.kind === 'other').map(x => x.severity)).toEqual(['low', 'low', 'low']);
    expect(f.some(x => x.kind === 'breaking' || x.kind === 'deprecation')).toBe(false);
  });

  it('on baseline, reports only deprecated operations the piece still calls', () => {
    const f = openApiBaselineFindings(buildOpMap(specV2), inventory, 'u');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'deprecation', severity: 'medium', affected_targets: ['get_widget'], is_baseline: true, signature: 'deprecation|GET /v1/widgets/{}' });
  });
});
