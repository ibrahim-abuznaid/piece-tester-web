import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../db/schema.js';
import { createTestPlan, createSetupRun, getSetupRun, type ScheduleTarget, type WaveInfo } from '../db/queries.js';

vi.mock('./test-engine.js', () => ({ runScheduledTests: vi.fn() }));
import { startFirstRun, firstRunPlans } from './setup-first-run.js';

function deferred() {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(r => setTimeout(r, 0));
const newSetupRun = () => createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });

describe('startFirstRun', () => {
  beforeEach(() => getDb().exec('DELETE FROM test_plan_runs; DELETE FROM test_plans; DELETE FROM setup_runs;'));

  it('runs only the approved, runnable plans of the batch pieces as one wave and records it on the setup run', async () => {
    createTestPlan({ piece_name: 'a', target_action: 'x', steps: '[{"id":"s1"}]', status: 'approved' });
    createTestPlan({ piece_name: 'a', target_action: 'y', steps: '[{"id":"s1"}]', status: 'draft' });
    createTestPlan({ piece_name: 'a', target_action: 'z', steps: '[]', status: 'approved' });
    createTestPlan({ piece_name: 'b', target_action: 'w', steps: '[{"id":"s1"}]', status: 'approved' });
    createTestPlan({ piece_name: 'c', target_action: 'v', steps: '[{"id":"s1"}]', status: 'approved' });
    const run = newSetupRun();

    const d = deferred();
    const calls: { targets: ScheduleTarget[]; wave: WaveInfo }[] = [];
    const result = startFirstRun(run.id, ['a', 'b'], { run: (targets, wave) => { calls.push({ targets, wave }); return d.promise; } });

    expect(result).toEqual({ waveId: expect.stringMatching(new RegExp(`^setup${run.id}-\\d+$`)), total: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].targets).toEqual([{ piece_name: 'a' }, { piece_name: 'b' }]);
    expect(calls[0].wave).toEqual({ wave_id: result!.waveId });

    let row = getSetupRun(run.id)!;
    expect(row.first_run_wave_id).toBe(result!.waveId);
    expect(row.first_run_total).toBe(2);
    expect(row.first_run_completed_at).toBeNull();

    d.resolve();
    await flush();
    row = getSetupRun(run.id)!;
    expect(row.first_run_completed_at).not.toBeNull();
  });

  it('returns null and records nothing when no plan is approved', () => {
    createTestPlan({ piece_name: 'a', target_action: 'x', steps: '[{"id":"s1"}]', status: 'draft' });
    const run = newSetupRun();
    const runner = vi.fn().mockResolvedValue(undefined);

    expect(startFirstRun(run.id, ['a'], { run: runner })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(getSetupRun(run.id)!.first_run_wave_id).toBeNull();
  });

  it('still marks the first run complete when the runner rejects', async () => {
    createTestPlan({ piece_name: 'a', target_action: 'x', steps: '[{"id":"s1"}]', status: 'approved' });
    const run = newSetupRun();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    startFirstRun(run.id, ['a'], { run: () => Promise.reject(new Error('boom')) });
    await flush();

    expect(getSetupRun(run.id)!.first_run_completed_at).not.toBeNull();
    errorSpy.mockRestore();
  });

  it('firstRunPlans ignores pieces outside the batch', () => {
    createTestPlan({ piece_name: 'a', target_action: 'x', steps: '[{"id":"s1"}]', status: 'approved' });
    createTestPlan({ piece_name: 'c', target_action: 'v', steps: '[{"id":"s1"}]', status: 'approved' });
    expect(firstRunPlans(['a']).map(p => p.piece_name)).toEqual(['a']);
  });
});
