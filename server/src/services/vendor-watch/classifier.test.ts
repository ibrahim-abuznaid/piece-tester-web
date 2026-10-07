import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { classifyChange, buildClassifierPrompt, MAX_CLASSIFIER_CHARS, type ClassifyInput } from './classifier.js';
import type { MessagesClient } from '../anthropic-client.js';

const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  pieceName: '@activepieces/piece-acme', pieceDisplayName: 'Acme', vendorName: 'Acme', apiVersion: 'v1', authType: 'API key',
  inventory: [{ target: 'send_message', target_kind: 'action', method: 'POST', path: '/v1/messages' }],
  source: { label: 'Acme changelog', url: 'https://acme.dev/changelog', kind: 'feed' },
  mode: 'change', text: '## Sunset\nPOST /v1/messages will be removed on 2027-01-31.', today: '2026-10-06', ...over,
});

function fake(response: unknown): { client: MessagesClient; calls: any[] } {
  const calls: any[] = [];
  return { calls, client: { messages: { create: async (body) => { calls.push(body); return response as Anthropic.Message; } } } };
}

const reply = (findings: unknown[]) => ({
  stop_reason: 'tool_use',
  usage: { input_tokens: 1000, output_tokens: 200 },
  content: [{ type: 'tool_use', id: 't1', name: 'report_findings', input: { findings } }],
});

const finding = {
  kind: 'breaking', severity: 'high', affected_targets: ['send_message'], effective_date: '2027-01-31',
  title: 'Messages v1 removed', summary: 's', suggested_action: 'a',
  evidence_excerpt: 'POST /v1/messages will be removed on 2027-01-31',
};

describe('classifyChange', () => {
  it('forces the report_findings tool and returns validated findings with their cost', async () => {
    const { client, calls } = fake(reply([finding]));
    const r = await classifyChange(input(), { client, model: 'claude-haiku-4-5' });
    expect(calls[0].model).toBe('claude-haiku-4-5');
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'report_findings' });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'breaking', evidence_verified: true, is_baseline: false, evidence_url: 'https://acme.dev/changelog' });
    expect(r.costUsd).toBeCloseTo(0.002);
  });

  it('tells the model when it is reading a baseline, and marks the findings', async () => {
    const { client, calls } = fake(reply([finding]));
    const r = await classifyChange(input({ mode: 'baseline' }), { client });
    expect(calls[0].messages[0].content).toContain('FIRST read');
    expect(r.findings[0].is_baseline).toBe(true);
  });

  it('throws when the model does not call the tool or is cut off', async () => {
    await expect(classifyChange(input(), { client: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }).client })).rejects.toThrow(/report_findings/);
    await expect(classifyChange(input(), { client: fake({ ...reply([]), stop_reason: 'max_tokens' }).client })).rejects.toThrow(/truncated/);
  });

  it('caps oversized text and only verifies evidence inside what the model saw', async () => {
    const long = `${'A'.repeat(MAX_CLASSIFIER_CHARS + 5000)} POST /v1/messages will be removed on 2027-01-31`;
    const prompt = buildClassifierPrompt(input({ text: long }));
    expect(prompt).toContain(`cut at ${MAX_CLASSIFIER_CHARS} characters`);
    expect(prompt).not.toContain('will be removed on 2027-01-31');
    const { client } = fake(reply([finding]));
    const r = await classifyChange(input({ text: long }), { client });
    expect(r.findings[0].evidence_verified).toBe(false);
  });

  it('shows the model exactly the first MAX_CLASSIFIER_CHARS chars and checks evidence against that same window', async () => {
    const seen = 'POST /v1/messages will be removed';
    const unseen = ' on 2027-01-31';
    const text = `${'A'.repeat(MAX_CLASSIFIER_CHARS - seen.length - 1)} ${seen}${unseen}`;
    const { client, calls } = fake(reply([
      { ...finding, evidence_excerpt: seen },
      { ...finding, evidence_excerpt: `${seen}${unseen}` },
    ]));
    const r = await classifyChange(input({ text }), { client });
    const shown = /<text>\n([\s\S]*)\n<\/text>/.exec(calls[0].messages[0].content)![1];
    expect(shown).toBe(text.slice(0, MAX_CLASSIFIER_CHARS));
    expect(shown).toHaveLength(MAX_CLASSIFIER_CHARS);
    expect(r.findings.map(f => f.evidence_verified)).toEqual([true, false]);
  });
});
