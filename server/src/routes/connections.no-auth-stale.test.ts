import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import connectionsRoutes from './connections.js';
import { getDb } from '../db/schema.js';
import { getTestPlan, createConnection } from '../db/queries.js';

const AI = '@activepieces/piece-ai';
const SLACK = '@activepieces/piece-slack';

function seedApprovedPlan(piece: string, action: string): number {
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status)
     VALUES (?,?,?,?,?)`,
    [piece, action, 'action', '[]', 'approved'],
  ).lastId;
}

function noAuthRow(piece: string) {
  return createConnection({ piece_name: piece, display_name: 'AI', connection_type: 'NO_AUTH', connection_value: '{}' });
}

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
  app.use('/api/connections', connectionsRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

describe('NO_AUTH placeholder connections never stale approved plans', () => {
  it('POST / with NO_AUTH (the piece page auto-create) leaves plans alone', async () => {
    const plan = seedApprovedPlan(AI, 'askAi');
    const res = await call('POST', '/', {
      piece_name: AI, display_name: 'AI', connection_type: 'NO_AUTH', connection_value: '{}', actions_config: '{}',
    });
    expect(res.status).toBe(201);
    expect(getTestPlan(plan)!.needs_regen).toBe(0);
  });

  it('POST / with a real credential still stales plans (regression guard)', async () => {
    const plan = seedApprovedPlan(SLACK, 'send_message');
    const res = await call('POST', '/', {
      piece_name: SLACK, display_name: 'Slack', connection_type: 'SECRET_TEXT', connection_value: '{"secret_text":"x"}',
    });
    expect(res.status).toBe(201);
    expect(getTestPlan(plan)!.needs_regen).toBe(1);
  });

  it('activating a NO_AUTH row leaves plans alone', async () => {
    const plan = seedApprovedPlan(AI, 'askAi');
    const conn = noAuthRow(AI);
    const res = await call('POST', `/${conn.id}/activate`);
    expect(res.status).toBe(200);
    expect(getTestPlan(plan)!.needs_regen).toBe(0);
  });

  it('updating the value of an active NO_AUTH row leaves plans alone', async () => {
    const plan = seedApprovedPlan(AI, 'askAi');
    const conn = noAuthRow(AI);
    const res = await call('PUT', `/${conn.id}`, { connection_value: '{}' });
    expect(res.status).toBe(200);
    expect(getTestPlan(plan)!.needs_regen).toBe(0);
  });

  it('deleting the active NO_AUTH row leaves plans alone', async () => {
    const plan = seedApprovedPlan(AI, 'askAi');
    const conn = noAuthRow(AI);
    const res = await call('DELETE', `/${conn.id}`);
    expect(res.status).toBe(200);
    expect(getTestPlan(plan)!.needs_regen).toBe(0);
  });
});
