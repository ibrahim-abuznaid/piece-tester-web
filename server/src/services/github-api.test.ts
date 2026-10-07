import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import { updateSettings } from '../db/queries.js';
import {
  githubApiGet, validateGitHubToken, GitHubRateLimitError,
  getGitHubRateLimitedUntil, githubRateLimitHitsSince,
  __setHttpForTests, __resetGitHubRateLimitForTests,
} from './github-api.js';

const URL = 'https://api.github.com/repos/activepieces/activepieces/contents/packages/pieces/community/acme/src/lib/actions';
const TOKEN = 'github_pat_TESTTOKENDONOTLEAK1234';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

let get: Mock;
let warn: MockInstance;

function httpError(status: number, headers: Record<string, string>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers, data: {} } });
}

beforeEach(() => {
  get = vi.fn();
  __setHttpForTests(get);
  __resetGitHubRateLimitForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setHttpForTests(null);
  __resetGitHubRateLimitForTests();
  warn.mockRestore();
  vi.useRealTimers();
  updateSettings({ github_token: '' });
});

describe('githubApiGet', () => {
  it('sends Accept and User-Agent and no Authorization when no token is saved', async () => {
    updateSettings({ github_token: '' });
    get.mockResolvedValueOnce({ status: 200, headers: {}, data: [] });
    const res = await githubApiGet(URL, { timeout: 4321 });
    expect(res.data).toEqual([]);
    const [url, config] = get.mock.calls[0];
    expect(url).toBe(URL);
    expect(config.timeout).toBe(4321);
    expect(config.headers).toEqual({ Accept: 'application/vnd.github.v3+json', 'User-Agent': 'piece-tester' });
  });

  it('sends the saved token as a Bearer header', async () => {
    updateSettings({ github_token: TOKEN });
    get.mockResolvedValueOnce({ status: 200, headers: {}, data: [] });
    await githubApiGet(URL);
    expect(get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('rate-limit detection', () => {
  it('treats 403 with x-ratelimit-remaining 0 as a hit and records the reset time', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    const err = await githubApiGet(URL).catch(e => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(err.name).toBe('GitHubRateLimitError');
    expect(err.resetAt).toBe(reset * 1000);
    expect(getGitHubRateLimitedUntil()).toBe(reset * 1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[github] rate limit reached; resets at ${new Date(reset * 1000).toISOString()}`);
  });

  it('treats 429 with x-ratelimit-remaining 0 as a hit', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    get.mockRejectedValueOnce(httpError(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    await expect(githubApiGet(URL)).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(getGitHubRateLimitedUntil()).toBe(reset * 1000);
  });

  it('treats a rate-limited response that did not throw as a hit too', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    get.mockResolvedValueOnce({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, data: {} });
    await expect(githubApiGet(URL)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('does not treat 403 with requests remaining as a hit and rethrows the original error', async () => {
    const original = httpError(403, { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1900000000' });
    get.mockRejectedValueOnce(original);
    const err = await githubApiGet(URL).catch(e => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect(getGitHubRateLimitedUntil()).toBe(0);
    expect(githubRateLimitHitsSince(0)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rethrows a 404 untouched', async () => {
    const original = httpError(404, {});
    get.mockRejectedValueOnce(original);
    await expect(githubApiGet(URL)).rejects.toBe(original);
    expect(getGitHubRateLimitedUntil()).toBe(0);
  });

  it('falls back to one hour from now when the reset header is missing or invalid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0' }));
    expect((await githubApiGet(URL).catch(e => e)).resetAt).toBe(NOW + 60 * 60_000);
    expect(getGitHubRateLimitedUntil()).toBe(NOW + 60 * 60_000);

    get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'soon' }));
    expect((await githubApiGet(URL).catch(e => e)).resetAt).toBe(NOW + 60 * 60_000);
  });

  it('reports 0 once the reset time has passed', async () => {
    const reset = Math.floor(Date.now() / 1000) - 10;
    get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    await expect(githubApiGet(URL)).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(getGitHubRateLimitedUntil()).toBe(0);
  });

  it('githubRateLimitHitsSince is true only for hits at or after the given time, and tracks the last hit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(githubRateLimitHitsSince(0)).toBe(false);

    get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0' }));
    await githubApiGet(URL).catch(() => {});
    expect(githubRateLimitHitsSince(NOW - 1000)).toBe(true);
    expect(githubRateLimitHitsSince(NOW)).toBe(true);
    expect(githubRateLimitHitsSince(NOW + 1)).toBe(false);

    vi.setSystemTime(NOW + 5000);
    get.mockRejectedValueOnce(httpError(429, { 'x-ratelimit-remaining': '0' }));
    await githubApiGet(URL).catch(() => {});
    expect(githubRateLimitHitsSince(NOW + 1)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('validateGitHubToken', () => {
  it('resolves the core limit, sending the candidate token rather than the saved one', async () => {
    updateSettings({ github_token: 'github_pat_SAVED' });
    get.mockResolvedValueOnce({ status: 200, headers: {}, data: { resources: { core: { limit: 5000 } } } });
    await expect(validateGitHubToken(TOKEN)).resolves.toEqual({ limit: 5000 });
    const [url, config] = get.mock.calls[0];
    expect(url).toBe('https://api.github.com/rate_limit');
    expect(config.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(config.headers['User-Agent']).toBe('piece-tester');
  });

  it('says GitHub rejected the token when GitHub answers with an error status', async () => {
    get.mockRejectedValueOnce(httpError(401, {}));
    await expect(validateGitHubToken(TOKEN)).rejects.toThrow('GitHub rejected the token');
  });

  it('says the token is still on the 60/hour limit when GitHub accepts it at 60', async () => {
    get.mockResolvedValueOnce({ status: 200, headers: {}, data: { resources: { core: { limit: 60 } } } });
    await expect(validateGitHubToken(TOKEN)).rejects.toThrow('Token accepted but still on the 60/hour limit');
  });

  it('says GitHub could not be reached on a network error, without the token in the message', async () => {
    get.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'));
    const err = await validateGitHubToken(TOKEN).catch(e => e);
    expect(err.message).toBe('Could not reach GitHub: getaddrinfo ENOTFOUND api.github.com');
    expect(err.message).not.toContain(TOKEN);
  });

  it('does not record a rate-limit hit', async () => {
    get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0' }));
    await validateGitHubToken(TOKEN).catch(() => {});
    expect(githubRateLimitHitsSince(0)).toBe(false);
  });
});
