import { describe, it, expect } from 'vitest';
import { assertionTarget, evaluateAssertion } from './plan-executor.js';
import type { TestPlanStep } from './ai-config-generator.js';

const pollingStep = { type: 'trigger_test', triggerStrategy: 'TEST_FUNCTION' } as TestPlanStep;
const webhookStep = { type: 'trigger_test', triggerStrategy: 'SIMULATION' } as TestPlanStep;
const actionStep = { type: 'test' } as TestPlanStep;

const driveOutput = {
  sampleCount: 1,
  samples: [
    {
      kind: 'drive#file',
      id: '1wUrEEs56sZcB4kept6HwpCNwMBm7kHt98etF74-VTek',
      name: 'My Spreadsheet',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    },
  ],
};

describe('assertionTarget — POLLING assertions resolve against the samples array', () => {
  it('resolves 0.mimeType against the first sample (the screenshot bug)', () => {
    const target = assertionTarget(pollingStep, driveOutput);
    const r = evaluateAssertion(target, {
      path: '0.mimeType', op: 'equals', value: 'application/vnd.google-apps.spreadsheet',
    });
    expect(r.actual).toBe('application/vnd.google-apps.spreadsheet');
    expect(r.passed).toBe(true);
  });

  it('resolves 0.id and 0.name against the first sample', () => {
    const target = assertionTarget(pollingStep, driveOutput);
    expect(evaluateAssertion(target, { path: '0.id', op: 'exists' }).passed).toBe(true);
    expect(evaluateAssertion(target, { path: '0.name', op: 'exists' }).passed).toBe(true);
  });

  it('treats the empty path as the samples array (not_empty = at least one event)', () => {
    const target = assertionTarget(pollingStep, driveOutput);
    expect(evaluateAssertion(target, { path: '', op: 'not_empty' }).passed).toBe(true);

    const emptyTarget = assertionTarget(pollingStep, { sampleCount: 0, samples: [] });
    expect(evaluateAssertion(emptyTarget, { path: '', op: 'not_empty' }).passed).toBe(false);
  });
});

describe('assertionTarget — WEBHOOK assertions resolve against the single captured event', () => {
  const eventOutput = {
    sampleCount: 1,
    samples: [{ id: 'evt_123', email: 'jane@example.com', type: 'contact.created' }],
  };

  it('resolves a bare field path against the captured event payload', () => {
    const target = assertionTarget(webhookStep, eventOutput);
    expect(evaluateAssertion(target, { path: 'id', op: 'exists' }).passed).toBe(true);
    expect(evaluateAssertion(target, { path: 'email', op: 'exists' }).passed).toBe(true);
    expect(
      evaluateAssertion(target, { path: 'type', op: 'equals', value: 'contact.created' }).passed,
    ).toBe(true);
  });
});

describe('assertionTarget — action steps assert on the whole output', () => {
  it('leaves action-step output untouched', () => {
    const output = { result: { id: 'abc' } };
    const target = assertionTarget(actionStep, output);
    expect(target).toBe(output);
    expect(evaluateAssertion(target, { path: 'result.id', op: 'exists' }).passed).toBe(true);
  });
});
