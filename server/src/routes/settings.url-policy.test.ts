import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import settingsRoutes from './settings.js';
import { getSettings, updateSettings } from '../db/queries.js';

const CLOUD = 'https://cloud.activepieces.com/api';

let server: Server;
let base: string;

function send(method: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  updateSettings({ base_url: CLOUD, api_key: '', project_id: '', notify_webhook_url: '', linear_report_webhook_url: '' });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  updateSettings({ base_url: CLOUD, api_key: 'stored-key', project_id: 'p1', notify_webhook_url: '', linear_report_webhook_url: '' });
});

describe('PUT /api/settings URL policy', () => {
  it('refuses to point base_url at a non-Activepieces host and keeps the stored one', async () => {
    const res = await send('PUT', '/', { base_url: 'https://attacker.invalid/api' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/base_url/);
    expect(getSettings().base_url).toBe(CLOUD);
  });

  it('accepts Activepieces Cloud as base_url', async () => {
    const res = await send('PUT', '/', { base_url: CLOUD });
    expect(res.status).toBe(200);
  });

  it('still saves when an already-stored base_url is resubmitted unchanged', async () => {
    updateSettings({ base_url: 'https://legacy.example/api' });
    const res = await send('PUT', '/', { base_url: 'https://legacy.example/api', project_id: 'p2' });
    expect(res.status).toBe(200);
    expect(getSettings().project_id).toBe('p2');
  });

  it('refuses a Discord notification webhook on another host', async () => {
    const res = await send('PUT', '/', { notify_webhook_url: 'http://169.254.169.254/api/webhooks/1/x' });
    expect(res.status).toBe(400);
    expect(getSettings().notify_webhook_url).toBe('');
  });

  it('accepts a real Discord webhook', async () => {
    const res = await send('PUT', '/', { notify_webhook_url: 'https://discord.com/api/webhooks/1/abc' });
    expect(res.status).toBe(200);
  });

  it('refuses a Linear reporting webhook outside Activepieces', async () => {
    const res = await send('PUT', '/', { linear_report_webhook_url: 'https://attacker.invalid/hook' });
    expect(res.status).toBe(400);
    expect(getSettings().linear_report_webhook_url).toBe('');
  });

  it('accepts an Activepieces flow webhook for Linear reporting', async () => {
    const res = await send('PUT', '/', { linear_report_webhook_url: 'https://cloud.activepieces.com/api/v1/webhooks/abc' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/settings/test-connection URL policy', () => {
  it('will not send the stored API key to a host outside Activepieces', async () => {
    const res = await send('POST', '/test-connection', { base_url: 'https://attacker.invalid/api' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/base_url .*not allowed/);
  });
});
