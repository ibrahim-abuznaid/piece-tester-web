import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

export interface SafeFetchOptions {
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** false returns a 3xx as the result instead of following it. Default true. */
  followRedirects?: boolean;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

export type SafeFetchErrorCode =
  | 'bad_url' | 'blocked_address' | 'dns_not_found' | 'connection_refused' | 'tls'
  | 'timeout' | 'too_large' | 'too_many_redirects' | 'network';

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const USER_AGENT = 'piece-tester-vendor-watch/1';
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, unspecified, multicast and reserved ranges. */
export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  const v6 = address.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) {
    const rest = v6.slice(7);
    return net.isIPv4(rest) ? isBlockedAddress(rest) : true;
  }
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

async function assertPublicHost(url: URL, lookup: LookupFn): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new SafeFetchError('blocked_address', `Refusing to fetch ${host}: not a public address`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch (err: any) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') throw new SafeFetchError('dns_not_found', `DNS: ${host} not found`);
    throw new SafeFetchError('network', `DNS lookup failed for ${host}: ${err?.code || err?.message}`);
  }
  if (addrs.length === 0) throw new SafeFetchError('dns_not_found', `DNS: ${host} has no addresses`);
  const bad = addrs.find(a => isBlockedAddress(a.address));
  if (bad) throw new SafeFetchError('blocked_address', `Refusing to fetch ${host}: resolves to ${bad.address}`);
}

function classifyNetworkError(err: any): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new SafeFetchError('timeout', 'Timed out');
  const code: string = err?.cause?.code || err?.code || '';
  if (code === 'ECONNREFUSED') return new SafeFetchError('connection_refused', 'Connection refused');
  if (code === 'ENOTFOUND') return new SafeFetchError('dns_not_found', 'DNS: host not found');
  if (/CERT|SSL|TLS/i.test(code) || /certificate|ssl|tls/i.test(String(err?.cause?.message || ''))) {
    return new SafeFetchError('tls', `TLS error: ${code || err?.cause?.message}`);
  }
  return new SafeFetchError('network', `Network error: ${code || err?.message || 'unknown'}`);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new SafeFetchError('too_large', `Body is ${declared} bytes (cap ${maxBytes})`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SafeFetchError('too_large', `Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch a vendor URL that came from an AI or a web page. Only public http(s) hosts, every redirect
 * hop re-checked, time and size capped. Any HTTP status is returned; callers decide what is a failure.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const lookup = opts.lookup ?? defaultLookup;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const followRedirects = opts.followRedirects ?? true;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('bad_url', `Not a URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SafeFetchError('bad_url', `Only http(s) URLs are allowed: ${url.href}`);
    }
    await assertPublicHost(url, lookup);
    let res: Response;
    try {
      res = await fetchImpl(url.href, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
    } catch (err) {
      throw classifyNetworkError(err);
    }
    const location = res.headers.get('location');
    if (followRedirects && res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    let body: string;
    try {
      body = await readCapped(res, maxBytes);
    } catch (err) {
      throw classifyNetworkError(err);
    }
    return { status: res.status, finalUrl: url.href, contentType: res.headers.get('content-type') || '', body };
  }
  throw new SafeFetchError('too_many_redirects', `More than ${maxRedirects} redirects`);
}
