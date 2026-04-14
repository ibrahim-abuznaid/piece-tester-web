/**
 * Lightweight MCP Streamable HTTP client using raw fetch.
 *
 * Connects to an MCP server (like https://mcp.activepieces.com/mcp) with a
 * Bearer token, lists available tools, and proxies tool calls — without
 * relying on Anthropic's beta mcp_servers feature (which has OAuth discovery
 * issues with some servers).
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpProxyClient {
  private sessionId: string | null = null;

  constructor(private url: string, private token: string) {}

  private async rpc(method: string, params?: unknown, expectResponse = true): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: expectResponse ? Date.now() : undefined,
      method,
      params: params ?? {},
    });

    const res = await fetch(this.url, { method: 'POST', headers, body });

    if (!expectResponse || res.status === 202) return null; // notification accepted

    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`MCP RPC ${method} failed (${res.status}): ${text}`);
    }

    // Capture session ID from server for multi-turn sessions
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // Streaming SSE response — read all data: events and find the result
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const envelope = JSON.parse(line.slice(6));
          if (envelope.error) throw new Error(envelope.error.message || JSON.stringify(envelope.error));
          if (envelope.result !== undefined) return envelope.result;
        } catch (e) {
          if ((e as Error).message?.startsWith('MCP')) throw e;
          // Not valid JSON line, skip
        }
      }
      throw new Error(`MCP RPC ${method}: no result found in SSE response`);
    }

    const data = await res.json() as any;
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  /** Initialize the MCP session. Must be called before listTools / callTool. */
  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'piece-tester-web', version: '1.0.0' },
    });
    // Send initialized notification (no response expected)
    await this.rpc('notifications/initialized', {}, false).catch(() => {});
  }

  /** List all tools exposed by the MCP server. */
  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc('tools/list') as any;
    return (result?.tools ?? []) as McpTool[];
  }

  /** Call a named MCP tool and return its text output. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc('tools/call', { name, arguments: args }) as any;
    if (!result) return '(no result)';

    // MCP tool result content is an array of content blocks
    if (Array.isArray(result.content)) {
      return result.content
        .map((c: any) => {
          if (c.type === 'text') return c.text;
          return JSON.stringify(c);
        })
        .join('\n');
    }
    return JSON.stringify(result);
  }
}

/** Convert an MCP tool definition to an Anthropic tool definition. */
export function mcpToolToAnthropic(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}
