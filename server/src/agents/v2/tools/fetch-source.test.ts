import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

import axios from 'axios';
import { fetchPieceSourceFromGitHub } from './fetch-source.js';
import { __resetGitHubRateLimitForTests } from '../../../services/github-api.js';

const get = axios.get as unknown as Mock;
const RAW = 'https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/community/acme';
const API = 'https://api.github.com/repos/activepieces/activepieces/contents/packages/pieces/community/acme/src/lib/actions';
const NOTE = '=== NOTE ===\nGitHub API rate limit reached: the action files under src/lib/actions were not read.';

let warn: MockInstance;

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers, data: {} } });
}

function serve(routes: Record<string, () => unknown>) {
  get.mockImplementation(async (url: string) => {
    const route = routes[url];
    if (!route) throw httpError(404);
    return route();
  });
}

beforeEach(() => {
  get.mockReset();
  __resetGitHubRateLimitForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetGitHubRateLimitForTests();
  warn.mockRestore();
});

describe('fetchPieceSourceFromGitHub', () => {
  it('still returns index.ts and ends with a NOTE when the actions listing hits the rate limit', async () => {
    serve({
      [`${RAW}/src/index.ts`]: () => ({ status: 200, headers: {}, data: 'export const acme = createPiece({});' }),
      [`${RAW}/src/lib/common.ts`]: () => ({ status: 200, headers: {}, data: 'export const common = {};' }),
      [API]: () => { throw httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' }); },
    });
    const out = await fetchPieceSourceFromGitHub('@activepieces/piece-acme');
    expect(out).toContain('=== src/index.ts ===\nexport const acme = createPiece({});');
    expect(out).toContain('=== src/lib/common.ts ===');
    expect(out!.endsWith(NOTE)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[github] rate limit reached; resets at'));
  });

  it('reads action files through the GitHub API helper and adds no NOTE when the listing works', async () => {
    serve({
      [`${RAW}/src/index.ts`]: () => ({ status: 200, headers: {}, data: 'export const acme = createPiece({});' }),
      [API]: () => ({ status: 200, headers: {}, data: [{ name: 'send.ts', download_url: `${RAW}/src/lib/actions/send.ts` }, { name: 'README.md', download_url: 'x' }] }),
      [`${RAW}/src/lib/actions/send.ts`]: () => ({ status: 200, headers: {}, data: 'export const send = createAction({});' }),
    });
    const out = await fetchPieceSourceFromGitHub('@activepieces/piece-acme');
    expect(out).toContain('=== src/lib/actions/send.ts ===\nexport const send');
    expect(out).not.toContain('=== NOTE ===');
    const apiCall = get.mock.calls.find(c => c[0] === API)!;
    expect(apiCall[1].headers['User-Agent']).toBe('piece-tester');
  });

  it('returns the NOTE on its own rather than "not found" when nothing else could be read', async () => {
    serve({ [API]: () => { throw httpError(403, { 'x-ratelimit-remaining': '0' }); } });
    expect(await fetchPieceSourceFromGitHub('@activepieces/piece-acme')).toBe(NOTE);
  });

  it('adds no NOTE when the actions directory is simply missing', async () => {
    serve({ [`${RAW}/src/index.ts`]: () => ({ status: 200, headers: {}, data: 'export const acme = createPiece({});' }) });
    const out = await fetchPieceSourceFromGitHub('@activepieces/piece-acme');
    expect(out).toBe('=== src/index.ts ===\nexport const acme = createPiece({});');
    expect(warn).not.toHaveBeenCalled();
  });
});
