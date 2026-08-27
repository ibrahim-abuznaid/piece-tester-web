import { describe, it, expect, vi } from 'vitest';

// Stub the network layer: return a controller and never fire callbacks, so the
// loop parks on the first target and we can inspect the synchronous state.
vi.mock('./api', () => ({
  api: {
    streamAiPlanV2: () => new AbortController(),
    streamTriggerPlanV2: () => new AbortController(),
  },
}));

import { batchSetupRunner } from './batchSetupRunner';

describe('batchSetupRunner per-piece isolation', () => {
  it('starting a batch for piece B does not wipe piece A', () => {
    batchSetupRunner.startCreateMissing({
      pieceName: 'piece-a',
      actions: [{ name: 'a1', displayName: 'A1' }, { name: 'a2', displayName: 'A2' }],
      triggers: [],
      existingActionPlans: {},
      existingTriggerPlans: {},
    });
    batchSetupRunner.startCreateMissing({
      pieceName: 'piece-b',
      actions: [{ name: 'b1', displayName: 'B1' }],
      triggers: [],
      existingActionPlans: {},
      existingTriggerPlans: {},
    });

    const a = batchSetupRunner.getFor('piece-a');
    const b = batchSetupRunner.getFor('piece-b');

    // A is still tracked and running after B started — the original bug.
    expect(a.pieceName).toBe('piece-a');
    expect(a.running).toBe(true);
    expect(a.showPanel).toBe(true);
    expect(a.items).toHaveLength(2);

    expect(b.pieceName).toBe('piece-b');
    expect(b.running).toBe(true);
    expect(b.items).toHaveLength(1);
  });

  it('includes triggers alongside actions', () => {
    batchSetupRunner.startCreateMissing({
      pieceName: 'piece-c',
      actions: [{ name: 'c1', displayName: 'C1' }],
      triggers: [{ name: 't1', displayName: 'T1' }],
      existingActionPlans: {},
      existingTriggerPlans: {},
    });
    const c = batchSetupRunner.getFor('piece-c');
    expect(c.items.map(i => i.key)).toEqual(['action:c1', 'trigger:t1']);
  });
});
