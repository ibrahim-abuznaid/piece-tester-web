import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  beginPlanGeneration, completePlanGeneration, insertFinding, upsertPieceUsage,
} from '../db/vendor-watch-queries.js';
import { resetVendorWatch, sampleDraft, samplePlanResult } from '../db/vendor-watch-test-utils.js';
import vendorWatchRoutes from './vendor-watch.js';

vi.mock('../services/vendor-watch/piece-usage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/vendor-watch/piece-usage.js')>()),
  ensureWatchedUsage: () => false,
}));

const P = (s: string) => `@activepieces/piece-${s}`;

let server: Server;
let base: string;

function findings(name: string, n: number): number[] {
  const p = completePlanGeneration(beginPlanGeneration(name).id, samplePlanResult());
  return Array.from({ length: n }, (_, i) => insertFinding({
    plan_id: p.id, piece_name: name, source_id: null, run_id: null, draft: sampleDraft({ signature: `${name}-${i}` }),
  })!.id);
}

async function getFindings(query: string) {
  const res = await fetch(`${base}/findings${query}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    findings: { id: number }[]; counts: Record<string, number>; total: number; limit: number; offset: number;
  }>;
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

beforeEach(resetVendorWatch);

describe('GET /findings', () => {
  it('returns one page with the total, the tier counts and the page it used', async () => {
    upsertPieceUsage([{ piece_name: P('stripe'), projects: 491, versions: 2, versions_failed: 0 }]);
    const stripe = findings(P('stripe'), 3);
    findings(P('acme'), 2);
    const body = await getFindings('?status=new&importance=high&limit=2&offset=1');
    expect(body.findings.map(f => f.id)).toEqual([stripe[1], stripe[0]]);
    expect(body).toMatchObject({ total: 3, limit: 2, offset: 1, counts: { high: 3, medium: 0, low: 0, unrated: 2 } });
  });

  it('uses the defaults for missing or non-numeric paging and clamps the rest', async () => {
    findings(P('acme'), 3);
    expect(await getFindings('?status=new')).toMatchObject({ total: 3, limit: 100, offset: 0 });
    expect(await getFindings('?status=new&limit=abc&offset=xyz')).toMatchObject({ limit: 100, offset: 0 });
    expect(await getFindings('?status=new&limit=&offset=')).toMatchObject({ limit: 100, offset: 0 });
    expect(await getFindings('?status=new&limit=1000&offset=-4')).toMatchObject({ limit: 200, offset: 0 });
    const past = await getFindings('?status=new&offset=10');
    expect(past).toMatchObject({ findings: [], total: 3, offset: 10 });
  });
});
