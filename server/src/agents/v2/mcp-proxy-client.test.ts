import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpProxyClient } from './mcp-proxy-client.js';

const servers: Server[] = [];

/** Start a throwaway HTTP server and return its /mcp URL. */
function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe('McpProxyClient timeout', () => {
  it('rejects a stalled request within the timeout instead of hanging forever', async () => {
    // Server accepts the connection but never sends a response — mimics an MCP
    // server that stalls, or an SSE stream that never closes.
    const url = await listen(() => { /* never respond */ });
    const client = new McpProxyClient(url, 'tok', { timeoutMs: 150 });

    const outcome = await Promise.race([
      client.listTools().then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('still-pending'), 1500)),
    ]);

    expect(outcome).toBe('rejected');
  });

  it('still returns results for a normal JSON-RPC response', async () => {
    const url = await listen((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const { id } = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: {} }] } }));
      });
    });
    const client = new McpProxyClient(url, 'tok', { timeoutMs: 2000 });

    const tools = await client.listTools();

    expect(tools).toEqual([{ name: 'ping', description: 'p', inputSchema: {} }]);
  });

  it('aborts an in-flight request when the external signal fires', async () => {
    const url = await listen(() => { /* never respond */ });
    const controller = new AbortController();
    // Long timeout so only the external abort can end the request.
    const client = new McpProxyClient(url, 'tok', { timeoutMs: 60_000, signal: controller.signal });

    const outcome = client.listTools().then(() => 'resolved', () => 'rejected');
    controller.abort();

    await expect(outcome).resolves.toBe('rejected');
  });
});
