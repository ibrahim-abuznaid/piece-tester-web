import { describe, it, expect } from 'vitest';
import { checkLiveness, countsTowardDead, hostOf } from './liveness.js';
import type { LookupFn } from './safe-fetch.js';

const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const asFetch = (fn: () => Promise<Response>) => fn as unknown as typeof fetch;

describe('checkLiveness', () => {
  it('treats any HTTP response, even 404, as alive and fetches the origin root', async () => {
    let asked = '';
    const f = ((url: string) => { asked = url; return Promise.resolve(new Response('nope', { status: 404 })); }) as unknown as typeof fetch;
    const r = await checkLiveness('https://api.acme.dev/v1/things', { lookup, fetchImpl: f });
    expect(r).toEqual({ alive: true, detail: 'HTTP 404' });
    expect(asked).toBe('https://api.acme.dev/');
  });

  it('treats a redirect as alive without following it, even when the target host is gone', async () => {
    const asked: string[] = [];
    const partial: LookupFn = async (host) => {
      if (host === 'api.acme.dev') return [{ address: '93.184.216.34', family: 4 }];
      throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    };
    const f = ((url: string) => {
      asked.push(url);
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://www.gone.example/' } }));
    }) as unknown as typeof fetch;
    const r = await checkLiveness('https://api.acme.dev/v1', { lookup: partial, fetchImpl: f });
    expect(r).toEqual({ alive: true, detail: 'HTTP 302' });
    expect(asked).toEqual(['https://api.acme.dev/']);
  });

  it('reports DNS not-found as a dead-type failure', async () => {
    const gone: LookupFn = async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };
    const r = await checkLiveness('https://api.gone.example', { lookup: gone, fetchImpl: asFetch(async () => new Response('')) });
    expect(r.alive).toBe(false);
    expect(r.failure).toBe('dns_not_found');
    expect(countsTowardDead(r.failure)).toBe(true);
  });

  it('reports a timeout as a failure that does not count toward dead', async () => {
    const slow = asFetch(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    const r = await checkLiveness('https://api.acme.dev', { lookup, fetchImpl: slow });
    expect(r.alive).toBe(false);
    expect(countsTowardDead(r.failure)).toBe(false);
  });

  it('rejects a non-URL', async () => {
    const r = await checkLiveness('not a url');
    expect(r).toMatchObject({ alive: false, failure: 'bad_url' });
  });

  it('hostOf returns the hostname, or the input when it is not a URL', () => {
    expect(hostOf('https://api.acme.dev/v1')).toBe('api.acme.dev');
    expect(hostOf('weird')).toBe('weird');
  });
});
