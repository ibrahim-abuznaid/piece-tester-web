import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgentLoop = vi.fn();
vi.mock('../agent-runner.js', () => ({ runAgentLoop: (...args: unknown[]) => runAgentLoop(...args) }));
vi.mock('../../../db/queries.js', () => ({
  getSettings: () => ({ mcp_access_token: '', mcp_token: '' }),
  getConnectionByPiece: () => undefined,
  getLessonsForPiece: () => [],
}));

const { runResearchWorker } = await import('./research.js');
const { runVerifierWorker } = await import('./verifier.js');

const meta = {
  name: '@activepieces/piece-acme', displayName: 'Acme', description: '', logoUrl: '', version: '0.5.0',
  actions: { send_message: { name: 'send_message', displayName: 'Send message', description: '', requireAuth: true, props: {} } },
  triggers: {}, pieceType: 'OFFICIAL', packageType: 'REGISTRY',
} as any;

describe('research and verifier workers', () => {
  beforeEach(() => {
    runAgentLoop.mockReset();
    runAgentLoop.mockResolvedValue({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'VERDICT: PASS' }] }] });
  });

  it('research uses the model from Settings', async () => {
    await runResearchWorker({ pieceMeta: meta, actionName: 'send_message', onLog: () => {} });
    expect(runAgentLoop.mock.calls[0][1]).toMatchObject({ role: 'research', model: '' });
  });

  it('verifier uses the model from Settings', async () => {
    await runVerifierWorker({ pieceMeta: meta, actionName: 'send_message', steps: [], planNote: '', onLog: () => {} });
    expect(runAgentLoop.mock.calls[0][1]).toMatchObject({ role: 'verifier', model: '' });
  });
});
