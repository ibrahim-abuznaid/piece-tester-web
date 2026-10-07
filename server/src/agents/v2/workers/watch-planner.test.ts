import { describe, it, expect } from 'vitest';
import { runWatchPlannerWorker, WEB_SEARCH_TOOL } from './watch-planner.js';
import type { MessagesClient } from '../../../services/anthropic-client.js';

const meta = {
  name: '@activepieces/piece-acme', displayName: 'Acme', description: 'Acme API', logoUrl: '', version: '0.5.0',
  actions: { send_message: { name: 'send_message', displayName: 'Send message', description: '', requireAuth: true, props: {} } },
  triggers: {}, pieceType: 'OFFICIAL', packageType: 'REGISTRY',
} as any;

describe('runWatchPlannerWorker', () => {
  it('offers web_search with the planner tools, rejects an unprobed plan, and returns null when the agent gives up', async () => {
    const calls: any[] = [];
    const responses: any[] = [
      { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'set_watch_plan', input: {
        vendor_name: 'Acme', api_base_urls: ['https://api.acme.dev'], endpoint_inventory: [],
        sources: [{ kind: 'feed', url: 'https://acme.dev/rss', label: 'rss' }], note: '',
      } }] },
      { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'I could not verify any source.' }] },
    ];
    const client: MessagesClient = { messages: { create: async (body: any) => { calls.push(JSON.parse(JSON.stringify(body))); return responses.shift(); } } };

    const result = await runWatchPlannerWorker({ pieceMeta: meta, onLog: () => {}, client });

    expect(result).toBeNull();
    const names = calls[0].tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['fetch_piece_source', 'fetch_trigger_source', 'probe_source', 'set_watch_plan', 'web_search']));
    expect(calls[0].tools.find((t: any) => t.name === 'web_search')).toEqual(WEB_SEARCH_TOOL);
    expect(calls[0].system[0].text).toContain('WATCH PLAN');
    expect(calls[0].messages[0].content[0].text).toContain('- send_message: Send message');
    const feedback = calls[1].messages[calls[1].messages.length - 1].content[0];
    expect(feedback).toMatchObject({ is_error: true });
    expect(feedback.content).toContain('never probed');
  });
});
