import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { executePlan } from './plan-executor.js';

// A plan whose first step needs a person. Unattended runs (auto_test / scheduled) have no one
// to answer, so they must block up front rather than parking on waitForResume forever.
function seedHumanPlan(opts: { savedResponse?: string } = {}): number {
  const steps = JSON.stringify([
    {
      id: 'step_1', type: 'human_input', label: 'Enable the Vertex AI API', description: '',
      humanPrompt: 'Enable the Vertex AI API in the GCP project, then Continue',
      input: {}, inputMapping: {}, requiresApproval: false,
      ...(opts.savedResponse ? { savedHumanResponse: opts.savedResponse } : {}),
    },
  ]);
  return getDb().run(
    `INSERT INTO test_plans (piece_name, target_action, target_type, steps, status, needs_regen)
     VALUES (?,?,?,?,?,?)`,
    ['vertex-ai', 'generate_content', 'action', steps, 'approved', 0],
  ).lastId;
}

describe('executePlan — unattended human_input gate', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM piece_connections;'));

  it('blocks an auto_test run that needs human input, without waiting or calling AP', async () => {
    const planId = seedHumanPlan();
    const run = await executePlan(planId, () => {}, 'auto_test');
    expect(run.status).toBe('blocked');
    const steps = JSON.parse(run.step_results);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepId).toBe('human_input');
    expect(steps[0].status).toBe('skipped');
    expect(steps[0].error).toContain('Vertex AI');
  });

  it('blocks a scheduled run that needs human input', async () => {
    const planId = seedHumanPlan();
    const run = await executePlan(planId, () => {}, 'scheduled');
    expect(run.status).toBe('blocked');
  });

  it('does NOT block at this gate when the human step has a saved response', async () => {
    // A saved answer replays without pausing, so the gate must let it through. It then reaches
    // getPieceMetadata, which throws in tests (no live AP) — proving the gate did not short-circuit.
    const planId = seedHumanPlan({ savedResponse: 'done' });
    await expect(executePlan(planId, () => {}, 'auto_test')).rejects.toThrow();
  });

  it('does NOT block a manual (attended) run at this gate', async () => {
    // A person is watching a manual run, so waiting is legitimate. The gate must not fire; the run
    // proceeds past it to getPieceMetadata, which throws in tests.
    const planId = seedHumanPlan();
    await expect(executePlan(planId, () => {}, 'manual')).rejects.toThrow();
  });
});
