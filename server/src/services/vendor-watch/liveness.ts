import { safeFetch, SafeFetchError, type SafeFetchErrorCode, type SafeFetchOptions } from './safe-fetch.js';

export interface LivenessResult {
  alive: boolean;
  failure?: SafeFetchErrorCode;
  detail: string;
}

/** Failures that mean "the host is gone", not "the host is having a bad day". */
const DEAD_FAILURES: ReadonlySet<SafeFetchErrorCode> = new Set(['dns_not_found', 'connection_refused', 'tls']);

export function countsTowardDead(failure: SafeFetchErrorCode | undefined): boolean {
  return !!failure && DEAD_FAILURES.has(failure);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Does the vendor's API host still exist? Any HTTP response from the host itself, 3xx/4xx/5xx
 * included, counts as alive. Redirects are not followed.
 */
export async function checkLiveness(baseUrl: string, opts: SafeFetchOptions = {}): Promise<LivenessResult> {
  let root: string;
  try {
    root = `${new URL(baseUrl).origin}/`;
  } catch {
    return { alive: false, failure: 'bad_url', detail: `Not a URL: ${baseUrl}` };
  }
  try {
    const r = await safeFetch(root, { maxBytes: 256 * 1024, timeoutMs: 15_000, ...opts, followRedirects: false });
    return { alive: true, detail: `HTTP ${r.status}` };
  } catch (err) {
    if (err instanceof SafeFetchError) {
      if (err.code === 'too_large') return { alive: true, detail: 'responded (large body)' };
      return { alive: false, failure: err.code, detail: err.message };
    }
    return { alive: false, failure: 'network', detail: String((err as Error)?.message || err) };
  }
}
