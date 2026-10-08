import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import vendorWatchRoutes from './vendor-watch.js';
import { getPlan, queuePlanGeneration } from '../db/vendor-watch-queries.js';
import { resetVendorWatch } from '../db/vendor-watch-test-utils.js';
import { resetGenerationQueueForTests } from '../services/vendor-watch/generation-queue.js';

let server: Server;
let base: string;

function call(method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/vendor-watch', vendorWatchRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vendor-watch`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  resetVendorWatch();
  resetGenerationQueueForTests();
});

describe('vendor watch routes: generation queue', () => {
  it('GET /generation-queue reports the queue state', async () => {
    const res = await call('GET', '/generation-queue');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 0, running: 0, github_wait_until: null });
  });

  it('caps a batch at 300 pieces', async () => {
    const names = Array.from({ length: 301 }, (_, i) => `@activepieces/piece-p${i}`);
    const res = await call('POST', '/plans/generate-batch', { piece_names: names });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'At most 300 pieces per batch' });
  });

  it('deletes a queued plan', async () => {
    const plan = queuePlanGeneration('@activepieces/piece-acme');
    const res = await call('DELETE', `/plans/${plan.id}`);
    expect(res.status).toBe(200);
    expect(getPlan(plan.id)).toBeUndefined();
  });

  it('refuses to run, pause or activate a queued plan', async () => {
    const plan = queuePlanGeneration('@activepieces/piece-acme');
    const run = await call('POST', `/plans/${plan.id}/run`);
    expect(run.status).toBe(409);
    const patch = await call('PATCH', `/plans/${plan.id}`, { status: 'active' });
    expect(patch.status).toBe(409);
    expect(await patch.json()).toEqual({ error: 'Plan is queued' });
    expect(getPlan(plan.id)!.status).toBe('queued');
  });
});
