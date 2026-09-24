import { describe, it, expect } from 'vitest';
import { findNonExecutableActionSteps } from './plan-validate.js';
import type { TestPlanStep } from './types.js';

function step(overrides: Partial<TestPlanStep> = {}): TestPlanStep {
  return {
    id: 's1',
    type: 'test',
    label: 'Run action',
    description: 'desc',
    actionName: 'get_thing',
    input: {},
    inputMapping: {},
    requiresApproval: false,
    ...overrides,
  };
}

describe('findNonExecutableActionSteps', () => {
  const runnable = ['get_thing', 'create_thing'];

  it('returns no issues when every action step uses a runnable action', () => {
    const steps = [step({ actionName: 'get_thing' }), step({ id: 's2', type: 'setup', actionName: 'create_thing' })];
    expect(findNonExecutableActionSteps(steps, runnable)).toEqual([]);
  });

  it('flags a step that uses an action absent from the runnable set (the MCP audience:ai leak)', () => {
    const steps = [step({ id: 'x', actionName: 'apify_run_task' })];
    const issues = findNonExecutableActionSteps(steps, runnable);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('apify_run_task');
    expect(issues[0]).toContain('x');
  });

  it('ignores human_input steps (they run no piece action)', () => {
    const steps = [step({ id: 'h', type: 'human_input', actionName: '' })];
    expect(findNonExecutableActionSteps(steps, runnable)).toEqual([]);
  });

  it('ignores trigger steps (checked against triggers, not actions)', () => {
    const steps = [
      step({ id: 't1', type: 'trigger_arm', kind: 'trigger', actionName: 'new_item', triggerName: 'new_item' }),
      step({ id: 't2', type: 'trigger_test', kind: 'trigger', actionName: 'new_item', triggerName: 'new_item' }),
    ];
    expect(findNonExecutableActionSteps(steps, runnable)).toEqual([]);
  });

  it('flags each offending step independently', () => {
    const steps = [
      step({ id: 'a', actionName: 'get_thing' }),
      step({ id: 'b', type: 'verify', actionName: 'ghost_action' }),
      step({ id: 'c', type: 'cleanup', actionName: 'other_ghost' }),
    ];
    expect(findNonExecutableActionSteps(steps, runnable)).toHaveLength(2);
  });
});
