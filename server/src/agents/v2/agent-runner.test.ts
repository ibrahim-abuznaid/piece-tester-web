import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgentLoop } from './agent-runner.js';
import { ToolRegistry } from './tool-registry.js';
import type { AgentRunnerConfig, ToolContext } from './types.js';
import type { MessagesClient } from '../../services/anthropic-client.js';

function scripted(responses: unknown[]) {
  const calls: any[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body) => {
        calls.push(JSON.parse(JSON.stringify(body)));
        const next = responses.shift();
        if (!next) throw new Error('no scripted response left');
        return next as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

function registry() {
  const r = new ToolRegistry();
  r.register({
    name: 'set_watch_plan',
    description: 'test terminal',
    input_schema: { type: 'object', properties: {} },
    validateTerminal: (input) => (input.ok ? null : 'sources: never probed'),
    handler: async () => 'saved',
  });
  return r;
}

const ctx = (): ToolContext => ({ pieceMeta: { name: 'p', actions: {}, triggers: {} } as unknown as ToolContext['pieceMeta'], actionName: '' });
const config = (over: Partial<AgentRunnerConfig>): AgentRunnerConfig => ({
  role: 'watch_planner', model: 'claude-sonnet-4-6', systemPrompt: 'sys',
  initialMessages: [{ role: 'user', content: 'go' }], maxIterations: 5, toolNames: ['set_watch_plan'],
  disableMcp: true, onLog: () => {}, ...over,
});
const usage = { input_tokens: 10, output_tokens: 5 };

describe('runAgentLoop', () => {
  it('passes server tools through and continues after pause_turn without a cache breakpoint on the assistant turn', async () => {
    const { client, calls } = scripted([
      { stop_reason: 'pause_turn', usage, content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'acme changelog' } }] },
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'set_watch_plan', input: { ok: true } }] },
    ]);
    const web: Anthropic.WebSearchTool20250305 = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
    const r = await runAgentLoop(registry(), config({ client, serverTools: [web] }), ctx());
    expect(r.terminatedByTool).toBe(true);
    expect(r.output).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.map((t: any) => t.name)).toEqual(['set_watch_plan', 'web_search']);
    const last = calls[1].messages[calls[1].messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(calls[1].messages)).not.toContain('cache_control');
  });

  it('returns a rejected terminal call to the model as an error and keeps going', async () => {
    const { client, calls } = scripted([
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'set_watch_plan', input: { ok: false } }] },
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't2', name: 'set_watch_plan', input: { ok: true } }] },
    ]);
    const r = await runAgentLoop(registry(), config({ client }), ctx());
    expect(r.terminatedByTool).toBe(true);
    expect(r.output).toEqual({ ok: true });
    const feedback = calls[1].messages[calls[1].messages.length - 1].content[0];
    expect(feedback).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
    expect(feedback.content).toContain('sources: never probed');
  });

  it('runs Sonnet 5.5 at medium effort with room for thinking, and passes thinking blocks back unchanged', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
    const { client, calls } = scripted([
      { stop_reason: 'tool_use', usage, content: [thinking, { type: 'tool_use', id: 't1', name: 'set_watch_plan', input: { ok: false } }] },
      { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't2', name: 'set_watch_plan', input: { ok: true } }] },
    ]);
    await runAgentLoop(registry(), config({ client, model: 'claude-sonnet-5-5' }), ctx());
    expect(calls[0].output_config).toEqual({ effort: 'medium' });
    expect(calls[0].max_tokens).toBe(16000);
    expect(calls[1].messages[1]).toEqual({ role: 'assistant', content: [thinking, { type: 'tool_use', id: 't1', name: 'set_watch_plan', input: { ok: false } }] });
  });

  it('sends no effort to a Haiku 4.5 worker', async () => {
    const { client, calls } = scripted([{ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] }]);
    await runAgentLoop(registry(), config({ client, model: 'claude-haiku-4-5' }), ctx());
    expect(calls[0].output_config).toBeUndefined();
  });

  it('stops and logs an error on a refusal', async () => {
    const logs: any[] = [];
    const { client, calls } = scripted([{ stop_reason: 'refusal', usage, stop_details: { type: 'refusal', category: 'cyber' }, content: [] }]);
    const r = await runAgentLoop(registry(), config({ client, model: 'claude-sonnet-5-5', onLog: (e) => logs.push(e) }), ctx());
    expect(calls).toHaveLength(1);
    expect(r.terminatedByTool).toBe(false);
    expect(logs.some(l => l.type === 'error' && l.message.includes('refusal: cyber'))).toBe(true);
  });

  it('stops without a terminal call on end_turn', async () => {
    const { client } = scripted([{ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] }]);
    const r = await runAgentLoop(registry(), config({ client }), ctx());
    expect(r.terminatedByTool).toBe(false);
    expect(r.output).toBeNull();
  });
});
