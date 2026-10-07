import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import settingsRoutes from './settings.js';
import { getSettings, updateSettings } from '../db/queries.js';
import {
  githubApiGet, getGitHubRateLimitedUntil, __setHttpForTests, __resetGitHubRateLimitForTests,
} from '../services/github-api.js';

const TOKEN = 'github_pat_ROUTETESTTOKEN1234567890';

let server: Server;
let base: string;
let get: Mock;
let warn: MockInstance;

function httpError(status: number, headers: Record<string, string>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers, data: {} } });
}

async function hitRateLimit() {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  get.mockRejectedValueOnce(httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
  await githubApiGet('https://api.github.com/repos/x').catch(() => {});
  expect(getGitHubRateLimitedUntil()).toBe(reset * 1000);
}

function post(path: string, body: unknown = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  get = vi.fn();
  __setHttpForTests(get);
  __resetGitHubRateLimitForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  updateSettings({ github_token: '' });
});

afterEach(() => {
  __setHttpForTests(null);
  __resetGitHubRateLimitForTests();
  warn.mockRestore();
  updateSettings({ github_token: '' });
});

describe('POST /save-github-token', () => {
  it('saves a valid trimmed token and clears a recorded rate-limit wait', async () => {
    await hitRateLimit();
    get.mockResolvedValueOnce({ status: 200, headers: {}, data: { resources: { core: { limit: 5000 } } } });
    const res = await post('/save-github-token', { token: `  ${TOKEN}  ` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, limit: 5000 });
    expect(getSettings().github_token).toBe(TOKEN);
    expect(getGitHubRateLimitedUntil()).toBe(0);
  });

  it('keeps the wait and saves nothing when GitHub rejects the token', async () => {
    await hitRateLimit();
    get.mockRejectedValueOnce(httpError(401, {}));
    const res = await post('/save-github-token', { token: TOKEN });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'GitHub rejected the token' });
    expect(getSettings().github_token).toBe('');
    expect(getGitHubRateLimitedUntil()).toBeGreaterThan(0);
  });

  it('rejects an empty token without calling GitHub', async () => {
    const res = await post('/save-github-token', { token: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Token is required' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('POST /remove-github-token', () => {
  it('clears the saved token', async () => {
    updateSettings({ github_token: TOKEN });
    const res = await post('/remove-github-token');
    expect(await res.json()).toEqual({ success: true });
    expect(getSettings().github_token).toBe('');
  });
});
