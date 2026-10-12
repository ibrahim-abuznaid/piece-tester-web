import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../db/schema.js';
import { executePlan } from './plan-executor.js';
import { MAX_STRING_CHARS } from './step-results-storage.js';

const HUGE = 'A'.repeat(300_000);

vi.mock('./test-engine.js', () => ({
  createClient: () => ({ getPieceMetadata: async () => ({ name: 'image-gen', actions: {}, triggers: {} }) }),
}));
vi.mock('./ai-config-generator.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeActionOnAP: async () => ({ image: HUGE }),
}));

function seedPlan(): number {
  const steps = JSON.stringify([
    { id: 'step_1', type: 'test', label: 'Generate', description: '', actionName: 'generate',
      input: {}, inputMapping: {}, requiresApproval: false },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status) VALUES (?,?,?,?,?)`,
    ['image-gen', 'generate', 'action', steps, 'approved'],
  ).lastId;
}

describe('executePlan — stored step results are capped', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('stores a truncated copy of an oversized step output', async () => {
    const run = await executePlan(seedPlan(), () => {}, 'manual');
    expect(run.status).toBe('completed');
    expect(run.step_results.length).toBeLessThan(MAX_STRING_CHARS + 500);
    const [step] = JSON.parse(run.step_results);
    expect(step.output.image).toContain(`truncated, ${HUGE.length} chars`);
  });
});
