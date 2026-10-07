import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { getSettings } from '../db/queries.js';

const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
const DEFAULT_TIMEOUT_MS = 10_000;
const UNAUTHENTICATED_LIMIT = 60;
const FALLBACK_RESET_MS = 60 * 60_000;
const BASE_HEADERS = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'piece-tester' };

export type HttpGet = (url: string, config: AxiosRequestConfig) => Promise<AxiosResponse>;

const axiosGet: HttpGet = (url, config) => axios.get(url, config);
let httpGet: HttpGet = axiosGet;

let rateLimitedUntil = 0;
let lastHitAt = 0;

export class GitHubRateLimitError extends Error {
  readonly resetAt: number;
  constructor(resetAt: number) {
    super(`GitHub API rate limit reached; resets at ${new Date(resetAt).toISOString()}`);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

function isRateLimitHit(status: number | undefined, headers: any): boolean {
  return (status === 403 || status === 429) && String(headers?.['x-ratelimit-remaining']) === '0';
}

function recordHit(headers: any): GitHubRateLimitError {
  const reset = Number(headers?.['x-ratelimit-reset']);
  const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + FALLBACK_RESET_MS;
  rateLimitedUntil = resetAt;
  lastHitAt = Date.now();
  console.warn(`[github] rate limit reached; resets at ${new Date(resetAt).toISOString()}`);
  return new GitHubRateLimitError(resetAt);
}

/**
 * GET a GitHub REST API URL, sending the saved token when there is one.
 * Throws GitHubRateLimitError (and remembers the reset time) when GitHub reports the
 * rate limit as used up; any other failure is rethrown unchanged.
 */
export async function githubApiGet(url: string, opts: { timeout?: number } = {}): Promise<AxiosResponse> {
  const token = getSettings().github_token;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: AxiosResponse;
  try {
    res = await httpGet(url, { timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS, headers });
  } catch (err: any) {
    if (isRateLimitHit(err?.response?.status, err?.response?.headers)) throw recordHit(err.response.headers);
    throw err;
  }
  if (isRateLimitHit(res.status, res.headers)) throw recordHit(res.headers);
  return res;
}

/** Epoch ms until which the GitHub rate limit is known to be used up; 0 when not limited or already reset. */
export function getGitHubRateLimitedUntil(): number {
  return rateLimitedUntil > Date.now() ? rateLimitedUntil : 0;
}

/** True when a rate-limit hit was recorded at or after `ts` (epoch ms). */
export function githubRateLimitHitsSince(ts: number): boolean {
  return lastHitAt > 0 && lastHitAt >= ts;
}

/** Check a candidate token against GitHub before saving it. Resolves the hourly core limit it grants. */
export async function validateGitHubToken(token: string): Promise<{ limit: number }> {
  let res: AxiosResponse;
  try {
    res = await httpGet(RATE_LIMIT_URL, {
      timeout: DEFAULT_TIMEOUT_MS,
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
    });
  } catch (err: any) {
    if (err?.response) throw new Error('GitHub rejected the token');
    const msg = String(err?.message || err);
    throw new Error(`Could not reach GitHub: ${token ? msg.replaceAll(token, '[redacted]') : msg}`);
  }
  if (res.status !== 200) throw new Error('GitHub rejected the token');
  const limit = Number(res.data?.resources?.core?.limit);
  if (!(limit > UNAUTHENTICATED_LIMIT)) throw new Error('Token accepted but still on the 60/hour limit');
  return { limit };
}

/** Test seam: swap the HTTP GET used for GitHub calls; null restores axios. */
export function __setHttpForTests(get: HttpGet | null): void {
  httpGet = get ?? axiosGet;
}

/** Test seam: forget any recorded rate-limit hit. */
export function __resetGitHubRateLimitForTests(): void {
  rateLimitedUntil = 0;
  lastHitAt = 0;
}
