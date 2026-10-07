import { describe, it, expect } from 'vitest';
import { detectKind, probeSource, probeSourceTool } from './probe-source.js';
import type { LookupFn } from '../../../services/vendor-watch/safe-fetch.js';
import type { ToolContext } from '../types.js';

const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const serve = (body: string, contentType: string, status = 200) =>
  (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>1</guid><title>Hello</title><description>World news here.</description></item></channel></rss>';
const LONG_HTML = `<html><body><main>${Array.from({ length: 10 }, (_, i) => `<p>Release ${i}: this changelog paragraph is long enough to count as text.</p>`).join('')}</main></body></html>`;
const SPA = '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';

describe('detectKind', () => {
  it('recognizes feeds, OpenAPI (JSON and YAML), readable HTML and JS-only shells', () => {
    expect(detectKind(RSS, 'application/rss+xml').kind).toBe('feed');
    expect(detectKind(JSON.stringify({ openapi: '3.0.0', paths: { '/a': { get: {} } } }), 'application/json').kind).toBe('openapi');
    expect(detectKind('openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n', 'text/yaml').kind).toBe('openapi');
    expect(detectKind(LONG_HTML, 'text/html').kind).toBe('html');
    expect(detectKind(SPA, 'text/html').kind).toBe('unreadable');
    expect(detectKind('{"hello":"world"}', 'application/json').kind).toBe('unreadable');
  });
});

describe('probeSource', () => {
  it('reports a readable feed as ok with a sample', async () => {
    const r = await probeSource('https://acme.dev/rss', { lookup, fetchImpl: serve(RSS, 'application/rss+xml') });
    expect(r).toMatchObject({ ok: true, status: 200, detected_kind: 'feed', problem: '' });
    expect(r.sample).toContain('Hello');
  });

  it('reports HTTP errors, JS-only pages and blocked hosts as not ok', async () => {
    expect((await probeSource('https://acme.dev/x', { lookup, fetchImpl: serve('nope', 'text/html', 404) })).problem).toBe('HTTP 404');
    expect((await probeSource('https://acme.dev/app', { lookup, fetchImpl: serve(SPA, 'text/html') })).problem).toMatch(/JavaScript-only/);
    const blocked = await probeSource('http://10.0.0.1/', { lookup });
    expect(blocked).toMatchObject({ ok: false, status: null });
    expect(blocked.problem).toMatch(/^blocked_address/);
  });
});

describe('probeSourceTool.handler', () => {
  it('answers a bad or missing URL with a not-ok result and records it, without throwing', async () => {
    const ctx = { pieceMeta: {}, actionName: '' } as unknown as ToolContext;
    for (const url of ['not a url', 'ftp://acme.dev/rss', 42, undefined]) {
      const out = JSON.parse(await probeSourceTool.handler({ url }, ctx));
      expect(out).toMatchObject({ ok: false, status: null, detected_kind: 'unreadable' });
      expect(out.problem).toMatch(/^bad_url/);
    }
    expect(ctx.probedSources?.get('not a url')).toMatchObject({ ok: false });
    expect(ctx.probedSources?.get('ftp://acme.dev/rss')).toMatchObject({ ok: false });
  });
});
