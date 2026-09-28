import { describe, it, expect } from 'vitest';
import { planStepsUnchanged } from './plan-diff.js';
import type { TestPlanStep } from './types.js';

function step(overrides: Partial<TestPlanStep> = {}): TestPlanStep {
  return {
    id: 's1',
    type: 'test',
    label: 'Run action',
    description: 'desc',
    actionName: 'do_thing',
    input: {},
    inputMapping: {},
    requiresApproval: false,
    ...overrides,
  };
}

describe('planStepsUnchanged', () => {
  it('is true when the fixer returned the very same array (the no-op path)', () => {
    const steps = [step()];
    // fixer.ts returns `params.previousSteps` by reference when it fails to fix
    expect(planStepsUnchanged(steps, steps)).toBe(true);
  });

  it('is true for a structurally identical but distinct copy', () => {
    const before = [step({ id: 'a' }), step({ id: 'b', type: 'verify' })];
    const after = [step({ id: 'a' }), step({ id: 'b', type: 'verify' })];
    expect(planStepsUnchanged(before, after)).toBe(true);
  });

  it('is false when a step input changed', () => {
    const before = [step({ input: { x: 1 } })];
    const after = [step({ input: { x: 2 } })];
    expect(planStepsUnchanged(before, after)).toBe(false);
  });

  it('is false when the number of steps changed', () => {
    const before = [step({ id: 'a' })];
    const after = [step({ id: 'a' }), step({ id: 'b' })];
    expect(planStepsUnchanged(before, after)).toBe(false);
  });

  it('is false when a step was reordered (treated as a real change, so we still re-verify)', () => {
    const before = [step({ id: 'a' }), step({ id: 'b' })];
    const after = [step({ id: 'b' }), step({ id: 'a' })];
    expect(planStepsUnchanged(before, after)).toBe(false);
  });
});
