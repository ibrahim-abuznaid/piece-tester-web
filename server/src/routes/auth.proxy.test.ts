import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import authRoutes from './auth.js';
import { TRUST_PROXY } from '../middleware/auth.js';

let server: Server;
let base: string;

// nginx appends the real peer address to X-Forwarded-For and connects from loopback.
function login(forwardedFor: string, password = 'wrong-password') {
  return fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
    body: JSON.stringify({ password }),
  });
}

beforeAll(async () => {
  process.env.APP_AUTH_PASSWORD = 'right-password';
  process.env.SESSION_SECRET = 'test-secret-please-change';
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
});

afterAll(async () => {
  delete process.env.APP_AUTH_PASSWORD;
  delete process.env.SESSION_SECRET;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('login throttle behind nginx', () => {
  it('locks out only the client that keeps failing, not everyone behind the proxy', async () => {
    for (let i = 0; i < 5; i++) expect((await login('203.0.113.7')).status).toBe(401);
    expect((await login('203.0.113.7')).status).toBe(429);
    expect((await login('198.51.100.9')).status).toBe(401);
  });

  it('does not let a client dodge the lockout by forging extra X-Forwarded-For entries', async () => {
    for (let i = 0; i < 5; i++) expect((await login(`10.0.0.${i}, 203.0.113.80`)).status).toBe(401);
    expect((await login('10.9.9.9, 203.0.113.80')).status).toBe(429);
  });
});
