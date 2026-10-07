import { describe, it, expect, vi } from 'vitest';
import { safeFetch, isBlockedAddress, type LookupFn } from './safe-fetch.js';

const publicLookup: LookupFn = async (host) =>
  host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
const asFetch = (fn: (url: string, init?: any) => Promise<Response>) => fn as unknown as typeof fetch;

describe('isBlockedAddress', () => {
  it.each([
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '93.184.216.34', '2606:4700::1111'])('allows %s', (a) =>
    expect(isBlockedAddress(a)).toBe(false));
});

describe('safeFetch', () => {
  it('returns status, final URL, content type and body', async () => {
    const f = asFetch(async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const r = await safeFetch('https://acme.dev/x', { lookup: publicLookup, fetchImpl: f });
    expect(r).toEqual({ status: 200, finalUrl: 'https://acme.dev/x', contentType: 'text/plain', body: 'hello' });
  });

  it('refuses a host that resolves to the metadata address without fetching', async () => {
    const f = vi.fn();
    const lookup: LookupFn = async () => [{ address: '169.254.169.254', family: 4 }];
    await expect(safeFetch('http://metadata.example/', { lookup, fetchImpl: asFetch(f) })).rejects.toMatchObject({ code: 'blocked_address' });
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a literal private IP', async () => {
    await expect(safeFetch('http://192.168.0.10/', { lookup: publicLookup, fetchImpl: asFetch(vi.fn()) })).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('refuses non-http protocols', async () => {
    await expect(safeFetch('file:///etc/passwd', { lookup: publicLookup })).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('re-checks every redirect hop', async () => {
    const f = asFetch(async (url) =>
      url.startsWith('https://acme.dev')
        ? new Response(null, { status: 302, headers: { location: 'http://internal.example/admin' } })
        : new Response('secret'));
    await expect(safeFetch('https://acme.dev/start', { lookup: publicLookup, fetchImpl: f })).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('follows a public redirect and reports the final URL', async () => {
    const f = asFetch(async (url) =>
      url === 'https://acme.dev/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('moved', { status: 200 }));
    const r = await safeFetch('https://acme.dev/old', { lookup: publicLookup, fetchImpl: f });
    expect(r.finalUrl).toBe('https://acme.dev/new');
    expect(r.body).toBe('moved');
  });

  it('stops after too many redirects', async () => {
    const f = asFetch(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    await expect(safeFetch('https://acme.dev/loop', { lookup: publicLookup, fetchImpl: f, maxRedirects: 2 })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('caps the body size', async () => {
    const f = asFetch(async () => new Response('x'.repeat(2000)));
    await expect(safeFetch('https://acme.dev/big', { lookup: publicLookup, fetchImpl: f, maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('maps DNS not-found', async () => {
    const lookup: LookupFn = async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); };
    await expect(safeFetch('https://gone.example/', { lookup, fetchImpl: asFetch(vi.fn()) })).rejects.toMatchObject({ code: 'dns_not_found' });
  });

  it('maps connection refused, TLS and timeout errors', async () => {
    const refused = asFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    await expect(safeFetch('https://acme.dev/', { lookup: publicLookup, fetchImpl: refused })).rejects.toMatchObject({ code: 'connection_refused' });
    const tls = asFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); });
    await expect(safeFetch('https://acme.dev/', { lookup: publicLookup, fetchImpl: tls })).rejects.toMatchObject({ code: 'tls' });
    const slow = asFetch(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    await expect(safeFetch('https://acme.dev/', { lookup: publicLookup, fetchImpl: slow })).rejects.toMatchObject({ code: 'timeout' });
  });
});
