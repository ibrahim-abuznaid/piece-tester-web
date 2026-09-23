import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ActivepiecesClient } from './ap-client.js';

const servers: Server[] = [];

/** Start a throwaway HTTP server; handler gets the 1-based request count. Returns its base URL + a counter. */
function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, count: number) => void,
): Promise<{ baseUrl: string; count: () => number }> {
  let count = 0;
  const server = createServer((req, res) => { count += 1; handler(req, res, count); });
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, count: () => count });
    });
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const RETRY = { maxRetries: 3, retryBackoffMs: 5 };

describe('ActivepiecesClient retry', () => {
  it('retries a GET on 502 and then succeeds', async () => {
    const { baseUrl, count } = await startServer((_req, res, n) => {
      if (n === 1) { res.statusCode = 502; res.end('bad gateway'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'slack', displayName: 'Slack', actions: {}, triggers: {} }));
    });
    const client = new ActivepiecesClient(baseUrl, 'key', 'proj', undefined, RETRY);

    const meta = await client.getPieceMetadata('slack');

    expect(meta).toBeTruthy();
    expect(count()).toBe(2); // 1 failure + 1 success
  });

  it('does not retry a POST — createFlow fails on the first 502', async () => {
    const { baseUrl, count } = await startServer((_req, res) => { res.statusCode = 502; res.end('bad gateway'); });
    const client = new ActivepiecesClient(baseUrl, 'key', 'proj', undefined, RETRY);

    await expect(client.createFlow('n')).rejects.toThrow();
    expect(count()).toBe(1); // writes are never retried
  });

  it('gives up on a GET after exhausting retries on a persistent 502', async () => {
    const { baseUrl, count } = await startServer((_req, res) => { res.statusCode = 502; res.end('bad gateway'); });
    const client = new ActivepiecesClient(baseUrl, 'key', 'proj', undefined, RETRY);

    await expect(client.getPieceMetadata('slack')).rejects.toThrow();
    expect(count()).toBe(4); // 1 initial + 3 retries
  });

  it('does not retry a GET on 400', async () => {
    const { baseUrl, count } = await startServer((_req, res) => { res.statusCode = 400; res.end('bad request'); });
    const client = new ActivepiecesClient(baseUrl, 'key', 'proj', undefined, RETRY);

    await expect(client.getPieceMetadata('slack')).rejects.toThrow();
    expect(count()).toBe(1);
  });
});
